/// Create a task (design: task-new.html): title, description, an assignee
/// picked from live agents and people (with what each is busy on), priority,
/// reviewers (one review request each, #TSK1098), due, repo and files. A
/// draft handed over from elsewhere (design "+ Task", chat) pre-fills it.
import { useMemo, useRef, useState, type FormEvent } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { CheckIcon, PaperclipIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { isAgentOnline, toLivePriority, toLiveStatus } from "@/lib/live-mappers"
import { columns, type ColumnId, type Priority } from "@/lib/workspace-view"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel, type ModelId } from "../components/actor-models"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { requestReview } from "./task-api"
import { takeTaskSeed } from "./task-seed"

type Who = { key: string; kind: "user" | "agent"; id: number; name: string; model: ModelId | null; online: boolean; detail: string }

const PRIORITIES: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High", critical: "Critical" }

function WhoCard({ who, selected, onSelect }: { who: Who; selected: boolean; onSelect: () => void }) {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors focus-within:outline-2 focus-within:outline-ring",
        selected ? "border-ring bg-accent/50" : "border-border hover:bg-muted/50",
      )}
    >
      <input type="radio" name="assignee" className="sr-only" checked={selected} onChange={onSelect} />
      <ActorAvatar model={who.model} name={who.name} status={who.kind === "agent" ? (who.online ? "running" : "offline") : null} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{who.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{who.detail}</span>
      </span>
      <CheckIcon className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")} aria-hidden />
    </label>
  )
}

