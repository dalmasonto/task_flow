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
