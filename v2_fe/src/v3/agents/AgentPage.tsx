/// One agent (design: agent-claude-main.html, agent-terminal.html): status,
/// the task it's on, its live terminal (with keys you can send), its role
/// instructions, its sessions and keys, and delete.
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { CircleDotIcon, KeyRoundIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { TerminalKeypad, TerminalTranscript, TerminalWatchOnly } from "@/components/chat/terminal"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { agentInstructionsOf, patchAgentInstructions } from "@/lib/agent-instructions"
import { isSessionLive, mapLiveTerminalSessions } from "@/lib/live-mappers"
import { deleteAgent, setAgentInstructions } from "@/lib/taskflow-api"

import { ActorAvatar } from "../components/actor-avatar"
import { StatusChip } from "../components/status-chip"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { Section } from "../tasks/TaskSections"
import { mayManageKeys } from "../api-keys/api-keys-logic"
import { RotateKeyDialog } from "../api-keys/RotateKeyDialog"
import { myMembership } from "../invites/invites-logic"
import { useWorkspace } from "../workspace"
import { agentRows } from "./agents-logic"
import { useAgentSlices } from "./use-agent-slices"

export function AgentPage() {
  useAgentSlices()
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const { live, applyLiveUpdate, isSyncing, currentUser } = useWorkspace()
  const [rotateOpen, setRotateOpen] = useState(false)
  const now = useLivenessNow()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const agentId = Number(id)
  const agent = live?.agents.find((a) => a.id === agentId)
  const row = live ? agentRows(live.agents, live.agentSessions, live.tasks, now).find((r) => r.id === agentId) : undefined

  if (!agent || !row) {
    return (
      <V3Shell title="Agent">
        {isSyncing || !live ? (
          <Spinner className="mx-auto mt-16" />
        ) : (
          <Empty className="mx-auto mt-16 max-w-md rounded-2xl border border-dashed">
            <EmptyHeader>
              <EmptyTitle>This agent isn't in the project</EmptyTitle>
              <EmptyDescription>It may have been deleted, or it belongs to another project.</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" render={<Link to="/v3/agents" />} nativeButton={false}>
              All agents
            </Button>
          </Empty>
        )}
      </V3Shell>
    )
  }

  const term = live ? mapLiveTerminalSessions(live, now).find((t) => t.agentId === agentId && t.hasStream) ?? mapLiveTerminalSessions(live, now).find((t) => t.agentId === agentId) : undefined
  const sessions = (live?.agentSessions ?? []).filter((s) => s.agent === agentId).sort((a, b) => (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""))
  const keys = (live?.agentCredentials ?? []).filter((c) => c.agent === agentId)
  const instructions = agentInstructionsOf(agent)

  const saveInstructions = async () => {
    setSaving(true)
    try {
      const block = await setAgentInstructions(agentId, draft.trim() || null)
      applyLiveUpdate((w) => ({ ...w, agents: patchAgentInstructions(w.agents, agentId, block) }))
      setEditing(false)
      toast.success("Instructions saved", { description: `${agent.display_name} reads them on its next whoami.` })
    } catch (e) {
      toast.error("Couldn't save the instructions", { description: e instanceof Error ? e.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <V3Shell
      title={agent.display_name}
      actions={
        <>
          <Button variant="outline" size="sm" render={<Link to={`/v3/chat?agent=${agentId}`} />} nativeButton={false}>
            <MessageSquareIcon />
            <span className="hidden sm:inline">Message</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More agent actions" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon />
                Delete agent
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-4">
            <ActorAvatar model={row.model} name={row.name} status={row.state === "live" ? "running" : row.state === "idle" ? "idle" : "offline"} size="xl" />
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold tracking-tight">{agent.display_name}</h2>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <StatusChip tone={row.state === "live" ? "running" : row.state === "idle" ? "idle" : "paused"} label={row.state === "live" ? "Working" : row.state === "idle" ? "Online, idle" : "Offline"} />
                {agent.runtime ? <span>{agent.runtime}</span> : null}
                <span>{row.lastSeen ? `seen ${timeAgo(row.lastSeen, now)}` : "never connected"}</span>
              </p>
            </div>
          </div>

          {row.task ? (
            <Link to={`/v3/tasks/${row.task.id}`} className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm hover:border-ring">
              <CircleDotIcon className="size-4 shrink-0 text-running" aria-hidden />
              <span className="truncate">
                Working on <span className="font-mono text-xs text-muted-foreground">#{row.task.id}</span> {row.task.title}
              </span>
            </Link>
          ) : null}

          <Section title="Terminal" action={term ? <Badge variant="outline">{term.connected ? "Connected" : "Not connected"}</Badge> : null}>
            {term ? (
              <div className="space-y-3">
                <div className="max-h-[28rem] overflow-hidden rounded-lg border border-border bg-muted/30">
                  <TerminalTranscript session={term} />
                </div>
                {mayManageKeys(agent, myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser) ? <TerminalKeypad agentId={agentId} disabled={!term.connected} /> : <TerminalWatchOnly />}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No terminal mirror yet. It appears when the agent runs inside tmux with TaskFlow connected.</p>
            )}
          </Section>

          <Section
            title="Role instructions"
            action={
              editing ? null : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Edit instructions"
                  onClick={() => {
                    setDraft(instructions.markdown ?? "")
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
                <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={8} autoFocus className="font-mono text-sm" aria-label="Role instructions (markdown)" />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void saveInstructions()} disabled={saving}>
                    {saving ? <Spinner /> : null}
                    Save
                  </Button>
                </div>
              </div>
            ) : instructions.markdown ? (
              <>
                <MarkdownRenderer content={instructions.markdown} className="text-sm" />
                {instructions.updated_at ? <p className="mt-2 text-xs text-muted-foreground">Updated {timeAgo(instructions.updated_at, now)}</p> : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">None. The agent follows the project instructions and TaskFlow's defaults.</p>
            )}
          </Section>
        </div>

        <aside className="min-w-0 space-y-4">
          <Section title="Sessions" count={sessions.length}>
            {sessions.length ? (
              <ul className="space-y-2 text-sm">
                {sessions.slice(0, 8).map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className={isSessionLive(s, now) ? "size-2 rounded-full bg-running" : "size-2 rounded-full bg-muted-foreground/40"} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.session_identifier ?? `#${s.id}`}</span>
                    <span className="text-xs text-muted-foreground">{timeAgo(s.last_seen_at, now) ?? "—"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Never connected.</p>
            )}
          </Section>
          <Section title="Keys" count={keys.length}>
            {keys.length ? (
              <ul className="space-y-2 text-sm">
                {keys.map((k) => (
                  <li key={k.id} className="flex items-center gap-2">
                    <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{k.key_prefix}…</span>
                    <Badge variant={k.status === "active" ? "secondary" : "outline"}>{k.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No keys.</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">A key is shown once, when it&apos;s made. Lost it? Make a new key; the old one stops at once.</p>
            {mayManageKeys(agent, myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser) ? (
              <>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => setRotateOpen(true)}>
                  <KeyRoundIcon />
                  Make a new key
                </Button>
                <RotateKeyDialog agent={agent} open={rotateOpen} onOpenChange={setRotateOpen} />
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Owners and admins, or the person who added it, can make it a new key.</p>
            )}
          </Section>
        </aside>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agent.display_name}?</AlertDialogTitle>
            <AlertDialogDescription>Its keys stop working at once and it leaves every room. Tasks it worked on keep their history. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                deleteAgent(agentId)
                  .then(() => {
                    applyLiveUpdate((w) => ({ ...w, agents: w.agents.filter((a) => a.id !== agentId) }))
                    toast.success(`${agent.display_name} deleted`)
                    navigate("/v3/agents", { replace: true })
                  })
                  .catch((e: unknown) => toast.error("Couldn't delete the agent", { description: e instanceof Error ? e.message : undefined }))
              }}
            >
              Delete agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </V3Shell>
  )
}
