/// The v3 sidebar's navigation, from the design's `tf-shell` (docs/v3-design/
/// components/tf-shell.js). Only surfaces that exist are listed: stage-3 items
/// (usage, database) join once their pages are built,
/// so the shell never links to something that isn't there.
import {
  ActivityIcon,
  BotIcon,
  CalendarClockIcon,
  CheckCheckIcon,
  ImageIcon,
  InboxIcon,
  KanbanIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  MessagesSquareIcon,
  PaletteIcon,
  ScaleIcon,
  SettingsIcon,
  UserPlusIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

export type NavCount = "pendingReviews" | "pendingInvites" | "designUnread" | "onlineAgents"

export type NavItem = {
  id: string
  label: string
  icon: LucideIcon
  href: string
  /// Which workspace count drives the badge, if any.
  count?: NavCount
  /// A live dot (agents running) instead of a plain count.
  live?: boolean
}

export type NavGroup = {
  title: string
  collapsible?: boolean
  items: NavItem[]
}

export const V3_NAV: NavGroup[] = [
  {
    title: "Work",
    items: [
      { id: "inbox", label: "Inbox", icon: InboxIcon, href: "/v3/inbox" },
      {
        id: "overview",
        label: "Overview",
        icon: LayoutDashboardIcon,
        href: "/v3/overview",
      },
      { id: "board", label: "Board", icon: KanbanIcon, href: "/v3/board" },
      { id: "chat", label: "Chat", icon: MessagesSquareIcon, href: "/v3/chat" },
      {
        id: "agents",
        label: "Agents",
        icon: BotIcon,
        href: "/v3/agents",
        count: "onlineAgents",
        live: true,
      },
      {
        id: "reviews",
        label: "Reviews",
        icon: CheckCheckIcon,
        href: "/v3/reviews",
        count: "pendingReviews",
      },
    ],
  },
  {
    title: "Insights",
    items: [
      {
        id: "activity",
        label: "Activity",
        icon: ActivityIcon,
        href: "/v3/activity",
      },
      {
        id: "decisions",
        label: "Decisions",
        icon: ScaleIcon,
        href: "/v3/decisions",
      },
      {
        id: "daily-update",
        label: "Daily update",
        icon: CalendarClockIcon,
        href: "/v3/daily-update",
      },
    ],
  },
  {
    title: "Project",
    collapsible: true,
    items: [
      {
        id: "design",
        label: "Design",
        icon: PaletteIcon,
        href: "/v3/design",
        count: "designUnread",
      },
      {
        id: "toolbox",
        label: "Toolbox",
        icon: WrenchIcon,
        href: "/v3/toolbox",
      },
      { id: "media", label: "Media", icon: ImageIcon, href: "/v3/media" },
      {
        id: "invites",
        label: "Invites",
        icon: UserPlusIcon,
        href: "/v3/invites",
        count: "pendingInvites",
      },
      {
        id: "api",
        label: "API keys",
        icon: KeyRoundIcon,
        href: "/v3/api-keys",
      },
      {
        id: "settings",
        label: "Settings",
        icon: SettingsIcon,
        href: "/v3/project/settings",
      },
    ],
  },
]

/// The nav item a pathname belongs to (longest href prefix wins).
export function activeNavId(pathname: string): string | null {
  let best: NavItem | null = null
  for (const item of V3_NAV.flatMap((g) => g.items)) {
    const hit = pathname === item.href || pathname.startsWith(`${item.href}/`)
    if (hit && (!best || item.href.length > best.href.length)) best = item
  }
  if (!best && (pathname.startsWith("/v3/tasks") || pathname.startsWith("/v3/sessions"))) return "board"
  if (!best && (pathname === "/v3/project" || pathname.startsWith("/v3/project/"))) return "settings"
  return best?.id ?? null
}

/// The v2 page that still serves a v3 route that isn't ported yet.
export const V2_FALLBACK: Record<string, string> = {
  inbox: "/dashboard/agents",
  overview: "/dashboard/overview",
  board: "/dashboard/board",
  chat: "/dashboard/agents",
  agents: "/dashboard/agents",
  reviews: "/dashboard/reviews",
  activity: "/dashboard/activity",
  design: "/dashboard/design",
  toolbox: "/dashboard/toolbox",
  media: "/dashboard/media",
  invites: "/dashboard/invites",
  api: "/dashboard/api",
  settings: "/dashboard/api",
}
