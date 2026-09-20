/// Pure pointer-mode helper for the design canvas toolbar (Phase 3 Task 3).
/// Kept out of `DesignSurfacePage.tsx` and `design-canvas.tsx` so the
/// keyboard-shortcut mapping can be unit-tested without pulling in React.

/// The two canvas pointer modes: Select (today's click/pick behavior) and Pan
/// (plain left-drag pans the canvas). The element-inspector "Pick" crosshair
/// is a separate toggle and does not live here.
export type CanvasTool = "select" | "pan"

/// Keyboard shortcuts: `v` selects, `h` pans (industry-standard mnemonics —
/// "hand" for pan). Case-insensitive. Any other key is not a tool shortcut.
export function toolForKey(key: string): CanvasTool | null {
  switch (key.toLowerCase()) {
    case "v":
      return "select"
    case "h":
      return "pan"
    default:
      return null
  }
}
