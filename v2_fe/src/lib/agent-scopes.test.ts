import { describe, expect, it } from "vitest"

import {
  AGENT_SCOPE_MANAGE,
  agentScopesOf,
  mayGrantAgentScopes,
  scopeLabel,
} from "@/lib/agent-scopes"

describe("agentScopesOf", () => {
  it("reads the stored JSON array", () => {
    expect(agentScopesOf({ scopes: JSON.stringify([AGENT_SCOPE_MANAGE]) })).toEqual([AGENT_SCOPE_MANAGE])
  })

  it("reads null, empty and junk as no scopes", () => {
    expect(agentScopesOf({ scopes: null })).toEqual([])
    expect(agentScopesOf({ scopes: "" })).toEqual([])
    expect(agentScopesOf({ scopes: "not json" })).toEqual([])
    expect(agentScopesOf({ scopes: '{"agents:manage":true}' })).toEqual([])
    expect(agentScopesOf({})).toEqual([])
  })
})

describe("scopeLabel", () => {
  it("names the known scope and falls back to the raw id", () => {
    expect(scopeLabel(AGENT_SCOPE_MANAGE)).toBe("Can manage agents")
    expect(scopeLabel("something:else")).toBe("something:else")
  })
})

describe("mayGrantAgentScopes", () => {
  it("is true only for an active owner or admin, or a superuser", () => {
    expect(mayGrantAgentScopes({ role: "owner", status: "active" }, false)).toBe(true)
    expect(mayGrantAgentScopes({ role: "admin", status: "active" }, false)).toBe(true)
    expect(mayGrantAgentScopes({ role: "developer", status: "active" }, false)).toBe(false)
    expect(mayGrantAgentScopes({ role: "owner", status: "invited" }, false)).toBe(false)
    expect(mayGrantAgentScopes(undefined, false)).toBe(false)
    // A superuser may grant even without a membership row.
    expect(mayGrantAgentScopes(undefined, true)).toBe(true)
  })
})
