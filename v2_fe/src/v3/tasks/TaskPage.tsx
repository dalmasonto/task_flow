/// One task (design: task.html), at /v3/tasks/:id. Opens through v2's own
/// open-task path (so a task the board hasn't paged in still loads), edits
/// through the workspace's `task.patch` (server response reconciles state).
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { CheckIcon, ChevronRightIcon, GitBranchIcon, LinkIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowTaskUpdate } from "@/api/client"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { fetchClaimLease } from "@/lib/taskflow-api"
import { columns, type ColumnId, type Priority } from "@/lib/workspace-view"

import { StatusChip } from "../components/status-chip"
import { COLUMN_LABEL, COLUMN_TONE } from "../components/status-tones"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { leaseLabel, leaseLeft } from "../board/board-logic"
import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { DescriptionSection, EvidenceSection, FilesSection, NotesSection, RelationsSection, TimelineSection } from "./TaskSections"

const PRIORITIES: Record<Priority, string> = { critical: "Critical", high: "High", normal: "Normal", low: "Low" }

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  )
}

/// `due_at` → the date input's value, in local time.
function toDateInput(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function TaskPage() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { task: tv, live: projectLive, projectTasks, isSyncing } = useWorkspace()
  const now = useLivenessNow()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")

  // Open on enter, close on leave, through App's open-task path.
  const openRef = useRef(tv.open)
  useEffect(() => {
    openRef.current = tv.open
  })
  useEffect(() => {
    openRef.current(id)
    return () => openRef.current(null)
  }, [id])

  const task = tv.current?.id === id ? tv.current : null
  const live = tv.live
  const raw = live?.tasks.find((t) => String(t.id) === id) ?? projectLive?.tasks.find((t) => String(t.id) === id)
  const lease = useLoad("claim-lease", (signal) => fetchClaimLease(signal))
  const leaseAgent = raw?.assigned_agent_id != null ? (live?.agents ?? projectLive?.agents ?? []).find((a) => a.id === raw.assigned_agent_id) : undefined
  const leftOnLease = leaseLeft(raw, leaseAgent, lease.data?.lease_minutes ?? null, now)

  const save = async (patch: TaskflowTaskUpdate, what: string) => {
    try {
      await tv.patch(id, patch)
    } catch (e) {
      toast.error(`Couldn't save the ${what}`, { description: e instanceof Error ? e.message : undefined })
      throw e
    }
  }

  const titleOf = (n: number) => projectTasks.find((t) => t.id === String(n))?.title ?? live?.tasks.find((t) => t.id === n)?.title ?? null

  if (!task) {
    return (
      <V3Shell title={`#${id}`}>
        {isSyncing || !tv.current ? (
          <div className="mx-auto max-w-5xl space-y-4" aria-busy="true" aria-label="Loading the task">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : (
          <Empty className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed">
            <EmptyHeader>
              <EmptyTitle>Task #{id} isn't here</EmptyTitle>
              <EmptyDescription>It may be in another project, or deleted.</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" render={<Link to="/v3/board" />} nativeButton={false}>
              Back to the board
            </Button>
          </Empty>
        )}
      </V3Shell>
    )
  }

  const people = (live?.members ?? []).filter((m) => m.user != null && m.status === "active")
  const agents = (live?.agents ?? []).filter((a) => a.status !== "revoked")
  const assigneeValue = raw?.assigned_agent_id != null ? `agent:${raw.assigned_agent_id}` : raw?.assigned_user != null ? `user:${raw.assigned_user}` : "none"
  const assigneeItems: Record<string, string> = {
    none: "Unassigned",
    ...Object.fromEntries(people.map((m) => [`user:${m.user}`, m.display_name])),
    ...Object.fromEntries(agents.map((a) => [`agent:${a.id}`, a.display_name])),
  }

  const commitTitle = async () => {
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (next && next !== task.title) await save({ title: next }, "title").catch(() => undefined)
  }

  return (
    <V3Shell
      title={`#${task.id} ${task.title}`}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy a link to this task"
            onClick={() => {
              void navigator.clipboard.writeText(`${window.location.origin}/v3/tasks/${task.id}`).then(() => toast.success("Link copied"))
            }}
          >
            <LinkIcon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More task actions" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon />
                Delete task
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-4">
          <div>
            <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
              <Link to="/v3/board" className="hover:text-foreground">
                Board
              </Link>
              <ChevronRightIcon className="size-3.5" aria-hidden />
              <span className="font-mono text-xs">#{task.id}</span>
              <StatusChip tone={COLUMN_TONE[task.status]} className="ml-1" />
            </nav>
            {editingTitle ? (
              <Input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") void commitTitle()
                  if (e.key === "Escape") setEditingTitle(false)
                }}
                autoFocus
                aria-label="Title"
                className="mt-2 h-auto py-1 text-xl font-semibold"
              />
            ) : (
              <h2 className="mt-2 text-xl font-semibold tracking-tight break-words">
                <button
                  type="button"
                  className="rounded text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
                  title="Click to rename"
                  onClick={() => {
                    setTitleDraft(task.title)
                    setEditingTitle(true)
                  }}
                >
                  {task.title}
                </button>
              </h2>
            )}
            {tv.offBoard ? <p className="mt-1 text-xs text-muted-foreground">Opened from the server: this task isn't on the loaded board page, so some sections may not have loaded yet.</p> : null}
          </div>

          <DescriptionSection task={task} onSave={(md) => save({ description_markdown: md }, "description")} />
          <NotesSection notes={task.notes} />
          <EvidenceSection taskId={Number(task.id)} />
          <FilesSection task={task} live={live} offBoard={tv.offBoard} onUpload={(files) => tv.upload(task.id, files)} />
          {live ? <RelationsSection task={task} live={live} projectId={live.project.id} titleOf={titleOf} /> : null}
          <TimelineSection taskId={Number(task.id)} live={live} offBoard={tv.offBoard} onComment={(body) => tv.comment(task.id, body)} />
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-0 lg:self-start">
          <section className="rounded-xl border border-border bg-card p-4" aria-label="Properties">
            <dl>
              <Prop label="Status">
                <Select items={COLUMN_LABEL} value={task.status} onValueChange={(v) => v && v !== task.status && tv.move(task.id, v as ColumnId)}>
                  <SelectTrigger className="h-8 w-full" aria-label="Status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {COLUMN_LABEL[c.id]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Prop>
              <Prop label="Assignee">
                <Select
                  items={assigneeItems}
                  value={assigneeValue}
                  onValueChange={(v) => {
                    if (!v || v === assigneeValue) return
                    const [kind, n] = v.split(":")
                    void save(
                      kind === "agent"
                        ? { assigned_agent_id: Number(n), assigned_user: null, assignee_label: assigneeItems[v] }
                        : kind === "user"
                          ? { assigned_user: Number(n), assigned_agent_id: null, assignee_label: assigneeItems[v] }
                          : { assigned_user: null, assigned_agent_id: null, assignee_label: null },
                      "assignee",
                    ).catch(() => undefined)
                  }}
                >
                  <SelectTrigger className="h-8 w-full" aria-label="Assignee">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {people.map((m) => (
                      <SelectItem key={`u${m.id}`} value={`user:${m.user}`}>
                        {m.display_name}
                      </SelectItem>
                    ))}
                    {agents.map((a) => (
                      <SelectItem key={`a${a.id}`} value={`agent:${a.id}`}>
                        {a.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Prop>
              <Prop label="Priority">
                <Select
                  items={PRIORITIES}
                  value={task.priority}
                  onValueChange={(v) => v && v !== task.priority && void save({ priority: v as Priority }, "priority").catch(() => undefined)}
                >
                  <SelectTrigger className="h-8 w-full" aria-label="Priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PRIORITIES) as Priority[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PRIORITIES[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Prop>
              <Prop label="Due">
                <Input
                  type="date"
                  defaultValue={toDateInput(raw?.due_at)}
                  key={raw?.due_at ?? "none"}
                  aria-label="Due date"
                  className="h-8"
                  onChange={(e) => {
                    const v = e.target.value
                    // End of that local day, so "due Nov 3" isn't overdue at 00:01.
                    void save({ due_at: v ? new Date(`${v}T23:59:59`).toISOString() : null }, "due date").catch(() => undefined)
                  }}
                />
              </Prop>
              {leftOnLease != null ? (
                <Prop label="Claim lease">
                  <span title="The agent keeps this task while it's active. If it goes quiet this long, the task is released for someone else.">
                    {leftOnLease > 0 ? `Expires in ${leaseLabel(leftOnLease)}` : "Expired; releasing soon"}
                  </span>
                </Prop>
              ) : null}
              {raw?.review_gate && !/^no review gate/i.test(raw.review_gate) ? <Prop label="Review gate">{raw.review_gate}</Prop> : null}
              {raw?.github_repo ? (
                <Prop label="Repo">
                  <span className="inline-flex items-center gap-1.5">
                    <GitBranchIcon className="size-3.5 text-muted-foreground" aria-hidden />
                    {raw.github_repo}
                  </span>
                </Prop>
              ) : null}
              {raw?.github_issue_url ? (
                <Prop label="Issue">
                  <a href={raw.github_issue_url} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">
                    #{raw.github_issue_number}
                  </a>
                </Prop>
              ) : null}
            </dl>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
              Created {timeAgo(raw?.created_at, now) ?? "—"} · updated {timeAgo(raw?.updated_at, now) ?? "—"}
            </p>
          </section>
          {task.status !== "done" ? (
            <Button variant="outline" className="w-full" onClick={() => tv.move(task.id, "done")}>
              <CheckIcon />
              Mark as done
            </Button>
          ) : null}
        </aside>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete #{task.id}?</AlertDialogTitle>
            <AlertDialogDescription>&ldquo;{task.title}&rdquo; and its comments, files and links are removed for everyone. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                tv.remove(task.id)
                navigate("/v3/board", { replace: true })
              }}
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </V3Shell>
  )
}
