import { Button } from "@/components/ui/button"
import { PageShell } from "@/components/layout"
import { MailIcon, PlugIcon, UserRoundPlusIcon, UsersIcon } from "lucide-react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { formatLiveDate } from "@/lib/live-mappers"
import { type AuthUser } from "@/lib/auth-api"
import { type InviteRecord, type Project } from "@/lib/workspace-view"
import { type TaskflowProjectInviteRole, type TaskflowProjectMember } from "@/api/client"
import { useState } from "react"

/// Who is in the project, and who has been asked in. Coding agents are not
/// here: they are linked, not invited (Connect agents).
export function InvitesPage({
  project,
  members,
  invites,
  currentUser,
  onInvite,
  onRevoke,
}: {
  project: Project
  members: TaskflowProjectMember[]
  invites: InviteRecord[]
  currentUser: AuthUser | null
  onInvite: () => void
  onRevoke: (inviteId: string) => Promise<void>
}) {
  const me = currentUser ? members.find((member) => member.user === currentUser.id) : undefined
  // The server is the authority (it refuses a revoke from anyone else); this
  // only decides whether to offer the buttons.
  const canManage = !!currentUser?.is_superuser || (me?.status === "active" && (me.role === "owner" || me.role === "admin"))

  const pending = invites.filter((invite) => invite.status === "Pending")
  const past = invites.filter((invite) => invite.status !== "Pending")
  const people = [...members].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.display_name.localeCompare(b.display_name),
  )

  return (
    <PageShell
      eyebrow={project.name}
      title="Members & invites"
      description="Everyone who can open this project, and the people you have invited."
      actions={
        canManage ? (
          <Button size="sm" onClick={onInvite}>
            <UserRoundPlusIcon />
            Invite someone
          </Button>
        ) : null
      }
    >
      <div className="space-y-3">
        {pending.length ? (
          <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
            <SectionHeader icon={<MailIcon className="size-4 text-primary" />} title="Pending invites" count={pending.length} />
            <ul className="divide-y">
              {pending.map((invite) => (
                <PendingInviteRow key={invite.id} invite={invite} canManage={canManage} onRevoke={onRevoke} />
              ))}
            </ul>
          </section>
        ) : null}

        <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <SectionHeader icon={<UsersIcon className="size-4 text-primary" />} title="Members" count={people.length} />
          {people.length ? (
            <ul className="divide-y">
              {people.map((member) => (
                <li key={member.id} className="flex items-center gap-3 px-4 py-3">
                  <Initials name={member.display_name} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {member.display_name}
                      {currentUser && member.user === currentUser.id ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">You</span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {member.email ?? "No email"}
                      {member.joined_at ? ` · joined ${formatLiveDate(member.joined_at, "")}` : ""}
                    </p>
                  </div>
                  {member.status !== "active" ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground capitalize">{member.status}</span>
                  ) : null}
                  <RoleChip role={member.role} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-6 text-center text-sm text-muted-foreground">No members yet.</p>
          )}
        </section>

        {!pending.length && canManage ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
            <span>No invites waiting. Invite a teammate by email — they accept after signing in.</span>
            <Button size="sm" variant="outline" onClick={onInvite}>
              <UserRoundPlusIcon />
              Invite someone
            </Button>
          </div>
        ) : null}

        {past.length ? (
          <details className="group overflow-hidden rounded-lg border bg-card shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold">
              Past invites
              <span className="text-xs font-normal text-muted-foreground">
                {past.length} · <span className="group-open:hidden">show</span>
                <span className="hidden group-open:inline">hide</span>
              </span>
            </summary>
            <ul className="divide-y border-t">
              {past.map((invite) => (
                <li key={invite.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{invite.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Sent by {invite.invitedBy} · {invite.sent}
                      {invite.status === "Accepted" && invite.acceptedAt ? ` · accepted ${invite.acceptedAt}` : ""}
                    </p>
                  </div>
                  <RoleChip role={invite.role} />
                  <span className={cn("w-20 rounded-full px-2 py-0.5 text-center text-xs font-semibold ring-1", STATUS_CLASS[invite.status])}>
                    {invite.status}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <PlugIcon className="size-3.5" />
          <span>
            Coding agents don't need an invite —{" "}
            <Link to="/dashboard/api" className="font-medium text-primary hover:underline">
              link them on Connect agents
            </Link>
            .
          </span>
        </p>
      </div>
    </PageShell>
  )
}

function PendingInviteRow({
  invite,
  canManage,
  onRevoke,
}: {
  invite: InviteRecord
  canManage: boolean
  onRevoke: (inviteId: string) => Promise<void>
}) {
  // Two-step revoke, as the task sheet's delete: the first click arms it.
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRevoke(invite.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the invite.")
      setArmed(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Initials name={invite.name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{invite.email}</p>
        <p className="truncate text-xs text-muted-foreground">
          Invited by {invite.invitedBy} · {invite.sent}
          {invite.timeLeft ? ` · ${invite.timeLeft}` : ""}
        </p>
        {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      </div>
      <RoleChip role={invite.role} />
      {canManage ? (
        armed ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="destructive" disabled={busy} onClick={revoke}>
              {busy ? "Revoking…" : "Revoke"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArmed(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setArmed(true)}>
            Revoke
          </Button>
        )
      ) : null}
    </li>
  )
}

function SectionHeader({ icon, title, count }: { icon: React.ReactNode; title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
      {icon}
      {title}
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{count}</span>
    </div>
  )
}

function Initials({ name }: { name: string }) {
  const initials =
    name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?"
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
      {initials}
    </span>
  )
}

const ROLE_ORDER: TaskflowProjectInviteRole[] = ["owner", "admin", "developer", "reviewer", "viewer"]

function RoleChip({ role }: { role: TaskflowProjectInviteRole }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize ring-1", ROLE_CLASS[role])}>{role}</span>
  )
}

const ROLE_CLASS: Record<TaskflowProjectInviteRole, string> = {
  owner: "bg-primary/10 text-primary ring-primary/20",
  admin: "bg-violet-100 text-violet-800 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30",
  developer: "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
  reviewer: "bg-sky-100 text-sky-800 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30",
  viewer: "bg-muted text-muted-foreground ring-border",
}

const STATUS_CLASS: Record<InviteRecord["status"], string> = {
  Pending: "bg-amber-100 text-amber-800 ring-amber-200",
  Accepted: "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
  Declined: "bg-muted text-muted-foreground ring-border",
  Expired: "bg-muted text-muted-foreground ring-border",
  Revoked: "bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30",
}
