/// The multi-selection list: several components picked, possibly on several
/// different pages, with ONE of them active.
///
/// The single selection the rest of the surface addresses — the canvas overlay,
/// the chat rail's context chip, the comment pins, the Inspector's form — is
/// `list[active]`. Everything that reads "the selection" goes on reading the
/// active row, which is why the operations here are index-based rather than
/// being a second, parallel notion of selection: `active` is an index into
/// `list`, and every function below returns one that names a real row (or -1
/// when there is none).
///
/// A module rather than `useState` bodies inside `DesignSurfacePage.tsx`, for
/// the reason `design-comments.ts` and `token-filter.ts` give: this is where the
/// feature can go wrong INVISIBLY. A duplicate row costs nothing at runtime and
/// nothing in `tsc` — it is two rows for one element, one of which will be
/// removed by hand later and leave a twin looking uncommented. An `active` past
/// the end throws nowhere either: the Inspector's form is rendered from
/// `list[active]`, so `undefined` there is a panel that draws no form at all.
///
/// The identity rule, in ONE place (`targetKey` below): a row is one
/// (route, elementPath) pair. Not `elementPath` alone — the same markup on two
/// pages is two different components to comment on, which is the whole reason
/// the user asked for this — and not the element's `component` name, which a
/// frame may not have stamped at all.

import type { DesignComment } from "@/lib/design-api"
import { commentElementPath, commentRoute } from "./design-comments"
import type { SelectionState } from "./design-selection"

/// The list plus the index of the row that is active. `active` is `-1` exactly
/// when the list is empty; every operation here maintains that.
export type SelectionList<T> = { list: T[]; active: number }

/// The identity of a target: the page it is on and the selector that resolves
/// to it inside that page's frame. `\u0000` because a route is a path and an
/// element path is a chain of ` > `-joined segments — a separator that could
/// appear in either (a space, a slash) would let two different targets collide.
const targetKey = (route: string, elementPath: string) => `${route}\u0000${elementPath}`

const key = (s: SelectionState) => targetKey(s.route, s.elementPath)

/// Add `next` unless an equivalent selection is already present (same route AND
/// same elementPath), in which case that row is RE-POINTED at `next` and left
/// where it is. Returns the list and the index that is now active.
///
/// Two clicks on one element are one row — the second click is a re-activation,
/// not a second selection — but they are still two CLICKS, and the row carries
/// where the click landed: `boardKey`, `rect` and `viewport`. One route is open
/// on one board per selected device, and those boards are the same page in the
/// same DOM, so the same element clicked on the laptop board has the same route
/// and the same element path as the click on the phone board. Re-activating
/// without re-pointing therefore leaves the row naming the FIRST board: the
/// canvas overlay stays on the other screen and the click just made shows
/// nothing at all, which is the whole feedback the human gets.
///
/// What a refresh leaves alone is the row's IDENTITY — route and elementPath,
/// the pair the search matched on — so the row's React key and its comment
/// badge, which are both keyed on that pair, do not move.
///
/// The list handed in is never modified: a hit maps to a new array and a miss
/// copies, so a caller holding the previous list cannot be surprised by it.
export function addSelection<T extends SelectionState>(list: T[], next: T): SelectionList<T> {
  const at = list.findIndex((s) => key(s) === key(next))
  if (at >= 0) return { list: list.map((s, i) => (i === at ? next : s)), active: at }
  return { list: [...list, next], active: list.length }
}

/// Replace the row at `index` with `next` — the breadcrumb's `widenSelection`,
/// which re-anchors the active row to one of its ancestors.
///
/// The row keeps its POSITION: widening is a change to one row, and a row that
/// jumped to the bottom of the list while the human watched it happen would
/// read as a second selection.
///
/// A row that already names `next`'s target is dropped, and it is the other one
/// that goes — widening onto an ancestor another row already holds is the
/// second way to reach the duplicate `addSelection` dedupes away, and "one row
/// per target" is an invariant of the list rather than of one click path.
///
/// `active` is the surviving row's new index: dropping a row ABOVE it shifts it
/// up, and the row being widened is by definition the one the human is editing.
export function replaceSelection<T extends SelectionState>(
  list: T[],
  index: number,
  next: T,
): SelectionList<T> {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return addSelection(list, next)
  const replaced = list.map((s, i) => (i === index ? next : s))
  const kept = replaced.filter((s, i) => i === index || key(s) !== key(next))
  return { list: kept, active: kept.indexOf(next) }
}

/// Remove the row at `index`, and say which row is active afterwards.
///
/// This takes the whole `{ list, active }` rather than a bare list, and the
/// reason is the invariant it exists to hold: removing a row that is NOT the
/// active one has to leave the active row active — the Inspector's form edits
/// the active row, so a form that silently re-targets another component is the
/// failure this whole module is here to prevent. A function handed only
/// `(list, index)` cannot see which row that was, so the only `active` it could
/// return is "the index the removal landed on": right by accident when the
/// removed row happened to be the active one, and wrong whenever it did not.
///
/// Removing the ACTIVE row hands the slot to the row that followed it (clamped,
/// so removing the last row of the list hands it to the row before), and
/// removing the last remaining row leaves `active` at -1.
///
/// An index that names no row is refused rather than guessed: the state comes
/// back untouched, so a stale render cannot remove a neighbour.
export function removeSelection<T extends SelectionState>(
  state: SelectionList<T>,
  index: number,
): SelectionList<T> {
  const { list, active } = state
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return state
  const kept = list.filter((_, i) => i !== index)
  if (!kept.length) return { list: kept, active: -1 }
  // A removal before the active row shifts it down with the rest; the clamp is
  // for the removal of the active row itself when it was the last one.
  const shifted = index < active ? active - 1 : active
  return { list: kept, active: Math.min(shifted, kept.length - 1) }
}

/// What a row calls the thing it points at: the component when the frame
/// stamped one, else the element's tag. Both empty (a payload that carried
/// neither) still names something — a row with no label is a row with nothing
/// to click.
export function selectionName(selection: SelectionState): string {
  return selection.component || selection.tag || "element"
}

/// The comments already left on a selection — the row's badge, so the human can
/// see which components they have covered while picking the next one.
///
/// Same identity rule as the dedupe above, through the same `targetKey`, and
/// the two sides spell their fields differently: `route`/`elementPath` on a
/// selection, `page_path`/`element_path` on the ORM row a comment arrives as.
/// Reading one by the other's spelling is `undefined` — no type error, no
/// runtime error, every badge silently zero — so both comment-side reads go
/// through `design-comments.ts`'s accessors, which is where that trap is
/// documented (it cost the inspector a blank route label once already).
export function commentsForSelection(
  comments: DesignComment[],
  selection: SelectionState,
): DesignComment[] {
  const wanted = key(selection)
  return comments.filter((c) => targetKey(commentRoute(c), commentElementPath(c)) === wanted)
}
