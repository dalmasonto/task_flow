import { describe, expect, it } from "vitest"

import { clampZoom, fitScale, stepZoom, zoomLimits } from "./preview-zoom"

describe("preview zoom", () => {
  it("fits a tall phone screenshot by height, keeping its aspect", () => {
    // 1179×2556 into a 900×600 stage: height is the limit.
    const s = fitScale({ w: 1179, h: 2556 }, { w: 900, h: 600 })
    expect(s).toBeCloseTo(600 / 2556, 5)
    expect(1179 * s).toBeLessThan(900)
  })

  it("never enlarges a small image to fit", () => {
    expect(fitScale({ w: 200, h: 100 }, { w: 900, h: 600 })).toBe(1)
  })

  it("lets images zoom below 100% and down to 10%", () => {
    expect(stepZoom("image", 1, -1)).toBeCloseTo(0.8, 5)
    expect(clampZoom("image", 0.01)).toBe(zoomLimits("image").min)
    expect(fitScale({ w: 100_000, h: 100_000 }, { w: 500, h: 500 })).toBe(0.1)
  })

  it("steps images multiplicatively and stops at 400%", () => {
    expect(stepZoom("image", 0.2, 1)).toBeCloseTo(0.25, 5)
    expect(stepZoom("image", 3.9, 1)).toBe(4)
  })

  it("keeps PDFs at 100–300% in 25% steps", () => {
    expect(stepZoom("pdf", 1, -1)).toBe(1)
    expect(stepZoom("pdf", 1, 1)).toBe(1.25)
    expect(stepZoom("pdf", 3, 1)).toBe(3)
  })
})
