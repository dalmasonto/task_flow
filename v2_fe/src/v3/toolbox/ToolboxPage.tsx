/// Toolbox (design: toolbox.html, +empty, +loading): what agents learned and
/// built, saved so the next agent doesn't rediscover it. Memories and scripts
/// on the left, the open entry on the right (`?entry=<name>`).
///
/// Agents write entries through the MCP (`toolbox_save`), where secrets are
/// refused, so this page never edits code or text. People here approve a
/// draft, retire an entry with a reason, restore an older version or delete
/// it; the server decides who may. The toolbox isn't on App's stream, so the
/// list reloads on Refresh and after every action.
import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArchiveIcon, ArrowLeftIcon, CheckCircle2Icon, HistoryIcon, RefreshCwIcon, SearchIcon, Trash2Icon, WrenchIcon } from "lucide-react"
import { toast } from "sonner"

import { MarkdownRenderer } from "@/components/markdown-renderer"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { highlightCode } from "@/lib/shiki-highlighter"
import { diffSummary, diffText, type DiffLine } from "@/lib/toolbox-diff"
import {
  deleteToolboxEntry,
  fetchToolboxEntry,
  fetchToolboxIndex,
  fetchToolboxVersion,
  fetchToolboxVersions,
  restoreToolboxVersion,
  setToolboxStatus,
  type ToolboxIndexEntry,
  type ToolboxKind,
} from "@/lib/toolbox-api"
import { cn } from "@/lib/utils"

import { CopyBlock } from "../components/copy-block"
import { useLoad } from "../lib/use-load"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { countKinds, filterEntries, initialKind, statusLabel, versionRows } from "./toolbox-logic"

const STARTER_PROMPT = "Save this repo's base branch, merge rule and\ndeploy steps to the TaskFlow toolbox."

