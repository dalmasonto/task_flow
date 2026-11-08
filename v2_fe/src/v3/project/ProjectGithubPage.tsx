/// GitHub (design: project-github.html): how this project and GitHub stay in
/// step. Shows whose account is the project's tracking key and the linked
/// repos, and the two switches the backend has:
/// * auto-mirror comments to the linked issue (owners and admins);
/// * post as me, your own opt-in to have your activity posted under your
///   GitHub name (everyone, for themselves).
///
/// Left out until the backend has them: mirroring every new task as an issue,
/// importing new issues as tasks, and per-status labels. Today a task becomes
/// an issue when someone publishes it.
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { fetchGithubProjectStatus, githubConnectUrl, setGithubAutoMirror, setGithubPostAsMe, type GithubProjectStatus } from "@/lib/taskflow-api"

import { myMembership } from "../invites/invites-logic"
import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { projectPowers } from "./project-logic"
import { ProjectShell, Section } from "./ProjectShell"

function ToggleRow({ id, title, note, checked, disabled, onChange }: { id: string; title: string; note: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <li className="flex items-start gap-3 px-4 py-4">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-sm font-medium">
          {title}
        </label>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(!!v)} />
    </li>
  )
}

export function ProjectGithubPage() {
  const { live, currentUser } = useWorkspace()
  const project = live?.project ?? null
  const powers = projectPowers(myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser)
  const status = useLoad(project ? `gh-status:${project.id}` : null, () => fetchGithubProjectStatus(project!.id))
  const s: GithubProjectStatus | undefined = status.data
  const linker = project?.github_linked_by != null ? (live?.members ?? []).find((m) => m.user === project.github_linked_by) : undefined
  const repos = s?.repos ?? (s?.github_repo ? [{ repo: s.github_repo, is_default: true }] : [])

  async function flip(action: () => Promise<unknown>, done: string) {
    try {
      await action()
      toast.success(done)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.")
    } finally {
      status.reload()
    }
  }

  return (
    <ProjectShell>
      {status.error && !s ? (
        <p className="text-sm text-destructive">{status.error}</p>
      ) : !s || !project ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : (
        <div className="grid gap-10">
          <div className="rounded-xl border bg-card p-5">
            {s.project_linked ? (
              <>
                <p className="text-sm font-medium">Connected through {linker ? `${linker.display_name}'s` : "a member's"} GitHub account</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Tasks publish into {repos.length === 1 ? "1 repo" : `${repos.length} repos`} on{" "}
                  <Link to="/v3/project/repos" className="underline underline-offset-4">
                    Repositories
                  </Link>
                  .
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Not linked to GitHub</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {powers.edit ? (
                    <>
                      Link a repo on{" "}
                      <Link to="/v3/project/repos" className="underline underline-offset-4">
                        Repositories
                      </Link>{" "}
                      to publish tasks as issues.
                    </>
                  ) : (
                    "An owner or admin links the project's repos."
                  )}
                </p>
              </>
            )}
            {!s.user_connected ? (
              <p className="mt-3 text-sm">
                Your own GitHub account isn&apos;t connected.{" "}
                <Button size="sm" variant="outline" className="ml-1" nativeButton={false} render={<a href={githubConnectUrl("/v3/project/github")} />}>
                  Connect GitHub
                </Button>
              </p>
            ) : null}
          </div>

          <Section title="Issues" description="How tasks and GitHub issues stay in step.">
            <ul className="divide-y rounded-xl border bg-card">
              <ToggleRow
                id="gh-auto-mirror"
                title="Mirror comments to the issue"
                note={powers.edit ? "Comments on a published task post to its issue without a click each time. Each person's own setting below still applies." : "Owners and admins choose this. Each person's own setting below still applies."}
                checked={s.auto_mirror}
                disabled={!powers.edit || !s.project_linked}
                onChange={(v) => flip(() => setGithubAutoMirror(project.id, v), v ? "Comments mirror to issues" : "Comments no longer mirror automatically")}
              />
              <ToggleRow
                id="gh-post-as-me"
                title="Post my activity under my GitHub name"
                note={s.user_connected ? "Only you can turn this on for yourself. Off means nothing goes to GitHub under your name." : "Connect your GitHub account first."}
                checked={s.post_as_me}
                disabled={!s.user_connected}
                onChange={(v) => flip(() => setGithubPostAsMe(project.id, v), v ? "Your activity can post as you" : "Nothing posts as you")}
              />
            </ul>
            <p className="text-sm text-muted-foreground">A task becomes an issue when someone publishes it from the task page. Opening issues for every new task, importing issues as tasks, and status labels aren&apos;t available yet.</p>
          </Section>
        </div>
      )}
    </ProjectShell>
  )
}
