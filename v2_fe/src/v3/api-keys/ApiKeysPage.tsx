/// API keys (design: api-keys.html, +error): every agent's key and what it
/// may do. Owners and admins switch a capability off or on through
/// `PATCH agents/{id}/scopes`; it applies on the agent's next call, with no
/// new key. Everyone else sees the same list read-only.
///
/// Keys come from App's settings slice (this route's gate), and realtime
/// keeps them current: the PATCH emits a save per credential, so other tabs
/// follow. A save also applies the server's answer here at once.
///
/// Keys (#1136): "Make a new key" rotates (old keys stop, the new one keeps
/// the capabilities, the raw key is shown once in RotateKeyDialog) and
/// "Revoke key" stops the key without deleting the agent. Both are for an
/// owner/admin or the human who linked the agent (`mayManageKeys`), which can
/// be wider than who may change capabilities (owner/admin only).
///
/// Left out until the backend has it: "Recent denials" and denial counts;
/// denials aren't recorded anywhere.
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { BanIcon, KeyRoundIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowAgent, TaskflowAgentCredential } from "@/api/client"
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { AGENT_CAPABILITIES } from "@/lib/agent-scopes"
import { revokeAgentKey, setAgentScopes } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { keyScopes } from "../agents/agents-logic"
import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { myMembership } from "../invites/invites-logic"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { activeKey, applyRevoke, applyScopes, CAPABILITY_TEXT, capabilitySummary, checkedFrom, mayManageKeys, sameChecks, sortAgents } from "./api-keys-logic"
import { RotateKeyDialog } from "./RotateKeyDialog"

