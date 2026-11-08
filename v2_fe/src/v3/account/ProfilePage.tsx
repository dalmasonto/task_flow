/// Profile (design: account-profile): how people and agents see you, and the
/// projects you're in with your role in each.
///
/// Read-only until #TSK1134 adds profile editing (name, username, and email
/// behind your current password) and a photo; until then it says so.
/// Memberships come from the project-scoped REST list of your own member rows.
import { Link } from "react-router-dom"

import type { TaskflowProjectMember } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { taskflowApi, taskflowTables } from "@/lib/taskflow-api"

import { ActorAvatar } from "../components/actor-avatar"
import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { AccountShell } from "./AccountShell"

async function countOf(table: typeof taskflowTables.members | typeof taskflowTables.agents, project: number): Promise<number> {
  const r = await taskflowApi.from(table).filter(table === taskflowTables.members ? { project, status: "active" } : { project }).param("page_size", 1).param("fields", "id").list()
  return r.count
}

export function ProfilePage() {
  const { currentUser, projects, chooseProject } = useWorkspace()
  const mine = useLoad(currentUser ? `my-members|${currentUser.id}` : null, () =>
    taskflowApi
      .from(taskflowTables.members)
      .filter({ user: currentUser!.id, status: "active" })
      .param("page_size", 100)
      .list()
      .then((r) => r.results as TaskflowProjectMember[]),
  )
  const ids = (mine.data ?? []).map((m) => m.project)
  const sizes = useLoad(ids.length ? `sizes|${ids.join(",")}` : null, async () =>
    Object.fromEntries(await Promise.all(ids.map(async (p) => [p, { people: await countOf(taskflowTables.members, p), agents: await countOf(taskflowTables.agents, p) }] as const))),
  )
  const name = (id: number) => projects.find((p) => p.id === String(id))?.name ?? `Project ${id}`
  const username = currentUser?.username ?? ""

  return (
    <AccountShell>
      <div>
        <h2 className="font-medium">Profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">How people and agents see you in rooms and on tasks.</p>
      </div>

      <section className="mt-5 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-4">
          <ActorAvatar name={username || "You"} size="xl" />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{username}</p>
            <p className="truncate text-sm text-muted-foreground">{currentUser?.email}</p>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Username</dt>
            <dd className="mt-0.5 font-mono text-sm">{username}</dd>
            <dd className="mt-0.5 text-xs text-muted-foreground">Agents mention you with this.</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Email</dt>
            <dd className="mt-0.5 text-sm">{currentUser?.email}</dd>
            <dd className="mt-0.5 text-xs text-muted-foreground">Project invitations are matched to this address.</dd>
          </div>
        </dl>
        <p className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">Editing your name, username, email and photo is on its way. Changing your email will ask for your password.</p>
      </section>

      <div className="mt-8">
        <h2 className="font-medium">Projects</h2>
        <p className="mt-1 text-sm text-muted-foreground">Where you&apos;re a member, and your role in each.</p>
      </div>
      {mine.loading ? (
        <Skeleton className="mt-5 h-24 rounded-xl" />
      ) : mine.error ? (
        <p className="mt-5 text-sm text-destructive">Couldn&apos;t load your projects.</p>
      ) : mine.data?.length ? (
        <ul className="mt-5 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {mine.data.map((m) => {
            const s = sizes.data?.[m.project]
            return (
              <li key={m.id}>
                <Link to="/v3/overview" onClick={() => chooseProject(String(m.project))} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold uppercase">{name(m.project).slice(0, 2)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name(m.project)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {s ? `${s.agents} ${s.agents === 1 ? "agent" : "agents"}, ${s.people} ${s.people === 1 ? "person" : "people"}` : " "}
                    </span>
                  </span>
                  <Badge variant={m.role === "owner" ? "secondary" : "outline"} className="capitalize">
                    {m.role}
                  </Badge>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">
          You&apos;re not in any project yet.{" "}
          <Link to="/v3/projects/new" className="underline underline-offset-4">
            Create one
          </Link>
          .
        </p>
      )}
    </AccountShell>
  )
}
