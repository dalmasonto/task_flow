import { describe, expect, it } from "vitest"

import type { DesignManifest } from "@/lib/design-api"

import {
  evictFor,
  routeVisualStamps,
  snapshotKey,
  stampIsTrustworthy,
  UNKNOWN_STAMP,
} from "./design-snapshots"

const manifest = (over: Partial<DesignManifest> = {}): DesignManifest => ({
  project: 1,
  routes: [
    { path: "/", file: "pages/index.html", title: "Home", version: 3 },
    { path: "/setup", file: "pages/setup.html", title: "Setup", version: 1 },
  ],
  components: [
    { name: "app-header", file: "components/app-header.js", attrs: [], usedOn: ["/"], usageCount: 1, version: 5 },
    { name: "app-nav", file: "components/app-nav.js", attrs: [], usedOn: ["/setup"], usageCount: 2, version: 2 },
  ],
  tokens: [],
  revision: 9,
  tokensVersion: 4,
  resourcesVersion: 0,
  resources: [],
  ...over,
})

describe("routeVisualStamps", () => {
  it("stamps a route with its own file and the style documents", () => {
    const stamps = routeVisualStamps(manifest())
    expect(stamps.get("/")).toContain("3")
    expect(stamps.get("/")).toContain("4") // tokensVersion
    // The two routes differ (different page versions and components).
    expect(stamps.get("/")).not.toEqual(stamps.get("/setup"))
  })

  it("moves a route's stamp when tokens change", () => {
    const before = routeVisualStamps(manifest())
    const after = routeVisualStamps(manifest({ tokensVersion: 5 }))
    expect(after.get("/")).not.toEqual(before.get("/"))
    expect(after.get("/setup")).not.toEqual(before.get("/setup"))
  })

  it("moves a route's stamp when a component IT USES changes", () => {
    const before = routeVisualStamps(manifest())
    const after = routeVisualStamps(
      manifest({
        components: [
          { name: "app-header", file: "components/app-header.js", attrs: [], usedOn: ["/"], usageCount: 1, version: 6 },
          { name: "app-nav", file: "components/app-nav.js", attrs: [], usedOn: ["/setup"], usageCount: 2, version: 2 },
        ],
      }),
    )
    expect(after.get("/")).not.toEqual(before.get("/"))
    // ...and leaves the route that does NOT use it alone. A stamp that moved
    // for every component edit would throw away every cached snapshot on any
    // component write — the exact cost the scoping exists to avoid.
    expect(after.get("/setup")).toEqual(before.get("/setup"))
  })

  it("treats a manifest without versions as unknown, never as unchanged", () => {
    const legacy = manifest({
      routes: [
        { path: "/", file: "pages/index.html", title: "Home" },
        { path: "/setup", file: "pages/setup.html", title: "Setup", version: 1 },
      ],
      tokensVersion: undefined,
      resourcesVersion: undefined,
    })
    const stamps = routeVisualStamps(legacy)
    expect(stamps.get("/")).toContain(UNKNOWN_STAMP)
    expect(stampIsTrustworthy(stamps.get("/")!)).toBe(false)
    expect(stamps.get("/setup")).toContain(UNKNOWN_STAMP) // tokens version missing
  })
})

describe("stampIsTrustworthy", () => {
  it("rejects the unknown marker anywhere in the stamp", () => {
    expect(stampIsTrustworthy("3|4|0|app-header@5")).toBe(true)
    expect(stampIsTrustworthy("3|?|0|")).toBe(false)
    expect(stampIsTrustworthy("3|4|0|app-header@?")).toBe(false)
  })
})

describe("snapshotKey", () => {
  it("separates device and theme, because the image differs by both", () => {
    const base = snapshotKey(1, "/", "laptop", "light")
    expect(snapshotKey(1, "/", "iphone-16-pro", "light")).not.toEqual(base)
    expect(snapshotKey(1, "/", "laptop", "ocean")).not.toEqual(base)
    expect(snapshotKey(1, "/setup", "laptop", "light")).not.toEqual(base)
    expect(snapshotKey(2, "/", "laptop", "light")).not.toEqual(base)
  })
})

describe("evictFor", () => {
  const rows = (bytes: number[]) =>
    bytes.map((b, i) => ({ key: `k${i}`, bytes: b, lastUsedAt: i }))

  it("keeps everything while the total fits", () => {
    expect(evictFor(rows([10, 10, 10]), 10, 100)).toEqual([])
  })

  it("evicts least-recently-used first, only until the incoming fits", () => {
    // Cap 50, holding 40, incoming 20: 10 bytes must go — the oldest row is
    // 10, so exactly it.
    expect(evictFor(rows([10, 10, 20]), 20, 50)).toEqual(["k0"])
  })

  it("evicts as many as it must when one old row is not enough", () => {
    expect(evictFor(rows([10, 10, 20]), 25, 50)).toEqual(["k0", "k1"])
  })

  it("evicts everything when the incoming entry alone exceeds the cap", () => {
    // A snapshot bigger than the whole cache: the row still gets stored (it is
    // on screen NOW), and the cache pays for it by dropping the rest.
    expect(evictFor(rows([10, 10]), 200, 50)).toEqual(["k0", "k1"])
  })
})
