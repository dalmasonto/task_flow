/// Workflow (design: project-workflow.html): the statuses tasks move through,
/// and the board's columns.
///
/// Statuses are the server's seven, shown flat (#5933): Paused is not Blocked
/// and Archived is not Done. Columns (#5907 1b) are the project's own: each
/// maps onto one status, so agents, reviews and timers are unchanged. Owners
/// and admins rename, reorder, colour, hide, add and remove them. On a server
/// without the statuses endpoint the default columns show read-only.
import { useState } from "react"
import { Link } from "react-router-dom"
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, KanbanIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

import { TaskStatusChip } from "../components/status-chip"
import { STATUS_LABEL } from "../components/status-tones"
import { keyFor, saveBoardColumns, type ColumnInput } from "../board/columns"
import { useBoardColumns } from "../board/use-board-columns"
import { useStatusCounts } from "../board/use-status-counts"
import { myMembership } from "../invites/invites-logic"
import { STATUS_ORDER, type TaskStatus } from "../lib/task-status"
import { useWorkspace } from "../workspace"
import { projectPowers } from "./project-logic"
import { ProjectShell, Section } from "./ProjectShell"

const STATUS_NOTE: Record<TaskStatus, string> = {
  not_started: "Not picked up yet. New tasks start here.",
  in_progress: "Someone is working on it. Moving a task here starts its work timer.",
  paused: "Put down for now, not stuck. The work timer stops.",
  blocked: "Stuck on something or someone.",
  partial_done: "Waiting on a reviewer. Agents ask for review with partial_done.",
  done: "Finished.",
  archived: "Kept for the record, out of the way. Hidden on the board unless you show it.",
}

type Draft = ColumnInput & { id: string }

function ColumnEditor({ project, initial, version, onSaved, onCancel }: { project: number; initial: Draft[]; version: number; onSaved: () => void; onCancel: () => void }) {
  const [rows, setRows] = useState<Draft[]>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (i: number, patch: Partial<Draft>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const swap = (i: number, j: number) => setRows((r) => {
    if (j < 0 || j >= r.length) return r
    const next = [...r]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })
  const missing = STATUS_ORDER.filter((k) => !rows.some((r) => r.kind === k))

  async function save() {
    if (rows.some((r) => !r.label.trim())) return setError("Every column needs a name.")
    if (missing.length) return setError(`Every status needs a column (it can be hidden). Missing: ${missing.map((k) => STATUS_LABEL[k]).join(", ")}.`)
    setBusy(true)
    setError(null)
    try {
      // A column added here takes its key from its name (kept columns keep
      // theirs, so tasks in them stay put).
      const taken = rows.filter((r) => !r.id.startsWith("new-")).map((r) => r.key)
      const out = rows.map((r) => {
        if (!r.id.startsWith("new-")) return r
        const key = keyFor(r.label, taken)
        taken.push(key)
        return { ...r, key }
      })
      await saveBoardColumns(project, out.map(({ key, label, kind, color, hidden }) => ({ key, label: label.trim(), kind, color: color || null, hidden: !!hidden })), version)
      toast.success("Board columns saved")
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the columns.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3">
      <ol className="divide-y rounded-xl border bg-card">
        {rows.map((r, i) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="flex flex-col">
              <Button variant="ghost" size="icon-xs" aria-label={`Move ${r.label || "column"} up`} disabled={i === 0} onClick={() => swap(i, i - 1)}>
                <ArrowUpIcon />
              </Button>
              <Button variant="ghost" size="icon-xs" aria-label={`Move ${r.label || "column"} down`} disabled={i === rows.length - 1} onClick={() => swap(i, i + 1)}>
                <ArrowDownIcon />
              </Button>
            </div>
            <input type="color" aria-label={`Colour of ${r.label || "column"}`} value={r.color || "#888888"} onChange={(e) => set(i, { color: e.target.value })} className="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5" />
            <Input aria-label="Column name" value={r.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} className="h-8 min-w-0 flex-1 basis-40" />
            <Select items={STATUS_LABEL} value={r.kind} onValueChange={(v) => v && set(i, { kind: v as TaskStatus })}>
              <SelectTrigger className="h-8 w-36" aria-label={`Status for ${r.label || "column"}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((k) => (
                  <SelectItem key={k} value={k}>
                    {STATUS_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon-sm" aria-label={r.hidden ? `Show ${r.label}` : `Hide ${r.label}`} title={r.hidden ? "Hidden on the board" : "Shown on the board"} onClick={() => set(i, { hidden: !r.hidden })}>
              {r.hidden ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${r.label}`} disabled={rows.length <= 1} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
              <Trash2Icon />
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={rows.length >= 30}
          onClick={() => setRows((r) => [...r, { id: `new-${Date.now()}`, key: "", label: "New column", kind: "in_progress", color: null, hidden: false }])}
        >
          <PlusIcon />
          Add a column
        </Button>
        <p className="text-xs text-muted-foreground">Tasks in a removed column move to the first column of their status. No task changes status.</p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner /> : null}
          Save columns
        </Button>
      </div>
    </div>
  )
}

export function ProjectWorkflowPage() {
  const { live, currentUser } = useWorkspace()
  const counts = useStatusCounts()
  const cols = useBoardColumns()
  const [editing, setEditing] = useState(false)
  const powers = projectPowers(myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser)
  const loaded = Object.keys(counts).length > 0

  return (
    <ProjectShell
      actions={
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/v3/board" />}>
          <KanbanIcon />
          View board
        </Button>
      }
    >
      <div className="grid gap-10">
        <Section
          title="Task statuses"
          description={
            <>
              Every task has one of these. Agents see them in <code className="rounded bg-muted px-1 font-mono text-xs">list_tasks</code> and set them with{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">update_task_status</code>.
            </>
          }
        >
          <ol className="divide-y rounded-xl border bg-card">
            {STATUS_ORDER.map((s) => (
              <li key={s} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <TaskStatusChip status={s} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted-foreground">{STATUS_NOTE[s]}</p>
                  <code className="mt-0.5 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{s}</code>
                </div>
                {loaded ? (
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {counts[s] ?? 0} {(counts[s] ?? 0) === 1 ? "task" : "tasks"}
                  </span>
                ) : (
                  <Skeleton className="h-4 w-14" />
                )}
              </li>
            ))}
          </ol>
        </Section>

        <Section
          title="Board columns"
          description={cols.custom ? "This project's own columns. Each one holds tasks of one status." : "One column per status. Owners and admins can rename, reorder, colour and hide columns, or split a status into several."}
        >
          {editing && live ? (
            <ColumnEditor
              project={live.project.id}
              version={cols.version}
              initial={cols.columns.map((c) => ({ id: c.key, key: c.key, label: c.label, kind: c.kind, color: c.color, hidden: c.hidden }))}
              onSaved={() => {
                setEditing(false)
                cols.reload()
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <ol className="divide-y rounded-xl border bg-card">
                {cols.columns.map((c) => (
                  <li key={c.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color ?? "var(--muted-foreground)" }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.label}</span>
                    <TaskStatusChip status={c.kind} />
                    {c.hidden ? <span className="text-xs text-muted-foreground">Hidden</span> : null}
                    {c.count != null ? <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">{c.count}</span> : null}
                  </li>
                ))}
              </ol>
              {powers.edit ? (
                cols.fromServer ? (
                  <Button variant="outline" className="justify-self-start" onClick={() => setEditing(true)}>
                    Edit columns
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">Editing columns needs the next server update. Until then every project uses the columns above.</p>
                )
              ) : null}
            </>
          )}
        </Section>
      </div>
    </ProjectShell>
  )
}
