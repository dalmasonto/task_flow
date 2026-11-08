/// The task page's sections (design: task.html). Each reads live data and says
/// plainly when it has none; sections whose backend isn't built yet (approval
/// gate, handoff, code/CI, lease) are not drawn at all.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { CircleCheckIcon, CircleXIcon, FileTextIcon, GitPullRequestIcon, LinkIcon, PencilIcon, PlusIcon, StickyNoteIcon, Trash2Icon, UploadIcon } from "lucide-react"

import type { TaskflowWorkspace } from "@/lib/taskflow-api"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { MessageAttachments } from "@/components/message-attachments"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { getTaskAttachments } from "@/lib/live-mappers"
import { createTaskflowTaskRelation, deleteTaskflowTaskRelation } from "@/lib/taskflow-api"
import type { Task } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { timeAgo } from "../lib/time"
import { fetchTaskEvidence, type Evidence } from "./task-api"
import { groupRelations, parseTaskNumber, RELATION_LABEL, relationToCreate, taskTimeline, type RelationGroup } from "./task-logic"
import { TaskLink } from "../components/task-link"

export function Section({ title, count, action, children, className }: { title: string; count?: number; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-4", className)} aria-label={title}>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {count != null ? <span className="text-xs tabular-nums text-muted-foreground">{count}</span> : null}
        {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function DescriptionSection({ task, onSave }: { task: Task; onSave: (markdown: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.description ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(draft.trim())
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the description.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <Section
      title="Description"
      action={
        editing ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit description"
            onClick={() => {
              setDraft(task.description ?? "")
              setEditing(true)
            }}
          >
            <PencilIcon />
          </Button>
        )
      }
    >
      {editing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} autoFocus className="font-mono text-sm" aria-label="Description (markdown)" />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner /> : null}
              Save
            </Button>
          </div>
        </div>
      ) : task.description?.trim() ? (
        <MarkdownRenderer content={task.description} className="text-sm" />
      ) : (
        <p className="text-sm text-muted-foreground">No description yet. Agents read this first, so a sentence on what "done" means helps.</p>
      )}
    </Section>
  )
}

export function NotesSection({ notes }: { notes: string | undefined }) {
  if (!notes?.trim()) return null
  return (
    <Section title="Notes" action={<StickyNoteIcon className="size-4 text-muted-foreground" aria-hidden />}>
      <MarkdownRenderer content={notes} compact className="text-sm" />
    </Section>
  )
}

function evidenceIcon(e: Evidence) {
  if (e.kind === "pull_request") return <GitPullRequestIcon className="size-4 text-review" aria-hidden />
  if (e.kind === "attachment" || e.kind === "note") return <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
  if (e.passed === false) return <CircleXIcon className="size-4 text-failed" aria-hidden />
  return <CircleCheckIcon className="size-4 text-done" aria-hidden />
}

function evidenceDetail(e: Evidence): string | null {
  const s = e.stats
  const parts: string[] = []
  if (s.additions != null || s.deletions != null) parts.push(`+${s.additions ?? 0} / -${s.deletions ?? 0}`)
  if (s.files != null) parts.push(`${s.files} ${s.files === 1 ? "file" : "files"}`)
  if (s.duration_ms != null) parts.push(`${Math.round(s.duration_ms / 1000)}s`)
  if (e.attachment) parts.push(e.attachment.filename)
  return parts.length ? parts.join(", ") : null
}

