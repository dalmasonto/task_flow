/// Security (design: account-security). Changing your password needs the
/// current one, and (#1101) logs out every other browser and token, which is
/// also how to sign out everywhere until the sessions list lands.
/// "Where you're logged in" waits on #TSK1134 (sessions list and revoke).
import { useState, type FormEvent } from "react"
import { CheckIcon, KeyRoundIcon, MonitorSmartphoneIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { changePassword } from "@/lib/auth-api"

import { AccountShell } from "./AccountShell"
import { MIN_PASSWORD_LENGTH, passwordError } from "./account-logic"

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
          <p className="mt-3 text-sm text-muted-foreground">
            The list of your sessions, with a log-out for each, is on its way. Until then, changing your password logs out everywhere except here.
          </p>
        </Section>
      </div>
    </AccountShell>
  )
}
