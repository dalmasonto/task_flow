/// Selection sanitizing + pin numbering — shared by the canvas, inspector and
/// tests (kept out of component files so fast refresh stays happy).

import type { Artboard } from "@/lib/design-devices"

export type SelectionState = {
  /** Validated fields of the sandbox `design:select` message. */
  component: string | null
  elementPath: string
  srcRef: string | null
  tag: string
  text: string
  snippet: string
  rect: { x: number; y: number; w: number; h: number }
  /** The clicked element's chain of ancestors, outermost first, ending with the
   *  element itself. `dataset.component || tagName` per element, so a label is
   *  a component name where one is stamped and a tag name otherwise. */
  ancestors: string[]
  /** Per crumb, what `elementPath` would have been had that element been
   *  clicked — the only way back from a crumb to an element, since a label
   *  cannot be turned into a selector. Index-aligned with `ancestors`. */
  ancestorPaths: string[]
  /** Per crumb, what `component` would have been (`closest('[data-component]')`
   *  at or above it). `""` means "inside no component" — an empty hole rather
   *  than a dropped entry, so the three arrays stay index-aligned. */
  ancestorComponents: string[]
  route: string
  viewport: string
}

/** Shape-check + clamp one postMessage selection before it touches state.
 *  Everything inbound came through postMessage — hostile until proven else. */
export function sanitizeSelection(
  raw: Record<string, unknown>,
  route: string,
  viewport: string,
): SelectionState | null {
  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.slice(0, max) : ""
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0
  // The three per-crumb arrays are three slices of ONE chain of elements in the
  // frame, so they are clamped by ONE rule: same last-six window, same order,
  // nothing filtered out. Index `i` has to name the same element in all three —
  // the breadcrumb widens a selection by index — so a non-string entry becomes
  // `""` (an empty crumb) rather than being dropped and shifting every crumb
  // after it onto its neighbour's path. Lengths mirror the columns they feed:
  // `ancestors`/`ancestorComponents` a component name, `ancestorPaths` an
  // `element_path` (500).
  const chain = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.slice(-6).map((x) => (typeof x === "string" ? x.slice(0, max) : "")) : []
  const rectRaw = (raw.rect ?? {}) as Record<string, unknown>
  const ancestors = chain(raw.ancestors, 120)
  const ancestorPaths = chain(raw.ancestorPaths, 500)
  const ancestorComponents = chain(raw.ancestorComponents, 120)
  // ...and the clamp above cannot make them the same window as EACH OTHER.
  // Three independent `slice(-6)`s of a frame that sent nine labels and three
  // paths are still three different windows, and index `i` then names two
  // different elements. Nothing downstream can tell: the breadcrumb offers a
  // crumb for `ancestors[i]` (a live-looking button — the panel checks only that
  // a path exists at `i`) and the click re-anchors to `ancestorPaths[i]`, so the
  // comment lands on an element the human never saw. So the invariant is
  // ENFORCED here, where the wire enters, rather than assumed there. A frame
  // that disagrees with itself is treated as one from before the chain existed:
  // the labels are kept — they are what the breadcrumb draws, and a row of plain
  // text is the honest rendering of "this cannot be widened" — while the two
  // arrays that widening needs are dropped. Refused rather than guessed, as
  // `widenSelection` refuses a crumb it cannot resolve.
  const aligned =
    ancestorPaths.length === ancestors.length && ancestorComponents.length === ancestors.length
  return {
    component: typeof raw.component === "string" ? raw.component.slice(0, 120) : null,
    elementPath: str(raw.elementPath, 500),
    srcRef: typeof raw.src === "string" ? raw.src.slice(0, 200) : null,
    tag: str(raw.tag, 40),
    text: str(raw.text, 80),
    snippet: str(raw.snippet, 600),
    rect: {
      x: num(rectRaw.x),
      y: num(rectRaw.y),
      w: Math.max(0, num(rectRaw.w)),
      h: Math.max(0, num(rectRaw.h)),
    },
    ancestors,
    ancestorPaths: aligned ? ancestorPaths : [],
    ancestorComponents: aligned ? ancestorComponents : [],
    route,
    viewport,
  }
}

