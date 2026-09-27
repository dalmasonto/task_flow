/// #507: the design export's decisions that need no browser — WHICH pages go
/// out and in what order, WHICH frame a device wears, and HOW a PDF page is
/// laid out. Kept pure so every rule here is a unit test, not a screenshot.

import type { RouteEntry } from "@/lib/design-api"
import type { LayoutDoc } from "@/lib/design-layout"
import { deviceById, type DevicePreset } from "@/lib/design-devices"
import { groupedPages } from "../pages-order"

/// What to export. `groups` and `pick` carry the operator's choice; `open` is
/// the boards currently on the canvas.
export type ExportScope =
  | { kind: "all" }
  | { kind: "groups"; groupIds: string[] }
  | { kind: "open" }
  | { kind: "pick"; routes: string[] }

/// One screen in the export, in the order it is printed.
export type ExportItem = {
  route: string
  /// The name the Pages panel lists it under.
  label: string
  /// The group it sits in, or null for an ungrouped page.
  group: string | null
  /// 1-based position in the export — the number printed beside it.
  n: number
}

/// The screens a scope selects, in the Pages panel's order: each group in its
/// order with its pages in flow order, then the ungrouped pages. The panel's
/// order is the one the operator arranged, so the document reads the way the
/// board does.
export function exportItems(
  layout: LayoutDoc,
  routes: RouteEntry[],
  scope: ExportScope,
  openRoutes: string[],
  labelFor: (route: string) => string,
): ExportItem[] {
  const sections = groupedPages(layout, routes)
  const ordered: { route: string; group: string | null; groupId: string | null }[] = [
    ...sections.groups.flatMap((g) => g.pages.map((p) => ({ route: p.route, group: g.name, groupId: g.id }))),
    ...sections.ungrouped.map((p) => ({ route: p.route, group: null, groupId: null })),
  ]
  const keep = (entry: (typeof ordered)[number]) => {
    switch (scope.kind) {
      case "all":
        return true
      case "groups":
        return entry.groupId != null && scope.groupIds.includes(entry.groupId)
      case "open":
        return openRoutes.includes(entry.route)
      case "pick":
        return scope.routes.includes(entry.route)
    }
  }
  return ordered.filter(keep).map((entry, index) => ({
    route: entry.route,
    label: labelFor(entry.route),
    group: entry.group,
    n: index + 1,
  }))
}

// The frames are shared with the canvas (`lib/design-frames`).
export { FRAME_METRICS, frameFor } from "@/lib/design-frames"

/// Phones print four to a page; everything larger prints two (the owner's
/// call: a laptop layout needs the room).
export function screensPerPage(device: DevicePreset): number {
  return device.group === "phone" ? 4 : 2
}

/// A4 in millimetres, and the page furniture every layout reserves.
export const A4 = { w: 210, h: 297 } as const
export const PAGE_MARGIN = { side: 14, top: 22, bottom: 16 } as const
/// Gap between slots, and the room under each image for its caption.
export const SLOT_GAP = 8
export const CAPTION_H = 11

export type PageSetup = {
  orientation: "portrait" | "landscape"
  cols: number
  rows: number
  /// Page size in mm for this orientation.
  pageW: number
  pageH: number
  /// One slot's box (image + caption) in mm.
  slotW: number
  slotH: number
  /// The image's drawn size in mm, fitted into the slot above its caption.
  imageW: number
  imageH: number
}

/// The page arrangement that prints `perPage` images of this aspect ratio
/// (width / height) as LARGE as possible: every orientation × every grid whose
/// cells hold exactly `perPage`, keeping the one with the biggest image. So a
/// laptop screen lands top-and-bottom on a portrait page, a phone four across a
/// landscape one, and a tablet wherever it is biggest — chosen, not guessed.
export function bestPageSetup(aspect: number, perPage: number): PageSetup {
  let best: PageSetup | null = null
  for (const orientation of ["portrait", "landscape"] as const) {
    const pageW = orientation === "portrait" ? A4.w : A4.h
    const pageH = orientation === "portrait" ? A4.h : A4.w
    const areaW = pageW - PAGE_MARGIN.side * 2
    const areaH = pageH - PAGE_MARGIN.top - PAGE_MARGIN.bottom
    for (let cols = 1; cols <= perPage; cols++) {
      if (perPage % cols !== 0) continue
      const rows = perPage / cols
      const slotW = (areaW - SLOT_GAP * (cols - 1)) / cols
      const slotH = (areaH - SLOT_GAP * (rows - 1)) / rows
      const boxH = slotH - CAPTION_H
      if (slotW <= 0 || boxH <= 0) continue
      const imageW = Math.min(slotW, boxH * aspect)
      const imageH = imageW / aspect
      if (!best || imageW * imageH > best.imageW * best.imageH) {
        best = { orientation, cols, rows, pageW, pageH, slotW, slotH, imageW, imageH }
      }
    }
  }
  // perPage >= 1 always yields at least the 1-column layout.
  return best!
}

/// Where slot `index` (0-based, on its page) sits, top-left, in mm.
export function slotOrigin(setup: PageSetup, index: number): { x: number; y: number } {
  const col = index % setup.cols
  const row = Math.floor(index / setup.cols)
  return {
    x: PAGE_MARGIN.side + col * (setup.slotW + SLOT_GAP),
    y: PAGE_MARGIN.top + row * (setup.slotH + SLOT_GAP),
  }
}

/// The export's file name: project and device, safe for any file system.
export function exportFileName(project: string, deviceId: string, ext: "pdf" | "zip"): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "design"
  return `${slug(project)}-${slug(deviceById(deviceId).label)}-screens.${ext}`
}

/// One PNG's name inside the ZIP: its number, then its name — so the files
/// sort in the export's order.
export function screenFileName(item: ExportItem, total: number): string {
  const width = String(total).length
  const slug = item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page"
  return `${String(item.n).padStart(Math.max(2, width), "0")}-${slug}.png`
}
