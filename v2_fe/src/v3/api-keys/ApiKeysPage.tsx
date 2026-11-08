/// API keys (design: api-keys.html, +error): every agent's key and what it
/// may do. Owners and admins switch a capability off or on through
/// `PATCH agents/{id}/scopes`; it applies on the agent's next call, with no
/// new key. Everyone else sees the same list read-only.
///
/// Keys come from App's settings slice (this route's gate), and realtime
/// keeps them current: the PATCH emits a save per credential, so other tabs
/// follow. A save also applies the server's answer here at once.
///
/// Left out on purpose, until the backend has them:
/// * "Make a new key": a re-link mints a second key and leaves the old one
///   working, so offering it as rotation would be false. Needs an atomic
///   rotate route (asked of the backend owner).
/// * "Recent denials" and denial counts: denials aren't recorded anywhere.
/// Removing an agent (which stops its key at once) is the agent page's
/// delete, linked from each row.
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { KeyRoundIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowAgent, TaskflowAgentCredential } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { AGENT_CAPABILITIES } from "@/lib/agent-scopes"
import { setAgentScopes } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { keyScopes } from "../agents/agents-logic"
import { ActorAvatar } from "../components/actor-avatar"
import { guessModel } from "../components/actor-models"
import { myMembership } from "../invites/invites-logic"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { activeKey, applyScopes, CAPABILITY_TEXT, capabilitySummary, checkedFrom, sameChecks, sortAgents } from "./api-keys-logic"

function AgentKeyRow({ agent, keyRow, canManage, open, onToggle }: { agent: TaskflowAgent; keyRow: TaskflowAgentCredential | undefined; canManage: boolean; open: boolean; onToggle: () => void }) {
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
            {open ? "Close" : canManage ? "Manage" : "View"}
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
          <p className="text-xs text-muted-foreground">
            Lost the key, or need it stopped? A key is shown once, when it&apos;s made. Removing the agent on{" "}
            <Link to={`/v3/agents/${agent.id}`} className="underline underline-offset-4">
              its page
            </Link>{" "}
            stops the key at once; its tasks, messages and activity stay.
          </p>
        </div>
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
              <AgentKeyRow key={a.id} agent={a} keyRow={activeKey(a.id, credentials)} canManage={canManage} open={openId === a.id} onToggle={() => setOpenId((o) => (o === a.id ? null : a.id))} />
            ))}
          </ul>
        )}
      </div>
    </V3Shell>
  )
}
