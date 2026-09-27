import { API_BASE_URL } from "@/lib/auth-api"
import { BotIcon, CheckCircle2Icon, ClipboardCheckIcon, CopyIcon, FileJsonIcon, GitBranchIcon, KeyRoundIcon, LockIcon, RotateCcwIcon, TerminalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GithubNeedsConnectError, fetchGithubProjectStatus, linkAgent, linkGithubProject, setGithubAutoMirror, setGithubPostAsMe, type GithubProjectStatus, type LinkAgentResult, type TaskflowWorkspace } from "@/lib/taskflow-api"
import { Input } from "@/components/ui/input"
import { Link } from "react-router-dom"
import { PageShell } from "@/components/layout"
import { cn } from "@/lib/utils"
import { type Project } from "@/lib/workspace-view"
import { formatLiveDate, isSessionLive, liveId } from "@/lib/live-mappers"
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { PROFILE_PATTERN, profileOf } from "@/lib/agent-profile"

/// The install one-liners, as the MCP README and docs give them.
const INSTALL_SCRIPT = "curl -fsSL https://raw.githubusercontent.com/dalmasonto/task_flow/main/scripts/install.sh | sh"
const INSTALL_NPM = "npm install -g @dalmasonto/taskflow-mcp && taskflow init"

export function ApiBasePage({
  project,
  workspace,
  onContract,
}: {
  project: Project
  workspace: TaskflowWorkspace | null
  onContract: () => void
  onUpdateProject?: (event: FormEvent<HTMLFormElement>) => void
}) {
  const agents = useMemo(() => workspace?.agents ?? [], [workspace?.agents])
  const numericProjectId = liveId(project.id)
  // Agents linked from this page, shown at once: the roster in `workspace` is
  // the core load's and is not refetched by a link, so without these a new
  // agent would not appear until a reload.
  const [justLinked, setJustLinked] = useState<{ agent: TaskflowWorkspace["agents"][number]; keyPrefix: string }[]>([])
  const projectAgents = useMemo(() => {
    if (numericProjectId == null) return []
    const known = agents.filter((agent) => agent.project === numericProjectId)
    const extra = justLinked
      .map((entry) => entry.agent)
      .filter((agent) => agent.project === numericProjectId && !known.some((k) => k.id === agent.id))
    return [...known, ...extra]
  }, [agents, justLinked, numericProjectId])
  const credentials = useMemo(
    () => [
      ...(workspace?.agentCredentials ?? []),
      ...justLinked.map((entry, index) => ({
        id: -1 - index,
        project: entry.agent.project,
        agent: entry.agent.id,
        issued_by: null,
        name: "",
        key_prefix: entry.keyPrefix,
        key_hash: "",
        status: "active" as const,
        expires_at: null,
        revoked_at: null,
        created_at: null,
      })),
    ],
    [workspace?.agentCredentials, justLinked]
  )

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
      title="Connect agents"
      description="Install the TaskFlow MCP, link a coding agent to this project, and see every agent you have linked."
      actions={
        <Button size="sm" variant="outline" onClick={onContract}>
          <FileJsonIcon />
          API Contract
        </Button>
      }
    >
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <InstallCard />
        <LinkAgentCard
          projectId={numericProjectId}
          projectAgents={projectAgents}
          onLinked={(linked) =>
            setJustLinked((current) => [
              ...current,
              {
                agent: {
                  id: linked.agent_id,
                  project: linked.project,
                  display_name: linked.display_name,
                  identifier: linked.identifier,
                  fingerprint: null,
                  project_root: null,
                  taskflow_file_path: null,
                  runtime: null,
                  version: null,
                  status: "offline" as const,
                  linked_by: null,
                  linked_user_label: null,
                  last_seen_at: null,
                  created_at: null,
                },
                keyPrefix: linked.key.slice(0, 16),
              },
            ])
          }
        />
      </div>

      <AgentsList
        agents={projectAgents}
        sessions={workspace?.agentSessions ?? []}
        credentials={credentials}
      />

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
    </PageShell>
  )
}

