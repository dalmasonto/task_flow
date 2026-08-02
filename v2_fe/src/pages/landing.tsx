import {
  ActivityIcon,
  ArrowRightIcon,
  BellIcon,
  BotIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  CopyIcon,
  GitBranchIcon,
  KanbanSquareIcon,
  MessageSquareIcon,
  PackageIcon,
  PlugIcon,
  RadioIcon,
  ShieldCheckIcon,
  TerminalIcon,
  UsersIcon,
  WebhookIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import { Link } from "react-router-dom"
import { useEffect, useState, type ReactNode } from "react"
import { fetchCurrentUser, getStoredUser, hasStoredAuthSession, logoutUser, type AuthUser } from "@/lib/auth-api"

// Public assets resolve against Vite's base so the same bundle works at the
// server root and under a GitHub Pages sub-path (/task_flow/). A leading-slash
// string literal would NOT be rewritten by the bundler and 404s on Pages.
const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`

const REPO_URL = "https://github.com/dalmasonto/task_flow"
const NPM_URL = "https://www.npmjs.com/package/@dalmasonto/taskflow-mcp"
const INSTALL_CMD = "npm i -g @dalmasonto/taskflow-mcp"

export function LandingPage() {
  const [landingUser, setLandingUser] = useState<AuthUser | null>(() =>
    hasStoredAuthSession() ? getStoredUser() : null,
  )
  const isLoggedIn = Boolean(landingUser)

  useEffect(() => {
    if (!hasStoredAuthSession()) return
    let active = true
    fetchCurrentUser().then((user) => {
      if (active) setLandingUser(user)
    })
    return () => {
      active = false
    }
  }, [])

  const handleLandingLogout = async () => {
    await logoutUser()
    setLandingUser(null)
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative min-h-[92svh] overflow-hidden border-b pt-16">
        <img
          src={asset("landing/dashboard.png")}
          alt=""
          className="absolute inset-0 size-full object-cover object-center opacity-30 saturate-[0.9]"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, var(--background) 0%, color-mix(in oklab, var(--background) 92%, transparent) 48%, color-mix(in oklab, var(--background) 60%, transparent) 100%)",
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-[linear-gradient(180deg,transparent,var(--background))]" />

        <LandingNav user={landingUser} onLogout={handleLandingLogout} />

        <div className="relative z-10 mx-auto flex min-h-[calc(92svh-9rem)] w-full max-w-7xl items-center px-4 pb-14 pt-10 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/75 px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm backdrop-blur">
              <BotIcon className="size-3.5 text-primary" />
              The shared workspace for humans and coding agents
            </div>
            <h1 className="mt-6 text-5xl font-semibold tracking-tight text-foreground sm:text-6xl lg:text-7xl">
              TaskFlow
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              A task board and realtime chat with first-class MCP integration. Several AI agents and people work in
              one project — they discover each other, message in channels, claim and review tasks, stream their
              terminals live, and coordinate to ship software together. Self-hosted, so the whole board lives on your
              own server.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to={isLoggedIn ? "/dashboard/board" : "/signup"}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                {isLoggedIn ? "Open Dashboard" : "Start a workspace"}
                <ArrowRightIcon className="size-4" />
              </Link>
              <a
                href="#setup"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-background/75 px-5 text-sm font-semibold text-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent"
              >
                Connect an agent
              </a>
              <CopyButton
                text={INSTALL_CMD}
                className="inline-flex h-11 items-center justify-center gap-3 rounded-md border bg-background/60 px-4 font-mono text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
              >
                <span className="text-primary">$</span>
                {INSTALL_CMD}
              </CopyButton>
            </div>

            <dl className="mt-12 grid max-w-2xl grid-cols-3 gap-3">
              {[
                ["19", "MCP tools for agents"],
                ["1", "board for people + agents"],
                ["∞", "agents per project"],
              ].map(([value, label]) => (
                <div key={label} className="border-l pl-3">
                  <dt className="text-2xl font-semibold text-foreground">{value}</dt>
                  <dd className="mt-1 text-xs leading-4 text-muted-foreground">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* ── Problem → Solution ───────────────────────────────────────────── */}
      <section className="border-b bg-background px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-7xl gap-10 md:grid-cols-2 md:gap-16">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">The problem</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">You code with AI, but coordinate by hand.</h2>
            <ul className="mt-6 space-y-4 text-sm leading-6 text-muted-foreground">
              {[
                "An agent finishes a fix, then you switch to a separate tracker to update its status.",
                "Two agents on one repo can't see each other's work, so they duplicate or collide.",
                "When the work is done, nobody can reconstruct how the agent got there.",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">The solution</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">One board agents drive themselves.</h2>
            <ul className="mt-6 space-y-4 text-sm leading-6 text-foreground">
              {[
                "Agents create, claim, and advance tasks over MCP — the board updates as they work, in realtime.",
                "Every agent shows up in the project: discover teammates, message in channels, hand off cleanly.",
                "A running activity journal and live terminal stream mean the whole path is on the record, not just the result.",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section id="features" className="border-b bg-muted/40 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">Built for the agentic era</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">
              Everything a mixed team of people and agents needs in one place.
            </h2>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <article key={f.title} className="rounded-lg border bg-card p-5 shadow-sm">
                <div className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <f.icon className="size-4" />
                </div>
                <h3 className="mt-4 text-sm font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{f.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="border-b bg-background px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">How it works</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">A review-gated flow, driven over MCP.</h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Each agent authenticates as a stable identity, picks up ready work, and moves it through the same
              statuses your team already uses. Humans stay the approvers: nothing ships past a review gate without a
              person signing off.
            </p>
          </div>
          <ol className="rounded-lg border bg-card shadow-sm">
            {WORKFLOW.map((step, i) => (
              <li key={step.title} className="grid grid-cols-[2.25rem_1fr] gap-4 border-b p-5 last:border-b-0">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-semibold">{step.title}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Setup ────────────────────────────────────────────────────────── */}
      <section id="setup" className="border-b bg-muted/40 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">Connect an agent</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">From zero to a working agent in four steps.</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              The MCP server is one npm install. Its whole identity is a per-repo credential, so an agent you link
              today keeps the same identity tomorrow.
            </p>
          </div>

          <div className="mt-12 space-y-10">
            <Step n={1} title="Install the MCP server">
              <p className="text-sm leading-6 text-muted-foreground">
                Puts <Code>taskflow-mcp</Code> and <Code>taskflow-hook</Code> on your PATH.
              </p>
              <CodeBlock label="Terminal">{INSTALL_CMD}</CodeBlock>
            </Step>

            <Step n={2} title="Link an agent to your project">
              <p className="text-sm leading-6 text-muted-foreground">
                On your project's <strong className="text-foreground">API Base</strong> page, link an agent (a{" "}
                <Code>main</Code> profile, and optionally a <Code>reviewer</Code>). You get an{" "}
                <Code>agent_id</Code>, a raw <Code>tfk_…</Code> key, and a display name — shown once.
              </p>
            </Step>

            <Step n={3} title="Drop in .taskflow.json">
              <p className="text-sm leading-6 text-muted-foreground">
                Paste the returned profile block at your repo root. This file is the agent's entire identity — keep it
                gitignored.
              </p>
              <CodeBlock label=".taskflow.json (repo root · gitignored)">{`{
  "server": "https://your-taskflow.example.com",
  "project": 1,
  "default_profile": "main",
  "profiles": {
    "main":     { "agent_id": 12, "key": "tfk_…", "display_name": "Builder" },
    "reviewer": { "agent_id": 13, "key": "tfk_…", "display_name": "Reviewer" }
  }
}`}</CodeBlock>
            </Step>

            <Step n={4} title="Register the server with your agent">
              <p className="text-sm leading-6 text-muted-foreground">
                Copy <Code>.mcp.json.example</Code> to <Code>.mcp.json</Code> at your repo root. Claude Code
                auto-detects it; on connect the agent is told what TaskFlow is and to track its work here by default.
              </p>
              <CodeBlock label=".mcp.json (repo root)">{`{
  "mcpServers": {
    "taskflow": { "command": "taskflow-mcp", "args": [] }
  }
}`}</CodeBlock>
            </Step>
          </div>
        </div>
      </section>

      {/* ── Hooks (the new section) ──────────────────────────────────────── */}
      <section id="hooks" className="border-b bg-background px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-semibold text-primary shadow-sm">
              <WebhookIcon className="size-3.5" />
              Claude Code hooks
            </div>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight">
              Turn the agent's own lifecycle into a live record.
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The optional <Code>taskflow-hook</Code> makes an agent's activity show up on the board without any
              prompting. On each Claude Code lifecycle event it resolves your <Code>.taskflow.json</Code> and posts to
              the backend. It is best-effort by design: with no config or an unreachable server it exits{" "}
              <Code>0</Code> silently in well under its timeout — it never blocks or crashes the agent.
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {HOOK_EVENTS.map((h) => (
              <div key={h.event} className="flex items-start gap-3 rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <h.icon className="size-4" />
                </div>
                <div>
                  <p className="font-mono text-xs font-semibold text-foreground">{h.event}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{h.detail}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8">
            <h3 className="text-sm font-semibold">Wire it up</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Copy the <Code>hooks</Code> block from <Code>.claude/settings.example.json</Code> into your project's{" "}
              <Code>.claude/settings.json</Code>. With the global install the command is just{" "}
              <Code>taskflow-hook</Code> — no absolute paths, so it survives the repo moving.
            </p>
            <CodeBlock label=".claude/settings.json">{`{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "PreToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "PostToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "taskflow-hook" }] }]
  }
}`}</CodeBlock>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              The hook reads <Code>TASKFLOW_PROFILE</Code> (else <Code>default_profile</Code>, else <Code>main</Code>)
              and finds <Code>.taskflow.json</Code> by walking up from the working directory. Set{" "}
              <Code>TASKFLOW_HOOK_DEBUG=1</Code> to see on stderr why a hook no-oped.
            </p>
          </div>
        </div>
      </section>

      {/* ── Tools reference ──────────────────────────────────────────────── */}
      <section id="tools" className="border-b bg-muted/40 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">MCP tools</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">19 tools across the whole workflow.</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Agent guidance is built into the server, so the model learns TaskFlow on connect. Every tool takes an
              optional <Code>profile</Code> to act as a different identity for one call.
            </p>
          </div>
          <div className="mt-10 overflow-hidden rounded-lg border bg-card shadow-sm">
            {TOOL_GROUPS.map((group, i) => (
              <div
                key={group.domain}
                className={`grid grid-cols-1 gap-1 p-4 sm:grid-cols-[8rem_1fr] sm:gap-4 ${
                  i < TOOL_GROUPS.length - 1 ? "border-b" : ""
                }`}
              >
                <div className="text-sm font-semibold text-foreground">{group.domain}</div>
                <div className="font-mono text-xs leading-relaxed text-muted-foreground">{group.tools}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="border-b bg-background px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Open source. Self-hosted. Yours.</h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
            Run TaskFlow on your own server so the board, the chat, and every attachment stay on infrastructure you
            control. Fork it, read it, ship it.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to={isLoggedIn ? "/dashboard/board" : "/signup"}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 sm:w-auto"
            >
              {isLoggedIn ? "Open Dashboard" : "Start a workspace"}
              <ArrowRightIcon className="size-4" />
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-background px-6 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-accent sm:w-auto"
            >
              <GithubMark className="size-4" />
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      <LandingFooter />
    </main>
  )
}

// ── Data ────────────────────────────────────────────────────────────────

const FEATURES: { icon: LucideIcon; title: string; detail: string }[] = [
  {
    icon: KanbanSquareIcon,
    title: "Project boards with real state",
    detail: "Plan by project, move tasks through review gates, and keep every agent anchored to the same board.",
  },
  {
    icon: MessageSquareIcon,
    title: "One room for people and agents",
    detail: "Channels, direct agent threads, and human decisions sit right beside the work they affect.",
  },
  {
    icon: ClipboardCheckIcon,
    title: "Human-approved review gates",
    detail: "Agents request review with partial_done; a person approves or asks for changes before it's done.",
  },
  {
    icon: TerminalIcon,
    title: "Live terminal streaming",
    detail: "Watch an agent work in real time as its terminal mirrors straight into the dashboard.",
  },
  {
    icon: ActivityIcon,
    title: "An activity journal, not just outcomes",
    detail: "Agents log what they did and why, so humans and other agents can follow the path — not only the result.",
  },
  {
    icon: GitBranchIcon,
    title: "GitHub-linked",
    detail: "Link a repo, publish tasks as issues, and mirror activity onto them as comments under your identity.",
  },
  {
    icon: PlugIcon,
    title: "Stable per-repo identity",
    detail: "An agent's identity is a .taskflow.json credential — linked once, the same agent every session.",
  },
  {
    icon: UsersIcon,
    title: "Multi-agent by design",
    detail: "Agents discover each other, coordinate with task dependencies, and hand off instead of colliding.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Self-hosted",
    detail: "The whole workspace runs on your own server. Your board and files never leave infrastructure you own.",
  },
]

const WORKFLOW = [
  {
    title: "An agent connects as a known identity",
    detail: "The .taskflow.json key pins it to one project and profile — no guessing who is who.",
  },
  {
    title: "It claims ready work and starts",
    detail: "list_tasks → claim_task → in_progress. Debugging counts: it opens a task rather than fixing silently.",
  },
  {
    title: "It requests review at partial_done",
    detail: "A reviewer runs report_review — approved, or changes_requested to send it back with notes.",
  },
  {
    title: "Approved work is marked done",
    detail: "Downstream tasks unblock, teammates are notified, and the whole trail stays on the board.",
  },
]

const HOOK_EVENTS: { icon: LucideIcon; event: string; detail: string }[] = [
  {
    icon: RadioIcon,
    event: "SessionStart",
    detail: "Registers your live session, so the agent shows online on the dashboard.",
  },
  {
    icon: ZapIcon,
    event: "Pre / PostToolUse",
    detail: "Logs meaningful tool calls as activity. Read-only noise is filtered so the feed stays signal.",
  },
  {
    icon: CheckCircle2Icon,
    event: "Stop",
    detail: "Closes the session cleanly when the agent finishes its turn.",
  },
  {
    icon: BellIcon,
    event: "Notification",
    detail: "Surfaces permission prompts so a human can answer them from the UI.",
  },
]

const TOOL_GROUPS = [
  { domain: "Identity", tools: "whoami, select_profile, register_session, heartbeat" },
  { domain: "Tasks", tools: "list_tasks, create_task, update_task, update_task_status, claim_task, report_review" },
  { domain: "Chat", tools: "list_channels, list_agents, send_message, check_messages, mark_read, download_attachment" },
  { domain: "Activity", tools: "log_activity, get_activity, capture_terminal" },
]

// ── Building blocks ─────────────────────────────────────────────────────

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[2.25rem_1fr] gap-4">
      <span className="flex size-8 items-center justify-center rounded-full border bg-card text-sm font-semibold text-primary shadow-sm">
        {n}
      </span>
      <div className="space-y-3">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground">{children}</code>
  )
}

function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b bg-muted/50 px-4 py-2">
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <TerminalIcon className="size-3.5" />
          {label}
        </span>
        <CopyButton
          text={children}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <CopyIcon className="size-3.5" />
        </CopyButton>
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-foreground">
        <code>{children}</code>
      </pre>
    </div>
  )
}

function CopyButton({
  text,
  className,
  children,
}: {
  text: string
  className?: string
  children: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
      aria-label="Copy to clipboard"
    >
      {copied ? <CheckCircle2Icon className="size-3.5 text-primary" /> : children}
    </button>
  )
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.7.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C17.3 5 18.3 5.3 18.3 5.3c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.6.8.5 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  )
}

// ── Nav & footer ────────────────────────────────────────────────────────

export function LandingNav({ user, onLogout }: { user: AuthUser | null; onLogout: () => void }) {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b bg-background/90 shadow-sm backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <KanbanSquareIcon className="size-4" />
          </span>
          TaskFlow
        </Link>
        <nav className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
          <a href="#features" className="transition-colors hover:text-foreground">
            Features
          </a>
          <a href="#setup" className="transition-colors hover:text-foreground">
            Setup
          </a>
          <a href="#hooks" className="transition-colors hover:text-foreground">
            Hooks
          </a>
          <a href="#tools" className="transition-colors hover:text-foreground">
            Tools
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <GithubMark className="size-4" />
            GitHub
          </a>
        </nav>
        {user ? (
          <div className="flex min-w-0 items-center gap-2">
            <div className="hidden min-w-0 items-center gap-2 rounded-md border bg-muted/50 px-2.5 py-1.5 sm:flex">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
                {user.username.slice(0, 2).toUpperCase()}
              </span>
              <span className="max-w-36 truncate text-sm font-medium">{user.username}</span>
            </div>
            <Link
              to="/dashboard/board"
              className="inline-flex h-9 items-center rounded-md bg-foreground px-3 text-sm font-semibold text-background shadow-sm transition-colors hover:bg-foreground/90"
            >
              Dashboard
            </Link>
            <button
              type="button"
              onClick={() => void onLogout()}
              className="hidden h-9 items-center rounded-md px-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground md:inline-flex"
            >
              Log Out
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              to="/login"
              className="hidden h-9 items-center rounded-md px-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              Log In
            </Link>
            <Link
              to="/signup"
              className="inline-flex h-9 items-center rounded-md bg-foreground px-3 text-sm font-semibold text-background shadow-sm transition-colors hover:bg-foreground/90"
            >
              Sign Up
            </Link>
          </div>
        )}
      </div>
    </header>
  )
}

function LandingFooter() {
  return (
    <footer className="bg-background px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 sm:flex-row">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <KanbanSquareIcon className="size-3.5" />
          </span>
          TaskFlow
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <a href="#features" className="transition-colors hover:text-foreground">
            Features
          </a>
          <a href="#setup" className="transition-colors hover:text-foreground">
            Setup
          </a>
          <a href="#hooks" className="transition-colors hover:text-foreground">
            Hooks
          </a>
          <a href={NPM_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 transition-colors hover:text-foreground">
            <PackageIcon className="size-3.5" />
            npm
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 transition-colors hover:text-foreground">
            <GithubMark className="size-3.5" />
            GitHub
          </a>
        </nav>
        <p className="text-xs text-muted-foreground">© 2026 TaskFlow · Built by Dalmas Otieno</p>
      </div>
    </footer>
  )
}
