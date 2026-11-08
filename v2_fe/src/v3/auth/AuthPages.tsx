/// v3 auth (group 2): log in, sign up, forgot password (+ sent), set a new
/// password from a reset link. From docs/v3-design/pages/{login,signup,
/// forgot-password}*.html, rewritten as Dalmas asked (see auth-ui.tsx).
///
/// Every action calls the real auth API (lib/auth-api.ts).
import { useState, type FormEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { CheckCircle2Icon, MailCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { confirmPasswordReset, loginUser, registerUser, requestPasswordReset } from "@/lib/auth-api"

import { ActorAvatar } from "../components/actor-avatar"
import { safeNextPath, V3_HOME } from "../routes"
import { AuthHeading, AuthLayout, FormError, PasswordField, ServerChip, SocialSignIn, SubmitButton } from "./auth-ui"
import { friendlyAuthError, MIN_PASSWORD, resetTokenFrom, validateEmail, validateSignup, type FieldErrors, type SignupInput } from "./auth-forms"

const INPUT = "h-11 rounded-xl text-base"

function useNext(fallback: string) {
  const { search } = useLocation()
  return safeNextPath(new URLSearchParams(search).get("next"), fallback)
}

export function LoginPage() {
  const navigate = useNavigate()
  const next = useNext(V3_HOME)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ text: string; offerReset: boolean } | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    const result = await loginUser({ username: String(f.get("identifier") ?? "").trim(), password: String(f.get("password") ?? "") })
    setPending(false)
    if (result.ok) navigate(next, { replace: true })
    else {
      const err = friendlyAuthError("login", result.message)
      // A reset link only helps when the password was the problem, not the network.
      setError({ text: err.text, offerReset: /don't match/.test(err.text) })
    }
  }

  return (
    <AuthLayout>
      <AuthHeading title="Log in to TaskFlow" subtitle="Your board, your rooms and every agent's terminal, where you left them." />
      <ServerChip />
      <SocialSignIn returnPath={next} />
      {error ? (
        <FormError>
          {error.text}
          {error.offerReset ? (
            <>
              {" "}
              <Link to="/v3/forgot-password" className="font-medium underline underline-offset-4">
                Reset your password
              </Link>
              .
            </>
          ) : null}
        </FormError>
      ) : null}
      <form className="mt-6" onSubmit={submit} noValidate>
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor="identifier">Email or username</FieldLabel>
            <Input id="identifier" name="identifier" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus className={INPUT} />
          </Field>
          <PasswordField
            id="password"
            autoComplete="current-password"
            action={
              <Link to="/v3/forgot-password" className="text-sm font-medium text-link underline-offset-4 hover:underline">
                Forgot it?
              </Link>
            }
          />
          <SubmitButton pending={pending} pendingLabel="Logging in…">
            Log in
          </SubmitButton>
        </FieldGroup>
      </form>
      <p className="mt-8 text-sm text-muted-foreground">
        New to TaskFlow?{" "}
        <Link to={`/v3/signup${next !== V3_HOME ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-link underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  )
}

function NextSteps() {
  return (
    <div className="flex h-full flex-col justify-center p-10 xl:p-14">
      <h2 className="text-2xl font-semibold tracking-tight">What happens next</h2>
      <ol className="mt-8 space-y-6">
        {[
          ["Name a project.", "One board, one chat, one set of agents."],
          ["Pick two agents.", "Claude and Codex, or any pair you run."],
          ["Watch them talk.", "The second replies to the first, live."],
        ].map(([title, text], i) => (
          <li key={title} className="flex gap-4">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-terminal-foreground/20 text-sm font-medium">{i + 1}</span>
            <p className="pt-1">
              <span className="font-medium">{title}</span> <span className="opacity-70">{text}</span>
            </p>
          </li>
        ))}
      </ol>
      <div className="mt-10 flex items-center gap-3 text-sm opacity-70">
        <span className="flex -space-x-1.5">
          {(["claude", "codex", "deepseek", "gemini"] as const).map((m) => (
            <ActorAvatar key={m} model={m} name={m} size="sm" />
          ))}
        </span>
        About five minutes
      </div>
    </div>
  )
}

export function SignupPage() {
  const navigate = useNavigate()
  const next = useNext("/v3/onboarding")
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<FieldErrors<keyof SignupInput>>({})
  const [formError, setFormError] = useState<{ text: string; account?: boolean } | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input: SignupInput = {
      username: String(f.get("username") ?? "").trim(),
      email: String(f.get("email") ?? "").trim(),
      password: String(f.get("password") ?? ""),
    }
    const found = validateSignup(input)
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length) return
    setPending(true)
    const created = await registerUser(input)
    if (!created.ok) {
      setPending(false)
      const err = friendlyAuthError("signup", created.message)
      if (err.field === "password") setErrors({ password: err.text })
      else setFormError({ text: err.text, account: err.field === "account" })
      return
    }
    // Sign straight in: making someone type the password they just chose is friction.
    const session = await loginUser({ username: input.username, password: input.password })
    setPending(false)
    navigate(session.ok ? next : "/v3/login", { replace: true })
  }

  return (
    <AuthLayout aside={<NextSteps />}>
      <AuthHeading title="Create your account" subtitle="Then you'll set up a project and connect your first two agents." />
      <ServerChip verb="Create your account on" />
      <SocialSignIn returnPath={next} />
      {formError ? (
        <FormError>
          {formError.text}{" "}
          {formError.account ? (
            <>
              <Link to="/v3/login" className="font-medium underline underline-offset-4">
                Log in instead
              </Link>{" "}
              or{" "}
              <Link to="/v3/forgot-password" className="font-medium underline underline-offset-4">
                reset the password
              </Link>
              .
            </>
          ) : null}
        </FormError>
      ) : null}
      <form className="mt-6" onSubmit={submit} noValidate>
        <FieldGroup className="gap-5">
          <Field data-invalid={errors.username ? true : undefined}>
            <FieldLabel htmlFor="username">Username</FieldLabel>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              aria-invalid={errors.username ? true : undefined}
              className={INPUT}
            />
            {errors.username ? <FieldError>{errors.username}</FieldError> : <FieldDescription>Agents see this when you mention them.</FieldDescription>}
          </Field>
          <Field data-invalid={errors.email ? true : undefined}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              aria-invalid={errors.email ? true : undefined}
              className={INPUT}
            />
            {errors.email ? <FieldError>{errors.email}</FieldError> : null}
          </Field>
          <PasswordField
            id="password"
            autoComplete="new-password"
            error={errors.password}
            hint={`At least ${MIN_PASSWORD} characters. A long phrase is easier to remember than symbols.`}
          />
          <SubmitButton pending={pending} pendingLabel="Creating your account…">
            Create account
          </SubmitButton>
          <p className="text-xs text-muted-foreground">
            TaskFlow is free for personal and noncommercial use. Using it for a business needs a{" "}
            <Link to="/v3/pricing" className="underline underline-offset-4 hover:text-foreground">
              commercial licence
            </Link>
            .
          </p>
        </FieldGroup>
      </form>
      <p className="mt-8 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/v3/login" className="font-medium text-link underline-offset-4 hover:underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  )
}

export function ForgotPasswordPage() {
  const [pending, setPending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  async function send(email: string) {
    setPending(true)
    setError(null)
    const result = await requestPasswordReset(email)
    setPending(false)
    if (result.ok) setSentTo(email)
    else setError(friendlyAuthError("reset", result.message).text)
  }

  if (sentTo) {
    return (
      <AuthLayout>
        <span className="grid size-12 place-items-center rounded-2xl bg-running/10 text-running">
          <MailCheckIcon className="size-6" />
        </span>
        <div className="mt-6">
          <AuthHeading
            title="Check your email"
            subtitle={
              <span role="status">
                If <span className="font-medium text-foreground">{sentTo}</span> has an account, a reset link is on its way.
              </span>
            }
          />
        </div>
        <div className="mt-8 rounded-2xl border border-border bg-card p-5">
          <p className="font-medium">Nothing after a few minutes?</p>
          <p className="mt-1 text-sm text-muted-foreground">Look in spam, or check the address and send again.</p>
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" disabled={pending} onClick={() => void send(sentTo)}>
              {pending ? "Sending…" : "Send again"}
            </Button>
            <Button variant="ghost" onClick={() => setSentTo(null)}>
              Use a different email
            </Button>
          </div>
        </div>
        <p className="mt-8 text-sm">
          <Link to="/v3/login" className="font-medium text-link underline-offset-4 hover:underline">
            Back to log in
          </Link>
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthHeading title="Reset your password" subtitle="Enter the email you signed up with and we'll send you a link to choose a new password." />
      {error ? <FormError>{error}</FormError> : null}
      <form
        className="mt-8"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          const email = String(new FormData(e.currentTarget).get("email") ?? "").trim()
          const problem = validateEmail(email)
          setFieldError(problem)
          if (!problem) void send(email)
        }}
      >
        <FieldGroup className="gap-5">
          <Field data-invalid={fieldError ? true : undefined}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" name="email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" required autoFocus className={INPUT} />
            {fieldError ? <FieldError>{fieldError}</FieldError> : null}
          </Field>
          <SubmitButton pending={pending} pendingLabel="Sending…">
            Send reset link
          </SubmitButton>
        </FieldGroup>
      </form>
      <p className="mt-8 text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link to="/v3/login" className="font-medium text-link underline-offset-4 hover:underline">
          Back to log in
        </Link>
      </p>
    </AuthLayout>
  )
}

/// The page a reset email links to: `?token=…` from the link, then a new password twice.
export function ResetPasswordPage() {
  const { search } = useLocation()
  const tokenFromLink = resetTokenFrom(search)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string; token?: string }>({})

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const token = tokenFromLink || String(f.get("token") ?? "").trim()
    const password = String(f.get("password") ?? "")
    const confirm = String(f.get("confirm") ?? "")
    const errs: typeof fieldErrors = {}
    if (!token) errs.token = "Paste the code from your reset email, or open the link in the email again."
    if (password.length < MIN_PASSWORD) errs.password = `Use at least ${MIN_PASSWORD} characters.`
    else if (confirm !== password) errs.confirm = "The two passwords don't match."
    setFieldErrors(errs)
    setError(null)
    if (Object.keys(errs).length) return
    setPending(true)
    const result = await confirmPasswordReset({ token, newPassword: password })
    setPending(false)
    if (result.ok) setDone(true)
    else {
      const err = friendlyAuthError("reset", result.message)
      if (err.field === "password") setFieldErrors({ password: err.text })
      else setError(/token|expired|invalid/i.test(result.message) ? "This reset link has expired or was already used. Ask for a new one." : err.text)
    }
  }

  if (done) {
    return (
      <AuthLayout>
        <span className="grid size-12 place-items-center rounded-2xl bg-running/10 text-running">
          <CheckCircle2Icon className="size-6" />
        </span>
        <div className="mt-6">
          <AuthHeading title="Password changed" subtitle="Log in with your new password. Any other devices were signed out." />
        </div>
        <Button size="lg" className="mt-8 h-11 rounded-xl" nativeButton={false} render={<Link to="/v3/login" />}>
          Log in
        </Button>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthHeading title="Choose a new password" subtitle="Pick something you haven't used here before." />
      {error ? (
        <FormError>
          {error}{" "}
          <Link to="/v3/forgot-password" className="font-medium underline underline-offset-4">
            Send a new link
          </Link>
          .
        </FormError>
      ) : null}
      <form className="mt-8" onSubmit={submit} noValidate>
        <FieldGroup className="gap-5">
          {tokenFromLink ? null : (
            <Field data-invalid={fieldErrors.token ? true : undefined}>
              <FieldLabel htmlFor="token">Reset code</FieldLabel>
              <Input id="token" name="token" autoComplete="one-time-code" spellCheck={false} className={INPUT} />
              {fieldErrors.token ? <FieldError>{fieldErrors.token}</FieldError> : <FieldDescription>From the email we sent you.</FieldDescription>}
            </Field>
          )}
          <PasswordField id="password" label="New password" autoComplete="new-password" error={fieldErrors.password} hint={`At least ${MIN_PASSWORD} characters.`} />
          <PasswordField id="confirm" label="Type it again" autoComplete="new-password" error={fieldErrors.confirm} />
          <SubmitButton pending={pending} pendingLabel="Saving…">
            Save new password
          </SubmitButton>
        </FieldGroup>
      </form>
    </AuthLayout>
  )
}
