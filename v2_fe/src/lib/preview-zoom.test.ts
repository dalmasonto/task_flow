import { describe, expect, it } from "vitest"

import { IMAGE_START_ZOOM, clampZoom, readImageZoom, stepZoom, writeImageZoom, zoomLimits } from "./preview-zoom"

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

describe("remembered image zoom", () => {
  const memory = () => {
    const data = new Map<string, string>()
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    }
  }

  it("starts at 50% and then remembers the last choice", () => {
    const storage = memory()
    expect(readImageZoom(storage)).toBe(IMAGE_START_ZOOM)
    writeImageZoom(0.8, storage)
    expect(readImageZoom(storage)).toBe(0.8)
    writeImageZoom(IMAGE_START_ZOOM, storage)
    expect(readImageZoom(storage)).toBe(IMAGE_START_ZOOM)
  })

  it("survives junk and storage that throws", () => {
    expect(readImageZoom({ getItem: () => "nope" })).toBe(IMAGE_START_ZOOM)
    expect(readImageZoom({ getItem: () => "99" })).toBe(zoomLimits("image").max)
    const broken = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {},
    }
    expect(readImageZoom(broken)).toBe(IMAGE_START_ZOOM)
    expect(() => writeImageZoom(1, broken)).not.toThrow()
  })
})