function AgentKeyRow({ agent, keyRow, canManage, canKeys, open, onToggle }: { agent: TaskflowAgent; keyRow: TaskflowAgentCredential | undefined; canManage: boolean; canKeys: boolean; open: boolean; onToggle: () => void }) {
  const [rotateOpen, setRotateOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const { applyLiveUpdate } = useWorkspace()
  const now = useLivenessNow()
  const saved = useMemo(() => checkedFrom(keyRow), [keyRow])
  // Edits are kept against the saved state they started from, so a realtime
  // change to the key underneath resets an untouched form rather than
  // showing stale switches.
  const [draft, setDraft] = useState<{ base: Record<string, boolean>; checks: Record<string, boolean> } | null>(null)
  const checks = draft && draft.base === saved ? draft.checks : saved
  const dirty = !sameChecks(checks, saved)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const res = await setAgentScopes(agent.id, keyScopes(checks))
      applyLiveUpdate((w) => ({ ...w, agentCredentials: applyScopes(w.agentCredentials, res) }))
      setDraft(null)
      toast.success(`${agent.display_name}'s capabilities saved`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the capabilities.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <ActorAvatar model={guessModel(agent.display_name)} name={agent.display_name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            <Link to={`/v3/agents/${agent.id}`} className="underline-offset-4 hover:underline">
              {agent.display_name}
            </Link>
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {keyRow ? (
              <>
                <span>
                  {keyRow.name} <code className="font-mono">{keyRow.key_prefix}…</code>
                </span>
                <span>{capabilitySummary(saved)}</span>
              </>
            ) : (
              <span className="text-destructive">No working key</span>
            )}
          </p>
        </div>
        {keyRow ? (
          <Button size="sm" variant="outline" onClick={onToggle} aria-expanded={open}>
            {open ? "Close" : canManage || canKeys ? "Manage" : "View"}
          </Button>
        ) : canKeys ? (
          <Button size="sm" variant="outline" onClick={() => setRotateOpen(true)}>
            <KeyRoundIcon />
            Make a key
          </Button>
        ) : null}
      </div>

      {open && keyRow ? (
        <div className="mt-4 grid gap-4 rounded-xl border bg-muted/30 p-4">
          <ul className="grid gap-3">
            {AGENT_CAPABILITIES.map((c) => {
              const text = CAPABILITY_TEXT[c.id] ?? { label: c.label, note: c.description }
              const on = !!checks[c.id]
              const id = `cap-${agent.id}-${c.id}`
              return (
                <li key={c.id} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <label htmlFor={id} className={cn("text-sm font-medium", !on && "text-muted-foreground")}>
                      {text.label}
                      {!on ? (
                        <Badge variant="outline" className="ml-2">
                          {c.defaultOn ? "Off" : "Off by default"}
                        </Badge>
                      ) : null}
                    </label>
                    <p className="text-xs text-muted-foreground">
                      <code className="font-mono">{c.id}</code>. {text.note}
                    </p>
                  </div>
                  <Switch id={id} checked={on} disabled={!canManage || saving} onCheckedChange={(v) => setDraft({ base: saved, checks: { ...checks, [c.id]: !!v } })} />
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <p className="flex-1 text-xs text-muted-foreground">
              {canManage ? "Changes apply on the agent's next call. No new key needed." : "Only the project's owners and admins can change these."}
              {keyRow.created_at ? ` Key made ${timeAgo(keyRow.created_at, now)?.toLowerCase()}.` : ""}
            </p>
            {canManage ? (
              <>
                <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(null)}>
                  Reset
                </Button>
                <Button size="sm" disabled={!dirty || saving} onClick={save}>
                  {saving ? <Spinner /> : null}
                  Save
                </Button>
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <p className="flex-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Key.</span> A new key stops the old one at once. The agent needs the new key in .taskflow.json.
              {!canKeys ? " Only owners and admins, or the person who added this agent, can change its key." : ""}
            </p>
            {canKeys ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setRotateOpen(true)}>
                  <KeyRoundIcon />
                  Make a new key
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setRevokeOpen(true)}>
                  <BanIcon />
                  Revoke key
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <RotateKeyDialog agent={agent} open={rotateOpen} onOpenChange={setRotateOpen} />
      {keyRow ? (
        <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {agent.display_name}&apos;s key?</AlertDialogTitle>
              <AlertDialogDescription>
                {agent.display_name} disconnects immediately and can&apos;t reconnect until you make it a new key. Its tasks, messages and activity stay.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep the key</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={async () => {
                  try {
                    const res = await revokeAgentKey(agent.id, keyRow.id)
                    applyLiveUpdate((w) => ({ ...w, agentCredentials: applyRevoke(w.agentCredentials, keyRow.id, res.credential.revoked_at) }))
                    toast.success(`${agent.display_name}'s key revoked`)
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Couldn't revoke the key.")
                  }
                }}
              >
                Revoke key
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </li>
  )
}

export function ApiKeysPage() {
  const { live, currentUser } = useWorkspace()
  const [openId, setOpenId] = useState<number | null>(null)
  const agents = useMemo(() => live?.agents ?? [], [live?.agents])
  const credentials = useMemo(() => live?.agentCredentials ?? [], [live?.agentCredentials])
  // The PATCH checks membership, not superuser, so only a member owner/admin
  // gets the switches.
  const me = myMembership(live?.members ?? [], currentUser?.id)
  const canManage = me?.role === "owner" || me?.role === "admin"
  const sorted = useMemo(() => sortAgents(agents, credentials), [agents, credentials])
  // Every linked agent has at least one key row (removing an agent removes
  // its keys), so agents with no key rows at all means the settings slice
  // hasn't landed yet, not that every key is gone.
  const keysPending = !live || (agents.length > 0 && credentials.length === 0)

  return (
    <V3Shell
      title="API keys"
      actions={
        <Button size="sm" nativeButton={false} render={<Link to="/v3/agents/new" />}>
          <PlusIcon />
          Add agent
        </Button>
      }
    >
      <div className="mx-auto grid max-w-3xl gap-4">
        <p className="text-sm text-muted-foreground">
          Every agent has one key and a set of capabilities. Switch one off and the agent gets <code className="rounded bg-muted px-1 font-mono text-xs">403 capability_denied</code> when it tries.
        </p>
        {keysPending ? (
          <div className="grid gap-2" aria-label="Loading the agent keys">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : !sorted.length ? (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>No agents yet</EmptyTitle>
              <EmptyDescription>Add an agent to get its key. The key is shown once, when it&apos;s made.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to="/v3/agents/new" />}>
                Add agent
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {sorted.map((a) => (
              <AgentKeyRow
                key={a.id}
                agent={a}
                keyRow={activeKey(a.id, credentials)}
                canManage={canManage}
                canKeys={mayManageKeys(a, me, !!currentUser?.is_superuser)}
                open={openId === a.id}
                onToggle={() => setOpenId((o) => (o === a.id ? null : a.id))}
              />
            ))}
          </ul>
        )}
      </div>
    </V3Shell>
  )
}
