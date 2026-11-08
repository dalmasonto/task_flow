/// The agents in this project (design: agents.html, agents--empty,
/// agents--loading). Live agents get a card with their terminal's latest
/// lines and the task they're on; the rest are a compact list. The design's
/// "pairs working together" needs a pairing signal the data doesn't have yet,
/// so it's left out rather than guessed.
import { useState } from "react"
import { Link } from "react-router-dom"
import { AlarmClockIcon, BotIcon, CircleDotIcon, MessageSquareIcon, PlusIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react"

import { TerminalTranscript } from "@/components/chat/terminal"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { mapLiveTerminalSessions } from "@/lib/live-mappers"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { StatusChip } from "../components/status-chip"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { useDetail } from "../lib/use-detail"
import { agentRows, countByState, type AgentRow, type AgentState } from "./agents-logic"
import { useAgentSlices } from "./use-agent-slices"
import { TaskLink } from "../components/task-link"

const TABS: { id: AgentState | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "idle", label: "Idle" },
  { id: "offline", label: "Offline" },
]

const STATE_CHIP: Record<AgentState, { tone: "running" | "idle" | "paused"; label: string }> = {
  live: { tone: "running", label: "Working" },
  idle: { tone: "idle", label: "Idle" },
  offline: { tone: "paused", label: "Offline" },
}

export function AddAgentButton() {
  return (
    <Button size="sm" render={<Link to="/v3/agents/new" />} nativeButton={false}>
      <PlusIcon />
      Add agent
    </Button>
  )
}

/// Message the agent, or open its live terminal in the right-hand sheet
/// (#5907 item 14) without leaving the list.
function Actions({ row, labelled = false }: { row: AgentRow; labelled?: boolean }) {
  const detail = useDetail()
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant={labelled ? "outline" : "ghost"} size={labelled ? "sm" : "icon-sm"} aria-label={`Message ${row.name}`} render={<Link to={`/v3/chat?agent=${row.id}`} />} nativeButton={false}>
        <MessageSquareIcon />
        {labelled ? <span className="hidden sm:inline">Message</span> : null}
      </Button>
      <Button variant={labelled ? "outline" : "ghost"} size={labelled ? "sm" : "icon-sm"} aria-label={`Open ${row.name}'s terminal`} render={<Link to={detail.href({ kind: "terminal", agent: row.id })} />} nativeButton={false}>
        <TerminalIcon />
        {labelled ? <span className="hidden sm:inline">Terminal</span> : null}
      </Button>
    </div>
  )
}