export function EvidenceSection({ taskId }: { taskId: number }) {
  const [rows, setRows] = useState<Evidence[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const ctl = new AbortController()
    fetchTaskEvidence(taskId, ctl.signal)
      .then((r) => {
        setRows(r)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load the evidence.")
      })
    return () => ctl.abort()
  }, [taskId])

  if (rows && rows.length === 0 && !error) return null
  return (
    <Section title="Evidence for review" count={rows?.length} action={<Badge variant="outline" title="The server records who said it, not whether it's true">Self-reported</Badge>}>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!rows && !error ? <Spinner /> : null}
      {rows?.length ? (
        <ul className="space-y-2">
          {rows.map((e) => (
            <li key={e.id} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5">{evidenceIcon(e)}</span>
              <span className="min-w-0 flex-1">
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer noopener" className="font-medium underline-offset-2 hover:underline">
                    {e.label}
                  </a>
                ) : (
                  <span className="font-medium">{e.label}</span>
                )}
                <span className="block text-xs text-muted-foreground">
                  {[evidenceDetail(e), `from ${e.author_label}`].filter(Boolean).join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  )
}

export function FilesSection({ task, live, offBoard, onUpload }: { task: Task; live: TaskflowWorkspace | null; offBoard: boolean; onUpload: (files: File[]) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const files = live ? getTaskAttachments(task, live) : []
  return (
    <Section
      title="Files"
      count={offBoard ? undefined : files.length}
      action={
        <>
          <input
            ref={input}
            type="file"
            multiple
            className="sr-only"
            aria-label="Attach files"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              e.target.value = ""
              if (!picked.length) return
              setUploading(true)
              void onUpload(picked).finally(() => setUploading(false))
            }}
          />
          <Button variant="ghost" size="sm" onClick={() => input.current?.click()} disabled={uploading}>
            {uploading ? <Spinner /> : <UploadIcon />}
            Attach
          </Button>
        </>
      }
    >
      {files.length ? (
        <MessageAttachments attachments={files} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {offBoard ? "Files for this task haven't loaded." : "No files yet."} Agents attach with <code className="font-mono text-xs">update_task files=[…]</code>, up to 25 MB each.
        </p>
      )}
    </Section>
  )
}

const ADDABLE: RelationGroup[] = ["blocks", "blocked_by", "duplicates", "related", "parent", "children"]

export function RelationsSection({ task, live, projectId, titleOf }: { task: Task; live: TaskflowWorkspace | null; projectId: number; titleOf: (id: number) => string | null }) {
  const id = Number(task.id)
  const groups = groupRelations(live?.taskRelations ?? [], id)
  const [kind, setKind] = useState<RelationGroup>("related")
  const [target, setTarget] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const any = Object.values(groups).some((g) => g.length)

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const other = parseTaskNumber(target)
    if (other == null) return setError("Type a task number, like #720.")
    if (other === id) return setError("A task can't link to itself.")
    if (groups[kind].some((r) => r.other === other)) return setError(`Already linked: ${RELATION_LABEL[kind].toLowerCase()} #${other}.`)
    setBusy(true)
    setError(null)
    try {
      await createTaskflowTaskRelation({ project: projectId, ...relationToCreate(kind, id, other) })
      setTarget("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the link.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Relations">
      {any ? (
        <dl className="space-y-2 text-sm">
          {(Object.keys(groups) as RelationGroup[])
            .filter((g) => groups[g].length)
            .map((g) => (
              <div key={g} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{RELATION_LABEL[g]}</dt>
                <dd className="space-y-1">
                  {groups[g].map((r) => (
                    <div key={r.relationId} className="group/rel flex items-center gap-2">
                      <TaskLink task={r.other} className="min-w-0 truncate underline-offset-2 hover:underline">
                        <span className="font-mono text-xs text-muted-foreground">#{r.other}</span> {titleOf(r.other) ?? ""}
                      </TaskLink>
                      <button
                        type="button"
                        className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 group-hover/rel:opacity-100 hover:text-destructive focus-visible:opacity-100"
                        aria-label={`Remove the link to #${r.other}`}
                        onClick={() => void deleteTaskflowTaskRelation(r.relationId).catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't remove the link."))}
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </dd>
              </div>
            ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Not linked to other tasks.</p>
      )}
      <form onSubmit={add} className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Select items={RELATION_LABEL} value={kind} onValueChange={(v) => setKind((v ?? "related") as RelationGroup)}>
          <SelectTrigger className="h-8 w-36" aria-label="Relation type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ADDABLE.map((g) => (
              <SelectItem key={g} value={g}>
                {RELATION_LABEL[g]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-0 flex-1">
          <LinkIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Task number, e.g. #720" aria-label="Task to link" className="h-8 pl-8" />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={busy || !target.trim()}>
          {busy ? <Spinner /> : <PlusIcon />}
          Add
        </Button>
        {error ? <p className="w-full text-sm text-destructive">{error}</p> : null}
      </form>
    </Section>
  )
}

export function TimelineSection({ taskId, live, offBoard, onComment }: { taskId: number; live: TaskflowWorkspace | null; offBoard: boolean; onComment: (body: string) => Promise<void> }) {
  const now = useLivenessNow()
  const [tab, setTab] = useState<"all" | "comments">("all")
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lines = taskTimeline(live?.taskActivity ?? [], taskId, tab === "comments")
  const agents = live?.agents ?? []

  const send = async () => {
    const body = draft.trim()
    if (!body) return
    setSending(true)
    setError(null)
    try {
      await onComment(body)
      setDraft("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't post the comment.")
    } finally {
      setSending(false)
    }
  }

  return (
    <Section
      title="Comments and activity"
      action={
        <Tabs value={tab} onValueChange={(v) => setTab(v as "all" | "comments")}>
          <TabsList className="h-7">
            <TabsTrigger value="all" className="text-xs">
              All
            </TabsTrigger>
            <TabsTrigger value="comments" className="text-xs">
              Comments
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {lines.length ? (
        <ol className="space-y-3">
          {lines.map((l) => {
            const agent = l.agent ? agents.find((a) => a.display_name === l.who) : undefined
            return (
              <li key={l.id} className="flex gap-2.5">
                <ActorAvatar model={l.agent ? (guessModel(agent?.runtime) ?? guessModel(l.who)) : null} name={l.who} size="xs" className="mt-0.5" />
                <div className="min-w-0 flex-1 text-sm">
                  <p>
                    <span className="font-medium">{l.who}</span> <span className="text-muted-foreground">{l.verb}</span>{" "}
                    <time className="text-xs text-muted-foreground" dateTime={l.at ?? undefined} title={l.at ? new Date(l.at).toLocaleString() : undefined}>
                      {timeAgo(l.at, now)}
                    </time>
                  </p>
                  {l.body ? (
                    l.comment ? (
                      <div className="mt-1 rounded-lg bg-muted/50 px-3 py-2">
                        <MarkdownRenderer content={l.body} compact className="text-sm" />
                      </div>
                    ) : (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{l.body.replace(/\s+/g, " ")}</p>
                    )
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{offBoard ? "Activity for this task hasn't loaded." : tab === "comments" ? "No comments yet." : "No activity yet."}</p>
      )}
      <div className="mt-4 space-y-2 border-t border-border pt-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          placeholder="Comment. Markdown works; #TSK and #MSG links become chips."
          aria-label="Comment"
        />
        {error ? (
          <Alert variant="destructive" className="rounded-lg">
            <AlertDescription className="text-foreground">{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Ctrl+Enter to send</span>
          <Button size="sm" onClick={() => void send()} disabled={sending || !draft.trim()}>
            {sending ? <Spinner /> : null}
            Comment
          </Button>
        </div>
      </div>
    </Section>
  )
}
