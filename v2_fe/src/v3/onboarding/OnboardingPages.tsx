/// v3 onboarding (group 2, second half), from docs/v3-design/pages/onboarding*.html:
/// who uses TaskFlow → name the project → pick two agents → connect them →
/// watch the second reply to the first. Every step is real: the project is
/// created, the agents are linked and their keys minted, the connect step
/// watches their live sessions, and the handshake is a real message in the
/// project room answered by a real agent.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import type { TaskflowAgentMessage } from "@/api/client"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowRightIcon, BuildingIcon, CheckIcon, CircleDashedIcon, MessagesSquareIcon, TriangleAlertIcon, UserIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Textarea } from "@/components/ui/textarea"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { API_BASE_URL } from "@/lib/auth-api"
import { linkAgent, sendTaskflowAgentMessage, setProjectAgentInstructions } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { ActorAvatar } from "../components/actor-avatar"
import { CopyBlock } from "../components/copy-block"
import { ModelPicker } from "../components/model-picker"
import { BrandMark } from "../marketing/public-chrome"
import { useWorkspace } from "../workspace"
import { agentConnectState, draftsWithLinked, handshakeStage, initCommand, kickoffBody, linkDrafts, PAIRINGS, projectRoom, taskflowJson, validateAgents, type AgentDraft, type LinkedAgent } from "./onboarding-logic"
import { onboardingStore } from "./onboarding-store"

const STEPS = ["Project", "Agents", "Connect", "Say hello"] as const

function Steps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label="Setup steps">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = n < current
        const on = n === current
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "grid size-6 place-items-center rounded-full text-xs font-medium",
                done ? "bg-primary text-primary-foreground" : on ? "border-2 border-primary text-foreground" : "border border-border text-muted-foreground",
              )}
              aria-hidden
            >
              {done ? <CheckIcon className="size-3.5" /> : n}
            </span>
            <span className={cn(on ? "font-medium" : "text-muted-foreground")} aria-current={on ? "step" : undefined}>
              {label}
            </span>
            {n < STEPS.length ? <span className="mx-1 h-px w-6 bg-border" aria-hidden /> : null}
          </li>
        )
      })}
    </ol>
  )
}

function OnboardingLayout({ step, wide, children }: { step?: number; wide?: boolean; children: ReactNode }) {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5">
        <BrandMark />
        <Button variant="ghost" nativeButton={false} render={<Link to="/v3/board" onClick={() => onboardingStore.clear()} />}>
          Skip setup
        </Button>
      </header>
      <main id="main" className={cn("mx-auto w-full px-5 pb-20 pt-6", wide ? "max-w-5xl" : "max-w-2xl")}>
        {step ? (
          <div className="mb-10">
            <Steps current={step} />
          </div>
        ) : null}
        {children}
      </main>
    </div>
  )
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {children ? <p className="mt-2 text-muted-foreground">{children}</p> : null}
    </div>
  )
}

// ── Step 0: who will use TaskFlow ─────────────────────────────────────────

export function OnboardingTeamPage() {
  const navigate = useNavigate()
  return (
    <OnboardingLayout>
      <Heading title="Who will use TaskFlow?">This decides who can see your projects and which licence applies.</Heading>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => navigate("/v3/onboarding/project")}
          className="flex flex-col items-start gap-2 rounded-2xl border-2 border-primary bg-card p-5 text-left transition-colors hover:bg-accent/40"
        >
          <UserIcon className="size-5" />
          <span className="font-medium">Just me</span>
          <span className="text-sm text-muted-foreground">You and your agents. Projects live in your personal space.</span>
        </button>
        <div className="flex flex-col items-start gap-2 rounded-2xl border border-dashed border-border p-5 text-left" aria-disabled="true">
          <BuildingIcon className="size-5 text-muted-foreground" />
          <span className="flex items-center gap-2 font-medium text-muted-foreground">
            A team <Badge variant="secondary">Coming with organisations</Badge>
          </span>
          <span className="text-sm text-muted-foreground">
            Shared projects, people and one budget. Start on your own for now; you can invite people to any project from its Invites page.
          </span>
        </div>
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        TaskFlow is free for personal, research and open-source work. Work for a business or paying clients needs a{" "}
        <Link to="/v3/pricing" className="font-medium text-link underline-offset-4 hover:underline">
          commercial licence
        </Link>
        .
      </p>
    </OnboardingLayout>
  )
}

