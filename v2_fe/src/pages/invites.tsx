import { Button } from "@/components/ui/button"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { PageShell } from "@/components/layout"
import { UserRoundPlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { type InviteRecord, type Project } from "@/lib/workspace-view"


export function InvitesPage({ project, invites, onInvite }: { project: Project; invites: InviteRecord[]; onInvite: () => void }) {
  const pendingCount = invites.filter((invite) => invite.status === "Pending" || invite.status === "Needs auth").length
  const acceptedCount = invites.filter((invite) => invite.status === "Accepted").length
  const agentInviteCount = invites.filter((invite) => invite.type === "Agent").length
  const expiringCount = invites.filter((invite) => invite.expires.includes("left")).length

  return (
    <PageShell
      eyebrow="Access"
      title="Invites"
      description="Invite humans and agents into project channels, reviews, API scopes, and activity history with explicit access."
      actions={
        <Button size="sm" onClick={onInvite}>
          <UserRoundPlusIcon />
          New Invite
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AccessMetric label="Pending" value={String(pendingCount)} detail="Awaiting acceptance or auth" />
        <AccessMetric label="Accepted" value={String(acceptedCount)} detail="Active project members" />
        <AccessMetric label="Agent invites" value={String(agentInviteCount)} detail={`${project.agentsOnline} agents online`} />
        <AccessMetric label="Expiring" value={String(expiringCount)} detail="Links with time remaining" />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Invite Requests</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {invites.length} access requests for {project.name}.
              </p>
            </div>
            <Button size="sm" onClick={onInvite}>
              <UserRoundPlusIcon />
              Invite
            </Button>
          </div>
          <div className="scrollbar-y overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-sm">
              <thead className="bg-muted/55 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Recipient</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Role</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Scope</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Lifecycle</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.id} className="border-t">
                    <td className="px-4 py-3 align-top">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
                          {invite.type === "Agent" ? "AI" : invite.recipient.slice(0, 2).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{invite.recipient}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{invite.type} · requested by {invite.requestedBy}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", inviteRoleClass(invite.role))}>
                        {invite.role}
                      </span>
                    </td>
                    <td className="max-w-[15rem] px-4 py-3 align-top">
                      <MarkdownRenderer
                        content={invite.scope}
                        compact
                        className="[&_p]:truncate"
                      />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", inviteStatusClass(invite.status))}>
                        {invite.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <MarkdownRenderer
                        content={invite.lastEvent}
                        compact
                        className="[&_p]:text-sm"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Sent {invite.sent} · {invite.expires}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invites.length === 0 ? (
            <div className="border-t p-8 text-center text-sm text-muted-foreground">
              No invites have been created for this project yet.
            </div>
          ) : null}
        </section>

        <aside className="space-y-3">
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <UserRoundPlusIcon className="size-4 text-primary" />
              How invites work
            </div>
            <div className="mt-4 space-y-3">
              <InviteFlowStep index="1" title="Invite is created" detail="A pending invite stores the recipient email, role, token, and expiry." />
              <InviteFlowStep index="2" title="Recipient accepts" detail="The invited person signs in and accepts from their Invitations page, which activates their membership." />
            </div>
            <div className="mt-4 space-y-2 border-t pt-4">
              <InviteRole title="Owner" detail="Manage API base, access, and project settings." />
              <InviteRole title="Developer" detail="Claim tasks, work with agents, and update task state." />
              <InviteRole title="Viewer" detail="Read board, logs, reviews, and activity without editing." />
            </div>
          </section>
        </aside>
      </div>
    </PageShell>
  )
}


export function AccessMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </section>
  )
}


export function InviteFlowStep({ index, title, detail }: { index: string; title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
        {index}
      </span>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}


export function InviteRole({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg bg-muted/55 p-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}


function inviteStatusClass(status: InviteRecord["status"]) {
  if (status === "Accepted") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  if (status === "Pending") return "bg-amber-100 text-amber-800 ring-amber-200"
  if (status === "Needs auth") return "bg-sky-100 text-sky-800 ring-sky-200"
  if (status === "Revoked") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}


function inviteRoleClass(role: InviteRecord["role"]) {
  if (role === "Owner") return "bg-primary/10 text-primary ring-primary/20"
  if (role === "Developer") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}
