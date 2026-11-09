/// v3 routing rules, kept pure so they can be tested without rendering App.
///
/// Design: docs/superpowers/specs/2026-11-08-v3-ui-upgrade-design.md, "Routing".

/// The one switch that makes v3 the default (reviewer, #MSG5649). While it is
/// off, v3 lives at /v3 and v2 stays home, so a half-finished port never locks
/// anyone out. Turn it on once board, task and chat are ported. Set at build
/// time with VITE_V3_DEFAULT=1.
export const V3_DEFAULT = import.meta.env?.VITE_V3_DEFAULT === "1"

export const V3_HOME = "/v3/board"
export const V3_LOGIN = "/v3/login"

/// Pages that render without a session. Everything else under /v3 is the app.
const V3_PUBLIC = new Set(["/v3", "/v3/login", "/v3/signup", "/v3/forgot-password", "/v3/reset-password", "/v3/pricing", "/v3/server"])
const V3_PUBLIC_PREFIXES = ["/v3/confirm-password", "/v3/docs"]

export type V3RouteKind = "public" | "app" | null

/// Is `path` (no trailing slash) a v3 route, and does it need a session?
export function v3RouteKind(path: string): V3RouteKind {
  if (path !== "/v3" && !path.startsWith("/v3/")) return null
  if (V3_PUBLIC.has(path) || V3_PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "public"
  return "app"
}

/// The v2 route whose data a v3 route needs. App's slice gates (live-slices.ts)
/// key on v2 paths, so v3 maps onto them instead of growing its own loaders.
const GATE_MAP: [prefix: string, v2: string | string[]][] = [
  ["/v3/board", "/dashboard/board"],
  ["/v3/tasks", "/dashboard/board"],
  ["/v3/sessions", "/dashboard/board"],
  ["/v3/reviews", "/dashboard/reviews"],
  ["/v3/chat", "/dashboard/agents"],
  ["/v3/inbox", "/dashboard/agents"],
  // Agents pages need presence (sessions), settings (keys) and the board
  // (what each agent is working on); chat/terminal come from the mount flag.
  ["/v3/agents", ["/dashboard/api", "/dashboard/board"]],
  // Overview: presence (who is working) and the board (totals, their tasks).
  ["/v3/overview", ["/dashboard/api", "/dashboard/board"]],
  ["/v3/design", "/dashboard/design"],
  ["/v3/api-keys", "/dashboard/api"],
  // Media names the room each file was shared in. The design gate loads the
  // channel list alone (2 queries, not the 6 of the chat slice).
  ["/v3/media", "/dashboard/design"],
  // Workflow shows each column's task total (the board slice); listed before
  // /v3/project because the first matching prefix wins.
  ["/v3/project/workflow", ["/dashboard/api", "/dashboard/board"]],
  ["/v3/project", "/dashboard/api"],
  // Onboarding watches agents connect (presence lives with the API page's
  // slices); its chat/terminal slices come from setChatSurfaceMounted.
  ["/v3/onboarding", "/dashboard/api"],
]

/// Every v2 gate path a v3 route needs (most need one; some, like the agents
/// pages, draw on several slices). Non-v3 paths pass through unchanged.
export function v3GatePaths(pathname: string): string[] {
  const hit = GATE_MAP.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  const paths = hit ? (Array.isArray(hit[1]) ? hit[1] : [hit[1]]) : [pathname]
  // The sidebar lists Rooms and Direct messages on every app page (tf-shell),
  // so every app route also takes the channel list: the design gate's
  // `chatChannels`, 2 queries, not the chat slice's 6.
  if (v3RouteKind(pathname) !== "app" || paths.includes(SIDEBAR_GATE)) return paths
  return [...paths, SIDEBAR_GATE]
}

const SIDEBAR_GATE = "/dashboard/design"

export function v3GatePath(pathname: string): string {
  return v3GatePaths(pathname)[0]
}

/// Where to go after login. Only same-app paths are honoured, so `?next=` can't
/// be used as an open redirect (`//evil.com` and `https://…` fall back).
export function safeNextPath(next: string | null, fallback: string): string {
  if (!next || next.startsWith("//")) return fallback
  if (next === "/v3" || next.startsWith("/v3/") || next.startsWith("/dashboard") || next.startsWith("/account")) return next
  return fallback
}

/// Where the root and post-login go when nothing else says.
export function defaultHome(): string {
  return V3_DEFAULT ? V3_HOME : "/dashboard/board"
}
