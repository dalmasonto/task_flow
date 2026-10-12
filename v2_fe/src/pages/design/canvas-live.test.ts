import { describe, expect, it } from "vitest"

import {
  LIVE_FRAME_BUDGET,
  MIN_LIVE_SCALE,
  liveBoardKeys,
  newlyColdKeys,
  type LiveBoard,
} from "./canvas-live"

/// A 1600x900 window looking at the origin. Boards are 400x300 so several fit.
const viewport = { width: 1600, height: 900 }
const at = (key: string, x: number, y: number, width = 400, height = 300): LiveBoard => ({
  key,
  x,
  y,
  width,
  height,
})
const identity = { x: 0, y: 0, scale: 1 }

describe("liveBoardKeys", () => {
  it("keeps boards inside the visible rect and drops the rest", () => {
    const keys = liveBoardKeys([at("near", 0, 0), at("far", 20000, 20000)], identity, viewport)
    expect([...keys]).toEqual(["near"])
  })

  it("keeps a board that sits in the MARGIN around the window", () => {
    // Just past the right edge (1600) but within the margin: mounting starts
    // there, which is what makes a pan feel preloaded rather than empty.
    const keys = liveBoardKeys([at("right", 1700, 0)], identity, viewport)
    expect([...keys]).toEqual(["right"])
  })

  it("drops a board past the margin", () => {
    const keys = liveBoardKeys([at("way-right", 4000, 0)], identity, viewport)
    expect([...keys]).toEqual([])
  })

  it("caps the live set at the budget, nearest the window centre first", () => {
    // Four boards inside the window, budget 2: the two closest to the centre
    // keep their documents; the others go cold.
    const boards = [
      at("edge", -300, -200), // centre (-100, -50) — far from (800, 450)
      at("centre", 600, 300), // centre (800, 450) — dead centre
      at("mid", 800, 300), // centre (1000, 450)
      at("far-edge", 1300, 600), // centre (1500, 750)
    ]
    const keys = liveBoardKeys(boards, identity, viewport, { budget: 2 })
    expect([...keys].sort()).toEqual(["centre", "mid"])
  })

  it("releases EVERY board when zoomed out below the live scale", () => {
    // Below ~35% a page's text is unreadable, so hundreds of live documents
    // buy nothing: the canvas goes snapshot-only.
    const boards = [at("a", 0, 0), at("b", 100, 0), at("c", 200, 0)]
    const zoomedOut = { x: 0, y: 0, scale: 0.2 }
    expect([...liveBoardKeys(boards, zoomedOut, viewport)]).toEqual([])
  })

  it("keeps boards in view while zoomed in", () => {
    const boards = [at("a", 0, 0)]
    const zoomedIn = { x: 0, y: 0, scale: 1.5 }
    expect([...liveBoardKeys(boards, zoomedIn, viewport)]).toEqual(["a"])
  })

  it("accounts for the pan offset when deciding what is visible", () => {
    // The window is panned 5000px right: a board at model x=5000 is now where
    // x=0 was, and the board at x=0 is off to the left, beyond any margin.
    const panned = { x: -5000, y: 0, scale: 1 }
    const keys = liveBoardKeys([at("here", 5000, 0), at("gone", 0, 0)], panned, viewport)
    expect([...keys]).toEqual(["here"])
  })

  it("has no live boards on an empty canvas", () => {
    expect([...liveBoardKeys([], identity, viewport)]).toEqual([])
  })

  it("exports the documented threshold and budget", () => {
    // These numbers are the bound the whole feature exists to hold; a drift in
    // either direction changes how many live documents a canvas can carry.
    expect(LIVE_FRAME_BUDGET).toBe(24)
    expect(MIN_LIVE_SCALE).toBeCloseTo(0.35)
  })
})

describe("newlyColdKeys", () => {
  it("names the boards that lost their live frame", () => {
    expect(newlyColdKeys(new Set(["a", "b"]), new Set(["b"])).sort()).toEqual(["a"])
  })

  it("names nothing when the live set only grew", () => {
    expect(newlyColdKeys(new Set(["a"]), new Set(["a", "b"]))).toEqual([])
  })

  it("names nothing when the live set is unchanged", () => {
    expect(newlyColdKeys(new Set(["a"]), new Set(["a"]))).toEqual([])
  })
})
