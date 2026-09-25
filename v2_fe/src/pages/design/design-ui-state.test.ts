import { describe, it, expect } from "vitest"
import { DEFAULT_DEVICE_ID } from "@/lib/design-devices"
import { parseUIState } from "./design-ui-state"

const valid = {
  openRoutes: ["/", "/login"],
  deviceIds: ["laptop"],
  transform: { x: 10, y: 20, scale: 1 },
  canvasTool: "pan",
  rightTab: "tokens",
  theme: "dark",
}

describe("parseUIState", () => {
  it("accepts a well-formed record", () => {
    const state = parseUIState(valid, 4, 2)
    expect(state).toMatchObject({
      userId: 4,
      projectId: 2,
      openRoutes: ["/", "/login"],
      deviceIds: ["laptop"],
      canvasTool: "pan",
      rightTab: "tokens",
      theme: "dark",
    })
  })

  it("returns null only for a non-object, and defaults an empty record", () => {
    expect(parseUIState(null, 4, 2)).toBeNull()
    expect(parseUIState(undefined, 4, 2)).toBeNull()
    expect(parseUIState("nope", 4, 2)).toBeNull()
    // `{}` is a *valid object*, so it does not take the null return — every
    // field defaults instead. That is the right contract ("anything in, a
    // usable state out"), and it still converges for the caller: an empty
    // openRoutes makes `shouldSeedRoutes` return true, so the manifest seed
    // runs either way.
    const empty = parseUIState({}, 4, 2)!
    expect(empty.openRoutes).toEqual([])
    expect(empty.deviceIds).toEqual([DEFAULT_DEVICE_ID])
    expect(empty.canvasTool).toBe("select")
  })

  it("clamps a scale outside the legal range or non-finite", () => {
    // Review Focus #5: a hand-edited or foreign-build record must not be able
    // to render the canvas at scale 9 or NaN.
    const huge = parseUIState({ ...valid, transform: { x: 0, y: 0, scale: 9 } }, 4, 2)!
    expect(huge.transform.scale).toBeLessThanOrEqual(2)
    expect(huge.transform.scale).toBeGreaterThan(0)

    const tiny = parseUIState({ ...valid, transform: { x: 0, y: 0, scale: 0.001 } }, 4, 2)!
    expect(tiny.transform.scale).toBeGreaterThanOrEqual(0.25)

    const nan = parseUIState({ ...valid, transform: { x: 0, y: 0, scale: Number.NaN } }, 4, 2)!
    expect(Number.isFinite(nan.transform.scale)).toBe(true)

    // Junk x/y degrade to the canvas's own fresh-viewport origin, not to 0:
    // `DesignSurfacePage` opens at { x: 40, y: 40, scale: 0.6 }, so a damaged
    // record has to land on the same view a fresh one gets.
    const junk = parseUIState({ ...valid, transform: { x: "a", y: null, scale: 1 } }, 4, 2)!
    expect(junk.transform.x).toBe(40)
    expect(junk.transform.y).toBe(40)
  })

  it("drops device ids the preset table no longer knows", () => {
    const state = parseUIState({ ...valid, deviceIds: ["laptop", "nokia-3310"] }, 4, 2)!
    expect(state.deviceIds).toEqual(["laptop"])
  })

  it("falls back for an unknown tool, tab or empty device list", () => {
    const state = parseUIState(
      { ...valid, canvasTool: "laser", rightTab: "nope", deviceIds: [] },
      4,
      2,
    )!
    expect(state.canvasTool).toBe("select")
    expect(state.rightTab).toBe("pages")
    expect(state.deviceIds.length).toBeGreaterThan(0)
  })

  it("drops non-string entries from openRoutes", () => {
    const state = parseUIState({ ...valid, openRoutes: ["/", 7, null] }, 4, 2)!
    expect(state.openRoutes).toEqual(["/"])
  })
})