// ── Step 1: name the project ──────────────────────────────────────────────

export function OnboardingProjectPage() {
  const navigate = useNavigate()
  const { createProject } = useWorkspace()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const name = String(f.get("name") ?? "").trim()
    const brief = String(f.get("brief") ?? "").trim()
    if (!name) {
      setNameError("Give the project a name.")
      return
    }
    setNameError(null)
    setPending(true)
    setError(null)
    try {
      const { id } = await createProject({ name, description_markdown: brief || undefined })
      // The brief becomes the project's instructions, which every agent reads at whoami.
      if (brief) await setProjectAgentInstructions(Number(id), brief).catch(() => undefined)
      onboardingStore.setProject(id)
      navigate("/v3/onboarding/agents")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the project.")
    } finally {
      setPending(false)
    }
  }

  return (
    <OnboardingLayout step={1}>
      <Heading title="Name your project">A project holds one board, its chat rooms and the agents working on it. You'll connect two agents next.</Heading>
      {error ? (
        <Alert variant="destructive" className="mt-6 rounded-xl">
          <TriangleAlertIcon />
          <AlertDescription className="text-foreground">{error}</AlertDescription>
        </Alert>
      ) : null}
      <form className="mt-8" onSubmit={submit} noValidate>
        <FieldGroup className="gap-6">
          <Field data-invalid={nameError ? true : undefined}>
            <FieldLabel htmlFor="name">Project name</FieldLabel>
            <Input id="name" name="name" autoComplete="off" autoFocus placeholder="Matchday league site" className="h-11 rounded-xl text-base" />
            {nameError ? <FieldError>{nameError}</FieldError> : <FieldDescription>You can rename it later in project settings.</FieldDescription>}
          </Field>
          <Field>
            <FieldLabel htmlFor="brief">
              What are you building? <span className="font-normal text-muted-foreground">Optional</span>
            </FieldLabel>
            <Textarea
              id="brief"
              name="brief"
              rows={4}
              placeholder="For example: a five-a-side league site with fixtures, tables and team pages"
              className="rounded-xl text-base"
            />
            <FieldDescription>Every agent reads this as the project's instructions, so a sentence or two is enough.</FieldDescription>
          </Field>
          <div className="flex justify-end">
            <Button type="submit" size="lg" className="h-11 rounded-xl" disabled={pending}>
              {pending ? <Spinner /> : null}
              {pending ? "Creating…" : "Continue to agents"}
              {pending ? null : <ArrowRightIcon />}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </OnboardingLayout>
  )
}

// ── Step 2: pick two agents ───────────────────────────────────────────────

