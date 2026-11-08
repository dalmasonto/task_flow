/// Repositories (design: project-repos.html): the GitHub repos this project
/// tracks. Owners and admins link one more, make one the default, or unlink
/// one, through the GitHub routes (`require_admin`; linking needs your own
/// GitHub account connected, and you become the project's tracking key).
///
/// Left out until the backend has them: each repo's open PRs, branch and CI
/// state, and the branches-and-PRs list. TaskFlow doesn't read those from
/// GitHub yet.
import { useState } from "react"
import { GitBranchIcon, PlusIcon, StarIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  GithubNeedsConnectError,
  addGithubProjectRepo,
  fetchGithubProjectStatus,
  githubConnectUrl,
  removeGithubProjectRepo,
  setDefaultGithubProjectRepo,
} from "@/lib/taskflow-api"

import { myMembership } from "../invites/invites-logic"
import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { projectPowers } from "./project-logic"
import { ProjectShell, Section } from "./ProjectShell"

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/// "https://github.com/a/b(.git)" or "a/b" → "a/b"; null when it isn't one.
function repoName(input: string): string | null {
  const s = input.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "")
  return REPO_RE.test(s) ? s : null
}

export function ProjectReposPage() {
  const { live, currentUser } = useWorkspace()
  const project = live?.project ?? null
  const powers = projectPowers(myMembership(live?.members ?? [], currentUser?.id), !!currentUser?.is_superuser)
  const status = useLoad(project ? `gh-status:${project.id}` : null, () => fetchGithubProjectStatus(project!.id))
  const [text, setText] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [needsConnect, setNeedsConnect] = useState<string | null>(null)
  const repos = status.data?.repos ?? (status.data?.github_repo ? [{ repo: status.data.github_repo, is_default: true }] : [])
  const typed = repoName(text)

  async function run(key: string, action: () => Promise<unknown>, done: string) {
    setBusy(key)
    try {
      await action()
      toast.success(done)
      status.reload()
      return true
    } catch (e) {
      if (e instanceof GithubNeedsConnectError) setNeedsConnect(e.connectUrl)
      else toast.error(e instanceof Error ? e.message : "That didn't work.")
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <ProjectShell>
      <div className="grid gap-10">
        <Section title="Repositories" description="Every task belongs to one repo, so publishing a task opens its issue in the right place, and agents know where to push.">
          {status.error && !status.data ? (
            <p className="text-sm text-destructive">{status.error}</p>
          ) : !status.data ? (
            <Skeleton className="h-28 w-full rounded-xl" />
          ) : repos.length ? (
            <ul className="divide-y rounded-xl border bg-card">
              {repos.map((r) => (
                <li key={r.repo} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <GitBranchIcon className="size-4 text-muted-foreground" />
                  <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-sm font-medium underline-offset-4 hover:underline">
                    {r.repo}
                  </a>
                  {r.is_default ? <Badge>Default</Badge> : null}
                  {powers.edit ? (
                    <span className="flex gap-1">
                      {!r.is_default ? (
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run(`d:${r.repo}`, () => setDefaultGithubProjectRepo(project!.id, r.repo), `${r.repo} is the default`)}>
                          {busy === `d:${r.repo}` ? <Spinner /> : <StarIcon />}
                          Make default
                        </Button>
                      ) : null}
                      {!r.is_default || repos.length === 1 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          aria-label={`Unlink ${r.repo}`}
                          disabled={busy !== null}
                          onClick={() => run(`r:${r.repo}`, () => removeGithubProjectRepo(project!.id, r.repo), `${r.repo} unlinked`)}
                        >
                          {busy === `r:${r.repo}` ? <Spinner /> : <Trash2Icon />}
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty className="rounded-xl border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GitBranchIcon />
                </EmptyMedia>
                <EmptyTitle>No repos linked</EmptyTitle>
                <EmptyDescription>Link the GitHub repo this project's code lives in, so tasks can open issues there.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {repos.length > 1 ? <p className="text-xs text-muted-foreground">To unlink the default, make another repo the default first.</p> : null}
        </Section>

        {powers.edit && project ? (
          <Section title="Link a repo">
            <div className="grid gap-3 rounded-xl border bg-card p-5">
              <Field>
                <FieldLabel htmlFor="link-repo">Repository</FieldLabel>
                <Input id="link-repo" value={text} placeholder="owner/name" className="font-mono" spellCheck={false} autoComplete="off" onChange={(e) => setText(e.target.value)} />
                <FieldDescription>{text && !typed ? "Use owner/name, or paste the repo's GitHub address." : "Linking uses your GitHub account, which becomes the project's tracking key."}</FieldDescription>
              </Field>
              {needsConnect ? (
                <p className="text-sm">
                  Connect your GitHub account first.{" "}
                  <a className="font-medium underline underline-offset-4" href={githubConnectUrl("/v3/project/repos")}>
                    Connect GitHub
                  </a>
                </p>
              ) : null}
              <Button
                className="justify-self-start"
                disabled={!typed || busy !== null || repos.some((r) => r.repo.toLowerCase() === typed?.toLowerCase())}
                onClick={async () => {
                  if (typed && (await run("add", () => addGithubProjectRepo(project.id, typed), `${typed} linked`))) setText("")
                }}
              >
                {busy === "add" ? <Spinner /> : <PlusIcon />}
                Link repo
              </Button>
            </div>
          </Section>
        ) : !powers.edit ? (
          <p className="text-sm text-muted-foreground">Only the project&apos;s owners and admins can link or unlink repos.</p>
        ) : null}
      </div>
    </ProjectShell>
  )
}