/// The tag a frame path ends on: `header:nth-child(1) > nav:nth-child(3)` →
/// `nav`. A crumb's label is `dataset.component || tagName`, so for a component
/// crumb the label names the COMPONENT and the path's last segment is the only
/// place the element's own tag survives — which is why widening reads it here
/// rather than assuming the label.
function tagOfPath(path: string): string {
  const last = path.split(" > ").pop() ?? ""
  return last.split(":nth-child(")[0].trim().slice(0, 40)
}

/// The selection a breadcrumb click produces: the same click, re-anchored to
/// the crumb at `index`.
///
/// `index` counts from the OUTERMOST crumb (0) to the clicked element itself
/// (`ancestors.length - 1`), matching how the breadcrumb renders the chain.
///
/// Identity comes from the crumb — `elementPath`, `component` and `tag` all
/// describe THAT element — while the captured artifacts stay the click's:
/// `rect`, because the chrome cannot measure or re-read a cross-origin element
/// and a pin that moved off the spot the human pointed at would mark a region
/// they never touched. `element_path` is the resolvable anchor on both sides
/// (the frame's `design:flash` querySelector, and the dispatch's target), so
/// the agent is sent to the crumb's element regardless.
///
/// The two captures that NAME something else go, unless this crumb IS the
/// click: `srcRef` is the file the clicked element was stamped from and
/// `snippet` is its own markup. Both are dispatched beside the crumb's
/// `elementPath`/`component`/`file`, so a crumb outside the component would tell
/// the agent `file: pages/settings.html` in one field and
/// `src: components/app-header.html:7` in another, with a snippet of an element
/// the target does not even contain — three answers to one question, two of them
/// about a different element. They are not marks the agent can weigh against
/// each other: nothing in the dispatch says which field is authoritative, and
/// the crumb's anchor is the one both the flash and the dispatch resolve. So the
/// stale pair is dropped rather than left to disagree — and for the innermost
/// crumb, which IS the clicked element, they describe exactly the target and
/// stay.
///
/// `null` for an index outside the chain, or a crumb with no path: a stale
/// render, or a frame from before the chain existed. Refused rather than
/// guessed — a comment that silently names the wrong element is exactly the
/// failure this function exists to prevent.
export function widenSelection(selection: SelectionState, index: number): SelectionState | null {
  if (!Number.isInteger(index) || index < 0 || index >= selection.ancestors.length) return null
  const elementPath = selection.ancestorPaths[index]
  if (!elementPath) return null
  // The innermost crumb IS the clicked element, so when a frame sent paths
  // without components its nearest host is already known from the click.
  const isClicked = index === selection.ancestors.length - 1
  return {
    ...selection,
    elementPath,
    component: selection.ancestorComponents[index] || (isClicked ? selection.component : null),
    tag: tagOfPath(elementPath) || selection.ancestors[index],
    srcRef: isClicked ? selection.srcRef : null,
    snippet: isClicked ? selection.snippet : "",
    // The crumb's own upward chain: a prefix of the chain we already hold, so
    // the rebuilt breadcrumb shows this crumb as current and can widen again.
    ancestors: selection.ancestors.slice(0, index + 1),
    ancestorPaths: selection.ancestorPaths.slice(0, index + 1),
    ancestorComponents: selection.ancestorComponents.slice(0, index + 1),
  }
}

const PIN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** Stable small badge label per comment row id for the pin. */
export function pinNumber(id: number): string {
  const n = ((id - 1) % PIN_ALPHABET.length + PIN_ALPHABET.length) % PIN_ALPHABET.length
  return PIN_ALPHABET[n]
}

export function boardForRoute(boards: Artboard[], route: string): Artboard | undefined {
  return boards.find((b) => b.route === route)
}