export function OnboardingAgentsPage() {
  const navigate = useNavigate()
  const projectId = onboardingStore.projectId()
  // `?pairing=` preselects a pair picked on the new-project page.
  const [searchParams] = useSearchParams()
  const initial = PAIRINGS.find((p) => p.id === searchParams.get("pairing")) ?? PAIRINGS[0]
  const [pairing, setPairing] = useState(initial.id)
  // #1119: agents that already linked (a retry after agent 2 failed, or Back
  // from Connect) keep their profile and model; their cards are read-only.
  const [linked, setLinked] = useState<LinkedAgent[]>(() => onboardingStore.agents())
  const [agents, setAgents] = useState<[AgentDraft, AgentDraft]>(() => draftsWithLinked(initial.agents, onboardingStore.agents()))
  const [errors, setErrors] = useState<(string | null)[]>([null, null])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!projectId) return <Navigate to="/v3/onboarding/project" replace />

  const isLinked = (i: 0 | 1) => linked[i] != null
  const update = (i: 0 | 1, patch: Partial<AgentDraft>) => {
    if (isLinked(i)) return
    setPairing("")
    setAgents((cur) => {
      const next = [...cur] as [AgentDraft, AgentDraft]
      next[i] = { ...next[i], ...patch }
      return next
    })
  }

  async function submit() {
    const found = validateAgents(agents)
    setErrors(found)
    if (found.some(Boolean)) return
    setPending(true)
    setError(null)
    try {
      await linkDrafts(
        agents,
        onboardingStore.agents(),
        (a) => linkAgent({ project: Number(projectId), display_name: a.displayName.trim(), profile: a.profile, runtime: a.model }),
        // Stored after every link, so a failure on agent 2 keeps agent 1's key.
        (soFar) => {
          onboardingStore.setAgents(soFar)
          setLinked(soFar)
        },
      )
      navigate("/v3/onboarding/connect")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the agents.")
    } finally {
      setPending(false)
    }
  }

  return (
    <OnboardingLayout step={2} wide>
      <Heading title="Pick two agents to work together">TaskFlow works best when one agent checks another's work. Agents from different models catch different mistakes.</Heading>

      <section className="mt-8" aria-labelledby="pairings">
        <h2 id="pairings" className="text-sm font-medium">
          Start from a pairing
        </h2>
        <div role="radiogroup" aria-labelledby="pairings" className="mt-3 grid gap-3 md:grid-cols-3">
          {PAIRINGS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={pairing === p.id}
              disabled={linked.length > 0}
              title={linked.length > 0 ? "An agent is already linked; its profile and model stay as they are." : undefined}
              onClick={() => {
                setPairing(p.id)
                setAgents(draftsWithLinked(p.agents, linked))
                setErrors([null, null])
              }}
              className={cn(
                "flex items-start gap-3 rounded-2xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                pairing === p.id ? "border-ring bg-accent/50 ring-2 ring-ring/20" : "border-border hover:bg-accent/40",
              )}
            >
              <span className="flex -space-x-1.5 pt-0.5">
                {p.agents.map((a, i) => (
                  <ActorAvatar key={i} model={a.model} name={a.displayName} size="sm" />
                ))}
              </span>
              <span>
                <span className="block text-sm font-medium">{p.title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">{p.detail}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {([0, 1] as const).map((i) => (
          <fieldset key={i} className="rounded-2xl border border-border bg-card p-5">
            <legend className="sr-only">{i === 0 ? "First agent" : "Second agent"}</legend>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-medium">{i === 0 ? "First agent" : "Second agent"}</h2>
              {isLinked(i) ? (
                <Badge variant="secondary" title="Already created. Its profile and model are fixed, so a retry reuses it.">
                  <CheckIcon />
                  Linked
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Profile <code className="font-mono">{agents[i].profile}</code>
                </span>
              )}
            </div>
            <fieldset disabled={isLinked(i)} className="contents">
            <ModelPicker name={i === 0 ? "First agent" : "Second agent"} value={agents[i].model} onChange={(m) => update(i, { model: m })} />
            <FieldGroup className="mt-5 gap-4 sm:grid sm:grid-cols-2">
              <Field data-invalid={errors[i] && !/Profile|own profile/.test(errors[i]!) ? true : undefined}>
                <FieldLabel htmlFor={`name-${i}`}>Display name</FieldLabel>
                <Input id={`name-${i}`} value={agents[i].displayName} onChange={(e) => update(i, { displayName: e.target.value })} className="h-10 rounded-xl" />
              </Field>
              <Field data-invalid={errors[i] && /Profile|own profile/.test(errors[i]!) ? true : undefined}>
                <FieldLabel htmlFor={`profile-${i}`}>Profile</FieldLabel>
                <Input
                  id={`profile-${i}`}
                  value={agents[i].profile}
                  onChange={(e) => update(i, { profile: e.target.value.toLowerCase() })}
                  spellCheck={false}
                  readOnly={isLinked(i)}
                  className="h-10 rounded-xl font-mono"
                />
              </Field>
            </FieldGroup>
            </fieldset>
            {errors[i] ? <FieldError className="mt-2">{errors[i]}</FieldError> : null}
          </fieldset>
        ))}
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-6 rounded-xl">
          <TriangleAlertIcon />
          <AlertDescription className="text-foreground">{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-8 flex items-center justify-between gap-3">
        <Button variant="ghost" nativeButton={false} render={<Link to="/v3/onboarding/project" />}>
          Back
        </Button>
        <Button size="lg" className="h-11 rounded-xl" disabled={pending} onClick={() => void submit()}>
          {pending ? <Spinner /> : null}
          {pending ? "Creating agents…" : "Create both agents"}
          {pending ? null : <ArrowRightIcon />}
        </Button>
      </div>
    </OnboardingLayout>
  )
}

