/// Which heavy workspace slices a surface needs — as a pure function of the
/// route and the UI state that is genuinely about being *on* a surface.
///
/// Every slice in the workspace loads through ONE effect in `App.tsx`
/// (`fetchWorkspaceChat`, `fetchWorkspaceBoard`, …), and which of them that
/// effect fetches was decided by eight inline consts in the component. Nothing
/// could assert which route loads what, and the mechanism had no executable
/// spec at all — it was documented in comments only, which is how the two leaks
/// this function was extracted to close went unnoticed.
///
/// Two rules decide the result:
///
///  1. **The route decides what a PAGE needs**, plus a real mount signal where
///     one exists. `chatSurfaceMounted` is the reliable half of the agents
///     gate: the route-string check assumes the route table and the path string
///     never drift, and a miss leaves the page permanently empty with no clue
///     why (`pages/agents.tsx` sets it on mount).
///
///  2. **A persisted preference decides nothing.** `dockOpen` reflects whether
///     the dock is open *in this session* — it is dashboard state that used to
///     be restored from localStorage at boot, which made `chat` true on every
///     dashboard route for the rest of that browser's life, so a returning user
///     paid for the project's channels, members, newest message page and newest
///     attachment page before they ever opened a chat. It starts false now (see
///     `chat-dock-state.ts`), so the dock contributes only once its own surface
///     has actually been opened.
///
/// The mappers that read a slice-gated collection degrade honestly when it is
/// absent (`Task #<id>` for an unresolved title, the agent roster's own
/// heartbeat for presence), so a wrong gate costs quality rather than
/// correctness — which is exactly why a gate has to be assertable.

export type LiveSliceGates = {
  /// Board task rows. Also the app's task-lookup table: the task sheet reads
  /// the open task, and the reviews queue renders the review-status rows.
  board: boolean
  /// Agent sessions (heartbeat detail, i.e. presence). Rendered only by the
  /// API-Base page and the task sheet.
  presence: boolean
  /// The whole chat slice: channels, members, messages, attachments, read
  /// cursors, prompts.
  chat: boolean
  /// Channels + their rosters ONLY — what the design page's left rail needs to
  /// resolve the project room. Split out of `chat` on purpose: the rail is the
  /// same `useAgentChat` instance the dock uses, and it needs the project's REAL
  /// channel list before it picks a conversation. With an empty one
  /// `mapLiveChannelChats` synthesises a project room, so the rail renders a
  /// conversation that does not exist — with a composer attached — while the room
  /// the user is actually in is missing from the list. (Sends are not at risk:
  /// the server's `create_channel` is get-or-create for a project room. The
  /// damage is a wrong screen, which is reason enough for the surface to load
  /// what it displays.)
  chatChannels: boolean
  /// Raw terminal capture — the frame page's own comment puts it at ~100 rows /
  /// 96 KB (quoted, not measured here). Only the agents surface renders it —
  /// deliberately not the chat dock, which would otherwise pull it onto every
  /// route the dock is open on.
  terminal: boolean
  /// API endpoints + agent credentials (the API-Base page).
  settings: boolean
  /// The project-wide reviews feed.
  reviews: boolean
  /// The project-wide activity feed (its own paginated slice).
  activity: boolean
  /// The OPEN task's numeric id, or null. Keyed by id rather than a boolean so
  /// opening a different task reloads that task's detail instead of reusing the
  /// first one's.
  taskDetailId: number | null
}

export type SliceGateInput = {
  pathname: string
  /// Set by a chat surface while it is mounted (`pages/agents.tsx`).
  chatSurfaceMounted: boolean
  /// Whether the chat dock is open in this session. Deliberately NOT read from
  /// localStorage — see rule 2 above.
  dockOpen: boolean
  /// The id of the task the sheet has open, from the route or a chip.
  openTaskId: string | null
}

/// The route test the gates share. A `startsWith` rather than an exact match
/// because every dashboard surface has child routes (`/dashboard/agents/:id`),
/// and it is applied to the raw pathname — `App.tsx` normalises the trailing
/// slash separately, and normalising here would change which paths match.
function onRoute(pathname: string, route: string): boolean {
  return pathname.startsWith(route)
}

/// The flags that say which slices the CURRENT project's workspace already
/// holds. A ref in `App.tsx` rather than state: they gate a fetch, they do not
/// belong in a render.
export type LoadedSlices = {
  /// The project these flags describe.
  project: number | null
  /// The core workspace's generation. A fresh core hands back empty chat and
  /// activity arrays, so a merged slice from the previous generation is no
  /// longer present even though its flag says "loaded".
  epoch: number
  board: boolean
  presence: boolean
  chat: boolean
  channels: boolean
  activity: boolean
  terminal: boolean
  settings: boolean
  reviews: boolean
  /// Keyed by the LOADED task id, not a boolean: opening a different task must
  /// reload that task's detail instead of reusing the first one's.
  taskDetail: number | null
}

/// Invalidate the loaded flags if the workspace they describe is gone — a
/// project switch, or a new core workspace under the same project.
///
/// Returns whether anything was cleared. Extracted from `App.tsx`'s slice effect
/// so the reset has a test: the effect's own behaviour is that a route change
/// does NOT clear anything (slices stay loaded, which is the point of holding
/// them), while a project or generation change clears everything — and getting
/// that backwards is invisible until a surface silently shows the previous
/// project's rows.
export function invalidateSlices(slices: LoadedSlices, projectId: number | null, epoch: number): boolean {
  if (slices.project === projectId && slices.epoch === epoch) return false
  slices.project = projectId
  slices.epoch = epoch
  slices.board = false
  slices.presence = false
  slices.chat = false
  slices.channels = false
  slices.activity = false
  slices.terminal = false
  slices.settings = false
  slices.reviews = false
  slices.taskDetail = null
  return true
}

export function sliceGatesFor(input: SliceGateInput): LiveSliceGates {
  const { pathname, chatSurfaceMounted, dockOpen, openTaskId } = input
  const onAgents = onRoute(pathname, "/dashboard/agents")
  // The chat slice, for the two surfaces that render a full chat: the agents
  // page (route or mount) and the dock. The design page is NOT here — its rail
  // takes `chatChannels` instead, which is 2 queries where this is 6.
  const chat = dockOpen || chatSurfaceMounted || onAgents
  const numericOpenTaskId =
    openTaskId !== null && Number.isFinite(Number(openTaskId)) ? Number(openTaskId) : null
  return {
    board:
      openTaskId !== null ||
      onRoute(pathname, "/dashboard/board") ||
      onRoute(pathname, "/dashboard/reviews"),
    presence: openTaskId !== null || onRoute(pathname, "/dashboard/api"),
    chat,
    chatChannels: onRoute(pathname, "/dashboard/design"),
    terminal: chatSurfaceMounted || onAgents,
    settings: onRoute(pathname, "/dashboard/api"),
    reviews: onRoute(pathname, "/dashboard/reviews"),
    activity: onRoute(pathname, "/dashboard/activity"),
    taskDetailId: numericOpenTaskId,
  }
}
