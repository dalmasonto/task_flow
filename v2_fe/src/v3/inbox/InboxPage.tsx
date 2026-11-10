/// The inbox (design: inbox.html, inbox--empty): everything that needs this
/// person, across their projects. Permission prompts are answered in place
/// (v2's AgentPromptCard, which types the choice into the agent's pane);
/// everything else links to where it's handled. Cross-project, so it reads
/// its own endpoint and refreshes on focus and every 30 seconds rather than
/// riding the active project's stream.
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowRightIcon, CalendarClockIcon, CheckCheckIcon, HelpCircleIcon, InboxIcon, MessageSquareIcon, ScaleIcon, ShieldCheckIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowWorkspace } from "@/lib/taskflow-api"
import { AgentPromptCard } from "@/components/chat/prompt-card"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { answerAgentPrompt, cancelAgentPrompt } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useMayDrive } from "../lib/use-may-drive"
import { useWorkspace } from "../workspace"
import { fetchInbox, markInboxRead, type InboxItem, type InboxPage as Feed, type InboxTab } from "./inbox-api"
import { TaskLink } from "../components/task-link"

const TABS: { id: InboxTab; label: string }[] = [
  { id: "needs_you", label: "Needs you" },
  { id: "mentions", label: "Mentions" },
  { id: "everything", label: "Everything" },
]

function Row({ item, icon, title, meta, children }: { item: InboxItem; icon: React.ReactNode; title: React.ReactNode; meta: string; children?: React.ReactNode }) {
  return (
    <li className={cn("flex gap-3 px-4 py-4", item.kind === "prompt_withdrawn" && "opacity-60")}>
      <div className="relative shrink-0">
        {icon}
        {item.unread ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" aria-label="Unread" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{title}</span> <span className="text-xs text-muted-foreground">{meta}</span>
        </p>
        {children}
      </div>
    </li>
  )
}

/// Where an inbox item opens. Chat items go through `?channel=&msg=` so the
/// chat page resolves the right room or DM (a DM's slug isn't `channel-N`) and
/// scrolls to the message; an item from another project switches to it first.
function Go({ project, to, children, variant = "default" }: { project: number; to: string; children: React.ReactNode; variant?: "default" | "outline" }) {
  const { live, chooseProject } = useWorkspace()
  const navigate = useNavigate()
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={() => {
        if (live?.project.id !== project) chooseProject(String(project))
        navigate(to)
      }}
    >
      {children}
      <ArrowRightIcon />
    </Button>
  )
}

const chatHref = (channel: number, message: number) => `/v3/chat?channel=${channel}&msg=${message}`