// ── Step 3: connect them ──────────────────────────────────────────────────

function useOnboardingLive() {
  const ws = useWorkspace()
  const { setChatSurfaceMounted } = ws
  // Chat and terminal slices for the room and agents (App's one stream).
  useEffect(() => {
    setChatSurfaceMounted(true)
    return () => setChatSurfaceMounted(false)
  }, [setChatSurfaceMounted])
  return ws
}

function ConnectCard({ agent, state, lastSeen }: { agent: LinkedAgent; state: "waiting" | "connected"; lastSeen: string | null }) {
  const cli = agent.model === "codex" ? "codex" : agent.model === "gemini" ? "gemini" : agent.model === "claude" ? "claude" : "your agent's command"
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <ActorAvatar model={agent.model} name={agent.displayName} status={state === "connected" ? "running" : "offline"} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{agent.displayName}</p>
          <p className="text-xs text-muted-foreground">
            Profile <code className="font-mono">{agent.profile}</code>
          </p>
        </div>
        {state === "connected" ? (
          <Badge className="gap-1.5 bg-running/10 text-running">
            <span className="size-1.5 rounded-full bg-running" />
            Connected
          </Badge>
        ) : (
          <Badge variant="secondary" className="gap-1.5">
            <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
            Waiting
          </Badge>
        )}
      </div>
      {state === "connected" ? (
        <p className="mt-4 text-sm text-muted-foreground">Connected{lastSeen ? `, last seen ${new Date(lastSeen).toLocaleTimeString()}` : ""}.</p>
      ) : (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">In a new terminal, in your repo:</p>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-terminal p-3 font-mono text-xs leading-5 text-terminal-foreground">
            {`tmux new -s ${agent.profile}\nTASKFLOW_PROFILE=${agent.profile} ${cli}`}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">Then ask it to call whoami. This card turns green the moment it does.</p>
        </div>
      )}
    </div>
  )
}

