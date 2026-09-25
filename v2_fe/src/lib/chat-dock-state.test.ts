import { describe, it, expect } from "vitest"
import { dockBodyFor, parseDockState, NO_DOCK_STATE } from "./chat-dock-state"

describe("parseDockState", () => {
  it("reads the stored conversation", () => {
    expect(parseDockState('{"chatId":"live:direct:2"}')).toEqual({ chatId: "live:direct:2" })
  })

  // Item 1 as a regression test, at the module that decides it. A stored
  // `open: true` must not come back as anything a caller can gate a fetch on:
  // it is what made every dashboard route load the chat slice for a user who
  // had ever opened the dock. Records in the old shape are still on disk, so
  // this asserts the IGNORE, not the absence of the key.
  it("ignores a stored open flag rather than restoring it", () => {
    expect(parseDockState('{"open":true,"chatId":"live:direct:2"}')).toEqual({ chatId: "live:direct:2" })
    expect(parseDockState('{"open":true,"chatId":null}')).toEqual(NO_DOCK_STATE)
  })

  // First visit. The dock must stay shut rather than springing open over the
  // board on a page the user never asked to chat from.
  it("defaults to nothing stored when nothing is stored", () => {
    expect(parseDockState(null)).toEqual(NO_DOCK_STATE)
  })

  it("defaults to nothing stored on malformed JSON", () => {
    expect(parseDockState("not json at all")).toEqual(NO_DOCK_STATE)
  })

  it("defaults to nothing stored on a JSON value that is not an object", () => {
    expect(parseDockState('"a string"')).toEqual(NO_DOCK_STATE)
    expect(parseDockState("42")).toEqual(NO_DOCK_STATE)
    expect(parseDockState("null")).toEqual(NO_DOCK_STATE)
  })

  // A half-written or hand-edited record must not produce `chatId: undefined`
  // flowing into the resolver as if it were a real conversation id.
  it("drops a non-string chatId rather than passing it through", () => {
    expect(parseDockState('{"chatId":42}')).toEqual(NO_DOCK_STATE)
    expect(parseDockState("{}")).toEqual(NO_DOCK_STATE)
  })
})

// Which body the dock draws, and — because the branches are ORDERED, not
// independent — which fact outranks which. The dock's own markup for the two
// unknown-list states is pinned in `components/chat/chat-dock.test.ts`; this is
// the decision behind it, including the case a markup test cannot reach
// (`minimised` is component state, and nothing in that file clicks).
describe("dockBodyFor", () => {
  const base = { minimised: false, channelsLoaded: true, channelsFailed: false, switcherOpen: false }

  it("is the conversation only when the list is loaded", () => {
    expect(dockBodyFor(base)).toBe("conversation")
    expect(dockBodyFor({ ...base, switcherOpen: true })).toBe("switcher")
    // Fail-closed: an unloaded list outranks both, switcher open included.
    expect(dockBodyFor({ ...base, channelsLoaded: false, switcherOpen: true })).toBe("loading")
  })

  it("separates a failed read from one that has not happened", () => {
    expect(dockBodyFor({ ...base, channelsLoaded: false })).toBe("loading")
    expect(dockBodyFor({ ...base, channelsLoaded: false, channelsFailed: true })).toBe("failed")
    // And a failure the loaders have since answered is not a failure: the flag
    // is the last COMPLETED read, and `loaded` is the newer fact.
    expect(dockBodyFor({ ...base, channelsFailed: true })).toBe("conversation")
  })

  // Collapsed wins over every other body, including the two unknown-channels
  // ones — which used to be a card of their own, drawn over a dock the user had
  // already minimised (a project switch re-opens the unknown window under a
  // collapsed dock).
  it("stays collapsed in every state", () => {
    for (const input of [
      base,
      { ...base, switcherOpen: true },
      { ...base, channelsLoaded: false },
      { ...base, channelsLoaded: false, channelsFailed: true },
    ]) {
      expect(dockBodyFor({ ...input, minimised: true })).toBe("collapsed")
    }
  })
})
