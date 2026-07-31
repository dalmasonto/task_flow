import { Button } from "@/components/ui/button"
import { FolderKanbanIcon, GitBranchIcon, InboxIcon, PlusIcon } from "lucide-react"
import { GithubNeedsConnectError, fetchGithubProjectStatus, linkGithubProject, type GithubProjectStatus } from "@/lib/taskflow-api"
import { Input } from "@/components/ui/input"
import { Link, useNavigate } from "react-router-dom"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { liveId } from "@/lib/live-mappers"
import { type Project } from "@/lib/workspace-view"
import { useEffect, useState } from "react"


export function PageShell({
  eyebrow,
  title,
  description,
  children,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="grid gap-5 p-4 sm:p-5">
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{eyebrow}</p>
            <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
            <MarkdownRenderer
              content={description}
              compact
              className="mt-2 max-w-3xl [&_p]:text-sm [&_p]:leading-6"
            />
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      </div>
      {children}
    </section>
  )
}


// A discoverable, top-of-page control for linking the active project to a
// GitHub repo. Lives in the dashboard header so it's visible from any page —
// not buried in the API Base settings. Self-contained: fetches its own status,
// and pops a small inline panel to enter `owner/repo`.
export function GithubHeaderButton({ project }: { project: Project }) {
  const navigate = useNavigate()
  const projectId = liveId(project.id)
  const [status, setStatus] = useState<GithubProjectStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [repoInput, setRepoInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (projectId === null) return
    let active = true
    void fetchGithubProjectStatus(projectId)
      .then((next) => {
        if (!active) return
        setStatus(next)
        setRepoInput(next.github_repo ?? "")
      })
      .catch(() => {
        if (active) setStatus(null)
      })
    return () => {
      active = false
    }
  }, [projectId])

  // Demo/unsaved projects have no live numeric id — nothing to link against.
  if (projectId === null) return null

  // Not connected yet → send them to Settings to connect their account first.
  if (status && !status.user_connected) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate("/account/settings")}
        title="Connect your GitHub account to link a repository"
      >
        <GitBranchIcon className="size-4" />
        Connect GitHub
      </Button>
    )
  }

  const repoName = status?.project_linked ? status.github_repo : null

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        title={repoName ? `Linked to ${repoName}` : "Link this project to a GitHub repository"}
      >
        <GitBranchIcon className="size-4" />
        <span className="max-w-40 truncate">{repoName ?? "Link GitHub repo"}</span>
      </Button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border bg-card p-3 shadow-lg">
          <p className="text-xs font-medium text-muted-foreground">Repository (owner/name)</p>
          <Input
            value={repoInput}
            onChange={(event) => setRepoInput(event.target.value)}
            placeholder="acme/widgets"
            className="mt-1.5"
            autoFocus
          />
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
          <div className="mt-3 flex items-center justify-between gap-2">
            {repoName ? (
              <a
                href={`https://github.com/${repoName}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline"
              >
                Open on GitHub
              </a>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || !repoInput.trim()}
                onClick={async () => {
                  setBusy(true)
                  setError(null)
                  try {
                    const result = await linkGithubProject(projectId, repoInput.trim())
                    setStatus((prev) =>
                      prev
                        ? { ...prev, project_linked: true, github_repo: result.github_repo, can_publish: true }
                        : prev,
                    )
                    setOpen(false)
                  } catch (linkError) {
                    setError(
                      linkError instanceof GithubNeedsConnectError
                        ? "Connect your GitHub account first."
                        : (linkError as Error).message,
                    )
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {repoName ? "Update" : "Link"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}


// Honest empty state shown across the dashboard when the signed-in user has no
// projects yet (a first-time account, or someone whose invites are still
// pending). This replaces the old fixture fallback — no fake project, no error.
export function NoProjectEmptyState({
  onNewProject,
  syncing,
}: {
  onNewProject: () => void
  syncing?: boolean
}) {
  return (
    <section className="grid place-items-center p-4 sm:p-8">
      <div className="w-full max-w-xl rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <FolderKanbanIcon className="size-6" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">No projects yet</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          {syncing
            ? "Loading your workspace…"
            : "You'll see a project here once you create one or accept an invitation to join one."}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={onNewProject}>
            <PlusIcon />
            New Project
          </Button>
          {/* Renders as an <a> (react-router Link), so tell Base UI it is not a
              native <button> — otherwise it warns and drops button semantics. */}
          <Button variant="outline" nativeButton={false} render={<Link to="/account/invitations" />}>
            <InboxIcon />
            View Invitations
          </Button>
        </div>
      </div>
    </section>
  )
}
