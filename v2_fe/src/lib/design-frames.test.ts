import { describe, expect, it } from "vitest"

import { FRAME_METRICS, frameStretch } from "./design-frames"

describe("frameStretch", () => {
  const m = FRAME_METRICS["iphone-14-pro"]
  it("adds nothing when the shot fits the screen below its status bar", () => {
    expect(frameStretch(m, { width: 390, height: 786 })).toBe(0)
    expect(frameStretch(m, { width: 390, height: 500 })).toBe(0)
  })
  it("adds the extra length a full-page shot needs, in frame pixels", () => {
    // 393-wide shot shown 390 wide: 1049 tall → 1040.99 in frame px; the screen
    // shows 830 - 44 = 786 below its status bar → stretch by 255.
    expect(frameStretch(m, { width: 393, height: 1049 })).toBe(255)
  })
})
