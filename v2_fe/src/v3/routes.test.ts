import { describe, expect, it } from "vitest"

import { safeNextPath, v3GatePath, v3RouteKind } from "./routes"

describe("v3RouteKind", () => {
  it("leaves non-v3 paths alone", () => {
    for (const p of ["/", "/dashboard/board", "/login", "/v3x", "/v30/board"]) expect(v3RouteKind(p)).toBeNull()
  })
  it("treats the landing, auth and docs as public", () => {
    for (const p of ["/v3", "/v3/login", "/v3/signup", "/v3/docs", "/v3/docs/getting-started", "/v3/confirm-password/abc"]) {
      expect(v3RouteKind(p)).toBe("public")
    }
  })
  it("treats everything else under /v3 as the app", () => {
    for (const p of ["/v3/board", "/v3/tasks/12", "/v3/chat/63", "/v3/loginx", "/v3/docsx"]) expect(v3RouteKind(p)).toBe("app")
  })
})

describe("v3GatePath", () => {
  it("maps v3 surfaces onto the v2 routes the slice gates know", () => {
    expect(v3GatePath("/v3/board")).toBe("/dashboard/board")
    expect(v3GatePath("/v3/tasks/886")).toBe("/dashboard/board")
    expect(v3GatePath("/v3/chat/63")).toBe("/dashboard/agents")
    expect(v3GatePath("/v3/design")).toBe("/dashboard/design")
  })
  it("does not match on a bare prefix", () => {
    expect(v3GatePath("/v3/boardroom")).toBe("/v3/boardroom")
  })
  it("passes v2 paths through", () => {
    expect(v3GatePath("/dashboard/reviews")).toBe("/dashboard/reviews")
  })
})

describe("safeNextPath", () => {
  it("honours in-app paths", () => {
    expect(safeNextPath("/v3/chat/63", "/x")).toBe("/v3/chat/63")
    expect(safeNextPath("/dashboard/board", "/x")).toBe("/dashboard/board")
  })
  it("refuses anything that leaves the app", () => {
    for (const n of ["//evil.com", "https://evil.com", "evil.com", "/other", null, ""]) expect(safeNextPath(n, "/x")).toBe("/x")
  })
})

describe("v3GatePaths", () => {
  it("lets a page draw on several slices", async () => {
    const { v3GatePaths } = await import("./routes")
    expect(v3GatePaths("/v3/agents/1")).toEqual(["/dashboard/api", "/dashboard/board"])
    expect(v3GatePaths("/v3/board")).toEqual(["/dashboard/board"])
    expect(v3GatePaths("/v3/media")).toEqual(["/dashboard/design"])
    expect(v3GatePaths("/dashboard/x")).toEqual(["/dashboard/x"])
  })
})
