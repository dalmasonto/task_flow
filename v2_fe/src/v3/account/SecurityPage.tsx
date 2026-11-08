/// Security (design: account-security). Changing your password needs the
/// current one, and (#1101) logs out every other browser and token, which is
/// also how to sign out everywhere until the sessions list lands.
/// "Where you're logged in" lists your own tokens and browser sessions
/// (#TSK1134): log out one, or everywhere else; this device asks first.
import { useState, type FormEvent } from "react"
import { CheckIcon, KeyRoundIcon, MonitorSmartphoneIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { changePassword } from "@/lib/auth-api"

import { timeAgo } from "../lib/time"
import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { AccountShell } from "./AccountShell"
import { endOtherSessions, endSession, listSessions } from "./account-api"
import { MIN_PASSWORD_LENGTH, describeAgent, passwordError } from "./account-logic"

function Section({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          {children}
        </div>
      </div>
    </section>
  )
}

function PasswordForm({ onDone }: { onDone: (changed: boolean) => void }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordError(current, next, confirm)
    setError(problem)
    if (problem) return
    setPending(true)
    const result = await changePassword({ currentPassword: current, newPassword: next })
    setPending(false)
    if (!result.ok) return setError(result.message)
    toast.success("Password changed", { description: "Every other browser and token was logged out." })
    onDone(true)
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 max-w-sm space-y-4" noValidate aria-label="Change password">
      <Field>
        <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
      </Field>
      <Field>
        <FieldLabel htmlFor="pw-new">New password</FieldLabel>
        <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <FieldDescription>At least {MIN_PASSWORD_LENGTH} characters.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="pw-confirm">New password again</FieldLabel>
        <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          Change password
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function SessionsList() {
  const { logout } = useWorkspace()
  const now = useLivenessNow()
  const list = useLoad("my-sessions", (signal) => listSessions(signal))
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmCurrent, setConfirmCurrent] = useState(false)

  const end = async (id: string) => {
    setBusy(id)
    try {
      await endSession(id)
      toast.success("Logged out")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't log that out")
    } finally {
      setBusy(null)
      list.reload()
    }
  }

  if (list.loading) return <Skeleton className="mt-4 h-24" />
  if (list.error) return <p className="mt-3 text-sm text-destructive">{list.error}</p>
  const rows = [...(list.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || (b.last_used_at ?? b.created_at ?? "").localeCompare(a.last_used_at ?? a.created_at ?? ""))
  const others = rows.filter((r) => !r.current).length

  return (
    <>
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {rows.map((r) => {
          const what = describeAgent(r.user_agent) ?? (r.kind === "token" ? "Sign-in token" : "Browser session")
          const used = r.last_used_at ? `active ${timeAgo(r.last_used_at, now)}` : "last use unknown"
          return (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {what}
                  {r.current ? <Badge variant="secondary">This device</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.name ? `${r.name}, ` : ""}
                  {used}
                  {r.created_at ? `, signed in ${timeAgo(r.created_at, now)}` : ""}
                </p>
              </div>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => (r.current ? setConfirmCurrent(true) : void end(r.id))}>
                {busy === r.id ? <Spinner /> : null}
                Log out
              </Button>
            </li>
          )
        })}
      </ul>
      {others ? (
        <Button
          variant="outline"
          className="mt-3"
          disabled={busy !== null}
          onClick={() => {
            setBusy("others")
            void endOtherSessions()
              .then((r) => toast.success("Logged out everywhere else", { description: `${r.revoked_tokens + r.revoked_sessions} ended.` }))
              .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't log out the others"))
              .finally(() => {
                setBusy(null)
                list.reload()
              })
          }}
        >
          {busy === "others" ? <Spinner /> : null}
          Log out everywhere else
        </Button>
      ) : null}
      <AlertDialog open={confirmCurrent} onOpenChange={setConfirmCurrent}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Log out of this device?</AlertDialogTitle>
            <AlertDialogDescription>You&apos;ll go back to the sign-in page.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay signed in</AlertDialogCancel>
            <AlertDialogAction onClick={() => void logout().then(() => window.location.assign("/v3/login"))}>Log out</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function SecurityPage() {
  const [changing, setChanging] = useState(false)
  const [changed, setChanged] = useState(false)
  return (
    <AccountShell>
      <div className="space-y-4">
        <Section icon={<KeyRoundIcon />} title="Password" description="You'll need your current password. Changing it logs out every other browser and token.">
          {changing ? (
            <PasswordForm
              onDone={(ok) => {
                setChanging(false)
                setChanged(ok)
              }}
            />
          ) : (
            <div className="mt-4 flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setChanged(false)
                  setChanging(true)
                }}
              >
                Change password
              </Button>
              {changed ? (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  <CheckIcon className="size-4 text-done" /> Changed
                </span>
              ) : null}
            </div>
          )}
        </Section>

        <Section icon={<MonitorSmartphoneIcon />} title="Where you're logged in" description="Browsers and tokens with access to your account.">
          <SessionsList />
        </Section>
      </div>
    </AccountShell>
  )
}
