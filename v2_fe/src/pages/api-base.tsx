import { API_BASE_URL } from "@/lib/auth-api"
import { AlertCircleIcon, BotIcon, CheckIcon, ClipboardCheckIcon, Clock3Icon, CopyIcon, FileJsonIcon, GitBranchIcon, LinkIcon, LockIcon, RotateCcwIcon, ShieldCheckIcon, TerminalIcon, UsersIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { GithubNeedsConnectError, fetchGithubProjectStatus, linkAgent, linkGithubProject, setGithubAutoMirror, setGithubPostAsMe, type GithubProjectStatus, type LinkAgentResult, type TaskflowWorkspace } from "@/lib/taskflow-api"
import { Input } from "@/components/ui/input"
import { Link } from "react-router-dom"
import { PageShell } from "@/components/layout"
import { cn } from "@/lib/utils"
import { type Project } from "@/lib/workspace-view"
import { formatLiveDate, isSessionLive, liveId } from "@/lib/live-mappers"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { useLivenessNow } from "@/hooks/use-liveness-now"


export function ApiBasePage({
  project,
  workspace,
  onContract,
  onUpdateProject,
}: {
  project: Project
  workspace: TaskflowWorkspace | null
  onContract: () => void
  onUpdateProject: (event: FormEvent<HTMLFormElement>) => void
}) {
  const sessions = workspace?.agentSessions ?? []
  const credentials = workspace?.agentCredentials ?? []
  const agents = workspace?.agents ?? []
  // Same liveness rule as the roster and the terminal: a session row that says
  // connected but stopped heartbeating is a dead process, not a live session.
  const apiLivenessNow = useLivenessNow()
  const connectedSessions = sessions.filter((session) => isSessionLive(session, apiLivenessNow)).length
  const expiredSessions = sessions.filter((session) => session.status === "expired").length
  // "Not live" MINUS the expired ones, which get their own card — otherwise an
  // expired session is counted twice and the three numbers stop summing.
  const disconnectedSessions = sessions.filter(
    (session) => !isSessionLive(session, apiLivenessNow) && session.status !== "expired"
  ).length
  const activeKeys = credentials.filter((credential) => credential.status === "active").length
  const restBase = "/api"
  const realtimeBase = "/realtime"
  const numericProjectId = liveId(project.id)

  const [ghStatus, setGhStatus] = useState<GithubProjectStatus | null>(null)
  const [ghRepoInput, setGhRepoInput] = useState("")
  const [ghBusy, setGhBusy] = useState(false)
  const [ghError, setGhError] = useState<string | null>(null)
  useEffect(() => {
    if (numericProjectId === null) return
    let active = true
    void fetchGithubProjectStatus(numericProjectId)
      .then((status) => {
        if (!active) return
        setGhStatus(status)
        setGhRepoInput(status.github_repo ?? "")
      })
      .catch(() => {
        if (active) setGhStatus(null)
      })
    return () => {
      active = false
    }
  }, [numericProjectId])

  return (
    <PageShell
      eyebrow={project.name}
      title="API Base"
      description="Configure the live API target, link coding agents, and inspect agent session identity."
      actions={
        <Button size="sm" onClick={onContract}>
          <FileJsonIcon />
          API Contract
        </Button>
      }
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <InfoCard icon={<GitBranchIcon />} title="API base" value={project.apiBase} />
        <InfoCard icon={<UsersIcon />} title="Members" value={`${project.members} collaborators`} />
        <InfoCard icon={<BotIcon />} title="Agents" value={`${project.agentsOnline} online`} />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <InfoCard icon={<TerminalIcon />} title="Connected sessions" value={`${connectedSessions} live`} />
        <InfoCard icon={<Clock3Icon />} title="Disconnected sessions" value={`${disconnectedSessions} idle`} />
        <InfoCard icon={<AlertCircleIcon />} title="Expired sessions" value={`${expiredSessions} expired`} />
        <InfoCard icon={<LockIcon />} title="Active keys" value={`${activeKeys} active`} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <form className="rounded-lg border bg-card p-4 shadow-sm" onSubmit={onUpdateProject}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileJsonIcon className="size-4 text-primary" />
            Runtime API
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The base URL agents and the dashboard use to reach this project's REST and realtime endpoints.
          </p>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Base URL</span>
              <Input name="default_api_base_url" defaultValue={project.apiBase || restBase} />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" type="submit">
              <CheckIcon />
              Save API Base
            </Button>
            <Button variant="outline" size="sm" type="button" onClick={onContract}>
              <FileJsonIcon />
              View Contract
            </Button>
          </div>
        </form>

        <LinkAgentCard projectId={numericProjectId} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <AgentSessionsTable sessions={sessions} agents={agents} credentials={credentials} />
        <AgentIdentityPanel project={project} agents={agents} />
      </div>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <GitBranchIcon className="size-4 text-primary" />
          GitHub
        </div>
        {numericProjectId === null ? (
          <p className="mt-2 text-sm text-muted-foreground">Save this project before linking GitHub.</p>
        ) : !ghStatus ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Link this project to a GitHub repository to publish tasks as issues.
            </p>
            {!ghStatus.user_connected ? (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                <Link to="/account/settings" className="underline">
                  Connect your GitHub account
                </Link>{" "}
                first to link a repo or post as yourself.
              </p>
            ) : null}
            <div className="mt-3 flex items-end gap-2">
              <label className="grid flex-1 gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Repository (owner/name)</span>
                <Input
                  value={ghRepoInput}
                  onChange={(event) => setGhRepoInput(event.target.value)}
                  placeholder="acme/widgets"
                />
              </label>
              <Button
                size="sm"
                disabled={ghBusy || !ghStatus.user_connected || !ghRepoInput.trim() || numericProjectId === null}
                onClick={async () => {
                  if (numericProjectId === null) return
                  setGhBusy(true)
                  setGhError(null)
                  try {
                    const result = await linkGithubProject(numericProjectId, ghRepoInput.trim())
                    setGhStatus({ ...ghStatus, project_linked: true, github_repo: result.github_repo, can_publish: true })
                  } catch (error) {
                    setGhError(
                      error instanceof GithubNeedsConnectError
                        ? "Connect your GitHub account first."
                        : (error as Error).message,
                    )
                  } finally {
                    setGhBusy(false)
                  }
                }}
              >
                {ghStatus.project_linked ? "Update repo" : "Link repo"}
              </Button>
            </div>
            {ghStatus.project_linked && ghStatus.github_repo ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Linked to <span className="font-mono">{ghStatus.github_repo}</span>.
              </p>
            ) : null}
            {ghError ? <p className="mt-2 text-xs text-destructive">{ghError}</p> : null}
            <div className="mt-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Let TaskFlow post issue comments as me</p>
                <p className="text-xs text-muted-foreground">
                  Opt in per project. Comments go out under your own GitHub identity.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={ghStatus.post_as_me}
                aria-label="Post issue comments as me"
                disabled={numericProjectId === null}
                onClick={async () => {
                  if (numericProjectId === null) return
                  const next = !ghStatus.post_as_me
                  setGhStatus({ ...ghStatus, post_as_me: next })
                  try {
                    await setGithubPostAsMe(numericProjectId, next)
                  } catch {
                    setGhStatus({ ...ghStatus, post_as_me: !next })
                  }
                }}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                  ghStatus.post_as_me ? "bg-primary" : "bg-input",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
                    ghStatus.post_as_me ? "translate-x-5" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Auto-mirror comments to the issue</p>
                <p className="text-xs text-muted-foreground">
                  Owner/admin. When on, task comments post to the issue automatically — each
                  still under the commenter's own key, only if they've opted in.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={ghStatus.auto_mirror}
                aria-label="Auto-mirror comments to the issue"
                disabled={numericProjectId === null || !ghStatus.project_linked}
                onClick={async () => {
                  if (numericProjectId === null) return
                  const next = !ghStatus.auto_mirror
                  setGhStatus({ ...ghStatus, auto_mirror: next })
                  try {
                    await setGithubAutoMirror(numericProjectId, next)
                  } catch (error) {
                    setGhStatus({ ...ghStatus, auto_mirror: !next })
                    setGhError(
                      error instanceof GithubNeedsConnectError
                        ? "Connect GitHub first."
                        : (error as Error).message,
                    )
                  }
                }}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
                  ghStatus.auto_mirror ? "bg-primary" : "bg-input",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-5 transform rounded-full bg-background shadow transition-transform",
                    ghStatus.auto_mirror ? "translate-x-5" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
          </>
        )}
      </section>

      <DeveloperEndpoints projectId={project.id} restBase={restBase} realtimeBase={realtimeBase} />
    </PageShell>
  )
}


