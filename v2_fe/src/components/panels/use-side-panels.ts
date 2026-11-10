/// One row of [left panel | canvas | right panel] with resizable sides
/// (#1083): measures the row, fits the two stored widths around the canvas
/// minimum, and hands each side's ResizeHandle what it needs.
import { useCallback, useEffect, useRef, useState } from "react"

import { fitPanels, usePanelWidth, type PanelSpec } from "./panel-width"

export function useSidePanels(left: PanelSpec, right: PanelSpec, userId: number | null, open: { left: boolean; right: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowW, setRowW] = useState(0)
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRowW(el.clientWidth))
    ro.observe(el)
    setRowW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const [leftStored, setLeft, leftDefault] = usePanelWidth(left, userId)
  const [rightStored, setRight, rightDefault] = usePanelWidth(right, userId)
  const [last, setLast] = useState<"a" | "b">("b")
  const [leftW, rightW] = fitPanels(rowW, { width: leftStored, spec: left, open: open.left }, { width: rightStored, spec: right, open: open.right }, last)
  const rowWidth = useCallback(() => rowRef.current?.clientWidth ?? 0, [])

  return {
    rowRef,
    leftWidth: leftW || leftStored,
    rightWidth: rightW || rightStored,
    leftHandle: {
      edge: "right" as const,
      width: leftW || leftStored,
      spec: left,
      defaultWidth: leftDefault,
      otherWidth: rightW,
      rowWidth,
      onChange: (w: number, persist: boolean) => {
        setLast("a")
        setLeft(w, persist)
      },
    },
    rightHandle: {
      edge: "left" as const,
      width: rightW || rightStored,
      spec: right,
      defaultWidth: rightDefault,
      otherWidth: leftW,
      rowWidth,
      onChange: (w: number, persist: boolean) => {
        setLast("b")
        setRight(w, persist)
      },
    },
  }
}
