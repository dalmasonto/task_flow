/// Wake-ups (design: subscriptions.html): rules that wait for an event or a
/// time, then type a note into an agent's terminal or post in a room, so
/// agents stop polling (#TSK1113). Agents set them with create_trigger;
/// people can add, pause, resume and cancel them here.
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { AlarmClockIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, PlusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowWakeRuleDeliver, TaskflowWakeRuleStatus, TaskflowWakeRuleTriggerKind } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { StatusChip } from "../components/status-chip"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { parseTaskNumber } from "../tasks/task-logic"
import { useWorkspace } from "../workspace"
import { describeRule } from "./agents-logic"
import { useAgentSlices } from "./use-agent-slices"
import { actOnWakeRule, createWakeRule, listWakeRules, type WakeRule } from "./wake-api"

const STATUS: Record<TaskflowWakeRuleStatus, { tone: "running" | "done" | "blocked" | "paused" | "idle"; label: string }> = {
  armed: { tone: "running", label: "Armed" },
  fired: { tone: "done", label: "Fired" },
  missed: { tone: "blocked", label: "Missed" },
  paused: { tone: "paused", label: "Paused" },
  cancelled: { tone: "idle", label: "Cancelled" },
}
const TRIGGERS: Record<TaskflowWakeRuleTriggerKind, string> = {
  after_time: "After a delay",
  task_unblocked: "A task is unblocked",
  reply_to_message: "A reply to a message",
  message_in_room: "A message in a room",
}
const DELIVER: Record<TaskflowWakeRuleDeliver, string> = { pane: "Type into its terminal", room: "Post in the room", both: "Both" }

function NewRuleDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const { live } = useWorkspace()
  const agents = (live?.agents ?? []).filter((a) => a.status !== "revoked")
  const rooms = (live?.agentChannels ?? []).filter((c) => !c.archived && c.kind !== "direct")
  const [agent, setAgent] = useState<string>("")
  const [trigger, setTrigger] = useState<TaskflowWakeRuleTriggerKind>("after_time")
  const [deliver, setDeliver] = useState<TaskflowWakeRuleDeliver>("pane")
  const [room, setRoom] = useState<string>("")
  const [mentionsOnly, setMentionsOnly] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!live) return
    const f = new FormData(e.currentTarget)
    const note = String(f.get("note") ?? "").trim()
    const agentId = Number(agent || agents[0]?.id)
    if (!agentId) return setError("Pick an agent.")
    if (!note) return setError("Say what the note should tell the agent.")
    const input: Parameters<typeof createWakeRule>[1] = { agent: agentId, trigger, note, deliver }
    if (trigger === "after_time") {
      const mins = Number(f.get("minutes"))
      if (!(mins >= 1 && mins <= 7 * 24 * 60)) return setError("Between 1 minute and 7 days.")
      input.in_minutes = mins
    } else if (trigger === "task_unblocked") {
      const n = parseTaskNumber(String(f.get("task") ?? ""))
      if (n == null) return setError("Which task? Type its number, like #721.")
      input.task = n
    } else if (trigger === "reply_to_message") {
      const n = Number(String(f.get("message") ?? "").replace(/^#?msg/i, ""))
      if (!n) return setError("Which message? Type its number, like #MSG5700.")
      input.message = n
    } else {
      if (!room) return setError("Pick a room.")
      input.channel = Number(room)
      input.mentions_only = mentionsOnly
    }
    setPending(true)
    setError(null)
    try {
      await createWakeRule(live.project.id, input)
      toast.success("Wake-up armed")
      onCreated()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the wake-up.")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>New wake-up</DialogTitle>
            <DialogDescription>Wake an agent when something happens, instead of having it poll.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-4 gap-4">
            <Field>
              <FieldLabel>Agent</FieldLabel>
              <Select items={Object.fromEntries(agents.map((a) => [String(a.id), a.display_name]))} value={agent || (agents[0] ? String(agents[0].id) : "")} onValueChange={(v) => setAgent((v as string) ?? "")}>
                <SelectTrigger className="w-full" aria-label="Agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Wake it when</FieldLabel>
              <Select items={TRIGGERS} value={trigger} onValueChange={(v) => setTrigger((v ?? "after_time") as TaskflowWakeRuleTriggerKind)}>
                <SelectTrigger className="w-full" aria-label="Trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TRIGGERS) as TaskflowWakeRuleTriggerKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {TRIGGERS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {trigger === "after_time" ? (
              <Field>
                <FieldLabel htmlFor="w-min">In how many minutes</FieldLabel>
                <Input id="w-min" name="minutes" type="number" min={1} max={10080} defaultValue={5} />
              </Field>
            ) : trigger === "task_unblocked" ? (
              <Field>
                <FieldLabel htmlFor="w-task">Task</FieldLabel>
                <Input id="w-task" name="task" placeholder="#721" />
              </Field>
            ) : trigger === "reply_to_message" ? (
              <Field>
                <FieldLabel htmlFor="w-msg">Message</FieldLabel>
                <Input id="w-msg" name="message" placeholder="#MSG5700" />
              </Field>
            ) : (
              <>
                <Field>
                  <FieldLabel>Room</FieldLabel>
                  <Select items={Object.fromEntries(rooms.map((c) => [String(c.id), c.title]))} value={room} onValueChange={(v) => setRoom((v as string) ?? "")}>
                    <SelectTrigger className="w-full" aria-label="Room">
                      <SelectValue placeholder="Pick a room" />
                    </SelectTrigger>
                    <SelectContent>
                      {rooms.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={mentionsOnly} onChange={(e) => setMentionsOnly(e.target.checked)} />
                  Only when the agent is mentioned
                </label>
              </>
            )}
            <Field>
              <FieldLabel htmlFor="w-note">The note it gets</FieldLabel>
              <Textarea id="w-note" name="note" rows={2} placeholder="Check whether the renderer deploy finished." />
            </Field>
            <Field>
              <FieldLabel>Deliver by</FieldLabel>
              <Select items={DELIVER} value={deliver} onValueChange={(v) => setDeliver((v ?? "pane") as TaskflowWakeRuleDeliver)}>
                <SelectTrigger className="w-full" aria-label="Deliver by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(DELIVER) as TaskflowWakeRuleDeliver[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {DELIVER[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !agents.length}>
              {pending ? <Spinner /> : null}
              Arm it
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function WakeupsPage() {
  useAgentSlices()
  const { live } = useWorkspace()
  const now = useLivenessNow()
  const [rules, setRules] = useState<WakeRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agentFilter, setAgentFilter] = useState<number | null>(null)
  const [status, setStatus] = useState<TaskflowWakeRuleStatus | "any">("any")
  const [creating, setCreating] = useState(false)
  const projectId = live?.project.id ?? null

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (projectId == null) return Promise.resolve()
      return listWakeRules(projectId, signal)
        .then((r) => {
          setRules(r)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!signal?.aborted) setError(e instanceof Error ? e.message : "Couldn't load the wake-ups.")
        })
    },
    [projectId],
  )
  useEffect(() => {
    const ctl = new AbortController()
    void load(ctl.signal)
    const tick = window.setInterval(() => void load(), 30_000)
    return () => {
      ctl.abort()
      window.clearInterval(tick)
    }
  }, [load])

  const agents = live?.agents ?? []
  const agentOf = (id: number) => agents.find((a) => a.id === id)
  const channelName = (id: number) => live?.agentChannels.find((c) => c.id === id)?.title ?? `room ${id}`
  const shown = (rules ?? []).filter((r) => (agentFilter == null || r.agent === agentFilter) && (status === "any" || r.status === status))
  const withRules = [...new Set((rules ?? []).map((r) => r.agent))]

  const act = (r: WakeRule, action: "pause" | "resume" | "cancel") =>
    projectId != null &&
    void actOnWakeRule(projectId, r.id, action)
      .then(() => load())
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : `Couldn't ${action} it`))

  return (
    <V3Shell
      title="Wake-ups"
      actions={
        <Button size="sm" onClick={() => setCreating(true)} disabled={!live}>
          <PlusIcon />
          New rule
        </Button>
      }
    >
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Wake me when</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Agents stop polling. Each rule waits for an event or a time, then types a note into the agent&apos;s terminal or posts in a room. Agents set these with <code className="font-mono text-xs">create_trigger</code>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Filter by agent" className="flex flex-wrap gap-1">
            <button type="button" role="tab" aria-selected={agentFilter == null} onClick={() => setAgentFilter(null)} className={cn("h-7 rounded-md px-2.5 text-sm", agentFilter == null ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
              All agents <span className="text-xs tabular-nums">{rules?.length ?? 0}</span>
            </button>
            {withRules.map((id) => (
              <button key={id} type="button" role="tab" aria-selected={agentFilter === id} onClick={() => setAgentFilter(id)} className={cn("h-7 rounded-md px-2.5 text-sm", agentFilter === id ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
                {agentOf(id)?.display_name ?? `Agent ${id}`}
              </button>
            ))}
          </div>
          <Select items={{ any: "Any status", ...Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])) }} value={status} onValueChange={(v) => setStatus((v ?? "any") as TaskflowWakeRuleStatus | "any")}>
            <SelectTrigger className="ml-auto h-8 w-36" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any status</SelectItem>
              {(Object.keys(STATUS) as TaskflowWakeRuleStatus[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {STATUS[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {rules && !shown.length ? (
          <Empty className="rounded-2xl border border-dashed py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlarmClockIcon />
              </EmptyMedia>
              <EmptyTitle>No wake-ups{status !== "any" || agentFilter != null ? " match" : " yet"}</EmptyTitle>
              <EmptyDescription>An agent that starts a deploy or waits on a review can arm one instead of polling.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {shown.length ? (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {shown.map((r) => {
              const a = agentOf(r.agent)
              const name = a?.display_name ?? `Agent ${r.agent}`
              return (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                  <ActorAvatar model={guessModel(a?.runtime) ?? guessModel(name)} name={name} size="sm" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{describeRule(r, channelName)}</span>
                      <span className="text-muted-foreground">, {r.note}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {name} · {DELIVER[r.deliver].toLowerCase()} · set by {r.created_by_label}
                      {r.fired_at ? ` · fired ${timeAgo(r.fired_at, now)}` : ""}
                    </p>
                  </div>
                  <StatusChip tone={STATUS[r.status].tone} label={STATUS[r.status].label} />
                  {r.status === "armed" || r.status === "paused" || r.status === "missed" ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Rule actions" />}>
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {r.status === "armed" ? (
                          <DropdownMenuItem onClick={() => act(r, "pause")}>
                            <PauseIcon />
                            Pause
                          </DropdownMenuItem>
                        ) : null}
                        {r.status === "paused" ? (
                          <DropdownMenuItem onClick={() => act(r, "resume")}>
                            <PlayIcon />
                            Resume
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem variant="destructive" onClick={() => act(r, "cancel")}>
                          <XIcon />
                          Cancel
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <span className="size-7" aria-hidden />
                  )}
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
      <NewRuleDialog open={creating} onOpenChange={setCreating} onCreated={() => void load()} />
    </V3Shell>
  )
}
