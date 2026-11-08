/// The account pages' frame (design: tf-account-nav): the app shell titled
/// "Account" with a tab row across Profile, Connections, Settings, Security
/// and Invitations. The tab row scrolls sideways on phones rather than
/// wrapping, and Invitations carries the count of open invitations.
import { useEffect, useRef, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"

import { fetchMyInvites } from "@/lib/taskflow-api"
import { cn } from "@/lib/utils"

import { useLoad } from "../lib/use-load"
import { V3Shell } from "../shell/V3Shell"

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "connections", label: "Connections" },
  { id: "settings", label: "Settings" },
  { id: "security", label: "Security" },
  { id: "invitations", label: "Invitations" },
] as const

export function AccountShell({ children, actions, inviteCount }: { children: ReactNode; actions?: ReactNode; inviteCount?: number }) {
  const { pathname } = useLocation()
  // The Invitations page passes its own count (it already loaded the list);
  // every other tab asks once for the badge.
  const invites = useLoad(inviteCount == null ? "account-invite-count" : null, () => fetchMyInvites())
  const count = inviteCount ?? invites.data?.filter((i) => i.status === "pending").length ?? 0
  // On a phone the row scrolls sideways; keep the active tab in view.
  const activeRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [pathname])
  return (
    <V3Shell title="Account" actions={actions}>
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Account" className="-mx-4 overflow-x-auto overflow-y-hidden border-b border-border px-4 lg:mx-0 lg:px-0">
          <ul className="flex gap-1">
            {TABS.map((t) => {
              const href = `/v3/account/${t.id}`
              const on = pathname === href
              return (
                <li key={t.id}>
                  <Link
                    ref={on ? activeRef : undefined}
                    to={href}
                    aria-current={on ? "page" : undefined}
                    className={cn("relative flex h-10 items-center gap-2 px-3 text-sm whitespace-nowrap", on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t.label}
                    {t.id === "invitations" && count ? <span className="rounded-full bg-secondary px-1.5 text-xs text-secondary-foreground tabular-nums">{count}</span> : null}
                    {on ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground" /> : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className="mt-8">{children}</div>
      </div>
    </V3Shell>
  )
}
