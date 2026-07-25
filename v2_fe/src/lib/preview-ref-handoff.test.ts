import { describe, expect, it } from "vitest"

import {
  TASK_SHEET_BACKDROP_Z,
  TASK_SHEET_PANEL_Z,
  handOffFromPreview,
  previewLayer,
} from "./preview-ref-handoff"

describe("handOffFromPreview", () => {
  it("backgrounds the preview BEFORE opening the target", () => {
    // Ordering is the fix. The preview has to step behind the task sheet before
    // the sheet mounts, or the sheet appears underneath the document.
    const calls: string[] = []
    const handoff = handOffFromPreview(
      () => calls.push("background"),
      () => calls.push("open"),
    )

    handoff?.(42)

    expect(calls).toEqual(["background", "open"])
  })

  it("passes the reference through untouched", () => {
    const seen: number[] = []
    const handoff = handOffFromPreview(
      () => {},
      (id: number) => seen.push(id),
    )

    handoff?.(7)

    expect(seen).toEqual([7])
  })

  it("stays null when there is no opener, so chips remain inert", () => {
    // `TaskChipContext` defaults to null and chips render as plain styled text.
    // Wrapping null would make every chip look clickable and then do nothing.
    expect(handOffFromPreview(() => {}, null)).toBeNull()
  })

  it("still backgrounds the preview when opening throws", () => {
    const calls: string[] = []
    const handoff = handOffFromPreview(
      () => calls.push("background"),
      () => {
        calls.push("open")
        throw new Error("boom")
      },
    )

    expect(() => handoff?.(1)).toThrow("boom")
    expect(calls).toEqual(["background", "open"])
  })
})

describe("previewLayer", () => {
  it("sits ABOVE the task sheet normally, so a preview opened from a task covers it", () => {
    // The task sheet renders the attachment list, so this is the common
    // direction: sheet open, click an attachment, preview must cover it.
    expect(previewLayer(false).z).toBeGreaterThan(TASK_SHEET_PANEL_Z)
  })

  it("drops BELOW the task sheet once it has handed off", () => {
    // The other direction: a chip clicked inside the preview opens the sheet,
    // which is fixed at z-50 in App.tsx and cannot be raised without breaking
    // the case above. So the preview steps back instead of the sheet stepping
    // up — and it stays open, keeping the reader's place in the document.
    expect(previewLayer(true).z).toBeLessThan(TASK_SHEET_BACKDROP_Z)
  })

  it("releases the focus trap when backgrounded", () => {
    // `modal: "trap-focus"` keeps focus inside the dialog. Left on, the task
    // sheet above would render its comment box unusable — visible, focusable
    // by eye, and refusing to type.
    expect(previewLayer(false).modal).toBe("trap-focus")
    expect(previewLayer(true).modal).toBe(false)
  })

  it("refuses pointer dismissal when backgrounded, so using the sheet cannot close it", () => {
    // A non-modal dialog closes on an outside press by default. Every click in
    // the task sheet is an outside press, so without this the preview would
    // close the moment the user touched the thing they just opened — the bug
    // this whole change exists to avoid.
    expect(previewLayer(true).disablePointerDismissal).toBe(true)
    expect(previewLayer(false).disablePointerDismissal).toBe(false)
  })

  it("names concrete tailwind classes, not computed ones", () => {
    // Tailwind scans source for literal class names; a template-built `z-${n}`
    // is never emitted into the stylesheet and silently has no effect.
    expect(previewLayer(false).backdropClass).toBe("z-80")
    expect(previewLayer(false).popupClass).toBe("z-81")
    expect(previewLayer(true).backdropClass).toBe("z-30")
    expect(previewLayer(true).popupClass).toBe("z-31")
  })
})
