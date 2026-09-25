/// The canvas arrangement document — mirrors the backend's `layout_doc::LayoutDoc`
/// serde shape exactly.
///
/// Deliberately free of any device/preset import so `design-devices.ts` can
/// depend on it one-way; the layout *engines* live there.

export type CanvasView = "rows" | "bands" | "groups"

export type LayoutGroup = { id: string; name: string; routes: string[] }

export type LayoutDoc = {
  view: CanvasView
  routeOrder: string[]
  groups: LayoutGroup[]
  /// Display names, route → human name. A *label* only: the page's own title
  /// and the real app are untouched, and the real route is what everything
  /// else keys on. A route that has never been renamed is ABSENT rather than
  /// blank, so every reader must fall back to the manifest title — that is
  /// what `pageLabel` is for.
  pageLabels: Record<string, string>
}

export const DEFAULT_LAYOUT: LayoutDoc = { view: "rows", routeOrder: [], groups: [], pageLabels: {} }

export const MAX_GROUPS = 24
export const MAX_GROUP_NAME = 40
export const MAX_LABEL = 40

/** Toolbar order and labels for the arrangement picker. */
export const CANVAS_VIEWS: { id: CanvasView; label: string; hint: string }[] = [
  { id: "rows", label: "Rows", hint: "One row per page, a column per device" },
  { id: "bands", label: "Bands", hint: "One band per device, its pages across" },
  { id: "groups", label: "Groups", hint: "Named groups as columns, the rest flow right" },
]

const VIEW_IDS: CanvasView[] = ["rows", "bands", "groups"]

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/// Tolerant read-side parse of a server document.
///
/// The backend already validates and self-heals, so this is belt-and-braces for
/// the cases it cannot cover: a response from a newer build, a schema that moved
/// under a cached tab, or a proxy returning something unexpected. A canvas that
/// renders the default is recoverable; one that throws on load is not.
export function normalizeLayout(raw: unknown): LayoutDoc {
  if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT
  const obj = raw as Record<string, unknown>
  const view = VIEW_IDS.includes(obj.view as CanvasView) ? (obj.view as CanvasView) : "rows"
  const groups: LayoutGroup[] = Array.isArray(obj.groups)
    ? obj.groups.flatMap((g): LayoutGroup[] => {
        if (!g || typeof g !== "object") return []
        const candidate = g as Record<string, unknown>
        if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return []
        return [{ id: candidate.id, name: candidate.name, routes: asStrings(candidate.routes) }]
      })
    : []
  // Same tolerant read as `groups`, and for the same reason: the server refuses
  // to store a blank label, so a non-string or blank entry here is a document
  // this build should not trust. Dropping it costs a fallback title; keeping it
  // would render an empty page name.
  const rawLabels = obj.pageLabels
  const pageLabels: Record<string, string> = {}
  if (rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)) {
    for (const [route, label] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (typeof label === "string" && label.trim()) pageLabels[route] = label
    }
  }
  return { view, routeOrder: asStrings(obj.routeOrder), groups, pageLabels }
}

/** The group a route belongs to, if any. */
export function groupOf(doc: LayoutDoc, route: string): LayoutGroup | undefined {
  return doc.groups.find((g) => g.routes.includes(route))
}

/** The name to show for a page: its label if it has one, else the manifest's
 *  own title, else the raw route. One resolver so the three places that render
 *  a page name can never disagree. */
export function pageLabel(doc: LayoutDoc, route: string, fallback: string): string {
  const label = doc.pageLabels[route]
  return label && label.trim() ? label : fallback
}

/// Group ids are opaque to the server; a counter plus a nonce is enough (they
/// only need to be unique inside one document and stable across a save).
let groupSeq = 0
function nextGroupId(): string {
  groupSeq += 1
  return `g${Date.now().toString(36)}${groupSeq.toString(36)}`
}

