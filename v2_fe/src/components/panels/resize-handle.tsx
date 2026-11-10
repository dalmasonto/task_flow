/// The drag handle on a side panel's inner edge (#1083). Drag to resize,
/// double-click to go back to the default, or focus it and use the arrow keys
/// (Shift for bigger steps). Only from `lg` up, where the panels are columns;
/// below that they're overlays with a fixed width.
import { useRef } from "react"

import { cn } from "@/lib/utils"

import { clampPanelWidth, keyboardStep, type PanelSpec } from "./panel-width"

export function ResizeHandle({
  edge,
  width,
  spec,
  defaultWidth,
  otherWidth,
  rowWidth,
  onChange,
  label,
}: {
  /** A left panel's handle is on its right edge (drag right to widen); a
   *  right panel's on its left edge. */
  edge: "right" | "left"
  width: number
  spec: PanelSpec
  /** Where a double-click puts it back. */
  defaultWidth: number
  /** The other panel's drawn width (0 when closed), for the canvas minimum. */
  otherWidth: number
  /** The row both panels and the canvas share. */
  rowWidth: () => number
  /** `persist` is false while dragging and true on commit. */
  onChange: (width: number, persist: boolean) => void
  label: string
}) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const widen: 1 | -1 = edge === "right" ? 1 : -1
  const clamp = (w: number) => clampPanelWidth(w, spec, rowWidth(), otherWidth)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className={cn("group absolute inset-y-0 z-20 hidden w-3 cursor-col-resize touch-none outline-none lg:block", edge === "right" ? "-right-1.5" : "-left-1.5")}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width }
        document.body.style.userSelect = "none"
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        onChange(clamp(drag.current.w + (e.clientX - drag.current.x) * widen), false)
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        const next = clamp(drag.current.w + (e.clientX - drag.current.x) * widen)
        drag.current = null
        document.body.style.userSelect = ""
        onChange(next, true)
      }}
      onPointerCancel={() => {
        drag.current = null
        document.body.style.userSelect = ""
      }}
      onDoubleClick={() => onChange(clamp(defaultWidth), true)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
        e.preventDefault()
        const towardWider = (e.key === "ArrowRight") === (edge === "right")
        onChange(clamp(width + keyboardStep(e.shiftKey, towardWider ? 1 : -1)), true)
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-active:bg-ring"
      />
    </div>
  )
}
