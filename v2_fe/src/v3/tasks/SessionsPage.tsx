/// Work sessions (design: sessions.html): time spent on one task by a person
/// or an agent. Active and paused first, with their controls; then the recent
/// finished ones. The design's cost column waits for per-task usage rollups
/// (#TSK1130) rather than showing a guess.
import { Link } from "react-router-dom"
import { MoreHorizontalIcon, PauseIcon, PlayIcon, SquareIcon, TimerIcon } from "lucide-react"

import type { TaskflowTaskSession } from "@/api/client"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useLivenessNow } from "@/hooks/use-liveness-now"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { StatusChip } from "../components/status-chip"
import { formatDuration, timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { sessionElapsed, splitSessions } from "./session-logic"

const STATE_LABEL: Record<TaskflowTaskSession["state"], string> = { running: "Working", paused: "Paused", stopped: "Finished", failed: "Failed" }

export function SessionsPage() {
  const { live, projectTasks, task: tv } = useWorkspace()
  const now = useLivenessNow()
  const { active, history } = splitSessions(live?.taskSessions ?? [])
  const agents = live?.agents ?? []
  const taskFor = (id: number) => projectTasks.find((t) => t.id === String(id))
  const titleFor = (id: number) => taskFor(id)?.title ?? live?.tasks.find((t) => t.id === id)?.title ?? null
  const modelFor = (s: TaskflowTaskSession) =>
    s.actor_kind === "agent" ? (guessModel(agents.find((a) => a.id === s.actor_agent_id)?.runtime) ?? guessModel(s.actor_label)) : null

  return (
    <V3Shell title="Work sessions">
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Work sessions</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A session is time spent on one task by a person or an agent. Moving a task to In progress starts one; pausing, review, blocked or done ends it.
          </p>
        </div>

        <section aria-labelledby="active-h">
          <div className="mb-2 flex items-center gap-2">
            <h3 id="active-h" className="text-sm font-semibold">
              Active and paused
            </h3>
            <span className="text-xs tabular-nums text-muted-foreground">{active.length}</span>
          </div>
          {active.length ? (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {active.map((s) => {
                const task = taskFor(s.task)
                return (
                  <li key={s.id} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
                    <ActorAvatar model={modelFor(s)} name={s.actor_label} status={s.state === "running" ? "running" : "idle"} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{s.actor_label}</p>
                      <Link to={`/v3/tasks/${s.task}`} className="block truncate text-sm text-muted-foreground underline-offset-2 hover:underline">
                        #{s.task} {titleFor(s.task) ?? ""}
                      </Link>
                      <p className="mt-2 flex items-center gap-2 text-xs">
                        <StatusChip tone={s.state === "running" ? "running" : "paused"} label={STATE_LABEL[s.state]} />
                        <span className="tabular-nums text-muted-foreground">{formatDuration(sessionElapsed(s, now))}</span>
                      </p>
                    </div>
                    {task ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Session actions for ${s.actor_label}`} />}>
                          <MoreHorizontalIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          {s.state === "running" ? (
                            <DropdownMenuItem onClick={() => tv.sessions.pause(task)}>
                              <PauseIcon />
                              Pause
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => tv.sessions.start(task)}>
                              <PlayIcon />
                              Resume
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>End it and move the task to</DropdownMenuLabel>
                            <DropdownMenuItem onClick={() => tv.sessions.stop(task, "partial_done")}>
                              <SquareIcon />
                              In review
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => tv.sessions.stop(task, "done")}>
                              <SquareIcon />
                              Done
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => tv.sessions.stop(task, "blocked")}>
                              <SquareIcon />
                              Blocked
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <Empty className="rounded-xl border border-dashed py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <TimerIcon />
                </EmptyMedia>
                <EmptyTitle>Nobody's working on a task right now</EmptyTitle>
                <EmptyDescription>Sessions start when a task moves to In progress.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </section>

        <section aria-labelledby="recent-h">
          <h3 id="recent-h" className="mb-2 text-sm font-semibold">
            Recent
          </h3>
          {history.length ? (
            <div className="overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Who</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead className="hidden sm:table-cell">State</TableHead>
                    <TableHead className="hidden md:table-cell">Ended</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <ActorAvatar model={modelFor(s)} name={s.actor_label} size="xs" />
                          <span className="truncate">{s.actor_label}</span>
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[16rem]">
                        <Link to={`/v3/tasks/${s.task}`} className="block truncate underline-offset-2 hover:underline">
                          #{s.task} {titleFor(s.task) ?? ""}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <StatusChip tone={s.state === "failed" ? "failed" : "done"} label={STATE_LABEL[s.state]} />
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{timeAgo(s.ended_at ?? s.started_at, now)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatDuration(sessionElapsed(s, now))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No finished sessions in what's loaded.</p>
          )}
        </section>
      </div>
    </V3Shell>
  )
}
