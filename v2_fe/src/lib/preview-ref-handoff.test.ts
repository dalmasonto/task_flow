import { describe, expect, it } from "vitest"

import { handOffFromPreview } from "./preview-ref-handoff"

describe("handOffFromPreview", () => {
  it("closes the preview BEFORE opening the target", () => {
    // The order is the whole fix. The preview sits at z-80/81 and the task sheet
    // at z-40/50, so opening the sheet while the preview is still up puts it 30
    // layers underneath — visible to nobody. Closing first means only one
    // surface is ever mounted, and no z-index can be wrong.
    const calls: string[] = []
    const handoff = handOffFromPreview(
      () => calls.push("close"),
      () => calls.push("open"),
    )

    handoff?.(42)

    expect(calls).toEqual(["close", "open"])
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
    // Wrapping null in a closure would make every chip look clickable and then
    // do nothing — worse than the inert state it replaced.
    expect(handOffFromPreview(() => {}, null)).toBeNull()
  })

  it("still closes the preview when opening throws", () => {
    // A failure to open must not strand the user under a dialog they can no
    // longer see past. Close having already happened is the point of the order.
    const calls: string[] = []
    const handoff = handOffFromPreview(
      () => calls.push("close"),
      () => {
        calls.push("open")
        throw new Error("boom")
      },
    )

    expect(() => handoff?.(1)).toThrow("boom")
    expect(calls).toEqual(["close", "open"])
  })
})
