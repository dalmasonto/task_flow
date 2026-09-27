/// #508: the Flow view's rules that need no canvas — where a page sits when it
/// has never been placed, and how a link or a move changes the layout
/// document. Pure, so each rule is a unit test.
///
/// The document fields (`edges`, `positions`) are the layout document's own:
/// the operator's save sends the whole document, and the backend validates
/// them exactly as it validates an agent's `link_pages` / `place_page`.

export type FlowEdge = { id: string; from: string; to: string; label?: string }
export type FlowPoint = { x: number; y: number }

/// The slice of the layout document this module reads and writes.
export type FlowDoc = {
  edges?: FlowEdge[]
  positions?: Record<string, FlowPoint>
}

/// Horizontal and vertical breathing room between auto-placed pages, in the
/// canvas's own pixels (a node is a device at 1:1 plus its header).
export const COLUMN_GAP = 300
export const ROW_GAP = 90

/// Where every route sits: its saved position if it has one, otherwise an
/// automatic LEFT-TO-RIGHT layout that follows the links — a page's column is
/// its longest distance from a page nothing links to, so a flow reads the way a
/// user walks it. Unlinked pages form the first column in their given order.
/// Cycles are cut (a back-link never pushes its target right), so any graph
/// lays out.
///
/// An auto-placed page keeps its natural slot unless another page already
/// occupies it, and then steps down below the one in its way — so it never
/// lands on top of a hand-placed page, and a page dropped far away does not
/// drag its column's neighbours after it.
export function flowPositions(
  routes: string[],
  doc: FlowDoc,
  node: { w: number; h: number },
): Record<string, FlowPoint> {
  const saved = doc.positions ?? {}
  const known = new Set(routes)
  const edges = (doc.edges ?? []).filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to)

  // Longest-path depth over the DAG that remains once back-edges are ignored:
  // walk in the given order, and only follow an edge to a route not yet on the
  // current path.
  const depth = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const e of edges) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to])
  const incoming = new Set(edges.map((e) => e.to))
  const visit = (route: string, d: number, path: Set<string>) => {
    if ((depth.get(route) ?? -1) >= d) return
    depth.set(route, d)
    path.add(route)
    for (const next of outgoing.get(route) ?? []) if (!path.has(next)) visit(next, d + 1, path)
    path.delete(route)
  }
  for (const route of routes) if (!incoming.has(route)) visit(route, 0, new Set())
  // A route only reachable through a cycle got no start: give it column 0.
  for (const route of routes) if (!depth.has(route)) visit(route, 0, new Set())

  const colW = node.w + COLUMN_GAP
  const rowH = node.h + ROW_GAP
  // Every box already on the canvas: the hand-placed pages first, then each
  // auto-placed one as it lands.
  const taken: FlowPoint[] = routes.filter((r) => saved[r]).map((r) => saved[r])
  const overlaps = (p: FlowPoint) =>
    taken.find((q) => Math.abs(q.x - p.x) < node.w + COLUMN_GAP / 2 && Math.abs(q.y - p.y) < node.h + ROW_GAP / 2)
  const nextRow = new Map<number, number>()
  const out: Record<string, FlowPoint> = {}
  for (const route of routes) {
    const p = saved[route]
    if (p) {
      out[route] = p
      continue
    }
    // Its natural slot: its column, the next row in that column. Only if that
    // slot is OCCUPIED does it step down — below whatever is in the way — so
    // one hand-placed page never flings its neighbours off down the canvas.
    const col = depth.get(route) ?? 0
    const r = nextRow.get(col) ?? 0
    nextRow.set(col, r + 1)
    let at: FlowPoint = { x: col * colW, y: r * rowH }
    for (let blocker = overlaps(at); blocker; blocker = overlaps(at)) {
      at = { x: at.x, y: blocker.y + rowH }
    }
    taken.push(at)
    out[route] = at
  }
  return out
}

/// The next edge id: `e<n>`, one past the highest numbered id present. The
/// backend mints the same way, so an id made here and one made by an agent's
/// `link_pages` cannot collide in one document.
export function nextEdgeId(edges: FlowEdge[]): string {
  let max = 0
  for (const e of edges) {
    const n = /^e(\d+)$/.exec(e.id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  return `e${max + 1}`
}

/// Why a link cannot be made, or null when it can. The same rules the backend
/// refuses with, checked first so the canvas never sends a doomed save.
export function linkProblem(doc: FlowDoc, from: string, to: string): string | null {
  if (from === to) return "A page cannot link to itself."
  if ((doc.edges ?? []).some((e) => e.from === from && e.to === to)) return "These pages are already linked."
  return null
}

export function linkPages<T extends FlowDoc>(doc: T, from: string, to: string, label?: string | null): T {
  if (linkProblem(doc, from, to)) return doc
  const edges = doc.edges ?? []
  // No label is NO key — the shape the backend stores and sends back.
  const clean = label?.trim().slice(0, 40)
  return { ...doc, edges: [...edges, { id: nextEdgeId(edges), from, to, ...(clean ? { label: clean } : {}) }] }
}

export function unlink<T extends FlowDoc>(doc: T, edgeId: string): T {
  const edges = doc.edges ?? []
  const next = edges.filter((e) => e.id !== edgeId)
  return next.length === edges.length ? doc : { ...doc, edges: next }
}

export function relabel<T extends FlowDoc>(doc: T, edgeId: string, label: string): T {
  const clean = label.trim().slice(0, 40)
  return {
    ...doc,
    edges: (doc.edges ?? []).map((e) => {
      if (e.id !== edgeId) return e
      const { label: _old, ...rest } = e // eslint-disable-line @typescript-eslint/no-unused-vars
      return clean ? { ...rest, label: clean } : rest
    }),
  }
}

/// Pin a page where it was dropped (rounded — sub-pixel positions are noise).
export function placePage<T extends FlowDoc>(doc: T, route: string, at: FlowPoint): T {
  return {
    ...doc,
    positions: { ...(doc.positions ?? {}), [route]: { x: Math.round(at.x), y: Math.round(at.y) } },
  }
}
