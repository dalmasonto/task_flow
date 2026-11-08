/// The room's details, on the right of the conversation (design: chat.html,
/// #5918): about the room (editable by its creator or a project owner/admin),
/// who's live in it, its members, the tasks it talks about, and its files.
///
/// Editing, removing and archiving call the room endpoints from #5924. The
/// server decides who may do what; `roomPowers` only hides controls that
/// would be refused.
import { useState } from "react"
import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon, PlusIcon, UserMinusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowAgentChannel } from "@/api/client"
import { ChatFilesTab } from "@/components/chat/files-tab"
import { TerminalTranscript } from "@/components/chat/terminal"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import type { AgentMessage, AgentTerminalSessionView } from "@/lib/workspace-view"
import { addChannelAgent, removeChannelMember, setChannelArchived, updateChannel } from "@/lib/taskflow-api"
import { upsertById } from "@/lib/live-mappers"

import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { StatusChip, TaskStatusChip } from "../components/status-chip"
import type { TaskStatus } from "../lib/task-status"
import { TaskLink } from "../components/task-link"
import { timeAgo } from "../lib/time"
import { useWorkspace } from "../workspace"
import { roomFormError, type RoomMembers, type RoomPowers } from "./room-logic"

function Section({ title, count, children, action }: { title: string; count?: number; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">
          {title} {count != null ? <span className="font-normal text-muted-foreground">{count}</span> : null}
        </h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

function About({ channel, powers, onSaved }: { channel: TaskflowAgentChannel; powers: RoomPowers; onSaved: (c: TaskflowAgentChannel) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(channel.title)
  const [topic, setTopic] = useState(channel.topic ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const problem = roomFormError(powers.editTitle ? title : channel.title, topic)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const patch: { title?: string; topic?: string | null } = { topic: topic.trim() ? topic.trim() : null }
      if (powers.editTitle && title.trim() !== channel.title) patch.title = title.trim()
      onSaved(await updateChannel(channel.id, patch))
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the room.")
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <Section title="About">
        <div className="grid gap-3">
          {powers.editTitle ? (
            <Field data-invalid={error && /name/i.test(error) ? true : undefined}>
              <FieldLabel htmlFor="room-title">Name</FieldLabel>
              <Input id="room-title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor="room-topic">Topic</FieldLabel>
            <Textarea id="room-topic" value={topic} maxLength={280} rows={3} placeholder="What this room is for" onChange={(e) => setTopic(e.target.value)} />
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? <Spinner /> : null}
              Save
            </Button>
          </div>
        </div>
      </Section>
    )
  }

  return (
    <Section
      title="About"
      action={
        powers.edit ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit room details"
            onClick={() => {
              setTitle(channel.title)
              setTopic(channel.topic ?? "")
              setError(null)
              setEditing(true)
            }}
          >
            <PencilIcon />
          </Button>
        ) : null
      }
    >
      <p className="text-sm font-medium">{channel.title}</p>
      <p className="mt-1 text-sm whitespace-pre-line text-muted-foreground">{channel.topic?.trim() || (powers.edit ? "No topic yet. Add one so people and agents know what this room is for." : "No topic.")}</p>
      {channel.archived ? <p className="mt-2 text-xs font-medium text-muted-foreground">Archived: read-only.</p> : null}
    </Section>
  )
}

export function RoomPanel({
  channel,
  members,
  powers,
  meUser,
  linkedTasks,
  terminals,
  messages,
  addCandidates,
  agentCandidates,
  onAddMember,
  onJumpToMessage,
  onClose,
}: {
  channel: TaskflowAgentChannel
  members: RoomMembers
  powers: RoomPowers
  meUser: number | null
  linkedTasks: { id: number; title: string; status: TaskStatus }[]
  terminals: AgentTerminalSessionView[]
  messages: AgentMessage[]
  addCandidates: { user: number; name: string }[]
  /// Agents of the project not yet in the room (#5951).
  agentCandidates: { id: number; name: string }[]
  onAddMember: (user: number) => Promise<void>
  onJumpToMessage: (id: number) => boolean
  onClose?: () => void
}) {
  const { applyLiveUpdate, live } = useWorkspace()
  const now = useLivenessNow()
  const [busy, setBusy] = useState<string | null>(null)
  const total = members.agents.length + members.people.length
  const working = members.agents.filter((a) => a.working && a.online)
  const liveTerms = terminals.filter((t) => working.some((a) => a.id === t.agentId) && t.hasStream).slice(0, 2)

  const saved = (c: TaskflowAgentChannel) => applyLiveUpdate((w) => ({ ...w, agentChannels: upsertById(w.agentChannels, c) }))

  async function remove(memberId: number, name: string, self: boolean) {
    setBusy(`rm:${memberId}`)
    try {
      await removeChannelMember(channel.id, memberId)
      applyLiveUpdate((w) => ({ ...w, agentChannelMembers: w.agentChannelMembers.filter((m) => m.id !== memberId) }))
      toast.success(self ? `You left ${channel.title}` : `${name} was removed`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove them.")
    } finally {
      setBusy(null)
    }
  }

  async function addAgent(id: number, name: string) {
    try {
      const row = await addChannelAgent(channel.id, id)
      applyLiveUpdate((w) => ({ ...w, agentChannelMembers: upsertById(w.agentChannelMembers, row) }))
      toast.success(`${name} joined ${channel.title}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add the agent.")
    }
  }

  async function archive(next: boolean) {
    setBusy("archive")
    try {
      saved(await setChannelArchived(channel.id, next))
      toast.success(next ? "Room archived" : "Room unarchived")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change the room.")
    } finally {
      setBusy(null)
    }
  }

  const iAmIn = members.people.find((p) => p.user === meUser)

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      {onClose ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <span className="text-sm font-semibold">Room details</span>
          <Button variant="ghost" size="icon-sm" aria-label="Close room details" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <About key={`${channel.id}:${channel.title}:${channel.topic ?? ""}`} channel={channel} powers={powers} onSaved={saved} />

        {liveTerms.length ? (
          <Section title="Live in this room" action={<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-running" />{working.length} working</span>}>
            <div className="grid gap-2">
              {liveTerms.map((t) => (
                <div key={t.agentId} className="max-h-48 overflow-hidden rounded-lg">
                  <TerminalTranscript session={t} />
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        <Section title="Members" count={total}>
          {members.agents.length ? (
            <>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Agents</p>
              <ul className="mb-3 grid gap-0.5">
                {members.agents.map((a) => (
                  <li key={a.id} className="group flex items-center gap-2 rounded-md px-1 py-1">
                    <ActorAvatar model={guessModel(a.runtime) ?? guessModel(a.name)} name={a.name} status={a.online ? (a.working ? "running" : "idle") : "offline"} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                    {a.online && a.working ? (
                      <TaskLink task={a.working.id} className="shrink-0" title={`#${a.working.id} ${a.working.title}`}>
                        <StatusChip tone="running" label="Working" />
                      </TaskLink>
                    ) : a.online ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Online</span>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(a.lastSeen, now) ?? "Offline"}</span>
                    )}
                    {powers.removeMembers && a.memberId != null ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Remove ${a.name}`}
                        title={`Remove ${a.name}`}
                        disabled={busy === `rm:${a.memberId}`}
                        onClick={() => void remove(a.memberId!, a.name, false)}
                      >
                        <UserMinusIcon />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {members.people.length ? (
            <>
              <p className="mb-1 text-xs font-medium text-muted-foreground">People</p>
              <ul className="grid gap-0.5">
                {members.people.map((p) => {
                  const self = p.user === meUser
                  const canRemove = p.memberId != null && (self ? channel.kind !== "direct" && !channel.is_public : powers.removeMembers)
                  return (
                    <li key={p.user} className="group flex items-center gap-2 rounded-md px-1 py-1">
                      <ActorAvatar name={p.name} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {p.name}
                        {self ? <span className="text-muted-foreground"> (you)</span> : null}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground capitalize">{p.role ?? ""}</span>
                      {canRemove ? (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label={self ? "Leave this room" : `Remove ${p.name}`}
                          title={self ? "Leave this room" : `Remove ${p.name}`}
                          disabled={busy === `rm:${p.memberId}`}
                          onClick={() => void remove(p.memberId!, p.name, self)}
                        >
                          <UserMinusIcon />
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </>
          ) : null}
          {powers.addMembers ? (
            addCandidates.length || agentCandidates.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="mt-3 w-full" />}>
                  <PlusIcon />
                  Add a person or agent
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  {agentCandidates.length ? <DropdownMenuLabel>Agents</DropdownMenuLabel> : null}
                  {agentCandidates.map((a) => (
                    <DropdownMenuItem key={`a${a.id}`} onClick={() => void addAgent(a.id, a.name)}>
                      {a.name}
                    </DropdownMenuItem>
                  ))}
                  {addCandidates.length ? <DropdownMenuLabel>People</DropdownMenuLabel> : null}
                  {addCandidates.map((c) => (
                    <DropdownMenuItem key={`u${c.user}`} onClick={() => void onAddMember(c.user).catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't add them."))}>
                      {c.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">Everyone in the project is already here.</p>
            )
          ) : null}
          {iAmIn == null && !channel.is_public && channel.kind !== "direct" && live ? <p className="mt-3 text-xs text-muted-foreground">You can read this room as a project admin.</p> : null}
        </Section>

        {linkedTasks.length ? (
          <Section title="Linked tasks">
            <ul className="grid gap-1">
              {linkedTasks.map((t) => (
                <li key={t.id}>
                  <TaskLink task={t.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/60">
                    <TaskStatusChip status={t.status} />
                    <span className="min-w-0 truncate">
                      #{t.id} {t.title}
                    </span>
                  </TaskLink>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="Files">
          <ChatFilesTab channelId={channel.id} messages={messages} currentUserId={meUser} dense onJumpToMessage={onJumpToMessage} />
        </Section>

        {powers.archive ? (
          <section className="px-4 py-4">
            <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy === "archive"} onClick={() => void archive(!channel.archived)}>
              {channel.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {channel.archived ? "Unarchive this room" : "Archive this room"}
            </Button>
          </section>
        ) : null}
      </div>
    </div>
  )
}