export function OnboardingConnectPage() {
  const navigate = useNavigate()
  const { live } = useOnboardingLive()
  const now = useLivenessNow()
  const projectId = onboardingStore.projectId()
  const agents = useMemo(() => onboardingStore.agents(), [])
  if (!projectId || agents.length < 2) return <Navigate to={projectId ? "/v3/onboarding/agents" : "/v3/onboarding/project"} replace />

  const sessions = live?.agentSessions ?? []
  const states = agents.map((a) => agentConnectState(a.agentId, sessions, now))
  const allConnected = states.every((s) => s.state === "connected")
  const keysKnown = agents.every((a) => a.key)
  const server = API_BASE_URL || window.location.origin

  return (
    <OnboardingLayout step={3} wide>
      <Heading title="Connect both agents">Three steps in your terminal. This page notices each agent the moment it connects.</Heading>
      <ol className="mt-8 space-y-8">
        <li>
          <h2 className="font-medium">1. Install TaskFlow</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Once per machine. <code className="font-mono text-xs">taskflow init</code> adds TaskFlow to your agents for you.
          </p>
          <div className="mt-3 max-w-2xl">
            <CopyBlock label="Terminal" text={initCommand(agents.map((a) => a.model))} />
          </div>
        </li>
        <li>
          <h2 className="font-medium">2. Save the keys</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Put this file at your repo root as <code className="font-mono text-xs">.taskflow.json</code>, and add it to <code className="font-mono text-xs">.gitignore</code>.
          </p>
          <Alert className="mt-3 max-w-2xl rounded-xl border-blocked/40 bg-blocked/10">
            <TriangleAlertIcon className="text-blocked" />
            <AlertDescription className="text-foreground">
              {keysKnown
                ? "These keys are shown once. Copy the file now. If you lose it, make new keys on the Agents page."
                : "The keys were shown once and this page was reloaded, so they're gone. Make new keys on the Agents page and put them in the file."}
            </AlertDescription>
          </Alert>
          <div className="mt-3 max-w-2xl">
            <CopyBlock label=".taskflow.json" text={taskflowJson(server, Number(projectId), agents)} />
          </div>
        </li>
        <li>
          <h2 className="font-medium">3. Start each agent</h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {agents.map((a, i) => (
              <ConnectCard key={a.agentId} agent={a} state={states[i].state} lastSeen={states[i].lastSeen} />
            ))}
          </div>
          {!allConnected ? (
            <details className="mt-4 max-w-2xl rounded-xl border border-border p-4 text-sm">
              <summary className="cursor-pointer font-medium">Not connecting?</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Check the file is at the repo root and named exactly .taskflow.json.</li>
                <li>
                  Check <code className="font-mono text-xs">server</code> is <code className="font-mono text-xs">{server}</code>, the API address, not the web app's.
                </li>
                <li>Restart the agent after saving the file, and ask it to call whoami.</li>
              </ul>
            </details>
          ) : null}
        </li>
      </ol>
      <div className="mt-10 flex items-center justify-between gap-3">
        <Button variant="ghost" nativeButton={false} render={<Link to="/v3/onboarding/agents" />}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          {!allConnected ? <p className="hidden text-sm text-muted-foreground sm:block">Available once both agents are connected</p> : null}
          <Button size="lg" className="h-11 rounded-xl" disabled={!allConnected} onClick={() => navigate("/v3/onboarding/hello")}>
            Start their first conversation
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  )
}

// ── Step 4: the handshake ─────────────────────────────────────────────────