function Glyph({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">{children}</span>
}

export function InboxPage() {
  const { projects, live } = useWorkspace()
  // #1127: the server says who may answer (`can_answer`). An older backend
  // doesn't, so fall back to the rule for the active project's agents and let
  // the server decide for the rest.
  const mayDrive = useMayDrive()
  const activeId = live?.project.id ?? null
  const now = useLivenessNow()
  const [tab, setTab] = useState<InboxTab>("needs_you")
  const [project, setProject] = useState<number | null>(null)
  const [feed, setFeed] = useState<Feed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const projectName = (id: number) => projects.find((p) => p.id === String(id))?.name ?? `project ${id}`

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetchInbox(tab, project, signal)
        .then((f) => {
          setFeed(f)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!signal?.aborted) setError(e instanceof Error ? e.message : "Couldn't load the inbox.")
        }),
    [tab, project],
  )

  useEffect(() => {
    const ctl = new AbortController()
    void load(ctl.signal)
    const tick = window.setInterval(() => void load(), 30_000)
    const onFocus = () => void load()
    window.addEventListener("focus", onFocus)
    return () => {
      ctl.abort()
      window.clearInterval(tick)
      window.removeEventListener("focus", onFocus)
    }
  }, [load])

  const item = (i: InboxItem) => {
    const where = projects.length > 1 ? ` in ${projectName(i.project)}` : ""
    const when = `${where}${where ? ", " : ""}${timeAgo(i.at, now) ?? ""}`
    switch (i.kind) {
      case "prompt":
      case "prompt_withdrawn": {
        const name = i.agent_label ?? `Agent ${i.agent}`
        return (
          <Row key={`p${i.prompt}`} item={i} icon={<ActorAvatar model={guessModel(name)} name={name} size="md" />} title={i.kind === "prompt" ? `${name} needs your permission` : "Permission no longer needed"} meta={when}>
            {i.kind === "prompt" ? (
              <div className="mt-2">
                <AgentPromptCard
                  readOnly={i.can_answer != null ? !i.can_answer : i.project === activeId && mayDrive(i.agent) === false}
                  prompt={{ id: i.prompt, project: i.project, agent: i.agent, question: i.question, options_json: i.options_json, kind: i.prompt_kind, status: "pending" } as unknown as TaskflowWorkspace["agentPrompts"][number]}
                  onAnswer={async (id, answers, cancel, texts) => {
                    await answerAgentPrompt(id, answers, cancel, texts)
                    toast.success("Answer sent", { description: `Typed into ${name}'s terminal.` })
                    void load()
                  }}
                  onDismiss={async (id) => {
                    await cancelAgentPrompt(id)
                    void load()
                  }}
                />
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">It asked again, or its terminal answered first, so this one was withdrawn. Nothing to answer.</p>
            )}
            <div className="mt-2">
              <Go project={i.project} to={`/v3/agents/${i.agent}`} variant="outline">
                Open {name}
              </Go>
            </div>
          </Row>
        )
      }
      case "decision":
        return (
          <Row key={`d${i.decision}`} item={i} icon={<Glyph><ScaleIcon /></Glyph>} title={`${i.asked_by_label} asks for a ruling`} meta={when}>
            <p className="mt-1 text-sm">{i.question}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{i.key}</p>
            <div className="mt-2">
              <Go project={i.project} to={`/v3/decisions?key=${encodeURIComponent(i.key)}`}>
                Rule on it
              </Go>
            </div>
          </Row>
        )
      case "review_request":
        return (
          <Row key={`r${i.review_request}`} item={i} icon={<Glyph><ShieldCheckIcon /></Glyph>} title={`${i.requester_label} asked you to review #${i.task}`} meta={when}>
            {i.focus_markdown ? <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{i.focus_markdown}</p> : null}
            <div className="mt-2 flex gap-2">
              <Button size="sm" render={<TaskLink task={i.task} />} nativeButton={false}>
                Open #{i.task}
              </Button>
              {i.link ? (
                <Button size="sm" variant="outline" render={<a href={i.link} target="_blank" rel="noreferrer noopener" />} nativeButton={false}>
                  Diff
                </Button>
              ) : null}
            </div>
          </Row>
        )
      case "daily_update":
        return (
          <Row key={`u${i.daily_update}`} item={i} icon={<Glyph><CalendarClockIcon /></Glyph>} title={`Daily update for ${i.date} is ready to review`} meta={`${i.drafted_by_label}${when ? `, ${when}` : ""}`}>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{i.excerpt}</p>
            <div className="mt-2">
              <Go project={i.project} to={`/v3/daily-update/${i.date}`}>
                Review it
              </Go>
            </div>
          </Row>
        )
      case "question":
        return (
          <Row
            key={`q${i.message}`}
            item={i}
            icon={i.sender_kind === "agent" ? <ActorAvatar model={guessModel(i.sender_label)} name={i.sender_label} size="md" /> : <Glyph><HelpCircleIcon /></Glyph>}
            title={`${i.sender_label} asked you ${i.open.length > 1 ? `${i.open.length} questions` : "a question"}`}
            meta={when}
          >
            <p className="mt-1 line-clamp-2 text-sm">{i.snippet}</p>
            <div className="mt-2">
              <Go project={i.project} to={chatHref(i.channel, i.message)}>
                Answer in chat
              </Go>
            </div>
          </Row>
        )
      case "mention":
        return (
          <Row key={`m${i.message}`} item={i} icon={<Glyph><MessageSquareIcon /></Glyph>} title={`${i.sender_label} mentioned you`} meta={when}>
            <p className="mt-1 line-clamp-2 text-sm">{i.snippet}</p>
            <div className="mt-2">
              <Go project={i.project} to={chatHref(i.channel, i.message)} variant="outline">
                Open in chat
              </Go>
            </div>
          </Row>
        )
    }
  }

  return (
    <V3Shell
      title="Inbox"
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={!feed?.unread}
          onClick={() =>
            void markInboxRead()
              .then(() => load())
              .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't mark it read"))
          }
        >
          <CheckCheckIcon />
          Mark all read
        </Button>
      }
    >
      <div className="mx-auto max-w-3xl space-y-4">
        <p className="text-sm text-muted-foreground">
          What's waiting on you, across your projects: agents asking permission, questions and decisions for you, review requests, daily updates to approve, and mentions. Each one opens where you act on it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Show" className="inline-flex rounded-md border border-border p-0.5 text-sm">
            {TABS.map((t) => {
              const n = t.id === "needs_you" ? feed?.counts.needs_you : t.id === "mentions" ? feed?.counts.mentions : undefined
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn("inline-flex h-7 items-center gap-1.5 rounded px-2.5", tab === t.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {t.label}
                  {n ? <span className="text-xs tabular-nums">{n}</span> : null}
                </button>
              )
            })}
          </div>
          {projects.length > 1 ? (
            <Select
              items={{ all: "All projects", ...Object.fromEntries(projects.map((p) => [p.id, p.name])) }}
              value={project ? String(project) : "all"}
              onValueChange={(v) => setProject(!v || v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="ml-auto h-8 w-48" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!feed && !error ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading the inbox">
            {[0, 1, 2].map((k) => (
              <Skeleton key={k} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : null}
        {feed && feed.items.length === 0 ? (
          <Empty className="rounded-2xl border border-dashed py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>{tab === "needs_you" ? "Nothing needs you" : tab === "mentions" ? "No mentions" : "Nothing in the last two weeks"}</EmptyTitle>
              <EmptyDescription>Permission prompts, questions, rulings, review requests, daily updates and mentions land here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {feed?.items.length ? <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{feed.items.map(item)}</ul> : null}
      </div>
    </V3Shell>
  )
}
