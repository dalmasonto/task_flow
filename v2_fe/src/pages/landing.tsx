import { ArrowRightIcon, BotIcon, FileJsonIcon, KanbanSquareIcon, MessageSquareIcon, ShieldCheckIcon } from "lucide-react"
import { Link } from "react-router-dom"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { fetchCurrentUser, getStoredUser, hasStoredAuthSession, logoutUser, type AuthUser } from "@/lib/auth-api"
import { useEffect, useState } from "react"


export function LandingPage() {
  const [landingUser, setLandingUser] = useState<AuthUser | null>(() =>
    hasStoredAuthSession() ? getStoredUser() : null
  )
  const isLoggedIn = Boolean(landingUser)
  const landingFeatures = [
    {
      icon: KanbanSquareIcon,
      title: "Project boards with real state",
      detail: "Plan work by project, drag tasks through review gates, and keep every agent anchored to the same board.",
    },
    {
      icon: MessageSquareIcon,
      title: "One room for people and agents",
      detail: "Group chats, direct agent threads, terminal views, and human decisions sit beside the work they affect.",
    },
    {
      icon: FileJsonIcon,
      title: "API-first from the start",
      detail: "The UI is ready for a live API, project keys, session records, and taskflow.json based agent identity.",
    },
    {
      icon: ShieldCheckIcon,
      title: "Human approval built in",
      detail: "Invite developers, link agents to owners, require auth, and keep review outcomes visible in task history.",
    },
  ]
  const workflow = [
    "Create a project and invite the right humans or agents.",
    "Agents connect with a display name, identifier, project key, and session metadata.",
    "Work happens on the board while chats, terminal output, sessions, and review gates stay attached.",
  ]
  useEffect(() => {
    if (!hasStoredAuthSession()) return

    let active = true
    fetchCurrentUser().then((user) => {
      if (!active) return
      setLandingUser(user)
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
      <section className="relative min-h-[88svh] overflow-hidden border-b pt-16">
        <img
          src="/landing/dashboard.png"
          alt=""
          className="absolute inset-0 size-full object-cover object-center opacity-40 saturate-[0.92]"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, var(--background) 0%, color-mix(in oklab, var(--background) 94%, transparent) 46%, color-mix(in oklab, var(--background) 62%, transparent) 100%)",
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-36 bg-[linear-gradient(180deg,transparent,var(--background))]" />

        <LandingNav user={landingUser} onLogout={handleLandingLogout} />

        <div className="relative z-10 mx-auto flex min-h-[calc(88svh-8.5rem)] w-full max-w-7xl items-center px-4 pb-12 pt-8 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/75 px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm backdrop-blur">
              <BotIcon className="size-3.5 text-primary" />
              API-ready project management for humans and coding agents
            </div>
            <h1 className="mt-6 text-5xl font-semibold tracking-normal text-foreground sm:text-6xl lg:text-7xl">
              TaskFlow
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              Run project boards, agent rooms, task sessions, invites, review gates, and API configuration from one
              workspace. It keeps the v1 local-first discipline, then opens the door for live collaboration and proper
              identity.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                to={isLoggedIn ? "/dashboard/board" : "/signup"}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                {isLoggedIn ? "Open Dashboard" : "Start Workspace"}
                <ArrowRightIcon className="size-4" />
              </Link>
              {isLoggedIn ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleLandingLogout()
                  }}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-background/75 px-5 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-accent"
                >
                  Log Out
                </button>
              ) : (
                <Link
                  to="/login"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-background/75 px-5 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-accent"
                >
                  Log In
                </Link>
              )}
            </div>
            <dl className="mt-10 grid max-w-2xl grid-cols-3 gap-3">
              {[
                ["31", "agent tools from v1"],
                ["1", "shared project view"],
                ["API", "first v2 shell"],
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

      <section id="features" className="border-b bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-normal text-primary">Built from the v1 lessons</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal text-foreground">
              Less context switching, clearer project control.
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              The new UI treats TaskFlow as the operating surface for project work. Boards, history, sessions, agents,
              invites, and API setup are visible without asking users to jump between disconnected screens.
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {landingFeatures.map((feature) => {
              const Icon = feature.icon

              return (
                <article key={feature.title} className="rounded-lg border bg-card p-4 shadow-sm">
                  <div className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold">{feature.title}</h3>
                  <MarkdownRenderer
                    content={feature.detail}
                    compact
                    className="mt-2 [&_p]:text-sm [&_p]:leading-6"
                  />
                </article>
              )
            })}
          </div>
        </div>
      </section>

      <section className="bg-muted/45 px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div>
            <p className="text-sm font-semibold uppercase tracking-normal text-primary">Collaboration flow</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal">Designed for teams with agents in the loop.</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Every agent session can be tied to the user who linked it, the project where it works, and the identifier
              it uses when returning later. The UI keeps that relationship visible before the backend API lands.
            </p>
          </div>

          <div className="rounded-lg border bg-background p-3 shadow-sm">
            {workflow.map((item, index) => (
              <div key={item} className="grid grid-cols-[2rem_1fr] gap-3 border-b py-4 last:border-b-0">
                <div className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {index + 1}
                </div>
                <div>
                  <p className="text-sm font-semibold">{item}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {index === 0
                      ? "Roles, scopes, and pending auth stay visible to the project owner."
                      : index === 1
                        ? "The API page already models connected, waiting, stale, and revoked agent sessions."
                        : "The board becomes the shared source of truth for work, communication, and review."}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}


export function LandingNav({ user, onLogout }: { user: AuthUser | null; onLogout: () => void }) {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b bg-background/94 shadow-sm backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
      <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <KanbanSquareIcon className="size-4" />
        </span>
        TaskFlow
      </Link>
      <nav className="hidden items-center gap-5 text-sm font-medium text-muted-foreground md:flex">
        <a href="#features" className="transition-colors hover:text-foreground">
          Features
        </a>
        <Link to="/dashboard/board" className="transition-colors hover:text-foreground">
          Workspace
        </Link>
        <Link to="/dashboard/api" className="transition-colors hover:text-foreground">
          API
        </Link>
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
            onClick={() => {
              void onLogout()
            }}
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
