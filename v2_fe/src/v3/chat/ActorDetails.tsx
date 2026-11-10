/// Who someone is, in the chat's right panel (chat.html): opened by clicking a
/// member in Room details or an @mention chip in a message. An agent shows its
/// model, liveness and what it's working on; a person their project role.
/// Both offer a direct message and their full page.
import { ArrowLeftIcon, BotIcon, MessageSquareIcon, UserIcon } from "lucide-react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { isAgentOnline } from "@/lib/live-mappers"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel, MODELS } from "../components/actor-models"
import { StatusChip } from "../components/status-chip"
import { TaskLink } from "../components/task-link"
import { timeAgo } from "../lib/time"
import { useWorkspace } from "../workspace"

export type Actor = { kind: "user" | "agent"; id: number }

export function ActorDetails({ actor, onBack, onMessage }: { actor: Actor; onBack: () => void; onMessage: (a: Actor) => void }) {
  const { live, projectTasks, currentUser } = useWorkspace()
  const now = useLivenessNow()

  const back = (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeftIcon />
        Room details
      </Button>
    </div>
  )

  if (actor.kind === "agent") {
    const a = live?.agents.find((x) => x.id === actor.id)
    if (!a) return <Missing back={back} what="This agent isn't in this project." />
    const model = guessModel(a.runtime) ?? guessModel(a.display_name)
    const online = isAgentOnline(a.id, live?.agents ?? [], live?.agentSessions ?? [], now)
    const working = projectTasks.find((t) => t.owner === a.display_name && t.liveStatus === "in_progress")
    return (
      <div className="flex h-full min-h-0 flex-col bg-sidebar">
        {back}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          <div className="flex items-center gap-3">
            <ActorAvatar model={model} name={a.display_name} status={online ? (working ? "running" : "idle") : "offline"} size="xl" />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{a.display_name}</p>
              <p className="text-sm text-muted-foreground">
                Agent{model ? `, ${MODELS[model].label}` : a.runtime ? `, ${a.runtime}` : ""}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid gap-3 text-sm">
            <Row label="Status">
              {online ? <StatusChip tone={working ? "running" : "idle"} label={working ? "Working" : "Online"} /> : <span className="text-muted-foreground">Offline{a.last_seen_at ? `, seen ${timeAgo(a.last_seen_at, now)}` : ""}</span>}
            </Row>
            {working ? (
              <Row label="Working on">
                <TaskLink task={Number(working.id)} className="text-link hover:underline">
                  #{working.id} {working.title}
                </TaskLink>
              </Row>
            ) : null}
            {a.linked_user_label ? <Row label="Linked by">{a.linked_user_label}</Row> : null}
            <Row label="Identity">
              <code className="font-mono text-xs break-all text-muted-foreground">{a.identifier}</code>
            </Row>
          </dl>
          <div className="mt-6 grid gap-2">
            <Button onClick={() => onMessage(actor)}>
              <MessageSquareIcon />
              Message {a.display_name}
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link to={`/v3/agents/${a.id}`} />}>
              <BotIcon />
              Open agent page
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const m = live?.members.find((x) => x.user === actor.id)
  if (!m) return <Missing back={back} what="This person isn't in this project." />
  const me = actor.id === currentUser?.id
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      {back}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="flex items-center gap-3">
          <ActorAvatar name={m.display_name} size="xl" />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">
              {m.display_name}
              {me ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
            </p>
            <p className="text-sm text-muted-foreground capitalize">{m.role}</p>
          </div>
        </div>
        <dl className="mt-5 grid gap-3 text-sm">
          <Row label="In this project">{m.status === "active" ? "Active member" : m.status}</Row>
        </dl>
        <div className="mt-6 grid gap-2">
          {me ? (
            <Button variant="outline" nativeButton={false} render={<Link to="/v3/account/profile" />}>
              <UserIcon />
              Your profile
            </Button>
          ) : (
            <Button onClick={() => onMessage(actor)}>
              <MessageSquareIcon />
              Message {m.display_name}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Missing({ back, what }: { back: React.ReactNode; what: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      {back}
      <p className="p-4 text-sm text-muted-foreground">{what}</p>
    </div>
  )
}
