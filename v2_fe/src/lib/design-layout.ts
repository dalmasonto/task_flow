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
}

export const DEFAULT_LAYOUT: LayoutDoc = { view: "rows", routeOrder: [], groups: [] }

export const MAX_GROUPS = 24
export const MAX_GROUP_NAME = 40

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
  return { view, routeOrder: asStrings(obj.routeOrder), groups }
}

/** The group a route belongs to, if any. */
export function groupOf(doc: LayoutDoc, route: string): LayoutGroup | undefined {
  return doc.groups.find((g) => g.routes.includes(route))
}

/// Group ids are opaque to the server; a counter plus a nonce is enough (they
/// only need to be unique inside one document and stable across a save).
let groupSeq = 0
function nextGroupId(): string {
  groupSeq += 1
  return `g${Date.now().toString(36)}${groupSeq.toString(36)}`
}

/** A new empty group, or the document unchanged when the cap is hit or the name
 *  is already taken (matching the server's rule, so the UI cannot build a
 *  document the server will reject). */
export function createGroup(doc: LayoutDoc, name: string): { doc: LayoutDoc; id: string } {
  const trimmed = name.trim()
  const taken = doc.groups.some((g) => g.name.trim().toLowerCase() === trimmed.toLowerCase())
  if (!trimmed || trimmed.length > MAX_GROUP_NAME || taken || doc.groups.length >= MAX_GROUPS) {
    return { doc, id: "" }
  }
  const id = nextGroupId()
  return { doc: { ...doc, groups: [...doc.groups, { id, name: trimmed, routes: [] }] }, id }
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
