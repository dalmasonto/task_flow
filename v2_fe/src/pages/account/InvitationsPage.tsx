import * as React from "react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  acceptInvite,
  declineInvite,
  fetchMyInvites,
  type InviteInboxEntry,
} from "@/lib/taskflow-api"
import { CheckIcon, MailIcon, XIcon } from "lucide-react"
import { AccountPageHeader } from "./AccountLayout"

type RowState = { busy: "accept" | "decline" | null; error: string | null }

/// Fetches the inbox and normalizes failures to a display message. Pulled out
/// of the component so both the mount effect and the post-action reload can
/// share it without either routing state updates through the other.
async function loadInviteInbox(): Promise<{ rows: InviteInboxEntry[]; error: string | null }> {
  try {
    const rows = await fetchMyInvites()
    return { rows, error: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : "Could not load your invitations." }
  }
}

export function InvitationsPage({
  onAccepted,
  onDeclined,
}: {
  onAccepted?: () => void
  onDeclined?: () => void
}) {
  const [invites, setInvites] = React.useState<InviteInboxEntry[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [rowState, setRowState] = React.useState<Record<string, RowState>>({})
  const [notice, setNotice] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const { rows, error } = await loadInviteInbox()
    setLoadError(error)
    setInvites(rows)
  }, [])

  React.useEffect(() => {
    let active = true
    loadInviteInbox().then(({ rows, error }) => {
      if (!active) return
      setLoadError(error)
      setInvites(rows)
    })
    return () => {
      active = false
    }
  }, [])

  function setRow(token: string, next: Partial<RowState>) {
    setRowState((current) => {
      const existing = current[token] ?? { busy: null, error: null }
      return { ...current, [token]: { ...existing, ...next } }
    })
  }

  async function onAccept(entry: InviteInboxEntry) {
    setNotice(null)
    setRow(entry.invite_token, { busy: "accept", error: null })
    try {
      await acceptInvite(entry.invite_token)
      setNotice(`You joined ${entry.project_name ?? "the project"}.`)
      onAccepted?.()
      await load()
    } catch (err) {
      setRow(entry.invite_token, {
        busy: null,
        error: err instanceof Error ? err.message : "Could not accept the invitation.",
      })
      // The invite may have changed state server-side (expired/revoked) — refresh
      // so the inbox reflects reality.
      await load()
    }
  }

  async function onDecline(entry: InviteInboxEntry) {
    setNotice(null)
    setRow(entry.invite_token, { busy: "decline", error: null })
    try {
      await declineInvite(entry.invite_token)
      setNotice(`Invitation to ${entry.project_name ?? "the project"} declined.`)
      onDeclined?.()
      await load()
    } catch (err) {
      setRow(entry.invite_token, {
        busy: null,
        error: err instanceof Error ? err.message : "Could not decline the invitation.",
      })
      await load()
    }
  }

  return (
    <div className="space-y-5">
      <AccountPageHeader
        eyebrow="Account"
        title="Invitations"
        description="Project invitations addressed to your account email. Accepting one adds you to the project."
      />

      {notice ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {notice}
        </div>
      ) : null}

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <div className="flex items-center gap-2">
            <MailIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Pending invitations</h2>
          </div>
          {invites ? <span className="text-xs text-muted-foreground">{invites.length} pending</span> : null}
        </div>

        {loadError ? (
          <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            {loadError}
          </p>
        ) : invites === null ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : invites.length === 0 ? (
          <div className="mt-6 flex flex-col items-center justify-center gap-2 py-8 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted">
              <MailIcon className="size-5 text-muted-foreground" />
            </span>
            <p className="text-sm font-medium">No pending invitations</p>
            <p className="text-xs text-muted-foreground">When someone invites you to a project, it will show up here.</p>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {invites.map((entry) => {
              const state = rowState[entry.invite_token] ?? { busy: null, error: null }
              const busy = state.busy !== null
              return (
                <li key={entry.invite_token} className="rounded-lg border bg-background p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{entry.project_name ?? `Project #${entry.project}`}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Invited as <span className="font-medium capitalize text-foreground">{entry.role}</span>
                        {entry.expires_at ? ` · expires ${new Date(entry.expires_at).toLocaleDateString()}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">Sent to {entry.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button size="sm" onClick={() => void onAccept(entry)} disabled={busy}>
                        <CheckIcon />
                        {state.busy === "accept" ? "Accepting…" : "Accept"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void onDecline(entry)} disabled={busy}>
                        <XIcon />
                        {state.busy === "decline" ? "Declining…" : "Decline"}
                      </Button>
                    </div>
                  </div>
                  {state.error ? <p className="mt-2 text-xs text-destructive">{state.error}</p> : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