function CodeView({ code, language, label }: { code: string; language: string | null; label: string }) {
  // Keyed to the code it came from, so a late result for another entry is
  // never shown. A highlighting failure just leaves the plain text.
  const [hl, setHl] = useState<{ code: string; html: string } | null>(null)
  useEffect(() => {
    let live = true
    highlightCode(code, language ?? "bash")
      .then((html) => live && setHl({ code, html }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [code, language])
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="truncate font-mono">{label}</span>
        <span className="hidden sm:inline">Read-only. Agents change scripts through the MCP.</span>
      </div>
      {hl && hl.code === code ? (
        // Shiki output, generated locally from the code text.
        <div className="max-h-96 overflow-auto p-3 text-xs [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: hl.html }} />
      ) : (
        <pre className="max-h-96 overflow-auto p-3 text-xs leading-5">{code}</pre>
      )}
    </div>
  )
}

function DiffView({ from, to, lines, onClose }: { from: number; to: number; lines: DiffLine[]; onClose: () => void }) {
  const s = diffSummary(lines)
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          v{from} to v{to}{" "}
          <span className="text-xs text-muted-foreground">
            +{s.added} −{s.removed}
          </span>
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto rounded-xl border p-3 text-xs leading-5">
        {lines.map((l, i) => (
          <div key={i} className={cn(l.kind === "add" && "bg-done/15", l.kind === "remove" && "bg-destructive/10")}>
            {l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " "} {l.text}
          </div>
        ))}
      </pre>
    </section>
  )
}

function EntryDetail({ projectId, name, onBack, onChanged }: { projectId: number; name: string; onBack: () => void; onChanged: () => void }) {
  const now = useLivenessNow()
  const data = useLoad(`toolbox:${projectId}:${name}`, () => Promise.all([fetchToolboxEntry(projectId, name), fetchToolboxVersions(projectId, name)]))
  const [busy, setBusy] = useState(false)
  const [retireOpen, setRetireOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [diff, setDiff] = useState<{ name: string; from: number; to: number; lines: DiffLine[] } | null>(null)

  if (data.error && !data.data) return <p className="p-6 text-sm text-destructive">{data.error}</p>
  if (!data.data) return <Skeleton className="h-96 w-full rounded-xl" />
  const [entry, history] = data.data
  const rows = versionRows(entry, history.current_version, history.versions)
  const label = statusLabel(entry.status)
  const shownDiff = diff?.name === name ? diff : null

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true)
    try {
      await run()
      toast.success(done)
      setDiff(null)
      data.reload()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.")
    } finally {
      setBusy(false)
    }
  }

  async function showDiff(from: number, to: number) {
    try {
      const [a, b] = await Promise.all([fetchToolboxVersion(projectId, name, from), fetchToolboxVersion(projectId, name, to)])
      setDiff({ name, from, to, lines: diffText(a.code ?? a.body_markdown, b.code ?? b.body_markdown) })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't build the diff.")
    }
  }

  return (
    <article className="grid gap-5">
      <Button variant="ghost" size="sm" className="justify-self-start lg:hidden" onClick={onBack}>
        <ArrowLeftIcon />
        Toolbox
      </Button>
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-lg font-semibold">{entry.name}</h2>
          <Badge variant="secondary">v{entry.version}</Badge>
          {label ? <Badge variant="outline">{label}</Badge> : null}
          <div className="ml-auto flex gap-2">
            {entry.status === "draft" ? (
              <Button size="sm" disabled={busy} onClick={() => act(() => setToolboxStatus(projectId, name, "approved"), "Approved")}>
                <CheckCircle2Icon />
                Approve
              </Button>
            ) : null}
            {entry.status !== "deprecated" ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setRetireOpen(true)}>
                <ArchiveIcon />
                Retire
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => setDeleteOpen(true)} aria-label="Delete entry">
              <Trash2Icon />
            </Button>
          </div>
        </div>
        {entry.title && entry.title !== entry.name ? <p className="font-medium">{entry.title}</p> : null}
        <p className="text-sm text-muted-foreground">{entry.description}</p>
        <p className="text-xs text-muted-foreground">
          Saved by {entry.author_label}, version {entry.version}
          {entry.updated_at ? `, updated ${timeAgo(entry.updated_at, now)?.toLowerCase()}` : ""}
        </p>
        {entry.deprecated_reason ? <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">Retired: {entry.deprecated_reason}</p> : null}
      </header>

      {entry.kind === "script" ? (
        <dl className="grid grid-cols-2 gap-3 rounded-xl border p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Runs</dt>
            <dd className="font-medium tabular-nums">{entry.run_ok_count + entry.run_fail_count}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Passed</dt>
            <dd className="font-medium tabular-nums">{entry.run_ok_count}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Last run</dt>
            <dd className={cn("font-medium", entry.last_run_at && !entry.last_run_ok && "text-destructive")}>
              {entry.last_run_at ? `${entry.last_run_ok ? "" : "Failed, "}${timeAgo(entry.last_run_at, now)}` : "Never"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Needs</dt>
            <dd className="flex flex-wrap gap-1">
              {entry.requires_env.length ? entry.requires_env.map((v) => <code key={v} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{v}</code>) : <span className="text-muted-foreground">Nothing</span>}
            </dd>
          </div>
        </dl>
      ) : null}

      {entry.params.length ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Parameters</h3>
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>What it is</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entry.params.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell className="font-mono text-xs">{p.name}</TableCell>
                    <TableCell>{p.required ? "Yes" : "No"}</TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">{p.description ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      {entry.body_markdown ? (
        <section className="rounded-xl border p-4 text-sm">
          <MarkdownRenderer content={entry.body_markdown} />
        </section>
      ) : entry.kind === "memory" ? (
        <p className="text-sm text-muted-foreground">No text saved.</p>
      ) : null}

      {entry.kind === "script" && entry.code ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Script</h3>
          <CodeView code={entry.code} language={entry.language} label={entry.entrypoint ?? entry.name} />
        </section>
      ) : null}

      <section className="grid gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <HistoryIcon className="size-4 text-muted-foreground" />
          Versions
        </h3>
        <ul className="divide-y rounded-xl border">
          {rows.map((row, i) => {
            const newer = i === 0 ? null : rows[i - 1]
            return (
              <li key={row.version} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-mono text-xs">v{row.version}</span>
                {row.current ? <Badge variant="secondary">Current</Badge> : null}
                <span className="text-muted-foreground">{row.author_label}</span>
                {row.note ? <span className="truncate text-muted-foreground italic">{row.note}</span> : null}
                {row.vetted_by ? <Badge variant="outline">Vetted by {row.vetted_by}</Badge> : null}
                <span className="ml-auto flex items-center gap-1">
                  {row.created_at ? <span className="text-xs text-muted-foreground">{timeAgo(row.created_at, now)}</span> : null}
                  {newer ? (
                    <Button size="sm" variant="ghost" onClick={() => showDiff(row.version, newer.version)}>
                      Diff
                    </Button>
                  ) : null}
                  {!row.current ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => restoreToolboxVersion(projectId, name, row.version), `Restored v${row.version} as a new version`)}>
                      Restore
                    </Button>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
        {rows.length === 1 ? <p className="text-xs text-muted-foreground">No earlier versions. Every update is kept here, and restoring is a new version.</p> : null}
      </section>

      {shownDiff ? <DiffView from={shownDiff.from} to={shownDiff.to} lines={shownDiff.lines} onClose={() => setDiff(null)} /> : null}

      <Dialog open={retireOpen} onOpenChange={setRetireOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retire {entry.name}?</DialogTitle>
            <DialogDescription>Agents stop using it. It stays here with your reason, and you can restore a version later.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="retire-reason">Why</Label>
            <Textarea id="retire-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Replaced by dispatching the renderer workflow" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRetireOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!reason.trim() || busy}
              onClick={() => {
                setRetireOpen(false)
                void act(() => setToolboxStatus(projectId, name, "deprecated", reason.trim()), "Retired")
                setReason("")
              }}
            >
              Retire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {entry.name}?</AlertDialogTitle>
            <AlertDialogDescription>It and its version history are removed for every agent. This can&apos;t be undone. Retire it instead to keep the history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                setBusy(true)
                try {
                  await deleteToolboxEntry(projectId, name)
                  toast.success(`Deleted ${name}`)
                  onChanged()
                  onBack()
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Couldn't delete it.")
                  setBusy(false)
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  )
}

function EntryList({ entries, kind, selected, onSelect }: { entries: ToolboxIndexEntry[]; kind: ToolboxKind; selected: string | null; onSelect: (name: string) => void }) {
  if (!entries.length) return <p className="px-3 py-6 text-center text-sm text-muted-foreground">{kind === "script" ? "No scripts match." : "No memories match."}</p>
  return (
    <ul className="grid gap-1">
      {entries.map((e) => {
        const label = statusLabel(e.status)
        const failing = e.kind === "script" && e.last_run_at && !e.last_run_ok
        return (
          <li key={e.name}>
            <button
              type="button"
              onClick={() => onSelect(e.name)}
              aria-current={selected === e.name || undefined}
              className={cn("grid w-full gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-muted", selected === e.name && "bg-muted", e.status === "deprecated" && "opacity-60")}
            >
              <span className="flex items-center gap-2">
                <span className="truncate font-mono text-sm font-medium">{e.name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{label ?? `v${e.version}`}</span>
              </span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{e.description}</span>
              {failing ? <span className="text-xs font-medium text-destructive">Last run failed</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function ToolboxPage() {
  const { live } = useWorkspace()
  const projectId = live?.project.id ?? null
  const [params, setParams] = useSearchParams()
  const selected = params.get("entry")
  const index = useLoad(projectId == null ? null : `toolbox:${projectId}`, () => fetchToolboxIndex(projectId!))
  const [kindChoice, setKindChoice] = useState<ToolboxKind | null>(null)
  const [query, setQuery] = useState("")
  const entries = useMemo(() => index.data ?? [], [index.data])
  const kind = kindChoice ?? initialKind(entries, selected)
  const counts = countKinds(entries)
  const visible = filterEntries(entries, kind, query)

  function select(name: string | null) {
    const next = new URLSearchParams(params)
    if (name) next.set("entry", name)
    else next.delete("entry")
    setParams(next, { replace: !name })
  }

  return (
    <V3Shell
      title="Toolbox"
      actions={
        <Button size="sm" variant="outline" onClick={index.reload} disabled={index.loading}>
          <RefreshCwIcon className={index.loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
      }
    >
      {index.error && !index.data ? (
        <div className="mx-auto max-w-xl rounded-xl border p-6 text-sm">
          <p className="text-destructive">{index.error}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={index.reload}>
            Try again
          </Button>
        </div>
      ) : !index.data ? (
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]" aria-label="Loading the toolbox">
          <div className="grid content-start gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="hidden h-96 w-full rounded-xl lg:block" />
        </div>
      ) : !entries.length ? (
        <div className="mx-auto mt-10 grid max-w-xl gap-4 text-center">
          <span className="mx-auto inline-flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <WrenchIcon className="size-6" />
          </span>
          <h2 className="text-lg font-semibold">Nothing saved yet</h2>
          <p className="text-sm text-muted-foreground">When an agent learns a project fact or builds a script that works, it saves it here, so the next agent starts from it instead of rediscovering it.</p>
          <div className="text-left">
            <p className="mb-2 text-sm font-medium">Ask an agent to start. Paste this into an agent&apos;s chat:</p>
            <CopyBlock label="Prompt" text={STARTER_PROMPT} />
          </div>
          <Button variant="outline" className="justify-self-center" nativeButton={false} render={<Link to="/v3/chat" />}>
            Open chat
          </Button>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className={cn("grid content-start gap-3", selected && "hidden lg:grid")}>
            <p className="text-sm text-muted-foreground">
              What your agents learned and built, saved so the next agent doesn&apos;t rediscover it. Agents write here with <code className="rounded bg-muted px-1 font-mono text-xs">toolbox_save</code>.
            </p>
            <Tabs value={kind} onValueChange={(v) => setKindChoice(v as ToolboxKind)}>
              <TabsList className="w-full">
                <TabsTrigger value="memory">
                  Memories <span className="text-muted-foreground">{counts.memory}</span>
                </TabsTrigger>
                <TabsTrigger value="script">
                  Scripts <span className="text-muted-foreground">{counts.script}</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput placeholder={kind === "script" ? "Search scripts" : "Search memories"} aria-label="Search the toolbox" value={query} onChange={(e) => setQuery(e.target.value)} />
            </InputGroup>
            <EntryList entries={visible} kind={kind} selected={selected} onSelect={select} />
          </aside>
          <div className={cn("min-w-0", !selected && "hidden lg:block")}>
            {selected && projectId != null ? (
              <EntryDetail key={selected} projectId={projectId} name={selected} onBack={() => select(null)} onChanged={index.reload} />
            ) : (
              <div className="flex h-64 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">Pick a memory or script to read it.</div>
            )}
          </div>
        </div>
      )}
    </V3Shell>
  )
}
