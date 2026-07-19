import * as React from "react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import type { AuthUser } from "@/lib/auth-api"
import { taskflowApi, taskflowTables } from "@/lib/taskflow-api"
import { initialsFor } from "@/lib/user-display"
import type { TaskflowProjectMember } from "@/api/client"
import { AccountPageHeader } from "./AccountLayout"

type ProjectName = { id: number; name: string }

type MembershipView = {
  id: number
  /// The project ID, not its name. The name is resolved at RENDER time from the
  /// `projects` prop, so a renamed or newly-loaded project never requires
  /// refetching this list — which is what made the page reload on its own.
  project: number
  role: TaskflowProjectMember["role"]
  status: TaskflowProjectMember["status"]
  joinedAt: string | null
}

export function ProfilePage({
  currentUser,
  projects,
}: {
  currentUser: AuthUser | null
  projects: ProjectName[]
}) {
  const [memberships, setMemberships] = React.useState<MembershipView[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const userId = currentUser?.id ?? null

  const projectNames = React.useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  )

  /// Fetch the caller's memberships. Deliberately does NOT clear to null: this
  /// runs again whenever someone joins, and blanking the list first is what made
  /// the page visibly "reload" over and over.
  const loadMemberships = React.useCallback(async () => {
    if (userId == null) return
    try {
      const page = await taskflowApi
        .from(taskflowTables.members)
        .filter({ user: userId })
        .orderBy("project", "id")
        .list()
      setMemberships(
        page.results.map((member) => ({
          id: member.id,
          project: member.project,
          role: member.role,
          status: member.status,
          joinedAt: member.joined_at,
        }))
      )
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your project memberships.")
      setMemberships((current) => current ?? [])
    }
  }, [userId])

  // Load once per signed-in user. The projects array is NOT a dependency — it is
  // only used for display names, and treating it as one meant every workspace
  // refresh (including every realtime reconnect) refetched this list.
  React.useEffect(() => {
    // Wrapped so the state update happens in the async continuation, not
    // synchronously in the effect body.
    let cancelled = false
    void (async () => {
      if (cancelled) return
      await loadMemberships()
    })()
    return () => {
      cancelled = true
    }
  }, [loadMemberships])

  // NOTE: live roster updates are deliberately NOT subscribed here yet. Opening
  // a second EventSource for this page exhausts the browser's per-origin
  // connection budget (~6 over HTTP/1.1, and an SSE stream holds one for its
  // whole life) — the new stream then neither opens nor errors, it just hangs,
  // and the app silently stops receiving everything. Doing this properly means
  // multiplexing every subscriber onto ONE connection, which is what umbral's
  // SharedWorker client did and what replacing it gave up.

  return (
    <div className="space-y-5">
      <AccountPageHeader
        eyebrow="Account"
        title="Profile"
        description="Your identity as the backend sees it. Username and email come from your authenticated session."
      />

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        {currentUser ? (
          <div className="flex items-start gap-4">
            <Avatar className="size-14">
              <AvatarFallback className="text-lg font-semibold">{initialsFor(currentUser)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-semibold">{currentUser.username}</h2>
                {currentUser.is_superuser ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-primary/20">
                    Superuser
                  </span>
                ) : null}
                {currentUser.is_staff ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    Staff
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{currentUser.email}</p>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Username" value={currentUser.username} />
                <Field label="Email" value={currentUser.email} />
                <Field label="User ID" value={String(currentUser.id)} />
                <Field label="Account type" value={currentUser.is_superuser ? "Superuser" : currentUser.is_staff ? "Staff" : "Member"} />
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">
                Username and email are managed by your identity provider. To change your password, visit the Security page.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-4">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-56" />
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <h2 className="text-sm font-semibold">Project memberships</h2>
          {memberships ? (
            <span className="text-xs text-muted-foreground">{memberships.length} project{memberships.length === 1 ? "" : "s"}</span>
          ) : null}
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            {error}
          </p>
        ) : memberships === null ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : memberships.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            You are not a member of any projects yet. Accept a pending invitation to join one.
          </p>
        ) : (
          <ul className="mt-4 divide-y">
            {memberships.map((membership) => (
              <li key={membership.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{projectNames.get(membership.project) ?? `Project #${membership.project}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {membership.joinedAt ? `Joined ${new Date(membership.joinedAt).toLocaleDateString()}` : "Membership pending"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium capitalize text-muted-foreground">
                    {membership.role}
                  </span>
                  <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium capitalize text-muted-foreground">
                    {membership.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <dt className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium">{value}</dd>
    </div>
  )
}