/// The rule a new group's name must satisfy, as a sentence the UI can show —
/// `null` when the name is usable, otherwise the reason to refuse it.
///
/// # Why the reason is a string and not a boolean
///
/// `createGroup` refuses a blank name, an over-long one, a duplicate and a call
/// at the cap — all four the same way: the document back unchanged and an empty
/// id. Behind `window.prompt` that was invisible (the dialog closed, nothing
/// appeared), and behind the Pages panel's dialog it would still be invisible
/// without something to ASK. So the panel asks this before it ever calls
/// `createGroup`, disables Create on a reason, and prints the sentence under
/// the field.
///
/// The precedent is `setNameProblem` (`lib/resources.ts`), the resource
/// editor's live reason under its Add button: same shape, same purpose, same
/// wording style, and — since both live beside the function that enforces them
/// — the same arrangement, one rule in one place.
///
/// # The measure is the SERVER's
///
/// Length is counted in CODE POINTS (`[...trimmed].length`), which is what
/// `layout_doc.rs:95` does (`name.chars().count()`). JS's `.length` counts
/// UTF-16 units, so an astral character would be 2 here and 1 there, and a
/// 40-emoji name the server accepts would be refused in front of the user with
/// a sentence claiming a cap it has not reached. A client stricter than the
/// server is a defect either way; for resource sets `setNameProblem` counts
/// code points for this exact reason.
///
/// null when `name` is usable for a new group, otherwise the reason to show.
///
/// The checks run blank → over-long → duplicate → cap, and the order is the
/// SENTENCE's: a name that is both blank and at the cap reads as blank — the
/// thing the user can act on — rather than as the cap, which no amount of
/// typing in this dialog can clear.
export function groupNameProblem(doc: LayoutDoc, name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "A group needs a name."
  if ([...trimmed].length > MAX_GROUP_NAME) {
    return `A group name is limited to ${MAX_GROUP_NAME} characters.`
  }
  // Case-insensitive, like the engine's and the server's, and compared TRIMMED
  // on both sides: "  auth  " is as taken as "Auth" is.
  if (doc.groups.some((g) => g.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    return `"${trimmed}" is already a group name.`
  }
  if (doc.groups.length >= MAX_GROUPS) return `At most ${MAX_GROUPS} groups.`
  return null
}

/** A new empty group, or the document unchanged when `groupNameProblem` has a
 *  reason — blank, over-long, already taken, or at the cap — matching the
 *  server's rule, so the UI cannot build a document the server will reject.
 *
 *  The refusal is not restated here: this is the rule's ONE enforcement, and
 *  the panel's Create button reads the same function to decide whether it is
 *  offered at all. What keeps the two from disagreeing is that there is nothing
 *  to disagree with — the sentence the user sees and the refusal that builds
 *  the document are the same check. */
export function createGroup(doc: LayoutDoc, name: string): { doc: LayoutDoc; id: string } {
  if (groupNameProblem(doc, name) !== null) return { doc, id: "" }
  const id = nextGroupId()
  return { doc: { ...doc, groups: [...doc.groups, { id, name: name.trim(), routes: [] }] }, id }
}

/** Move a route into `groupId`, or out of every group when it is null. A route
 *  lives in at most one group, so this removes it from wherever it was. */
export function assignRoute(doc: LayoutDoc, route: string, groupId: string | null): LayoutDoc {
  return {
    ...doc,
    groups: doc.groups.map((g) => {
      const without = g.routes.filter((r) => r !== route)
      const withRoute = g.id === groupId ? [...without, route] : without
      return withRoute.length === g.routes.length && without.length === g.routes.length
        ? g
        : { ...g, routes: withRoute }
    }),
  }
}

/// Remove a group. Its pages are not deleted — they fall back to the ungrouped
/// tail, which is what "remove this grouping" should mean.
export function removeGroup(doc: LayoutDoc, id: string): LayoutDoc {
  return { ...doc, groups: doc.groups.filter((g) => g.id !== id) }
}

/// Move a GROUP `delta` places along `doc.groups` (the panel's group arrows are
/// ±1), from where it sits now — `moveRoute`'s sibling for the other list this
/// document orders.
///
/// It is a MOVE, not a swap, exactly as `moveRoute` is: the groups between the
/// two positions shift one place the other way. `delta` is a WHOLE number of
/// places and anything else is refused by returning the document itself, for
/// `moveRoute`'s reason — `Math.max(0, NaN)` is `NaN`, `to === from` is then
/// false, and `splice(NaN, 0, …)` reads its start as 0, which would send a group
/// nobody asked to move to the top and, in `groups` view, jump its whole column
/// to the left edge. A whole `delta` past an end is clamped rather than refused,
/// so a large delta spells a move to the top or the bottom; a call that would
/// not change the order returns the document ITSELF, so a caller can skip a save
/// by identity rather than comparing lists.
///
/// # Why this needs neither a `routes` argument nor a normalisation pass
///
/// `moveRoute` takes the pages because the list it moves in (`routeOrder`) is
/// sparse: it can name pages this project no longer has, so the move is applied
/// to the RESOLVED flow and stored through `setRouteOrder`. `groups` is not
/// sparse — every group in the document is drawn, whole — and the server's
/// `validate` judges each group ON ITS OWN (`layout_doc.rs:79-120`: the id, the
/// name, the name's uniqueness against the others, the group's own routes), so
/// a PERMUTATION of groups it already accepted is a document it accepts. There
/// is nothing here to normalise away, and a `routes` parameter that only widened
/// the signature would be the seam someone later mistakes for a link.
///
/// The order it rewrites is the one the canvas draws (`layoutGroups` lays its
/// columns out in `doc.groups` order) and the one the panel numbers its group
/// headings from, which is the order the user means by a group's "position".
export function moveGroup(doc: LayoutDoc, id: string, delta: number): LayoutDoc {
  if (!Number.isInteger(delta)) return doc
  /// The FIRST group with this id, like `groupOf`/`assignRoute`, which both
  /// resolve by `find`: ids are unique in every document this client can build
  /// (`createGroup` mints one with a nonce) and the server does not check for
  /// repeats, so a hand-built document with two of them moves the one the other
  /// readers would resolve to.
  const from = doc.groups.findIndex((group) => group.id === id)
  if (from < 0) return doc
  const to = Math.min(doc.groups.length - 1, Math.max(0, from + delta))
  if (to === from) return doc
  const groups = [...doc.groups]
  // The removal shortens the list, so inserting at `to` in the shortened array
  // is the position `to` the caller asked for — the groups it passed shift one
  // place back and nothing else moves.
  const [moved] = groups.splice(from, 1)
  groups.splice(to, 0, moved)
  return { ...doc, groups }
}

/// Set or clear a page's display label. An empty (or whitespace) label CLEARS
/// the key rather than storing a blank — a blank label must render identically
/// to no label, and storing one would mean two spellings of the same state.
///
/// Non-mutating, like every other edit here. An over-cap label is refused by
/// returning the document itself, so the caller can tell "nothing happened" by
/// identity rather than comparing contents.
export function setPageLabel(doc: LayoutDoc, route: string, label: string): LayoutDoc {
  const trimmed = label.trim()
  if (trimmed.length > MAX_LABEL) return doc
  const pageLabels = { ...doc.pageLabels }
  if (!trimmed) delete pageLabels[route]
  else pageLabels[route] = trimmed
  return { ...doc, pageLabels }
}

// ---------------------------------------------------------------------------
// The flow: the order the pages are presented in
// ---------------------------------------------------------------------------

/// `routeOrder` is ONE global presentation order, not a per-group one.
///
/// The user's ask was a single sequence that CROSSES groups — "signup screen 1
/// > signup screen 2 > login with email > login with phone > password recovery"
/// — and groups are the other, separate axis they already have. A per-group
/// order would be a different feature (and a different field: the one that
/// exists is a flat list of routes, and a route lives in at most one group).
///
/// So: this order is the flow of the whole project, and it is what the panel
/// lists pages in and what the canvas draws them in — in every view. Grouping
/// is untouched by it and does not touch it: a grouping edit must not reflow the
/// canvas, and only an explicit reorder does (see `boardsForView`).
///
/// # Both directions are the SERVER's, and the strict one is the write
///
/// `layout_doc.rs` is asymmetric, and this half of the client has to match both
/// sides:
/// * **Strict write** (`validate`, :121-130): a `routeOrder` entry that is not a
///   known route is refused with a **400**; duplicates are dropped
///   **first-wins** (`seen_order.insert`). The document is PUT whole — every
///   layout edit sends `routeOrder` back — so a stale entry does not merely
///   fail to save itself, it fails the NEXT save of anything, including a
///   rename. That is why `setRouteOrder`/`moveRoute` normalise before they
///   return, and why the surface filters the order on its way out
///   (`filterRouteOrder`).
/// * **Forgiving read** (`filter_to_known`, :159-163): unknown entries are
///   dropped, not repaired. An optimistic render that keeps one is therefore a
///   row that disappears on the next reload — the other half of why the order
///   is deduped and filtered here rather than left to the server.
///
/// Nothing here mutates its input, and a refusal is by IDENTITY (the document
/// itself comes back), the way every other refusal in this module reads.

/// The document with its `routeOrder` cut down to what `routes` can answer for:
/// entries that are not in `routes` dropped, repeats dropped FIRST-WINS so the
/// result is a permutation of a subset of `routes` — exactly the shape
/// `validate` accepts.
///
/// `null` for `routes` means "the caller cannot know" (the manifest is still
/// loading, or the copy in hand belongs to another project). Nothing is judged,
/// so nothing is dropped and the document comes back untouched: filtering
/// against an empty list instead would wipe the user's flow on any save that
/// happened to land before the manifest did.
export function filterRouteOrder(doc: LayoutDoc, routes: string[] | null): LayoutDoc {
  if (!routes) return doc
  const known = new Set(routes)
  const seen = new Set<string>()
  const routeOrder: string[] = []
  for (const route of doc.routeOrder) {
    if (!known.has(route) || seen.has(route)) continue
    seen.add(route)
    routeOrder.push(route)
  }
  return { ...doc, routeOrder }
}

/// The order the pages are presented in: the stored flow first, then every page
/// it does not name, appended in the order `routes` arrives in.
///
/// Total and lossless, which is the property everything else rests on: the
/// result is a permutation of `routes`, so every page has a position and none
/// has two. `routes` is the candidate set — the pages of the project for the
/// panel, the OPEN pages for the canvas — and its own order is the fallback,
/// which is why an empty `routeOrder` renders the pages in their manifest order
/// rather than in nothing.
///
/// The append is what repairs a stored flow: a page added after it was written
/// is not in it (the state is reachable and ordinary), and dropping unnamed
/// pages instead of appending them would lose them from every listing at once.
/// The mirror case is a page that is GONE — its entry is dropped here rather
/// than carried, which is also what keeps the document writable.
///
/// The tail keeps the INPUT's order, so a caller that passes its pages in
/// manifest order gets manifest order for the tail. `openRoutes` is maintained
/// that way (`DesignSurfacePage`'s `openRoute`) and is the canvas's argument.
export function resolveRouteOrder(doc: LayoutDoc, routes: string[]): string[] {
  const named = filterRouteOrder(doc, routes).routeOrder
  const placed = new Set(named)
  return [...named, ...routes.filter((route) => !placed.has(route))]
}

/// Store a new flow. The order asked for is NORMALISED against `routes` — the
/// pages it names, in its order, then the rest of `routes` appended — so what
/// lands in the document is always a permutation of `routes` and can never be
/// a document the server refuses.
///
/// Appending rather than storing the caller's list verbatim means the stored
/// array is a complete flow of its own: a later reader (another viewer's tab, a
/// fresh load) resolves it to exactly this order without having to know what
/// the manifest looked like at the time.
export function setRouteOrder(doc: LayoutDoc, order: string[], routes: string[]): LayoutDoc {
  // ONE normalisation, and it is `resolveRouteOrder`'s: it filters what `order`
  // names (unknown dropped, repeats first-wins) and appends the rest of
  // `routes`. There is deliberately no `filterRouteOrder` pass over
  // `doc.routeOrder` as well — the value below REPLACES that field, so a stale
  // entry in the document is gone by construction rather than by a second
  // sweep, and a reader cannot mistake one for the other.
  return { ...doc, routeOrder: resolveRouteOrder({ ...doc, routeOrder: order }, routes) }
}

/// Move a page `delta` places along the flow (the panel's move up/down is
/// ±1), from where it sits now.
///
/// It is a MOVE, not a swap: the pages between the two positions shift one place
/// the other way, so "two places down" leaves the page two places further along
/// rather than trading it with whichever page happened to be there.
///
/// `delta` is a WHOLE number of places, and anything else — `NaN`, `±Infinity`,
/// a fraction — is refused by returning the document itself. That is not
/// tidiness: the clamp below cannot express `NaN` (`Math.max(0, NaN)` is `NaN`),
/// and `splice(NaN, 0, …)` reads its start as 0, so a `NaN` delta would silently
/// insert the page at the TOP of the flow instead of leaving it alone. A whole
/// `delta` past an end is clamped rather than refused: the page stops at that
/// end, which makes a large delta the spelling of a move to the top or the
/// bottom. A call that would not change the order — an end, a delta of zero, a
/// route that is not one of the pages — returns the document ITSELF, so the
/// caller can skip a save by identity rather than comparing lists.
///
/// The move is applied to the RESOLVED flow, not to the pages' own order: in a
/// document with no flow stored the two are the same list, and in one that has
/// a flow it is the user's list that moves. Going through `setRouteOrder` is
/// what makes the result writable, stale entries and all.
export function moveRoute(doc: LayoutDoc, route: string, delta: number, routes: string[]): LayoutDoc {
  if (!Number.isInteger(delta)) return doc
  const order = resolveRouteOrder(doc, routes)
  const from = order.indexOf(route)
  if (from < 0) return doc
  const to = Math.min(order.length - 1, Math.max(0, from + delta))
  if (to === from) return doc
  const next = [...order]
  // The removal shortens the list, so inserting at `to` in the shortened array
  // is the position `to` the caller asked for — the pages it passed shift one
  // place back and nothing else moves.
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return setRouteOrder(doc, next, routes)
}