/// Step 1: get the MCP onto the machine. `taskflow init` then registers it with
/// the coding agent (Claude Code, Codex, Gemini CLI, Cursor, opencode).
/// The app's tabs mark the active tab with a faint underline — fine for a
/// page's sections, but these tabs are a CHOICE (which OS, which file), so they
/// read as a segmented control: the active option is a raised chip.
const SEGMENTED_LIST = "w-fit gap-1 rounded-lg border-0 bg-muted p-1"
const SEGMENTED_TRIGGER =
  "rounded-md px-3 py-1.5 text-sm font-medium normal-case tracking-normal after:hidden data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm"

function InstallCard() {
  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <StepTitle n={1} icon={<TerminalIcon className="size-4 text-primary" />}>
        Install the TaskFlow MCP
      </StepTitle>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        One command installs it and runs <code className="rounded bg-muted px-1 py-0.5 text-xs">taskflow init</code>,
        which sets it up in Claude Code, Codex, Gemini CLI, Cursor or opencode for you.
      </p>
      <Tabs defaultValue="script" className="mt-3">
        <TabsList className={SEGMENTED_LIST}>
          <TabsTrigger value="script" className={SEGMENTED_TRIGGER}>macOS / Linux</TabsTrigger>
          <TabsTrigger value="npm" className={SEGMENTED_TRIGGER}>npm (any OS)</TabsTrigger>
        </TabsList>
        <TabsContent value="script" className="mt-3">
          <CommandLine command={INSTALL_SCRIPT} />
        </TabsContent>
        <TabsContent value="npm" className="mt-3">
          <CommandLine command={INSTALL_NPM} />
        </TabsContent>
      </Tabs>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Then link an agent (step 2), save its credential in your repo (step 3), restart the agent, and ask it to call{" "}
        <code className="rounded bg-muted px-1 py-0.5">whoami</code>.
      </p>
    </section>
  )
}

