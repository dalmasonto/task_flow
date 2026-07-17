import { NavLink, Outlet } from "react-router-dom"

import { cn } from "@/lib/utils"
import { BellIcon, ShieldCheckIcon, SlidersHorizontalIcon, UserRoundIcon, UserRoundPlusIcon } from "lucide-react"

type AccountNavItem = {
  to: string
  label: string
  description: string
  icon: React.ReactNode
}

const accountNav: AccountNavItem[] = [
  {
    to: "/account/profile",
    label: "Profile",
    description: "Your identity and access",
    icon: <UserRoundIcon className="size-4" />,
  },
  {
    to: "/account/settings",
    label: "Settings",
    description: "Theme and notifications",
    icon: <SlidersHorizontalIcon className="size-4" />,
  },
  {
    to: "/account/invitations",
    label: "Invitations",
    description: "Pending project invites",
    icon: <UserRoundPlusIcon className="size-4" />,
  },
  {
    to: "/account/security",
    label: "Security",
    description: "Password and sign-in",
    icon: <ShieldCheckIcon className="size-4" />,
  },
]

/// The `/account` shell: an internal nested router. The vertical sub-nav links
/// the four account pages and <Outlet/> renders whichever child route matches.
export function AccountLayout({ pendingInvites }: { pendingInvites?: number }) {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-5 p-4 sm:p-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-lg border bg-card p-3 shadow-sm">
          <div className="flex items-center gap-2 px-2 pb-2 pt-1">
            <BellIcon className="size-4 text-primary" />
            <div>
              <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Account</p>
              <p className="text-sm font-semibold">Manage your workspace identity</p>
            </div>
          </div>
          <nav className="mt-1 flex flex-col gap-1">
            {accountNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition",
                    isActive
                      ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                      : "text-foreground hover:bg-muted"
                  )
                }
              >
                <span className="shrink-0">{item.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                </span>
                {item.to === "/account/invitations" && pendingInvites ? (
                  <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                    {pendingInvites}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
        </div>
      </aside>
      <div className="min-w-0">
        <Outlet />
      </div>
    </section>
  )
}

/// Shared page header for account pages so they read consistently.
export function AccountPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{eyebrow}</p>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}
