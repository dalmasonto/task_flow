import { ArrowRightIcon, KanbanSquareIcon, LockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { cn } from "@/lib/utils"
import { confirmPasswordReset, loginUser, registerUser, requestPasswordReset, takeOAuthError, type AuthResult } from "@/lib/auth-api"
import { fetchOAuthProviders, oauthLoginUrl, type OAuthProvider } from "@/lib/taskflow-api"
import { type AuthMode } from "@/lib/workspace-view"
import { useEffect, useState, type FormEvent } from "react"


export function AuthPage({ mode }: { mode: AuthMode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const resetTokenFromUrl = new URLSearchParams(location.search).get("token") ?? ""
  const [authResult, setAuthResult] = useState<AuthResult | null>(null)
  // Surface an OAuth error stashed pre-render (rare — a GitHub denial or a flow
  // that returned an error param). Read-and-clear belongs in an effect, not the
  // useState initializer: takeOAuthError() has a side effect, and a lazy
  // initializer must stay pure (React may call it more than once).
  useEffect(() => {
    // The notice belongs on the login screen only; an anonymous denial always
    // lands there. Gate so a stashed error can't surface on signup/reset.
    if (mode !== "login") return
    const oauthError = takeOAuthError()
    if (oauthError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAuthResult({ ok: false, message: "Couldn't sign in with GitHub. Please try again." })
    }
  }, [mode])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isLogin = mode === "login"
  const isSignup = mode === "signup"
  const isReset = mode === "reset"
  const title = isLogin
    ? "Log in to TaskFlow"
    : isSignup
      ? "Create your workspace"
      : isReset
        ? "Reset your password"
        : "Confirm your new password"
  const description = isLogin
    ? "Return to your project boards, agent rooms, sessions, and pending review gates."
    : isSignup
      ? "Set up the account that will own project invites, agent links, and API access."
      : isReset
        ? "Enter the email tied to your workspace and the API will send recovery instructions."
        : "Choose the password that will protect your workspace and linked agent sessions."
  const submitLabel = isLogin
    ? "Log In"
    : isSignup
      ? "Create Account"
      : isReset
        ? "Send Reset Link"
        : "Update Password"
  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthResult(null)
    setIsSubmitting(true)

    const formData = new FormData(event.currentTarget)
    let result: AuthResult

    if (isLogin) {
      result = await loginUser({
        username: String(formData.get("username") ?? "").trim(),
        password: String(formData.get("password") ?? ""),
      })
      setAuthResult(result)
      setIsSubmitting(false)
      if (result.ok) {
        const nextPath = new URLSearchParams(location.search).get("next")
        navigate(nextPath?.startsWith("/dashboard") ? nextPath : "/dashboard/board")
      }
      return
    }

    if (isSignup) {
      result = await registerUser({
        username: String(formData.get("username") ?? "").trim(),
        email: String(formData.get("email") ?? "").trim(),
        password: String(formData.get("password") ?? ""),
      })
      setAuthResult(result)
      setIsSubmitting(false)
      return
    }

    if (isReset) {
      result = await requestPasswordReset(String(formData.get("email") ?? "").trim())
      setAuthResult(result)
      setIsSubmitting(false)
      return
    }

    const newPassword = String(formData.get("new-password") ?? "")
    const confirmPassword = String(formData.get("confirm-password") ?? "")
    const token = String(formData.get("token") ?? "").trim()

    if (newPassword !== confirmPassword) {
      setAuthResult({ ok: false, message: "Passwords do not match." })
      setIsSubmitting(false)
      return
    }

    result = await confirmPasswordReset({ token, newPassword })
    setAuthResult(result)
    setIsSubmitting(false)
  }

  return (
    <main className="grid min-h-svh bg-background text-foreground lg:grid-cols-[minmax(0,1fr)_minmax(28rem,34rem)]">
      <section className="relative hidden overflow-hidden border-r lg:block">
        <img
          src="/landing/dashboard.png"
          alt=""
          className="absolute inset-0 size-full object-cover object-left opacity-50 saturate-[0.9]"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in oklab, var(--background) 88%, transparent), color-mix(in oklab, var(--primary) 24%, transparent)), linear-gradient(90deg, var(--background), transparent)",
          }}
        />
        <div className="relative z-10 flex h-full flex-col justify-between p-8">
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <KanbanSquareIcon className="size-4" />
            </span>
            TaskFlow
          </Link>
          <div className="max-w-lg pb-8">
            <p className="text-sm font-semibold uppercase tracking-normal text-primary">API-ready workspace</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-normal">
              Auth that can own projects, invites, and agent identity.
            </h1>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Users authenticate first, then link agents, manage project keys, and return to the same project context
              across sessions.
            </p>
          </div>
        </div>
      </section>

      <section className="flex min-h-svh items-center justify-center px-4 py-8 sm:px-6">
        <div className="w-full max-w-md">
          <Link to="/" className="mb-8 flex items-center gap-2 text-sm font-semibold lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <KanbanSquareIcon className="size-4" />
            </span>
            TaskFlow
          </Link>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div>
              <p className="text-sm font-semibold uppercase tracking-normal text-primary">
                {isReset || mode === "confirm" ? "Account Recovery" : "Workspace Access"}
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-normal">{title}</h2>
              <MarkdownRenderer
                content={description}
                compact
                className="mt-2 [&_p]:text-sm [&_p]:leading-6"
              />
            </div>

            {(isLogin || isSignup) && <SocialAuthButtons />}

            {authResult ? <AuthNotice result={authResult} /> : null}

            <form className="mt-5 space-y-4" onSubmit={handleAuthSubmit}>
              {isSignup && (
                <>
                  <AuthTextInput label="Username" name="username" autoComplete="username" placeholder="ada" />
                  <AuthTextInput
                    label="Workspace name"
                    name="workspace"
                    autoComplete="organization"
                    placeholder="Automation Lab"
                    required={false}
                  />
                </>
              )}

              {isLogin && (
                <AuthTextInput
                  label="Username"
                  name="username"
                  autoComplete="username"
                  placeholder="ada"
                />
              )}

              {(isSignup || isReset) && (
                <AuthTextInput
                  label="Email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                />
              )}

              {(isLogin || isSignup) && (
                <AuthTextInput
                  label="Password"
                  name="password"
                  type="password"
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  placeholder="At least 8 characters"
                />
              )}

              {mode === "confirm" && (
                <>
                  <AuthTextInput
                    label="Reset token"
                    name="token"
                    autoComplete="one-time-code"
                    placeholder="Paste the reset token"
                    defaultValue={resetTokenFromUrl}
                  />
                  <AuthTextInput
                    label="New password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                  />
                  <AuthTextInput
                    label="Confirm password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Repeat your new password"
                  />
                </>
              )}

              {isLogin && (
                <div className="flex justify-end">
                  <Link to="/reset-password" className="text-sm font-medium text-primary hover:underline">
                    Forgot password?
                  </Link>
                </div>
              )}

              <Button className="w-full" size="lg" type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Working..." : submitLabel}
                <ArrowRightIcon />
              </Button>
            </form>

            <AuthFooter mode={mode} />
          </div>
        </div>
      </section>
    </main>
  )
}


