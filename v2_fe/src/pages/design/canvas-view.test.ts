import { describe, expect, it } from "vitest"

import { fitTransform } from "./canvas-view"
import { MIN_SCALE, MAX_SCALE } from "./design-canvas"

// "iphone-se": 375x667 — see lib/design-devices.ts. A card is NOT the bare
// device: it is a HEADER_H (30px) header above a bezel-wrapped board, so the
// fitted footprint is deliberately wider and taller than the device.
const DEVICE_ID = "iphone-se"
const CARD_W = 401 // 375 + 12 + 12 bezel + 2 x 1px border
const CARD_H = 743 // 30 header + (667 + 24 + 20 bezel + 2 x 1px border)
/** Screen-space gutter `fitTransform` keeps clear — `DEFAULT_PADDING`. */
const PADDING = 48

describe("fitTransform", () => {
  it("centers the bounding box in the viewport when the scale is unclamped", () => {
    const boards = [
      { x: 0, y: 0, deviceId: DEVICE_ID },
      { x: 500, y: 0, deviceId: DEVICE_ID },
    ]
    const viewport = { w: 1000, h: 800 }

    const t = fitTransform(boards, viewport)

    // Bounding box: [0, 500 + CARD_W] x [0, CARD_H] — the second card starts
    // at x=500 and is CARD_W wide. Measuring the bare device (375x667) here
    // would put the box's center 12px left and 15px above where it belongs,
    // which is what makes this assertion the one that catches both terms.
    const bboxW = 500 + CARD_W
    const bboxH = CARD_H
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

  it("fits every card's footprint inside the padded viewport", () => {
    const boards = [
      { x: 0, y: 0, deviceId: DEVICE_ID },
      { x: 500, y: 200, deviceId: DEVICE_ID },
    ]
    const viewport = { w: 1200, h: 900 }

    const t = fitTransform(boards, viewport)

    for (const board of boards) {
      const corners = [
        [board.x, board.y],
        [board.x + CARD_W, board.y + CARD_H],
      ]
      for (const [wx, wy] of corners) {
        const sx = t.x + wx * t.scale
        const sy = t.y + wy * t.scale
        // The gutter is the point: a box fitted to the bare device would let
        // the header hang past the bottom padding.
        expect(sx).toBeGreaterThanOrEqual(PADDING - 1)
        expect(sx).toBeLessThanOrEqual(viewport.w - PADDING + 1)
        expect(sy).toBeGreaterThanOrEqual(PADDING - 1)
        expect(sy).toBeLessThanOrEqual(viewport.h - PADDING + 1)
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