export function AgentsPage() {
  useAgentSlices()
  const { live, isSyncing, activeProject } = useWorkspace()
  const now = useLivenessNow()
  const [tab, setTab] = useState<AgentState | "all">("all")
  const rows = live ? agentRows(live.agents, live.agentSessions, live.tasks, now) : []
  const counts = countByState(rows)
  const shown = rows.filter((r) => tab === "all" || r.state === tab)
  const terminals = live ? mapLiveTerminalSessions(live, now) : []
  const terminalOf = (id: number) => terminals.find((t) => t.agentId === id && t.hasStream)

  let body
  if (!live && isSyncing) {
    body = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-busy="true" aria-label="Loading agents">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-56 rounded-xl" />
        ))}
      </div>
    )
  } else if (!rows.length) {
    body = (
      <Empty className="mx-auto mt-8 max-w-lg rounded-2xl border border-dashed p-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>No agents in {activeProject?.name ?? "this project"} yet</EmptyTitle>
          <EmptyDescription>Add an agent, copy its key into the repo, and start it. It shows up here the moment it connects.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <AddAgentButton />
        </EmptyContent>
      </Empty>
    )
  } else {
    const working = shown.filter((r) => r.state === "live")
    const rest = shown.filter((r) => r.state !== "live")
    body = (
      <div className="space-y-6">
        {working.length ? (
          <section aria-labelledby="live-h">
            <h2 id="live-h" className="mb-2 text-sm font-semibold">
              Live now
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {working.map((r) => {
                const term = terminalOf(r.id)
                return (
                  <article key={r.id} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
                    <div className="flex items-start gap-3 p-4">
                      <ActorAvatar model={r.model} name={r.name} status="running" size="lg" />
                      <div className="min-w-0 flex-1">
                        <Link to={`/v3/agents/${r.id}`} className="block truncate font-medium underline-offset-2 hover:underline">
                          {r.name}
                        </Link>
                        <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <StatusChip tone="running" label="Working" />
                          <span className="truncate">seen {timeAgo(r.lastSeen, now) ?? "—"}</span>
                        </p>
                      </div>
                    </div>
                    {term ? (
                      <div className="max-h-40 overflow-hidden border-y border-border bg-muted/30 text-xs [&_pre]:text-[11px]">
                        <TerminalTranscript session={term} />
                      </div>
                    ) : null}
                    <div className="mt-auto flex items-center gap-2 px-4 py-2.5">
                      {r.task ? (
                        <TaskLink task={r.task.id} className="flex min-w-0 flex-1 items-center gap-2 text-sm hover:underline">
                          <CircleDotIcon className="size-3.5 shrink-0 text-running" aria-hidden />
                          <span className="truncate">
                            <span className="font-mono text-xs text-muted-foreground">#{r.task.id}</span> {r.task.title}
                          </span>
                        </TaskLink>
                      ) : (
                        <span className="flex-1 text-sm text-muted-foreground">Not on a task</span>
                      )}
                      <Actions row={r} labelled />
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ) : null}
        {rest.length ? (
          <section aria-labelledby="others-h">
            <h2 id="others-h" className="mb-2 text-sm font-semibold">
              {working.length ? "Everyone else" : "Agents"}
            </h2>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {rest.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <ActorAvatar model={r.model} name={r.name} status={r.state === "idle" ? "idle" : "offline"} size="md" />
                  <div className="min-w-0 flex-1">
                    <Link to={`/v3/agents/${r.id}`} className="block truncate text-sm font-medium underline-offset-2 hover:underline">
                      {r.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.state === "idle" ? "Online, not on a task" : r.lastSeen ? `Last seen ${timeAgo(r.lastSeen, now)}` : "Never connected"}
                    </p>
                  </div>
                  <StatusChip tone={STATE_CHIP[r.state].tone} label={STATE_CHIP[r.state].label} className="hidden sm:inline-flex" />
                  <Actions row={r} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {!shown.length ? <p className="text-sm text-muted-foreground">No {tab} agents right now.</p> : null}
        <Link
          to="/v3/agents/new"
          className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:border-ring hover:text-foreground"
        >
          <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted">
            <PlusIcon className="size-4" />
          </span>
          <span>
            <span className="block font-medium text-foreground">Add an agent</span>
            <span className="block text-xs">Claude, Codex, Gemini, DeepSeek or any MCP client. It gets its own key and joins the board and rooms.</span>
          </span>
        </Link>
      </div>
    )
  }

  return (
    <V3Shell
      title="Agents"
      actions={
        <>
          <Button variant="ghost" size="sm" render={<Link to="/v3/agents/wakeups" />} nativeButton={false} className="hidden md:inline-flex">
            <AlarmClockIcon />
            Wake-ups
          </Button>
          <Button variant="outline" size="sm" render={<Link to="/v3/agents/launch" />} nativeButton={false} className="hidden sm:inline-flex">
            <SquareTerminalIcon />
            Launch in tmux
          </Button>
          <AddAgentButton />
        </>
      }
    >
      <div className="mx-auto max-w-5xl space-y-5">
        {rows.length ? (
          <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label="Filter agents" className="inline-flex rounded-md border border-border p-0.5 text-sm">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn("inline-flex h-7 items-center gap-1.5 rounded px-2", tab === t.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {t.label}
                  <span className="text-xs tabular-nums text-muted-foreground">{counts[t.id]}</span>
                </button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {counts.live + counts.idle ? `${counts.live + counts.idle} of ${counts.all} online.` : "Nobody's online right now."}{" "}
              <Link to="/v3/agents/launch" className="underline underline-offset-2 hover:text-foreground">
                How to start one
              </Link>
            </p>
          </div>
        ) : null}
        {body}
      </div>
    </V3Shell>
  )
}
