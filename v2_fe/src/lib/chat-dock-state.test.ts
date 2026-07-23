import { describe, it, expect } from "vitest"
import { parseDockState, DOCK_CLOSED } from "./chat-dock-state"

describe("parseDockState", () => {
  it("reads a stored open dock with its conversation", () => {
    expect(parseDockState('{"open":true,"chatId":"live:direct:2"}')).toEqual({
      open: true,
      chatId: "live:direct:2",
    })
  })

  it("reads a stored closed dock", () => {
    expect(parseDockState('{"open":false,"chatId":"live:channel:1"}')).toEqual({
      open: false,
      chatId: "live:channel:1",
    })
  })

  // First visit. The dock must stay shut rather than springing open over the
  // board on a page the user never asked to chat from.
  it("defaults to closed when nothing is stored", () => {
    expect(parseDockState(null)).toEqual(DOCK_CLOSED)
  })

  it("defaults to closed on malformed JSON", () => {
    expect(parseDockState("not json at all")).toEqual(DOCK_CLOSED)
  })

  it("defaults to closed on a JSON value that is not an object", () => {
    expect(parseDockState('"a string"')).toEqual(DOCK_CLOSED)
    expect(parseDockState("42")).toEqual(DOCK_CLOSED)
    expect(parseDockState("null")).toEqual(DOCK_CLOSED)
  })

  // A half-written or hand-edited record must not produce `chatId: undefined`
  // flowing into the resolver as if it were a real conversation id.
  it("drops a non-string chatId rather than passing it through", () => {
    expect(parseDockState('{"open":true,"chatId":42}')).toEqual({ open: true, chatId: null })
    expect(parseDockState('{"open":true}')).toEqual({ open: true, chatId: null })
  })

  it("coerces a non-boolean open flag rather than trusting it", () => {
    expect(parseDockState('{"open":"yes","chatId":null}').open).toBe(false)
  })
})
