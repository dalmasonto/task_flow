import { describe, expect, it } from "vitest"

import { fitTransform } from "./canvas-view"
import { MIN_SCALE, MAX_SCALE } from "./design-canvas"

// "iphone-se": 375x667 — see lib/design-devices.ts.
const DEVICE_ID = "iphone-se"
const DEVICE_W = 375
const DEVICE_H = 667

describe("fitTransform", () => {
  it("centers the bounding box in the viewport when the scale is unclamped", () => {
    const boards = [
      { x: 0, y: 0, deviceId: DEVICE_ID },
      { x: 500, y: 0, deviceId: DEVICE_ID },
    ]
    const viewport = { w: 1000, h: 800 }

    const t = fitTransform(boards, viewport)

    // Bounding box: [0, 875] x [0, 667] (second board starts at x=500 and is
    // DEVICE_W wide).
    const bboxW = 500 + DEVICE_W
    const bboxH = DEVICE_H
    const centerWorldX = bboxW / 2
    const centerWorldY = bboxH / 2

    // screen = transform.{x,y} + world * scale (origin-top-left scale then
    // translate — matches design-canvas's `translate() scale()` order).
    const screenCenterX = t.x + centerWorldX * t.scale
    const screenCenterY = t.y + centerWorldY * t.scale

    expect(screenCenterX).toBeCloseTo(viewport.w / 2, 1)
    expect(screenCenterY).toBeCloseTo(viewport.h / 2, 1)
    expect(t.scale).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(t.scale).toBeLessThanOrEqual(MAX_SCALE)
  })

  it("fits every board's bounding box within the viewport (with tolerance for padding)", () => {
    const boards = [
      { x: 0, y: 0, deviceId: DEVICE_ID },
      { x: 500, y: 200, deviceId: DEVICE_ID },
    ]
    const viewport = { w: 1200, h: 900 }

    const t = fitTransform(boards, viewport)

    for (const board of boards) {
      const corners = [
        [board.x, board.y],
        [board.x + DEVICE_W, board.y + DEVICE_H],
      ]
      for (const [wx, wy] of corners) {
        const sx = t.x + wx * t.scale
        const sy = t.y + wy * t.scale
        expect(sx).toBeGreaterThanOrEqual(-1)
        expect(sx).toBeLessThanOrEqual(viewport.w + 1)
        expect(sy).toBeGreaterThanOrEqual(-1)
        expect(sy).toBeLessThanOrEqual(viewport.h + 1)
      }
    }
  })

  it("clamps to MAX_SCALE when the boards are tiny relative to a huge viewport", () => {
    const boards = [{ x: 0, y: 0, deviceId: DEVICE_ID }]
    const viewport = { w: 20000, h: 20000 }

    const t = fitTransform(boards, viewport)

    expect(t.scale).toBe(MAX_SCALE)
  })

  it("clamps to MIN_SCALE when the boards are huge relative to a tiny viewport", () => {
    const boards = [
      { x: 0, y: 0, deviceId: DEVICE_ID },
      { x: 20000, y: 20000, deviceId: DEVICE_ID },
    ]
    const viewport = { w: 300, h: 300 }

    const t = fitTransform(boards, viewport)

    expect(t.scale).toBe(MIN_SCALE)
  })

  it("returns a clamped default transform when there are no boards", () => {
    const t = fitTransform([], { w: 1000, h: 800 })

    expect(t.scale).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(t.scale).toBeLessThanOrEqual(MAX_SCALE)
    expect(Number.isFinite(t.x)).toBe(true)
    expect(Number.isFinite(t.y)).toBe(true)
  })
})
