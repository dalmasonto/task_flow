import { describe, expect, it } from "vitest"
import { sliceGatesFor, type SliceGateInput } from "./live-slices"

/// A first-time visitor: nothing persisted, no task open, no chat surface
/// mounted. Every case below starts here and names only what it changes, so a
/// gate that starts firing for a reason the case did not ask for fails loudly.
function gates(overrides: Partial<SliceGateInput> = {}) {
  return sliceGatesFor({
    pathname: "/dashboard/board",
    chatSurfaceMounted: false,
    dockOpen: false,
    openTaskId: null,
    ...overrides,
  })
}

describe("sliceGatesFor", () => {
  it("loads the board's task rows on the board route and nothing else", () => {
    expect(gates()).toEqual({
      board: true,
      presence: false,
      chat: false,
      chatChannels: false,
      terminal: false,
      settings: false,
      reviews: false,
      activity: false,
      taskDetailId: null,
    })
  })

  it("asks for nothing on a route with no slice of its own", () => {
    for (const route of ["/dashboard/overview", "/dashboard/media", "/dashboard/invites"]) {
      expect(gates({ pathname: route })).toMatchObject({
        board: false,
        presence: false,
        chat: false,
        chatChannels: false,
        terminal: false,
        settings: false,
        reviews: false,
        activity: false,
      })
    }
  })

  // The account area renders no dashboard surface, and renders outside the
  // dashboard's route switch. A slice loading there is a slice nothing shows.
  it("asks for nothing on the account routes", () => {
    for (const route of ["/account", "/account/profile", "/account/invitations"]) {
      expect(gates({ pathname: route })).toMatchObject({ board: false, chat: false, activity: false })
    }
  })

  it("loads chat + terminal frames on the agents surface, by route or by mount", () => {
    for (const input of [
      { pathname: "/dashboard/agents" },
      { pathname: "/dashboard/agents/live:channel:3" },
      { pathname: "/dashboard/board", chatSurfaceMounted: true },
    ]) {
      expect(gates(input)).toMatchObject({ chat: true, terminal: true, chatChannels: false })
    }
  })

  // The dock renders chat but NOT the terminal, deliberately: the frames are
  // heavy raw capture and the dock is on every dashboard route, so bounding
  // them to the agents surface keeps the frame page off the board.
  it("does not load terminal frames for the chat dock", () => {
    expect(gates({ pathname: "/dashboard/board", dockOpen: true })).toMatchObject({
      terminal: false,
      chat: true,
    })
  })

  // The design rail needs the channel list and its rosters to resolve the
  // project room — 2 queries. It does not need messages, attachments, read
  // cursors or prompts, which is what `chat` would drag in.
  it("gives the design page channels only, never the whole chat slice", () => {
    expect(gates({ pathname: "/dashboard/design" })).toMatchObject({
      chat: false,
      chatChannels: true,
      terminal: false,
    })
  })

  // The activity feed resolves task TITLES and renders no task row. Keeping the
  // board gate here pulled five column queries — the fattest rows in the app —
  // onto a route that shows none of their fields.
  it("does not load the board's task rows for the activity feed", () => {
    expect(gates({ pathname: "/dashboard/activity" })).toMatchObject({
      activity: true,
      board: false,
      presence: false,
    })
  })

  // The reviews route is the exception, and the reason it must stay in `board`
  // is a render, not a title: `ReviewsPage` is handed the review-status task
  // rows and draws its queue from them.
  it("loads the board's task rows for the reviews queue, which renders them", () => {
    expect(gates({ pathname: "/dashboard/reviews" })).toMatchObject({
      reviews: true,
      board: true,
      activity: false,
    })
  })

  it("loads settings and presence on the API-Base page", () => {
    expect(gates({ pathname: "/dashboard/api" })).toMatchObject({
      settings: true,
      presence: true,
      board: false,
      chat: false,
    })
  })

  // Item 1 as a regression test. `dockOpen` is session state: false on a fresh
  // load, whatever localStorage said last time. While it is true the dock IS
  // mounted and showing a conversation list, so the chat slice is what it
  // renders; it must never be true merely because it once was.
  it("does not load chat on a non-chat route while the dock is closed", () => {
    expect(gates({ pathname: "/dashboard/board", dockOpen: false }).chat).toBe(false)
    expect(gates({ pathname: "/dashboard/board", dockOpen: true }).chat).toBe(true)
  })

  it("loads an open task's rows, sessions and detail together", () => {
    expect(gates({ openTaskId: "42" })).toEqual({
      board: true,
      presence: true,
      chat: false,
      chatChannels: false,
      terminal: false,
      settings: false,
      reviews: false,
      activity: false,
      taskDetailId: 42,
    })
  })

  // A chip whose id is not a number has no detail row to load, but it is still
  // an open task: the sheet needs the rows and presence to render it at all.
  it("keeps the open-task gates for an id that is not numeric, without a detail fetch", () => {
    expect(gates({ openTaskId: "live:task:9" })).toMatchObject({
      board: true,
      presence: true,
      taskDetailId: null,
    })
  })

  // The gates are recomputed from the route on every render; nothing carries
  // over. A navigating user must not keep the previous route's slices.
  it("recomputes from the route alone, with nothing carried over", () => {
    const onBoard = gates({ pathname: "/dashboard/board" })
    const onOverview = gates({ pathname: "/dashboard/overview" })
    expect(onBoard.board).toBe(true)
    expect(onOverview.board).toBe(false)
    expect(onOverview).toEqual(gates({ pathname: "/dashboard/overview" }))
  })
})
