import { describe, expect, it } from "vitest"

import {
  MAX_FRAME_PATH,
  divergedRoute,
  reportedRoute,
  routeFromSandboxPath,
  sameFrameReport,
  type FrameReport,
} from "./design-route"

// A sandbox frame posts the path it is ACTUALLY at, and the chrome turns that
// into an app route to compare against the board's own. Every case below is a
// way that conversion can hand the header something that is not a route — most
// of them silently, because the header would simply print it.
//
// The fixture paths are the REAL shapes: `sandboxUrl` (`lib/design-api.ts`)
// builds `/s/{token}{route}`, and the token is `{project}.{expiry:x}.{sig}`
// (`sandbox.rs`) — so the first segment after `/s/` is dotted, hex-encoded and
// 40-odd characters long, which is why nothing here may key on the token's own
// shape.
//
// They are what `location.pathname` holds in a composed frame, which is the
// value the picker runtime posts as `design:route` (`composer.rs`). A hand-copy
// and nothing more: no check ties these strings to that runtime, so a change to
// how it reports (a different field, a path already stripped of the prefix)
// leaves every test below passing on a premise nothing else holds. The guard is
// the pointer in the runtime's own comment naming `design-route.ts` — this note
// is the reciprocal half, and it can only help someone already reading here.

describe("routeFromSandboxPath — the path a frame is at, as a route", () => {
  it("reads the route out of the sandbox path", () => {
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/app")).toBe("/app")
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/settings")).toBe("/settings")
  })

  it("keeps the route's leading slash and everything after it", () => {
    // The second case is a REACHABLE path, not a hypothetical one: a page route
    // is a single segment (`urls.rs` matches `/s/{token}/{route}` and
    // `page_path_for_route` refuses a stem containing `/`), but the namespace
    // has deeper routes of its own, and `/preview/{name}` is one of them — the
    // same `compose_document` serves it, so that frame posts the same message,
    // and a board frame can even navigate there itself, because an href written
    // as `/s/…` is left byte-identical by `rewrite_hrefs` (it is already
    // tokenized) and therefore resolves inside the namespace.
    //
    // What has to change to fail: taking the LAST segment as the route (a frame
    // at `/s/{token}/preview/hero` then reports `/hero` — the page it really
    // navigated through is gone), or rebuilding what is left of the path without
    // its leading slash (`split('/').slice(3).join('/')` gives `app` for the
    // first case below), which no route the manifest spells could match.
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/app")).toBe("/app")
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/preview/hero")).toBe("/preview/hero")
  })

  it("reports the bare sandbox root as `/`, never as the token", () => {
    // The root board's frame is served at `/s/{token}` with NO trailing slash
    // (`sandboxUrl` drops the path for route `/`, and `serve_page_root` is
    // registered in both shapes), so this is the route HALF of the canvas — and
    // the failure mode of getting it wrong is spectacular: a rule that treats
    // the last segment as the route reports the token as the route, and the
    // header renders `→ /7.1a2b3c.deadbeef`.
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef")).toBe("/")
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/")).toBe("/")
  })

  it("normalizes a trailing slash, because a route is not spelled with one", () => {
    // `page_path_for_route` (manifest.rs) strips it, `rewrite_hrefs`
    // (composer.rs) normalizes it away when it builds these paths, and
    // `/s/{token}/app/` is not served at all — so `/app/` and `/app` are one
    // route everywhere except in the string, and comparing raw strings would
    // put a header chip on a board that is exactly where it should be.
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/app/")).toBe("/app")
  })

  it("cuts at a query or a fragment", () => {
    // `location.pathname` carries neither, which is what makes this cheap: the
    // one shape a frame can post that is not a path is dropped rather than
    // printed behind the arrow.
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/app?tab=2")).toBe("/app")
    expect(routeFromSandboxPath("/s/7.1a2b3c.deadbeef/app#section")).toBe("/app")
  })

  it("refuses anything that is not a sandbox path", () => {
    // None of these is "the root". A null here is what stops the header being
    // given a route to draw at all, and the rule doing that work is the `/s/`
    // requirement — asserted, not reasoned: deleting that one line from the
    // parser fails this test and only this test (17 of 18 still pass). The
    // parser slices a fixed four characters off whatever it is given, so
    // without the check an absolute url has those characters taken out of its
    // SCHEME: `https://taskflow.example/s/7.tok/app` yields the "token" `:` and
    // reads as the route `//taskflow.example/s/7.tok/app`.
    //
    // The sender of a message this parser refuses is a separate question, and
    // the canvas answers it first: `boardKeyForSource` matches the WindowProxy
    // against frames THIS canvas mounted for boards, so the component preview's
    // iframe (which posts the same runtime's messages from
    // `/s/{token}/preview/{name}` and carries no `data-design-frame`) is dropped
    // before any parsing happens. Not that its path would be refused here — it
    // is a sandbox path, and it parses to `/preview/{name}`, which is exactly
    // the kind of "this frame is not on a page" report a board frame could
    // legitimately produce.
    expect(routeFromSandboxPath("/app")).toBeNull()
    expect(routeFromSandboxPath("/s")).toBeNull()
    expect(routeFromSandboxPath("/s/")).toBeNull()
    expect(routeFromSandboxPath("/s//app")).toBeNull()
    expect(routeFromSandboxPath("/spa/7.1a2b3c.deadbeef/app")).toBeNull()
    expect(routeFromSandboxPath("")).toBeNull()
    expect(routeFromSandboxPath("https://taskflow.example/s/7.tok/app")).toBeNull()
  })

  it("refuses a path long enough to be a payload rather than a path", () => {
    // Any window on the page can post to us; the path is only as long as a
    // real one, and the cap is the reason the header can render whatever
    // arrives without a length rule of its own.
    const token = "7.1a2b3c.deadbeef"
    expect(routeFromSandboxPath(`/s/${token}/${"a".repeat(MAX_FRAME_PATH)}`)).toBeNull()
  })
})

