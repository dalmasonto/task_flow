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