function StepTitle({ n, icon, children }: { n: number; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold">
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
        {n}
      </span>
      {icon}
      {children}
    </div>
  )
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border bg-background p-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">{command}</code>
      <CopyButton value={command} />
    </div>
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


/// Steps 2 and 3: mint a credential, then save it. The key is shown ONCE, so the
/// saving instructions live right here with it.
///
/// What to save depends on the repo: a project whose other agents already sit in
/// a `.taskflow.json` needs only the NEW profile added to that file's `profiles`;
/// the first agent needs the whole file. Both are offered, and the one that fits
/// this project is shown first.
export function LinkAgentCard({
  projectId,
  projectAgents,
  onLinked,
}: {
  projectId: number | null
  projectAgents: TaskflowWorkspace["agents"]
  /// Called with each new link, so the page can list the agent at once.
  onLinked?: (linked: LinkAgentResult) => void
}) {
  const usedProfiles = useMemo(
    () => new Map(projectAgents.map((agent) => [profileOf(agent.identifier), agent.display_name])),
    [projectAgents]
  )
  const [displayName, setDisplayName] = useState("")
  const [profile, setProfile] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LinkAgentResult | null>(null)
  /// Whether the project already had agents when this one was linked — decides
  /// which save form is shown first.
  const [hadAgents, setHadAgents] = useState(false)

  // The first agent is `main` (the profile the MCP picks by default); later
  // ones must be named.
  const suggested = usedProfiles.has("main") ? "" : "main"
  const effectiveProfile = (profile || suggested).trim()
  const profileProblem = !effectiveProfile
    ? "Name the profile, e.g. reviewer."
    : !PROFILE_PATTERN.test(effectiveProfile)
      ? "Lowercase letters, numbers, - and _ only (e.g. main, reviewer)."
      : null
  const profileTakenBy = usedProfiles.get(effectiveProfile)

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (projectId == null) {
        setError("This project is still syncing — try again in a moment.")
        return
      }
      const name = displayName.trim()
      if (!name) {
        setError("Enter a display name for the agent.")
        return
      }
      if (profileProblem) {
        setError(profileProblem)
        return
      }
      setPending(true)
      setError(null)
      try {
        setHadAgents(projectAgents.length > 0)
        const linked = await linkAgent({ project: projectId, display_name: name, profile: effectiveProfile })
        setResult(linked)
        onLinked?.(linked)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not link the agent.")
      } finally {
        setPending(false)
      }
    },
    [projectId, displayName, profileProblem, effectiveProfile, projectAgents.length, onLinked]
  )

  const handleReset = useCallback(() => {
    setResult(null)
    setError(null)
    setDisplayName("")
    setProfile("")
  }, [])

  // The BACKEND origin, not this page's: an agent runs headless and must not
  // depend on the frontend being up (in dev the app is Vite on :5173, proxying
  // /api to :8000). `API_BASE_URL` is the real backend when configured; the page
  // origin covers a same-origin deployment.
  const server = API_BASE_URL || window.location.origin
  const entry = result
    ? {
        agent_id: result.taskflow_profile.agent_id,
        key: result.taskflow_profile.key,
        display_name: result.taskflow_profile.display_name,
      }
    : null
  const profileSnippet = result && entry ? `"${result.profile}": ${JSON.stringify(entry, null, 2)}` : ""
  const fileSnippet =
    result && entry
      ? JSON.stringify(
          { server, project: result.project, default_profile: result.profile, profiles: { [result.profile]: entry } },
          null,
          2
        )
      : ""

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      {result ? (
        <div className="space-y-3">
          <StepTitle n={3} icon={<KeyRoundIcon className="size-4 text-primary" />}>
            Save the credential in your repo
          </StepTitle>
          <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
            <CheckCircle2Icon className="mt-1 size-4 shrink-0 text-emerald-600" />
            <span>
              Linked <span className="font-semibold text-foreground">{result.display_name}</span> as profile{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{result.profile}</code>.
            </span>
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
            <LockIcon className="size-3.5 shrink-0" />
            The key below is shown once and cannot be recovered — save it now.
          </div>

          <Tabs defaultValue={hadAgents ? "entry" : "file"}>
            <TabsList className={SEGMENTED_LIST}>
              <TabsTrigger value="entry" className={SEGMENTED_TRIGGER}>Add to existing .taskflow.json</TabsTrigger>
              <TabsTrigger value="file" className={SEGMENTED_TRIGGER}>New .taskflow.json</TabsTrigger>
            </TabsList>
            <TabsContent value="entry" className="mt-3 space-y-2">
              <p className="text-xs leading-5 text-muted-foreground">
                Paste this inside <code className="rounded bg-muted px-1 py-0.5">"profiles"</code> in the{" "}
                <code className="rounded bg-muted px-1 py-0.5">.taskflow.json</code> your other agents already use (add a
                comma after the previous profile).
              </p>
              <Snippet value={profileSnippet} />
            </TabsContent>
            <TabsContent value="file" className="mt-3 space-y-2">
              <p className="text-xs leading-5 text-muted-foreground">
                Save this as <code className="rounded bg-muted px-1 py-0.5">.taskflow.json</code> in the repo root and add
                it to <code className="rounded bg-muted px-1 py-0.5">.gitignore</code> — it holds a secret.
              </p>
              <Snippet value={fileSnippet} />
            </TabsContent>
          </Tabs>

          <p className="text-xs leading-5 text-muted-foreground">
            With several profiles in one file, start each agent with{" "}
            <code className="rounded bg-muted px-1 py-0.5">TASKFLOW_PROFILE={result.profile}</code>, or it will ask which
            one it is on first use.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={handleReset}>
            <RotateCcwIcon />
            Link another agent
          </Button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={handleSubmit}>
          <StepTitle n={2} icon={<BotIcon className="size-4 text-primary" />}>
            Link a coding agent
          </StepTitle>
          <p className="text-sm leading-6 text-muted-foreground">
            Creates the agent's identity in this project and a key for it.
          </p>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Display name</span>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="e.g. Claude (builder)"
              maxLength={80}
              disabled={pending}
            />
            <span className="text-xs text-muted-foreground">How it appears in chat, on tasks and in activity.</span>
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Profile</span>
            <Input
              value={profile}
              onChange={(event) => setProfile(event.target.value.toLowerCase())}
              placeholder={suggested || "e.g. reviewer"}
              maxLength={32}
              spellCheck={false}
              autoCapitalize="off"
              disabled={pending}
              aria-invalid={profile !== "" && !!profileProblem}
              className="font-mono"
            />
            <span className={cn("text-xs", profile !== "" && profileProblem ? "text-rose-600" : "text-muted-foreground")}>
              {profile !== "" && profileProblem
                ? profileProblem
                : profileTakenBy
                  ? `Already used by ${profileTakenBy} — pick another name to keep both in one .taskflow.json.`
                  : "The identity's key inside .taskflow.json. The first agent is usually main."}
            </span>
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

function Snippet({ value }: { value: string }) {
  return (
    <div className="relative">
      <pre className="max-h-72 overflow-auto rounded-lg border bg-background p-3 pr-24 font-mono text-xs leading-5">{value}</pre>
      <CopyButton value={value} className="absolute top-2 right-2" />
    </div>
  )
}

/// Every agent linked to this project: who it is, whether it is online, and
/// what credential it holds — the page's answer to "which agents do I have?".
export function AgentsList({
  agents,
  sessions,
  credentials,
}: {
  agents: TaskflowWorkspace["agents"]
  sessions: TaskflowWorkspace["agentSessions"]
  credentials: TaskflowWorkspace["agentCredentials"]
}) {
  const now = useLivenessNow()
  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <BotIcon className="size-4 text-primary" />
          Agents in this project
        </div>
        <span className="text-xs text-muted-foreground">
          {agents.length} linked · {agents.filter((a) => sessions.some((s) => s.agent === a.id && isSessionLive(s, now))).length} online
        </span>
      </div>
      {agents.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No agents yet. Link one above — it appears here as soon as it is created.
        </p>
      ) : (
        <ul className="divide-y">
          {agents.map((agent) => {
            const live = sessions.filter((s) => s.agent === agent.id && isSessionLive(s, now))
            const lastSeen = [agent.last_seen_at, ...sessions.filter((s) => s.agent === agent.id).map((s) => s.last_seen_at)]
              .filter((v): v is string => !!v)
              .sort()
              .pop()
            const keys = credentials.filter((c) => c.agent === agent.id)
            const active = keys.find((c) => c.status === "active")
            const profile = profileOf(agent.identifier)
            return (
              <li key={agent.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <BotIcon className="size-4" />
                  <span
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card",
                      live.length ? "bg-emerald-500" : "bg-zinc-400"
                    )}
                    title={live.length ? "Online" : "Offline"}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{agent.display_name}</span>
                    {profile ? (
                      <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{profile}</code>
                    ) : null}
                    <span className={cn("text-xs", live.length ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                      {live.length ? `Online${live.length > 1 ? ` · ${live.length} sessions` : ""}` : "Offline"}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {[
                      lastSeen ? `Last seen ${formatLiveDate(lastSeen, "—")}` : "Never connected",
                      agent.linked_user_label ? `linked by ${agent.linked_user_label}` : null,
                      agent.project_root,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="text-right text-xs">
                  {active ? (
                    <span className="inline-flex items-center gap-1 font-mono text-muted-foreground" title="Active key (prefix)">
                      <KeyRoundIcon className="size-3.5" />
                      {active.key_prefix}…
                    </span>
                  ) : (
                    <span className="text-rose-600">No active key</span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