export function OnboardingHelloPage() {
  const { live } = useOnboardingLive()
  const projectId = onboardingStore.projectId()
  const agents = useMemo(() => onboardingStore.agents(), [])
  const [kickoffId, setKickoffId] = useState<number | null>(() => onboardingStore.kickoffId())
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const room = projectRoom(live?.agentChannels ?? [])
  const messages = useMemo(
    // Only stored messages: optimistic ones (still sending) have no id yet.
    () =>
      room
        ? (live?.agentMessages ?? [])
            .filter((m): m is TaskflowAgentMessage => "id" in m && typeof m.id === "number" && m.channel === room.id)
            .sort((a, b) => a.id - b.id)
        : [],
    [live?.agentMessages, room],
  )

  if (!projectId || agents.length < 2) return <Navigate to="/v3/onboarding/project" replace />
  const [first, second] = agents
  const stage = handshakeStage(messages, kickoffId, first.agentId, second.agentId)

  async function start() {
    if (!room) return
    setSending(true)
    setError(null)
    try {
      const sent = await sendTaskflowAgentMessage({
        channel: room.id,
        body_markdown: kickoffBody(first, second),
        targets: [{ kind: "agent", id: first.agentId }],
      })
      onboardingStore.setKickoff(sent.id)
      setKickoffId(sent.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't post the message.")
    } finally {
      setSending(false)
    }
  }

  const transcript = kickoffId == null ? [] : messages.filter((m) => m.id >= kickoffId)
  const title =
    stage === "complete"
      ? `${second.displayName} just replied to ${first.displayName}.`
      : stage === "waiting-reply"
        ? `${first.displayName} said hello. ${second.displayName} is reading it.`
        : stage === "first-speaking"
          ? `Asked ${first.displayName} to say hello.`
          : "Let them meet"

  return (
    <OnboardingLayout step={4} wide>
      <div role="status" aria-live="polite">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {stage === "complete" ? (
            <CheckIcon className="size-4 text-running" />
          ) : stage !== "not-started" ? (
            <Spinner className="size-4" />
          ) : (
            <MessagesSquareIcon className="size-4" />
          )}
          {stage === "complete" ? "Handshake complete" : stage === "not-started" ? "Last step" : "Waiting for a reply"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          {stage === "complete"
            ? "From here, give them a task and watch them pass it between them."
            : stage === "not-started"
              ? `TaskFlow will ask ${first.displayName} to greet ${second.displayName} in the project room. ${second.displayName} answers on its own, from its own terminal.`
              : "The message has reached the agent's terminal. Replies usually take under a minute."}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-6 rounded-xl">
          <TriangleAlertIcon />
          <AlertDescription className="text-foreground">{error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="mt-8 overflow-hidden rounded-2xl border border-border bg-card" aria-labelledby="room-title">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id="room-title" className="font-medium">
            Project room
          </h2>
          <span className="flex -space-x-1">
            <ActorAvatar model={first.model} name={first.displayName} size="xs" />
            <ActorAvatar model={second.model} name={second.displayName} size="xs" />
          </span>
        </div>
        {transcript.length ? (
          <ol className="space-y-4 p-5">
            {transcript.map((m) => {
              const who = m.sender_agent === first.agentId ? first : m.sender_agent === second.agentId ? second : null
              return (
                <li key={m.id} className="flex items-start gap-3">
                  {who ? <ActorAvatar model={who.model} name={who.displayName} size="md" /> : <ActorAvatar name={m.sender_label ?? "You"} size="md" />}
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{who?.displayName ?? m.sender_label ?? "You"}</span>{" "}
                      {m.created_at ? new Date(m.created_at).toLocaleTimeString() : ""}
                    </p>
                    <MarkdownRenderer content={m.body_markdown} compact className="mt-0.5 text-sm" />
                  </div>
                </li>
              )
            })}
          </ol>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">{room ? "Nothing here yet." : "Loading the project room…"}</p>
        )}
      </section>

      <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
        {stage === "not-started" ? (
          <Button size="lg" className="h-11 rounded-xl" disabled={!room || sending} onClick={() => void start()}>
            {sending ? <Spinner /> : null}
            {sending ? "Posting…" : `Ask ${first.displayName} to say hello`}
          </Button>
        ) : stage === "complete" ? (
          <>
            <Button variant="outline" size="lg" className="h-11 rounded-xl" nativeButton={false} render={<Link to="/v3/chat" onClick={() => onboardingStore.clear()} />}>
              Open the project room
            </Button>
            <Button size="lg" className="h-11 rounded-xl" nativeButton={false} render={<Link to="/v3/board" onClick={() => onboardingStore.clear()} />}>
              Give them a first task
              <ArrowRightIcon />
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No reply after a minute? Check the agent's terminal is still running, then{" "}
            <Link to="/v3/onboarding/connect" className="font-medium text-link underline-offset-4 hover:underline">
              check the connection
            </Link>
            .
          </p>
        )}
      </div>
    </OnboardingLayout>
  )
}
