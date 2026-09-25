/// Reading a comment row the way it arrives, and the board it points at.
///
/// `DesignComment` is an ORM row, so it comes back with its COLUMN names —
/// `page_path`, `resolution_note` (see the naming note at the top of
/// `design-api.ts`). Reading one by the other spelling is neither a type error
/// nor a runtime error: it is `undefined`, silently, which is how the inspector
/// drew a blank route label, never showed a resolution note, and focused
/// nothing at all when a comment was clicked.
///
/// So the readings of a comment's row live here as pure functions rather
/// than as expressions inside JSX, and `design-comments.test.ts` feeds them a
/// wire-shaped body. Behaviour is the only thing a test can hold on to;
/// `tsc` was satisfied the whole time the label was blank.
///
/// A module rather than exports from `design-inspector.tsx`, which is where the
/// reads started: two components need them (`design-inspector.tsx` and
/// `DesignSurfacePage.tsx`), and a `.tsx` that exports non-components costs a
/// `react-refresh/only-export-components` error apiece.

import type { DesignComment } from "@/lib/design-api"
import type { Artboard } from "@/lib/design-devices"

/// The route a comment was captured on — the label the list prints, and the key
/// every board lookup below matches on.
export function commentRoute(comment: DesignComment): string {
  return comment.page_path
}

/// The element a comment was pinned to, inside that route's frame: the selector
/// the frame's `design:flash` queries and the anchor the dispatch sends. The
/// other half of the target the inspector's selection list matches a row on
/// (see `commentsForSelection`), so it is read here with the route rather than
/// by its column name at the call site.
export function commentElementPath(comment: DesignComment): string {
  return comment.element_path
}

/// The comment's resolution note, or `null` when there is nothing to show. Both
/// spellings of "no note" answer `null`: a row that never carried one, and a
/// resolve that left only whitespace — which would otherwise draw an empty
/// italic block the reader cannot tell from a rendering fault.
export function commentResolutionNote(comment: DesignComment): string | null {
  return comment.resolution_note?.trim() || null
}

/// Every artboard a comment appears on — one pin per device view of its route.
export function boardsForComment(boards: Artboard[], comment: DesignComment): Artboard[] {
  return boards.filter((b) => b.route === commentRoute(comment))
}

/// The board a comment "take me there" zooms to: the first view of its route.
export function boardForComment(
  boards: Artboard[],
  comment: DesignComment,
): Artboard | undefined {
  return boardsForComment(boards, comment)[0]
}
