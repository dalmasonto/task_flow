import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { deviceById } from "@/lib/design-devices"
import { ArtboardHeader } from "./design-canvas"

// What the header DRAWS when a frame has navigated away from the page its board
// was created for — the half `design-route.test.ts` cannot reach. That file
// pins the rule that decides a frame has gone elsewhere (`divergedRoute`);
// this one pins what the user then sees, which is the only place the report
// becomes visible at all.
//
// Rendered with `renderToStaticMarkup` — no jsdom, no Testing Library, no new
// dependency (the repo's `test.include` is `src/**/*.test.ts`, so a `.tsx` here
// would never be collected, and `createElement` needs no JSX). Scope is the
// markup ONLY: nothing here clicks, so the reset's `onClick` — and the canvas's
// wiring of a reported route into these props — is verified by reading the
// canvas, not by this file. Saying so because a markup test that is mistaken
// for an interaction test is worse than no test.

/** The header for `/app` at the laptop preset, as `ArtboardCard` renders it. */
function header(over: Partial<Parameters<typeof ArtboardHeader>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ArtboardHeader, {
      boardKey: "/app@laptop",
      route: "/app",
      label: "Dashboard",
      strayRoute: null,
      onReloadBoard: () => {},
      device: deviceById("laptop"),
      projectId: 7,
      width: 1280,
      deviceIds: ["laptop"],
      onOpenBoard: () => {},
      onDuplicateBoard: () => {},
      onRemoveBoard: () => {},
      ...over,
    }),
  )
}

describe("ArtboardHeader — a frame that has gone elsewhere", () => {
  it("draws exactly what it always drew while the frame is home", () => {
    // The chip and its control are the only additions, and this is the state
    // every board is in almost all of the time: it must be untouched. What has
    // to change to fail: rendering the reported route unconditionally (a new
    // corner of every header), or showing the control as a permanently disabled
    // affordance.
    const markup = header()
    expect(markup).toContain("Dashboard")
    expect(markup).toContain("Laptop")
    expect(markup).not.toContain("→")
    expect(markup).not.toContain("Show /app again")
  })

  it("says where the frame is, and offers to bring it back to its own page", () => {
    // The page name above stays: it is what this board IS. The chip is the
    // frame's real location, and the control's name is the page it returns to —
    // "Show /app again" — so the two together read as "this board is Dashboard,
    // its frame is on /settings, click to go back".
    //
    // What has to change to fail: rendering `route` in the chip instead of the
    // stray route (the header would then claim the frame is home on the very
    // state that exists because it is not), or drawing the chip without the
    // control (the user is told they are lost and given nothing to do).
    const markup = header({ strayRoute: "/settings" })
    expect(markup).toContain("→ /settings")
    expect(markup).not.toContain("→ /app")
    expect(markup).toContain("Dashboard")
    expect(markup).toContain('title="This frame navigated to /settings"')
    expect(markup).toContain('title="Show /app again"')
    expect(markup).toContain('aria-label="Show /app again"')
    // A control, not a label: the reset is a button the user can press.
    expect(markup).toMatch(/<button[^>]*aria-label="Show \/app again"/)
  })

  it("keeps the board's own page as the thing a reset returns to", () => {
    // The root board is the case where a sloppy rule shows: its route is `/`,
    // and a control named after the STRAY route would read "Show /settings
    // again" — offering to return the frame to the page it is already on.
    const markup = header({ boardKey: "/@laptop", route: "/", label: "Home", strayRoute: "/settings" })
    expect(markup).toContain('aria-label="Show / again"')
    expect(markup).not.toContain('aria-label="Show /settings again"')
  })
})