/// Copies `value` to the clipboard and briefly flips to a "Copied" state so the
/// user gets feedback. Falls back silently if the Clipboard API is unavailable.
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  // #44: keep the reset timer in a ref so rapid re-clicks don't stack timers and
  // a timer never fires setCopied on an unmounted component.
  const resetTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }, [value])

  return (
    <Button type="button" variant="outline" size="sm" className={className} onClick={handleCopy}>
      {copied ? <ClipboardCheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  )
}


/// The real "link a coding agent" flow. Collects a display name + profile, calls
/// `linkAgent` with the NUMERIC project id, then shows the one-time key and a
/// ready-to-paste `.taskflow.json` snippet. `projectId` is null when the FE
/// project has no resolvable numeric id (not yet synced) — the form is disabled.
export function LinkAgentCard({ projectId }: { projectId: number | null }) {
  const [displayName, setDisplayName] = useState("")
  const [profile, setProfile] = useState("main")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LinkAgentResult | null>(null)

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (projectId == null) {
        setError("This project is still syncing — try again in a moment.")
        return
      }
      const name = displayName.trim()
      const role = profile.trim() || "main"
      if (!name) {
        setError("Enter a display name for the agent.")
        return
      }
      setPending(true)
      setError(null)
      try {
        const linked = await linkAgent({ project: projectId, display_name: name, profile: role })
        setResult(linked)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not link the agent.")
      } finally {
        setPending(false)
      }
    },
    [projectId, displayName, profile]
  )

  const handleReset = useCallback(() => {
    setResult(null)
    setError(null)
    setDisplayName("")
    setProfile("main")
  }, [])

  const snippet = result
    ? JSON.stringify(
        {
          // The BACKEND origin, not this page's. An agent runs headless and must
          // not depend on the frontend being up — and in dev those differ: the
          // app is served by Vite (:5173) which proxies /api to the backend
          // (:8000), so emitting `window.location.origin` would route every agent
          // call through the dev server. `API_BASE_URL` is the real backend when
          // configured; falling back to the page origin covers the same-origin
          // deployment where they are genuinely the same host.
          server: API_BASE_URL || window.location.origin,
          project: result.project,
          default_profile: "main",
          profiles: {
            [result.profile]: {
              agent_id: result.taskflow_profile.agent_id,
              key: result.taskflow_profile.key,
              display_name: result.taskflow_profile.display_name,
            },
          },
        },
        null,
        2
      )
    : ""

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <BotIcon className="size-4 text-primary" />
        Link a coding agent
      </div>

      {result ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-6 text-muted-foreground">
            Linked <span className="font-semibold text-foreground">{result.display_name}</span> as{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{result.identifier}</code> (profile{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{result.profile}</code>).
          </p>

          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-800">
              <LockIcon className="size-3.5" />
              Copy this key now — it is shown only once and cannot be recovered.
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 font-mono text-xs">
                {result.key}
              </code>
              <CopyButton value={result.key} label="Copy key" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">.taskflow.json</span>
              <CopyButton value={snippet} label="Copy snippet" />
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-lg border bg-background p-3 font-mono text-xs leading-5">
              {snippet}
            </pre>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            Save this as <code className="rounded bg-muted px-1 py-0.5">.taskflow.json</code> in your repo root and add
            it to <code className="rounded bg-muted px-1 py-0.5">.gitignore</code> (it holds a secret). The MCP/agent
            uses the <code className="rounded bg-muted px-1 py-0.5">main</code> profile by default; link a{" "}
            <code className="rounded bg-muted px-1 py-0.5">reviewer</code> profile the same way to add that role.
          </p>

          <Button type="button" variant="outline" size="sm" onClick={handleReset}>
            <RotateCcwIcon />
            Link another
          </Button>
        </div>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={handleSubmit}>
          <p className="text-sm leading-6 text-muted-foreground">
            Mint a per-agent credential for this project. The role you pick is the profile key written into{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">.taskflow.json</code>.
          </p>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Display name</span>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Builder"
              disabled={pending}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Profile</span>
            <Input
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
              placeholder="main"
              list="taskflow-agent-profiles"
              disabled={pending}
            />
            <datalist id="taskflow-agent-profiles">
              <option value="main" />
              <option value="reviewer" />
            </datalist>
          </label>
          {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
          <Button type="submit" size="sm" disabled={pending || projectId == null}>
            <BotIcon />
            {pending ? "Linking…" : "Link agent"}
          </Button>
        </form>
      )}
    </section>
  )
}


/// The genuinely useful REST/realtime entrypoints, collapsed by default so the
/// page reads as a settings surface rather than an endpoint dump.
export function DeveloperEndpoints({
  projectId,
  restBase,
  realtimeBase,
}: {
  projectId: string
  restBase: string
  realtimeBase: string
}) {
  return (
    <details className="group rounded-lg border bg-card p-4 shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
        <LinkIcon className="size-4 text-primary" />
        Developer endpoints
        <span className="ml-auto text-xs font-normal text-muted-foreground">Show</span>
      </summary>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <IntegrationLink label="OpenAPI schema" value="/openapi/openapi.json" />
        <IntegrationLink label="Projects REST" value={`${restBase}/taskflow_project/`} />
        <IntegrationLink label="Tasks REST" value={`${restBase}/taskflow_task/?project=${projectId}`} />
        <IntegrationLink label="Agents REST" value={`${restBase}/taskflow_agent/?project=${projectId}`} />
        <IntegrationLink label="Realtime runtime" value={`${realtimeBase}/client.js`} />
        <IntegrationLink label="Realtime SSE" value={`${realtimeBase}/sse`} />
      </div>
    </details>
  )
}


export function AgentSessionsTable({
  sessions,
  agents,
  credentials,
}: {
  sessions: TaskflowWorkspace["agentSessions"]
  agents: TaskflowWorkspace["agents"]
  credentials: TaskflowWorkspace["agentCredentials"]
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <TerminalIcon className="size-4 text-primary" />
            Agent Sessions
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Live sessions from taskflow_agent_session, with each agent's stable identifier and the credential prefix it authenticated with.
          </p>
        </div>
      </div>
      {sessions.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No agent sessions yet. Connected agents will appear here once they link to this project.
        </div>
      ) : (
        <div className="scrollbar-y overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead className="bg-muted/55 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Agent</th>
                <th className="px-4 py-2.5 text-left font-semibold">Stable identifier</th>
                <th className="px-4 py-2.5 text-left font-semibold">Credential</th>
                <th className="px-4 py-2.5 text-left font-semibold">Linked by</th>
                <th className="px-4 py-2.5 text-left font-semibold">Session</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const agent = agents.find((candidate) => candidate.id === session.agent)
                const credential =
                  credentials.find((item) => item.agent === session.agent && item.status === "active") ??
                  credentials.find((item) => item.agent === session.agent)
                const linkedBy =
                  agent?.linked_user_label ??
                  (session.connected_by != null ? `User #${session.connected_by}` : "Unlinked")
                return (
                  <tr key={session.id} className="border-t">
                    <td className="px-4 py-3 align-top">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                          <BotIcon className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{agent?.display_name ?? `Agent #${session.agent}`}</p>
                            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold ring-1", agentSessionStatusClass(session.status))}>
                              {session.status}
                            </span>
                          </div>
                          <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground">
                            {agent?.runtime ? `${agent.runtime}${agent.version ? ` · ${agent.version}` : ""}` : "Runtime not reported"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <code className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{agent?.identifier ?? "—"}</code>
                      <p className="mt-2 max-w-[16rem] truncate text-xs text-muted-foreground">
                        {agent?.taskflow_file_path ?? agent?.project_root ?? "No marker file recorded"}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {credential ? (
                        <>
                          <code className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary ring-1 ring-primary/20">
                            {credential.key_prefix}
                          </code>
                          <p className="mt-2 text-xs text-muted-foreground">
                            {credential.name} · {credential.status}
                          </p>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">No credential linked</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="font-medium">{linkedBy}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{formatLiveDate(session.connected_at, "—")}</p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <code className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{session.session_identifier}</code>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {[session.host, session.pid != null ? `pid ${session.pid}` : null].filter(Boolean).join(" · ") || "No host reported"}
                        {" · "}
                        {formatLiveDate(session.last_seen_at ?? session.connected_at, "—")}
                      </p>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}


export function AgentIdentityPanel({ project, agents }: { project: Project; agents: TaskflowWorkspace["agents"] }) {
  const agent = agents[0]
  const identity = agent
    ? {
        project_id: agent.project,
        display_name: agent.display_name,
        agent_identifier: agent.identifier,
        fingerprint: agent.fingerprint,
        status: agent.status,
        runtime: agent.runtime,
        version: agent.version,
        linked_by: agent.linked_user_label,
        project_root: agent.project_root,
        taskflow_file_path: agent.taskflow_file_path,
        last_seen_at: agent.last_seen_at,
        api_base: project.apiBase,
      }
    : null

  return (
    <aside className="space-y-3">
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <FileJsonIcon className="size-4 text-primary" />
          Identity Handshake
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Every agent writes a project-local identity marker before it can join sessions, channels, tasks, or activity.
        </p>
        <div className="mt-4 rounded-lg border bg-background p-3">
          {identity ? (
            <code className="block whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
              {JSON.stringify(identity, null, 2)}
            </code>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              No agents connected yet. Once an agent links to this project, its identity marker shows up here.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheckIcon className="size-4 text-primary" />
          Link Rules
        </div>
        <div className="mt-4 space-y-3">
          <IdentityRule title="Display name is human readable" detail="It can be reused across sessions, so the stable identifier decides identity." />
          <IdentityRule title="Identifier survives restarts" detail="Returning agents should resume the same identity instead of creating duplicates." />
          <IdentityRule title="Credential prefix is safe to show" detail="Only the key prefix and label are ever displayed — the full key is never surfaced in the UI." />
          <IdentityRule title="Credentials are scoped" detail="Keys are issued per project and can be rotated or revoked without touching the agent identity." />
          <IdentityRule title="Linked by is explicit" detail="Every agent records the human or owner that connected it to the project." />
        </div>
      </section>
    </aside>
  )
}


export function IdentityRule({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg bg-muted/55 p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}


function agentSessionStatusClass(status: TaskflowWorkspace["agentSessions"][number]["status"]) {
  if (status === "connected") return "bg-emerald-100 text-emerald-800 ring-emerald-200"
  if (status === "expired") return "bg-rose-100 text-rose-800 ring-rose-200"
  return "bg-slate-100 text-slate-700 ring-slate-200"
}


export function IntegrationLink({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/60 p-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <LinkIcon className="size-3.5 text-primary" />
        {label}
      </div>
      <p className="mt-1 break-all text-[0.72rem] leading-4 text-muted-foreground">{value}</p>
    </div>
  )
}


export function InfoCard({ icon, title, value }: { icon: React.ReactNode; title: string; value: string }) {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-primary">{icon}</span>
        {title}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{value}</p>
    </section>
  )
}