export function TaskNewPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { live, currentUser, task: tv, projectTasks } = useWorkspace()
  const now = useLivenessNow()
  const [seed] = useState(takeTaskSeed)
  const status = (columns.some((c) => c.id === params.get("status")) ? params.get("status") : "not_started") as ColumnId

  const [assignee, setAssignee] = useState<string>("none")
  const [priority, setPriority] = useState<Priority>("normal")
  const [reviewers, setReviewers] = useState<string[]>([])
  // null = "the project's default", so a workspace that loads after the first
  // render still pre-selects its repo.
  const [repoChoice, setRepo] = useState<string | null>(null)
  const repo = repoChoice ?? live?.project.github_repo ?? "none"
  const [files, setFiles] = useState<File[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [titleError, setTitleError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const people: Who[] = useMemo(() => {
    const me = currentUser?.id
    return (live?.members ?? [])
      .filter((m) => m.user != null && m.status === "active")
      .map((m) => ({ key: `user:${m.user}`, kind: "user" as const, id: m.user as number, name: m.display_name, model: null, online: false, detail: m.user === me ? "You" : m.role }))
  }, [live?.members, currentUser?.id])

  const agents: Who[] = (live?.agents ?? [])
    .filter((a) => a.status !== "revoked")
    .map((a) => {
      const busy = projectTasks.find((t) => t.status === "in_progress" && live?.tasks.find((r) => String(r.id) === t.id)?.assigned_agent_id === a.id)
      const online = live ? isAgentOnline(a.id, live.agents, live.agentSessions, now) : false
      return {
        key: `agent:${a.id}`,
        kind: "agent" as const,
        id: a.id,
        name: a.display_name,
        model: guessModel(a.runtime) ?? guessModel(a.display_name),
        online,
        detail: busy ? `Busy on #${busy.id}` : online ? "Online, free" : "Offline",
      }
    })
    .sort((x, y) => Number(y.online) - Number(x.online))

  const everyone = [...agents, ...people]
  const byKey = (k: string) => everyone.find((w) => w.key === k)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const title = String(f.get("title") ?? "").trim()
    const description = String(f.get("description") ?? "").trim()
    const due = String(f.get("due") ?? "")
    if (!title) {
      setTitleError("Give the task a title.")
      return
    }
    setTitleError(null)
    setPending(true)
    setError(null)
    const who = byKey(assignee)
    try {
      const { id } = await tv.create({
        title,
        description_markdown: description,
        status: toLiveStatus(status),
        priority: toLivePriority(priority),
        sort_order: projectTasks.length,
        assigned_user: who?.kind === "user" ? who.id : null,
        assigned_agent_id: who?.kind === "agent" ? who.id : null,
        assignee_label: who?.name ?? null,
        due_at: due ? new Date(`${due}T23:59:59`).toISOString() : null,
        github_repo: repo === "none" ? null : repo,
      })
      // Follow-ups on a task that now exists: a failure says so, never "not created".
      const problems: string[] = []
      if (files.length) await tv.upload(id, files).catch(() => problems.push("the files"))
      for (const k of reviewers) {
        const r = byKey(k)
        if (r) await requestReview(Number(id), { kind: r.kind, id: r.id }).catch(() => problems.push(`the review request for ${r.name}`))
      }
      if (problems.length) toast.warning(`Task #${id} created, but ${problems.join(" and ")} didn't go through`, { description: "Try again from the task page." })
      else toast.success(`Task #${id} created`)
      navigate(`/v3/tasks/${id}`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the task.")
    } finally {
      setPending(false)
    }
  }

  const reviewerOptions = everyone.filter((w) => w.key !== assignee && !reviewers.includes(w.key))

  return (
    <V3Shell title="New task">
      <form className="mx-auto grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]" onSubmit={submit} noValidate aria-label="New task">
        <div className="min-w-0 space-y-6">
          {error ? (
            <Alert variant="destructive" className="rounded-xl">
              <TriangleAlertIcon />
              <AlertDescription className="text-foreground">{error}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup className="gap-6">
            <Field data-invalid={titleError ? true : undefined}>
              <FieldLabel htmlFor="t-title">Title</FieldLabel>
              <Input id="t-title" name="title" defaultValue={seed?.title ?? ""} autoComplete="off" autoFocus className="h-10 text-base" aria-invalid={!!titleError} />
              {titleError ? <FieldError>{titleError}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="t-desc">Description</FieldLabel>
              <Textarea id="t-desc" name="description" rows={6} defaultValue={seed?.description ?? ""} placeholder="What should be true when this is done? Markdown works." />
              <FieldDescription>Tip: say &ldquo;done when&rdquo; so the reviewer knows what to check.</FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Assignee</FieldLegend>
              {everyone.length ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Assignee">
                  {everyone.map((w) => (
                    <WhoCard key={w.key} who={w} selected={assignee === w.key} onSelect={() => setAssignee(w.key)} />
                  ))}
                </div>
              ) : null}
              <Button type="button" variant={assignee === "none" ? "secondary" : "ghost"} size="sm" className="self-start" onClick={() => setAssignee("none")}>
                {assignee === "none" ? <CheckIcon /> : null}
                Leave unassigned, any agent can claim it
              </Button>
            </FieldSet>
            <Field>
              <FieldLabel>Attachments</FieldLabel>
              <div
                className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border p-5 text-center text-sm"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  setFiles((cur) => [...cur, ...Array.from(e.dataTransfer.files)])
                }}
              >
                <PaperclipIcon className="size-4 text-muted-foreground" aria-hidden />
                <span>
                  Drop files here, or{" "}
                  <button type="button" className="font-medium underline underline-offset-2" onClick={() => fileInput.current?.click()}>
                    browse
                  </button>
                </span>
                <span className="text-xs text-muted-foreground">Up to 25 MB each. Agents download them with download_attachment.</span>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  aria-label="Attach files"
                  onChange={(e) => {
                    setFiles((cur) => [...cur, ...Array.from(e.target.files ?? [])])
                    e.target.value = ""
                  }}
                />
              </div>
              {files.length ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {files.map((file, i) => (
                    <li key={`${file.name}-${i}`} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <span className="text-xs text-muted-foreground">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                      <button type="button" aria-label={`Remove ${file.name}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                        <XIcon className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Field>
          </FieldGroup>
        </div>

        <aside className="min-w-0 space-y-5">
          <Field>
            <FieldLabel htmlFor="t-pri">Priority</FieldLabel>
            <Select items={PRIORITIES} value={priority} onValueChange={(v) => setPriority((v ?? "normal") as Priority)}>
              <SelectTrigger id="t-pri" className="h-9 w-full">
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
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Reviewers</FieldLegend>
            {reviewers.length ? (
              <ul className="space-y-1.5">
                {reviewers.map((k) => {
                  const r = byKey(k)
                  if (!r) return null
                  return (
                    <li key={k} className="flex items-center gap-2 text-sm">
                      <ActorAvatar model={r.model} name={r.name} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <button type="button" aria-label={`Remove ${r.name}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setReviewers((cur) => cur.filter((x) => x !== k))}>
                        <XIcon className="size-3.5" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {reviewerOptions.length ? (
              <Select value={null} onValueChange={(v) => v && setReviewers((cur) => [...cur, v as string])}>
                <SelectTrigger className="h-9 w-full" aria-label="Add a reviewer">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <PlusIcon className="size-4" />
                    Add a reviewer
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {reviewerOptions.map((w) => (
                    <SelectItem key={w.key} value={w.key}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <FieldDescription>Each reviewer is asked to review and answers with their own verdict.</FieldDescription>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor="t-due">
              Due <span className="font-normal text-muted-foreground">Optional</span>
            </FieldLabel>
            <Input id="t-due" name="due" type="date" className="h-9" />
          </Field>
          {live?.project.github_repo ? (
            <Field>
              <FieldLabel htmlFor="t-repo">Repo</FieldLabel>
              <Select items={{ none: "No repo", [live.project.github_repo]: live.project.github_repo }} value={repo} onValueChange={(v) => setRepo((v as string) ?? "none")}>
                <SelectTrigger id="t-repo" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={live.project.github_repo}>{live.project.github_repo}</SelectItem>
                  <SelectItem value="none">No repo</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : null}
              {pending ? "Creating…" : "Create task"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => navigate(-1)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </aside>
      </form>
    </V3Shell>
  )
}
