/// Shared pieces of the v3 auth screens (group 2): the split layout, the server
/// chip, the password field, the GitHub button and the error notice.
///
/// Rewritten past the design (Dalmas: "even the new one needs a good rewrite"):
/// the design's narrow form becomes a split screen with the product in view,
/// sign-in with GitHub comes first, errors sit on the field they're about, the
/// password field warns about Caps Lock, and every submit shows progress.
import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CircleAlertIcon, EyeIcon, EyeOffIcon, ServerIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldError, FieldLabel, Field } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { API_BASE_URL } from "@/lib/auth-api"
import { serverLabel } from "@/lib/server-choice"
import { fetchOAuthProviders, oauthLoginUrl, type OAuthProvider } from "@/lib/taskflow-api"

import { ActorAvatar } from "../components/actor-avatar"
import { BrandMark } from "../marketing/public-chrome"

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.66.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}

/// Split screen: the form on the left, the product on the right (from lg up).
export function AuthLayout({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-svh bg-background text-foreground lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex min-w-0 flex-col px-5 py-6 sm:px-10">
        <header className="flex items-center justify-between">
          <BrandMark />
          <Link to="/v3/docs" className="text-sm text-muted-foreground hover:text-foreground">
            Docs
          </Link>
        </header>
        <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          {children}
        </main>
        <footer className="text-xs text-muted-foreground">
          Free for noncommercial use under the PolyForm Noncommercial License.{" "}
          <Link to="/v3/pricing" className="underline underline-offset-4 hover:text-foreground">
            Licences
          </Link>
        </footer>
      </div>
      <aside className="relative hidden overflow-hidden border-l border-border bg-terminal text-terminal-foreground lg:block">{aside ?? <RoomScene />}</aside>
    </div>
  )
}

export function AuthHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {subtitle ? <p className="mt-2 text-muted-foreground">{subtitle}</p> : null}
    </div>
  )
}

/// Which server you're signing in to, with a way to change it. Always the real
/// server: the build default or the one picked on the server page.
export function ServerChip({ verb = "Sign in to" }: { verb?: string }) {
  return (
    <Link
      to="/v3/server"
      className="mt-6 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-sm transition-colors hover:bg-accent/50"
    >
      <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {verb} <span className="font-medium text-foreground">{serverLabel(API_BASE_URL)}</span>
      </span>
      <span className="shrink-0 font-medium text-link">Change</span>
    </Link>
  )
}

/// "Continue with GitHub" (and any other provider the server has configured),
/// then an "or" rule. Renders nothing when the server offers no providers.
export function SocialSignIn({ returnPath }: { returnPath: string }) {
  const [providers, setProviders] = useState<OAuthProvider[] | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void fetchOAuthProviders().then((p) => live && setProviders(p))
    return () => {
      live = false
    }
  }, [])
  if (!providers?.length) return null
  return (
    <div className="mt-6">
      <div className="grid gap-2">
        {providers.map((p) => (
          <Button
            key={p.key}
            type="button"
            variant="outline"
            size="lg"
            className="h-11 w-full rounded-xl"
            disabled={pending !== null}
            onClick={() => {
              setPending(p.key)
              window.location.href = oauthLoginUrl(p.key, returnPath)
            }}
          >
            {pending === p.key ? <Spinner /> : p.key === "github" ? <GithubMark className="size-4" /> : null}
            {pending === p.key ? "Opening GitHub…" : `Continue with ${p.label}`}
          </Button>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or with your email
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  )
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="mt-6 rounded-xl" role="alert">
      <CircleAlertIcon />
      <AlertDescription className="text-foreground">{children}</AlertDescription>
    </Alert>
  )
}

/// Password with show/hide and a Caps Lock warning. The error, if any, replaces
/// the hint, as in the design's tf-password-field.
export function PasswordField({
  id,
  label = "Password",
  autoComplete,
  hint,
  error,
  action,
}: {
  id: string
  label?: string
  autoComplete: "current-password" | "new-password"
  hint?: ReactNode
  error?: string | null
  /// Something to put on the label row, e.g. "Forgot?".
  action?: ReactNode
}) {
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false)
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {action}
      </div>
      <InputGroup className="h-11 rounded-xl">
        <InputGroupInput
          id={id}
          name={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          onKeyDown={onKey}
          onKeyUp={onKey}
          onBlur={() => setCaps(false)}
          className="text-base"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : caps ? (
        <FieldDescription className="text-blocked">Caps Lock is on.</FieldDescription>
      ) : hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
    </Field>
  )
}

export function SubmitButton({ pending, children, pendingLabel }: { pending: boolean; children: ReactNode; pendingLabel: string }) {
  return (
    <Button type="submit" size="lg" className="h-11 w-full rounded-xl" disabled={pending}>
      {pending ? <Spinner /> : null}
      {pending ? pendingLabel : children}
    </Button>
  )
}

/// The right-hand panel: the product, as an illustration of two agents on one
/// task (the landing page's scene), so the screen says what you're signing in to.
export function RoomScene() {
  return (
    <div className="flex h-full flex-col justify-between p-10 xl:p-14">
      <p className="max-w-md text-2xl font-semibold leading-snug tracking-tight">Your agents kept working while you were away.</p>
      <div className="space-y-4">
        <div className="rounded-2xl border border-terminal-foreground/10 bg-terminal-foreground/5 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-sm font-medium">#TSK1026 Sign-up and onboarding screens</p>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-running/15 px-2.5 py-1 text-xs font-medium text-running">
              <span className="size-1.5 rounded-full bg-running" />
              In review
            </span>
          </div>
          <pre className="mt-4 overflow-hidden font-mono text-xs leading-relaxed opacity-80">
            <span className="opacity-60">$</span> design_screenshot --theme both{"\n  "}light ok, dark ok{"\n"}
            <span className="opacity-60">$</span> report_review approved
          </pre>
        </div>
        {[
          ["claude", "Claude (main)", "Onboarding is up with empty, loading and error states. Can you check contrast in dark?"],
          ["codex", "reviewer (codex)", "Checked. Buttons pass in both themes. Approved, moving the task to done."],
        ].map(([model, name, text]) => (
          <div key={name} className="flex items-start gap-3">
            <ActorAvatar model={model as "claude" | "codex"} name={name} size="md" />
            <div className="min-w-0 rounded-2xl bg-terminal-foreground/5 px-4 py-3">
              <p className="text-xs font-medium opacity-70">{name}</p>
              <p className="mt-1 text-sm">{text}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-sm opacity-60">One board, one chat and live terminals for every agent you run.</p>
    </div>
  )
}
