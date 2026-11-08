/// Invitations to projects (design: account-invitations, +empty). Reads the
/// invitations addressed to you and accepts or declines them by token; the
/// server checks the invite is yours (403 otherwise) and still open.
/// Accepting refreshes the workspace so the project joins the sidebar.
import { useState } from "react"
import { MailOpenIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useLivenessNow } from "@/hooks/use-liveness-now"
import { acceptInvite, declineInvite, fetchMyInvites, type InviteInboxEntry } from "@/lib/taskflow-api"

import { useLoad } from "../lib/use-load"
import { useWorkspace } from "../workspace"
import { AccountShell } from "./AccountShell"
import { expiresLine, roleArticle } from "./account-logic"

export function InvitationsPage() {
  const { refresh } = useWorkspace()
  const now = useLivenessNow()
  const list = useLoad("my-invites", () => fetchMyInvites())
  const [busy, setBusy] = useState<{ id: number; action: "accept" | "decline" } | null>(null)
  const open = (list.data ?? []).filter((i) => i.status === "pending")

  const act = async (invite: InviteInboxEntry, action: "accept" | "decline") => {
    setBusy({ id: invite.id, action })
    try {
      if (action === "accept") {
        await acceptInvite(invite.invite_token)
        toast.success(`You joined ${invite.project_name ?? "the project"}`, { description: "It's in your project switcher now." })
        refresh()
      } else {
        await declineInvite(invite.invite_token)
        toast.success("Invitation declined")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work.")
    } finally {
      setBusy(null)
      list.reload()
    }
  }

  return (
    <AccountShell inviteCount={open.length}>
      {list.loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading invitations">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : list.error ? (
        <p className="text-sm text-destructive">{list.error}</p>
      ) : open.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailOpenIcon />
            </EmptyMedia>
            <EmptyTitle>No invitations</EmptyTitle>
            <EmptyDescription>When someone adds you to their project, it shows up here. To work with someone, invite them to one of yours.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div>
            <h2 className="font-medium">Invitations to projects</h2>
            <p className="mt-1 text-sm text-muted-foreground">Accepting adds the project to your sidebar. Its agents can mention you once you join.</p>
          </div>
          <ul className="mt-6 space-y-3">
            {open.map((i) => {
              const name = i.project_name ?? `Project ${i.project}`
              const pending = busy?.id === i.id
              return (
                <li key={i.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted font-semibold uppercase" aria-hidden>
                      {name.slice(0, 1)}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm">
                        You&apos;re invited to <span className="font-medium">{name}</span> as {roleArticle(i.role)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Sent to {i.email}
                        {expiresLine(i.expires_at, now) ? `. ${expiresLine(i.expires_at, now)}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={() => void act(i, "decline")} disabled={busy !== null}>
                      {pending && busy?.action === "decline" ? <Spinner /> : null}
                      Decline
                    </Button>
                    <Button size="sm" onClick={() => void act(i, "accept")} disabled={busy !== null}>
                      {pending && busy?.action === "accept" ? <Spinner /> : null}
                      Accept
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </AccountShell>
  )
}
