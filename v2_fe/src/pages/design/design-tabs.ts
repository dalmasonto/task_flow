/// Pure tab-selection helper for the design surface's right panel (Task 8 of
/// the design-phase2 tabs/tokens work). Kept out of `DesignSurfacePage.tsx` so
/// it can be unit-tested without pulling in the page's React tree.

/// The four right-panel tabs, in display order.
export type DesignTab = "inspect" | "components" | "tokens" | "pages"

/// The auto-focus rule: a newly-appeared selection (an element picked on the
/// canvas) jumps the panel to Inspect so the human sees what they clicked.
/// Anything else — the selection persisting, changing shape, or clearing —
/// leaves whatever tab is already open alone; the human is looking at
/// something and a tab change under them would be a footgun. The one
/// exception is the very first call (`currentTab` is the empty-string
/// sentinel, meaning "no tab chosen yet"): default to Pages, or to Inspect if
/// a selection is somehow already present at mount.
export function nextDesignTab(
  prevHasSelection: boolean,
  currentTab: string,
  nextHasSelection: boolean,
): string {
  if (nextHasSelection && !prevHasSelection) return "inspect"
  if (!currentTab) return nextHasSelection ? "inspect" : "pages"
  return currentTab
}