/** The official GitHub mark, inline so there is no external asset or CSP concern. */
export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}


/** Provider key → its brand icon; unknown providers fall back to a text glyph. */
function providerIcon(key: string) {
  if (key === "github") return <GithubMark className="size-4" />
  return (
    <span className="flex size-4 items-center justify-center rounded-full border text-[0.65rem] font-bold">
      {key.charAt(0).toUpperCase()}
    </span>
  )
}


export function SocialAuthButtons() {
  const [providers, setProviders] = useState<OAuthProvider[]>([])
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchOAuthProviders().then((list) => {
      if (active) setProviders(list)
    })
    return () => {
      active = false
    }
  }, [])

  // Nothing configured (or still loading) → render nothing rather than a dead
  // button. A backend with no OAuth simply shows the password form alone.
  if (providers.length === 0) return null

  return (
    <div className="mt-5 grid gap-2 sm:grid-cols-2">
      {providers.map((provider) => (
        <Button
          key={provider.key}
          type="button"
          variant="outline"
          className="w-full justify-center"
          disabled={pending !== null}
          onClick={() => {
            setPending(provider.key)
            // Full-page navigation into the backend flow; the callback returns
            // to /dashboard/board with the token in the fragment.
            window.location.href = oauthLoginUrl(provider.key)
          }}
        >
          {providerIcon(provider.key)}
          {pending === provider.key ? "Redirecting…" : `Continue with ${provider.label}`}
        </Button>
      ))}
    </div>
  )
}


export function AuthNotice({ result }: { result: AuthResult }) {
  return (
    <div
      className={cn(
        "mt-5 rounded-lg border px-3 py-2.5 text-sm leading-5",
        result.ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-rose-200 bg-rose-50 text-rose-800"
      )}
      role="status"
    >
      {result.message}
    </div>
  )
}


export function AuthGateScreen() {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 text-foreground">
      <section className="w-full max-w-sm rounded-lg border bg-card p-5 text-center shadow-sm">
        <span className="mx-auto flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
          <LockIcon className="size-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold">Checking workspace access</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Validating your session before opening the dashboard.
        </p>
      </section>
    </main>
  )
}


export function AuthTextInput({
  label,
  name,
  type = "text",
  autoComplete,
  placeholder,
  defaultValue,
  required = true,
}: {
  label: string
  name: string
  type?: string
  autoComplete?: string
  placeholder?: string
  defaultValue?: string
  required?: boolean
}) {
  return (
    <label className="block text-sm font-medium">
      <span>{label}</span>
      <Input
        required={required}
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="mt-2"
      />
    </label>
  )
}


export function AuthFooter({ mode }: { mode: AuthMode }) {
  if (mode === "login") {
    return (
      <p className="mt-5 text-center text-sm text-muted-foreground">
        New to TaskFlow?{" "}
        <Link to="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    )
  }

  if (mode === "signup") {
    return (
      <p className="mt-5 text-center text-sm text-muted-foreground">
        Already have access?{" "}
        <Link to="/login" className="font-medium text-primary hover:underline">
          Log in
        </Link>
      </p>
    )
  }

  return (
    <p className="mt-5 text-center text-sm text-muted-foreground">
      Remember your credentials?{" "}
      <Link to="/login" className="font-medium text-primary hover:underline">
        Back to login
      </Link>
    </p>
  )
}
