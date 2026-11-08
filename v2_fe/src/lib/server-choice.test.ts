import { describe, expect, it } from "vitest"

import { normalizeServer, serverLabel } from "./server-choice"

describe("normalizeServer", () => {
  it("keeps origin and path, drops trailing slashes", () => {
    expect(normalizeServer("https://api.example.com/")).toBe("https://api.example.com")
    expect(normalizeServer("https://example.com/taskflow/")).toBe("https://example.com/taskflow")
  })
  it("adds https, or http for local addresses", () => {
    expect(normalizeServer("api.example.com")).toBe("https://api.example.com")
    expect(normalizeServer("localhost:8000")).toBe("http://localhost:8000")
    expect(normalizeServer("127.0.0.1:8000")).toBe("http://127.0.0.1:8000")
  })
  it("drops query and fragment", () => {
    expect(normalizeServer("https://a.dev/x?y=1#z")).toBe("https://a.dev/x")
  })
  it("refuses what can't be a server", () => {
    for (const bad of ["", "   ", "javascript:alert(1)", "ftp://a.dev", "https://user:pw@a.dev", "http://"]) expect(normalizeServer(bad)).toBeNull()
  })
})

describe("serverLabel", () => {
  it("names a server by host and path", () => {
    expect(serverLabel("https://api.taskflow.supercodehive.com")).toBe("api.taskflow.supercodehive.com")
    expect(serverLabel("https://a.dev/taskflow")).toBe("a.dev/taskflow")
  })
})
