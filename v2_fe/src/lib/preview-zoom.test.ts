import { describe, expect, it } from "vitest"

import { IMAGE_START_ZOOM, clampZoom, stepZoom, zoomLimits } from "./preview-zoom"

describe("preview zoom", () => {
  it("opens images at a fixed 50%", () => {
    expect(IMAGE_START_ZOOM).toBe(0.5)
  })

  it("lets images zoom below 100% and down to 10%", () => {
    expect(stepZoom("image", 1, -1)).toBeCloseTo(0.8, 5)
    expect(clampZoom("image", 0.01)).toBe(zoomLimits("image").min)
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