describe("divergedRoute — where the frame is, when that is not where the board points", () => {
  it("says nothing while the frame is on the board's own page", () => {
    expect(divergedRoute("/app", "/app")).toBeNull()
    expect(divergedRoute("/", "/")).toBeNull()
  })

  it("treats a trailing slash as the same route", () => {
    // Both sides: the board's route comes from the manifest and the report from
    // a URL, and a slash anywhere in that pair must not read as "somewhere
    // else" — the chip is an alarm, and an alarm that goes off over a slash is
    // one the user learns to ignore.
    expect(divergedRoute("/app", "/app/")).toBeNull()
    expect(divergedRoute("/app/", "/app")).toBeNull()
  })

  it("names the page the frame went to", () => {
    expect(divergedRoute("/app", "/settings")).toBe("/settings")
    expect(divergedRoute("/", "/settings")).toBe("/settings")
    expect(divergedRoute("/settings", "/")).toBe("/")
  })

  it("is not a prefix test", () => {
    // `/app-settings` STARTS WITH `/app`, and a `startsWith` rule would call
    // this board home while its frame shows another page — the exact silence
    // this whole task exists to break.
    expect(divergedRoute("/app", "/app-settings")).toBe("/app-settings")
    expect(divergedRoute("/app", "/app/settings")).toBe("/app/settings")
  })

  it("says nothing when no usable route was reported", () => {
    // "Nothing reported" is not "somewhere else": a board whose frame has not
    // announced yet (or announced something unreadable, which the parser
    // refuses) must render as it always did.
    expect(divergedRoute("/app", null)).toBeNull()
    expect(divergedRoute("/app", "")).toBeNull()
  })
})

describe("sameFrameReport — whether a board's frame is saying anything new", () => {
  it("calls a repeat a repeat, and any difference a change", () => {
    const held: FrameReport = { route: "/settings", epoch: 3, token: "7.tok" }
    expect(sameFrameReport(held, { ...held })).toBe(true)
    expect(sameFrameReport(null, held)).toBe(false)
    expect(sameFrameReport(held, { ...held, route: "/inbox" })).toBe(false)
    expect(sameFrameReport(held, { ...held, epoch: 4 })).toBe(false)
    expect(sameFrameReport(held, { ...held, token: "8.tok" })).toBe(false)
  })
})

describe("reportedRoute — a report only describes the document that sent it", () => {
  const held: FrameReport = { route: "/settings", epoch: 7, token: "7.1a2b3c.deadbeef" }

  it("reads the route while the frame document is unchanged", () => {
    expect(reportedRoute(held, 7, "7.1a2b3c.deadbeef")).toBe("/settings")
  })

  it("reads nothing once that frame has been remounted", () => {
    // Every remount moves the epoch — a file write's global bump, or one
    // board's Reload — and both put the frame back on the page its `src` names.
    // The report is then about a document that is gone, and the header has to
    // stop drawing it; this is the assertion for that, and it is the reason no
    // code anywhere has to remember to clear a board's report.
    expect(reportedRoute(held, 8, "7.1a2b3c.deadbeef")).toBeNull()
    expect(reportedRoute(held, 0, "7.1a2b3c.deadbeef")).toBeNull()
  })

  it("reads nothing after a project switch, which moves the token and NO epoch", () => {
    // The case the epoch alone cannot see, and the reason the token is in the
    // stamp: `App.tsx` mounts one surface for the whole session, so switching
    // project refetches the sandbox token and remounts every frame through
    // `frameSrc` — while `contentEpoch` and `boardEpochs` both stay put. Every
    // project has `/` at the default device, so without the token A's report
    // would read as a claim about B's frame — the same key, the same epoch, a
    // different document.
    //
    // What has to change to fail: dropping the token from the comparison (the
    // first assertion below returns `/settings`).
    expect(reportedRoute(held, 7, "9.1a2b3c.deadbeef")).toBeNull()
    expect(reportedRoute(held, 7, null)).toBeNull()
  })

  it("reads nothing for a board that never reported", () => {
    expect(reportedRoute(undefined, 0, "7.tok")).toBeNull()
    expect(reportedRoute(null, 0, "7.tok")).toBeNull()
  })
})
