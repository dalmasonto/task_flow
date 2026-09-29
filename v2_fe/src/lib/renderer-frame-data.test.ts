import { describe, expect, it } from "vitest"

// The screenshot renderer (backend/renderer/frames.mjs) dresses agent
// screenshots in the same frames this app draws, from its own copy of the
// tables. It is a separate deployable that cannot import from here, so this
// test is what keeps the copy honest: change a frame here and it fails until
// backend/renderer/frame-data.json says the same.
import rendererData from "../../../backend/renderer/frame-data.json"
import indexCss from "../index.css?raw"
import { DEVICE_PRESETS, chromeStyleForGroup } from "./design-devices"
import { FRAME_METRICS, frameFor, statusBarStyle } from "./design-frames"

/// The presets the backend accepts as `viewport` ids. The canvas also derives
/// `<id>:landscape` variants, which screenshots do not offer.
const BASE_PRESETS = DEVICE_PRESETS.filter((d) => !d.id.includes(":"))

describe("renderer frame data mirrors the Design Surface", () => {
  it("maps every preset to the same devices.css frame", () => {
    const ours = Object.fromEntries(
      BASE_PRESETS.flatMap((d) => {
        const frame = frameFor(d.id)
        return frame ? [[d.id, frame]] : []
      }),
    )
    expect(rendererData.frames).toEqual(ours)
  })

  it("has the same frame metrics and status-bar styles", () => {
    expect(rendererData.metrics).toEqual(FRAME_METRICS)
    const styles = Object.fromEntries(
      Object.keys(FRAME_METRICS).flatMap((frame) => {
        const style = statusBarStyle(frame)
        return style ? [[frame, style]] : []
      }),
    )
    expect(rendererData.statusStyles).toEqual(styles)
  })

  it("groups presets and draws classic chrome the same way", () => {
    expect(rendererData.groups).toEqual(Object.fromEntries(BASE_PRESETS.map((d) => [d.id, d.group])))
    for (const group of ["phone", "tablet", "laptop"] as const) {
      expect(rendererData.chrome[group]).toEqual(chromeStyleForGroup(group))
    }
  })

  it("carries the .tf-frame radius overrides from index.css", () => {
    const rules = (css: string) =>
      [...css.matchAll(/(\.tf-frame\.device-[\w-]+ \.device-(?:frame|screen))\s*\{\s*border-radius:\s*(\d+px);?\s*\}/g)]
        .map((m) => `${m[1]}{border-radius:${m[2]}}`)
        .sort()
    expect(rules(rendererData.frameCss)).toEqual(rules(indexCss))
    expect(rules(indexCss).length).toBeGreaterThan(0)
  })
})
