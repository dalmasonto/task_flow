import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { changePassword } from "@/lib/auth-api"
import { CheckIcon } from "lucide-react"
import { AccountPageHeader } from "./AccountLayout"

const MIN_PASSWORD_LENGTH = 8

export function SecurityPage() {
  const [currentPassword, setCurrentPassword] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [status, setStatus] = React.useState<"idle" | "saving" | "success">("idle")
  const [error, setError] = React.useState<string | null>(null)

  function validate(): string | null {
    if (!currentPassword) return "Enter your current password."
    if (newPassword.length < MIN_PASSWORD_LENGTH) return `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    if (newPassword === currentPassword) return "New password must be different from your current password."
    if (newPassword !== confirmPassword) return "New password and confirmation do not match."
    return null
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus("idle")
    setError(null)

    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setStatus("saving")
    const result = await changePassword({ currentPassword, newPassword })
    if (result.ok) {
      setStatus("success")
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    } else {
      setStatus("idle")
      setError(result.message)
    }
  }

  return (
    <div className="space-y-5">
      <AccountPageHeader
        eyebrow="Account"
        title="Security"
        description="Change the password you use to sign in. You'll need your current password to confirm the change."
      />

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Change password</h2>
        <form className="mt-4 max-w-sm space-y-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="space-y-1.5">
            <label htmlFor="current-password" className="text-sm font-medium">
              Current password
            </label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value)
                setStatus("idle")
              }}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="new-password" className="text-sm font-medium">
              New password
            </label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value)
                setStatus("idle")
              }}
            />
            <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="confirm-password" className="text-sm font-medium">
              Confirm new password
            </label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value)
                setStatus("idle")
              }}
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {status === "success" ? (
            <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckIcon className="size-4" />
              Password updated.
            </p>
          ) : null}

          <Button type="submit" disabled={status === "saving"}>
            {status === "saving" ? "Updating…" : "Update password"}
          </Button>
        </form>
      </section>
    </div>
  )
}
