/// Invites (design: invites.html): invite people to the project, see who's in
/// it, and the invites still waiting for an answer.
///
/// Members and invites are core workspace state (the sidebar's invite badge
/// needs them on every page), so this page reads them from App and realtime
/// keeps them current; a create or revoke also applies the server's row at
/// once. Invites: create and revoke. Members (#1136): owners and admins change
/// roles and remove people (anything touching an owner needs an owner; the
/// last owner stays), and anyone may leave. Removing someone also stops the
/// keys of agents they set up; the toast names them.
import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { LogOutIcon, MailIcon, RotateCcwIcon, SendIcon, UserMinusIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import type { TaskflowProjectInvite, TaskflowProjectInviteRole, TaskflowProjectMember } from "@/api/client"
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
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { createTaskflowProjectInvite, removeMember, revokeTaskflowProjectInvite, setMemberRole, type TaskflowWorkspace } from "@/lib/taskflow-api"

import { expiresLine } from "../account/account-logic"
import { ActorAvatar } from "../components/actor-avatar"
import { timeAgo } from "../lib/time"
import { V3Shell } from "../shell/V3Shell"
import { useWorkspace } from "../workspace"
import { assignableRoles, endedLine, invitableRoles, myMembership, parseEmails, removal, roleLabel, sortMembers, splitInvites } from "./invites-logic"

/// One member: their role (a picker when you may change it, #1136) and
/// Remove, or Leave on your own row. The server re-checks every rule.
function MemberRow({ m, me, projectId, ownerCount, isMe, username, now }: { m: TaskflowProjectMember; me: TaskflowProjectMember | undefined; projectId: number; ownerCount: number; isMe: boolean; username: string | null; now: number }) {
  const { applyLiveUpdate, refresh } = useWorkspace()
  const navigate = useNavigate()
  const roles = isMe ? [] : assignableRoles(me, m, ownerCount)
  const canRemove = removal(me, m, ownerCount)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const patchMember = (patch: Partial<TaskflowProjectMember>) => applyLiveUpdate((w) => ({ ...w, members: w.members.map((x) => (x.id === m.id ? { ...x, ...patch } : x)) }))

  async function changeRole(role: TaskflowProjectInviteRole) {
    if (role === m.role || m.user == null) return
    setBusy(true)
    try {
      const res = await setMemberRole(projectId, m.user, role)
      patchMember({ role: res.role })
      toast.success(`${m.display_name} is now ${roleLabel(res.role).toLowerCase()}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change the role.")
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (m.user == null) return
    setBusy(true)
    try {
      const res = await removeMember(projectId, m.user)
      const stopped = res.agents.length ? ` Agent keys they set up were stopped: ${res.agents.map((a) => a.display_name).join(", ")}.` : ""
      if (canRemove === "leave") {
        toast.success(`You left the project.${stopped}`)
        refresh()
        navigate("/v3/home", { replace: true })
        return
      }
      patchMember({ status: "left" })
      toast.success(`${m.display_name} was removed.${stopped}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <ActorAvatar name={m.display_name} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {m.display_name}
          {isMe ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {m.email ?? (isMe && username ? `@${username}` : null)}
          {m.status === "suspended" ? " · Suspended" : m.joined_at ? ` · Joined ${timeAgo(m.joined_at, now)}` : ""}
        </p>
      </div>
      {roles.length ? (
        <Select items={Object.fromEntries(roles.map((r) => [r, roleLabel(r)]))} value={m.role} onValueChange={(v) => v && changeRole(v as TaskflowProjectInviteRole)} disabled={busy}>
          <SelectTrigger className="h-8 w-32" aria-label={`Role for ${m.display_name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r} value={r}>
                {roleLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Badge variant={m.role === "owner" ? "default" : "secondary"}>{roleLabel(m.role)}</Badge>
      )}
      {canRemove ? (
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => setConfirm(true)} aria-label={canRemove === "leave" ? "Leave project" : `Remove ${m.display_name}`}>
          {busy ? <Spinner /> : canRemove === "leave" ? <LogOutIcon /> : <UserMinusIcon />}
          {canRemove === "leave" ? "Leave" : null}
        </Button>
      ) : null}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{canRemove === "leave" ? "Leave this project?" : `Remove ${m.display_name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {canRemove === "leave" ? "You lose access at once. " : `${m.display_name} loses access at once. `}
              Keys of agents {canRemove === "leave" ? "you" : "they"} set up here stop working; the agents and their history stay, and an owner or admin can make them new keys. Their tasks, messages and activity stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              {canRemove === "leave" ? "Leave project" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

function upsertInvite(row: TaskflowProjectInvite) {
  return (w: TaskflowWorkspace): TaskflowWorkspace => {
    const has = w.invites.some((i) => i.id === row.id)
    return { ...w, invites: has ? w.invites.map((i) => (i.id === row.id ? row : i)) : [row, ...w.invites] }
  }
}

function InviteForm({ projectId, projectName, roles, onCreated }: { projectId: number; projectName: string; roles: TaskflowProjectInviteRole[]; onCreated: (row: TaskflowProjectInvite) => void }) {
  const [text, setText] = useState("")
  const [role, setRole] = useState<TaskflowProjectInviteRole>(roles.includes("developer") ? "developer" : roles[roles.length - 1])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { valid, invalid } = parseEmails(text)

  async function send() {
    if (!valid.length || invalid.length) return
    setSending(true)
    setError(null)
    // One request per address; the ones that fail stay in the box so they
    // can be fixed and sent again.
    const failed: string[] = []
    let lastError: string | null = null
    for (const email of valid) {
      try {
        onCreated(await createTaskflowProjectInvite(projectId, { email, role }))
      } catch (e) {
        failed.push(email)
        lastError = e instanceof Error ? e.message : "Could not send the invite."
      }
    }
    setSending(false)
    const sent = valid.length - failed.length
    if (sent) toast.success(sent === 1 ? "Invite sent" : `${sent} invites sent`)
    setText(failed.join(", "))
    if (lastError) setError(failed.length === 1 ? lastError : `${failed.length} invites weren't sent. ${lastError}`)
  }

  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="text-base font-semibold">Invite people to {projectName}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        They&apos;ll see the board and rooms, and agents can mention them. To add an agent, use{" "}
        <Link to="/v3/agents/new" className="font-medium text-foreground underline-offset-4 hover:underline">
          New agent
        </Link>
        .
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_11rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="invite-emails">Email addresses</Label>
          <Textarea
            id="invite-emails"
            rows={2}
            value={text}
            placeholder="name@example.com, another@example.com"
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
            aria-invalid={invalid.length > 0 || undefined}
          />
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <Select items={Object.fromEntries(roles.map((r) => [r, roleLabel(r)]))} value={role} onValueChange={(v) => v && setRole(v as TaskflowProjectInviteRole)}>
            <SelectTrigger id="invite-role" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={send} disabled={sending || !valid.length || invalid.length > 0}>
          {sending ? <Spinner /> : <SendIcon />}
          {valid.length > 1 ? `Send ${valid.length} invites` : "Send invites"}
        </Button>
        {invalid.length ? (
          <p className="text-sm text-destructive">
            {invalid.length === 1 ? `"${invalid[0]}" isn't an email address.` : `${invalid.length} entries aren't email addresses.`}
          </p>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Invites last 14 days. They show up in the person&apos;s TaskFlow inbox when they sign in with that address.</p>
        )}
      </div>
    </section>
  )
}

export function InvitesPage() {
  const { live, activeProject, currentUser, applyLiveUpdate } = useWorkspace()
  const now = useLivenessNow()
  const [busy, setBusy] = useState<number | null>(null)
  const members = useMemo(() => live?.members ?? [], [live?.members])
  const invites = useMemo(() => live?.invites ?? [], [live?.invites])
  const me = myMembership(members, currentUser?.id)
  const ownerCount = members.filter((m) => m.status === "active" && m.role === "owner").length
  const roles = invitableRoles(me, !!currentUser?.is_superuser)
  const canManage = roles.length > 0
  const people = useMemo(() => sortMembers(members), [members])
  const { waiting, past } = useMemo(() => splitInvites(invites, members, now), [invites, members, now])
  const projectId = live?.project.id ?? null

  async function revoke(invite: TaskflowProjectInvite) {
    if (projectId == null) return
    setBusy(invite.id)
    try {
      applyLiveUpdate(upsertInvite(await revokeTaskflowProjectInvite(projectId, invite.id)))
      toast.success(`Invite to ${invite.email} cancelled`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not cancel the invite.")
    } finally {
      setBusy(null)
    }
  }

  async function sendAgain(invite: TaskflowProjectInvite) {
    if (projectId == null) return
    setBusy(invite.id)
    try {
      applyLiveUpdate(upsertInvite(await createTaskflowProjectInvite(projectId, { email: invite.email, role: invite.role, display_name: invite.display_name })))
      toast.success(`New invite sent to ${invite.email}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the invite.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <V3Shell title="Invites">
      <div className="mx-auto grid max-w-3xl gap-6">
        {!live ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading members…
          </div>
        ) : (
          <>
            {canManage && projectId != null ? (
              <InviteForm key={projectId} projectId={projectId} projectName={activeProject?.name ?? live.project.name} roles={roles} onCreated={(row) => applyLiveUpdate(upsertInvite(row))} />
            ) : (
              <p className="rounded-xl border bg-muted/40 p-4 text-sm text-muted-foreground">Only the project&apos;s owners and admins can invite people. Ask one of them below.</p>
            )}

            <section>
              <h2 className="mb-2 text-sm font-semibold">
                Members <span className="font-normal text-muted-foreground">{people.length}</span>
              </h2>
              <ul className="divide-y rounded-xl border bg-card">
                {people.map((m) => (
                  <MemberRow
                    key={m.id}
                    m={m}
                    me={me}
                    projectId={projectId!}
                    ownerCount={ownerCount}
                    isMe={m.user != null && m.user === currentUser?.id}
                    username={currentUser?.username ?? null}
                    now={now}
                  />
                ))}
              </ul>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold">
                Waiting to accept <span className="font-normal text-muted-foreground">{waiting.length}</span>
              </h2>
              {waiting.length ? (
                <ul className="divide-y rounded-xl border bg-card">
                  {waiting.map((inv) => (
                    <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <MailIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{inv.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {roleLabel(inv.role)}. Sent {timeAgo(inv.created_at, now) ?? "recently"}
                          {expiresLine(inv.expires_at, now) ? `, ${expiresLine(inv.expires_at, now)!.toLowerCase()}` : ""}
                        </p>
                      </div>
                      {canManage ? (
                        <Button size="sm" variant="ghost" onClick={() => revoke(inv)} disabled={busy === inv.id}>
                          {busy === inv.id ? <Spinner /> : <XIcon />}
                          Cancel invite
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No invites waiting. People you invite show here until they accept.</p>
              )}
            </section>

            {past.length ? (
              <section>
                <h2 className="mb-2 text-sm font-semibold">
                  Didn&apos;t join <span className="font-normal text-muted-foreground">{past.length}</span>
                </h2>
                <ul className="divide-y rounded-xl border bg-card">
                  {past.map((inv) => (
                    <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <MailIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-muted-foreground">{inv.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {roleLabel(inv.role)}. {endedLine(inv, now)}
                          {inv.created_at ? `, sent ${timeAgo(inv.created_at, now)?.toLowerCase()}` : ""}
                        </p>
                      </div>
                      {canManage && roles.includes(inv.role) ? (
                        <Button size="sm" variant="outline" onClick={() => sendAgain(inv)} disabled={busy === inv.id}>
                          {busy === inv.id ? <Spinner /> : <RotateCcwIcon />}
                          Send again
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </V3Shell>
  )
}
