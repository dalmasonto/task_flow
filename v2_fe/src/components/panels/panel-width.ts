/// Resizable side panels (#1083), shared by the Design and Database pages:
/// the width rules (pure, tested) and a hook that remembers each panel's width
/// per user, in the design settings database (`taskflow_design_ui.panels`).
///
/// Rules: every panel has a range; its default scales with the window (about a
/// quarter of it), so a big screen gets big panels; and the canvas between the
/// two panels always keeps at least `CANVAS_MIN` px. When both panels together
/// would squeeze it, the one you didn't just drag gives way first.
import { useCallback, useEffect, useState } from "react"

import { readPanelWidthRow, writePanelWidthRow } from "@/pages/design/design-ui-state"

export const CANVAS_MIN = 420

export type PanelSpec = {
  key: string
  min: number
  max: number
  /// The default, as a share of the window width, kept inside [min, max].
  share: number
}

/// Every panel opens at the same width (Dalmas: both sides alike, on Design
/// and Database), never under the 380 px Design always had.
export const DEFAULT_FLOOR = 380

export const DESIGN_CHAT_PANEL: PanelSpec = { key: "design.chat", min: 320, max: 880, share: 0.25 }
export const DESIGN_SIDE_PANEL: PanelSpec = { key: "design.side", min: 320, max: 880, share: 0.25 }
export const DB_CHAT_PANEL: PanelSpec = { key: "db.chat", min: 320, max: 880, share: 0.25 }
export const DB_SIDE_PANEL: PanelSpec = { key: "db.side", min: 320, max: 880, share: 0.25 }

/// The default width on a window this wide: 380 up to 1520, then a quarter
/// of the window (1920 → 480, 2560 → 640), inside [min, max].
export function defaultWidth(spec: PanelSpec, windowWidth: number): number {
  return Math.round(Math.max(spec.min, Math.min(spec.max, Math.max(DEFAULT_FLOOR, windowWidth * spec.share))))
}

/// Clamp a requested width: inside the panel's range, and never so wide the
/// canvas drops below `CANVAS_MIN` given the row and the other panel. On a row
/// too small for even the minimum, the minimum wins (panels are sheets below
/// `lg` anyway).
export function clampPanelWidth(requested: number, spec: Pick<PanelSpec, "min" | "max">, rowWidth: number, otherPanelWidth: number): number {
  const room = rowWidth > 0 ? rowWidth - otherPanelWidth - CANVAS_MIN : spec.max
  const max = Math.max(spec.min, Math.min(spec.max, room))
  return Math.round(Math.max(spec.min, Math.min(requested, max)))
}

/// The widths to draw two panels at in a row: each as stored, but when they'd
/// leave the canvas under its minimum, the panel NOT last dragged shrinks
/// first (down to its min), then the other. A closed panel takes no room.
export function fitPanels(
  rowWidth: number,
  a: { width: number; spec: PanelSpec; open: boolean },
  b: { width: number; spec: PanelSpec; open: boolean },
  lastDragged: "a" | "b",
): [number, number] {
  let wa = a.open ? a.width : 0
  let wb = b.open ? b.width : 0
  if (rowWidth <= 0) return [wa, wb]
  let over = wa + wb + CANVAS_MIN - rowWidth
  const give = (w: number, min: number) => {
    const cut = Math.min(over, Math.max(0, w - min))
    over -= cut
    return w - cut
  }
  if (over > 0) {
    if (lastDragged === "a") {
      if (b.open) wb = give(wb, b.spec.min)
      if (a.open) wa = give(wa, a.spec.min)
    } else {
      if (a.open) wa = give(wa, a.spec.min)
      if (b.open) wb = give(wb, b.spec.min)
    }
  }
  return [Math.round(wa), Math.round(wb)]
}

/// One keyboard step: 16 px, or 64 px with Shift. `direction` is +1 to widen.
export function keyboardStep(shift: boolean, direction: 1 | -1): number {
  return (shift ? 64 : 16) * direction
}

// A synchronous mirror of the stored width, so the first paint is already the
// right size (IndexedDB answers a moment later and stays the source of truth).
const mirrorKey = (userId: number | null, key: string) => `taskflow.panelWidth.${userId ?? "anon"}.${key}`

function readMirror(userId: number | null, spec: PanelSpec): number | null {
  try {
    const n = Number(localStorage.getItem(mirrorKey(userId, spec.key)))
    return Number.isFinite(n) && n >= spec.min && n <= spec.max ? n : null
  } catch {
    return null
  }
}

/// A panel's width for this user, with a setter. `persist` false while
/// dragging (no write per pixel), true on commit (drag end, key, reset).
/// `null` stored = no choice yet: the window-relative default applies.
export function usePanelWidth(spec: PanelSpec, userId: number | null) {
  const [stored, setStored] = useState<number | null>(() => readMirror(userId, spec))
  const [winW, setWinW] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth))

  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    if (userId == null) return
    let cancelled = false
    void readPanelWidthRow(userId, spec.key).then((w) => {
      if (!cancelled && w != null && w >= spec.min && w <= spec.max) setStored(w)
    })
    return () => {
      cancelled = true
    }
  }, [userId, spec.key, spec.min, spec.max])

  const setWidth = useCallback(
    (next: number | null, persist = true) => {
      setStored(next)
      if (!persist) return
      try {
        if (next == null) localStorage.removeItem(mirrorKey(userId, spec.key))
        else localStorage.setItem(mirrorKey(userId, spec.key), String(next))
      } catch {
        /* private mode: it just won't stick */
      }
      if (userId != null && next != null) void writePanelWidthRow(userId, spec.key, next)
    },
    [userId, spec.key],
  )

  return [stored ?? defaultWidth(spec, winW), setWidth, defaultWidth(spec, winW)] as const
}
