import { describe, expect, it } from "vitest"

import {
  AGENT_CAPABILITIES,
  AGENT_SCOPE_MANAGE,
  agentScopesOf,
  capabilityLabel,
  deniedCapabilitiesOf,
  effectiveCapabilities,
  mayGrantAgentScopes,
  scopeLabel,
} from "@/lib/agent-scopes"

const DEFAULT_ON_IDS = AGENT_CAPABILITIES.filter((c) => c.defaultOn).map((c) => c.id)

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

describe("deniedCapabilitiesOf", () => {
  it("reads a stored denial list", () => {
    expect(deniedCapabilitiesOf({ denied_scopes: '["design:write"]' })).toEqual(["design:write"])
  })

  it("treats null/absent as nothing denied", () => {
    expect(deniedCapabilitiesOf({ denied_scopes: null })).toEqual([])
    expect(deniedCapabilitiesOf({})).toEqual([])
    expect(deniedCapabilitiesOf({ denied_scopes: "[]" })).toEqual([])
  })

  it("fails CLOSED on a value the backend could not have written", () => {
    // The badge must never claim a key can do what the server will refuse.
    expect(deniedCapabilitiesOf({ denied_scopes: "junk" })).toEqual(DEFAULT_ON_IDS)
    expect(deniedCapabilitiesOf({ denied_scopes: '{"design:write":true}' })).toEqual(DEFAULT_ON_IDS)
  })

  it("drops names that are not default-on capabilities", () => {
    expect(deniedCapabilitiesOf({ denied_scopes: '["agents:manage","nope"]' })).toEqual([])
  })
})

describe("effectiveCapabilities", () => {
  it("gives an ordinary key every default and nothing else", () => {
    expect(effectiveCapabilities({})).toEqual([...DEFAULT_ON_IDS].sort())
    expect(effectiveCapabilities({ scopes: null, denied_scopes: null })).toEqual([...DEFAULT_ON_IDS].sort())
  })

  it("subtracts denials and adds grants", () => {
    const caps = effectiveCapabilities({
      scopes: JSON.stringify([AGENT_SCOPE_MANAGE]),
      denied_scopes: JSON.stringify(["design:write", "reviews:write"]),
    })
    expect(caps).not.toContain("design:write")
    expect(caps).not.toContain("reviews:write")
    expect(caps).toContain("tasks:write")
    expect(caps).toContain(AGENT_SCOPE_MANAGE)
  })

  it("keeps grants when the deny column is unreadable", () => {
    const caps = effectiveCapabilities({ scopes: JSON.stringify([AGENT_SCOPE_MANAGE]), denied_scopes: "junk" })
    expect(caps).toEqual([AGENT_SCOPE_MANAGE])
  })
})

describe("labels", () => {
  it("names the known capabilities and falls back to the raw id", () => {
    expect(capabilityLabel("design:write")).toBe("Design")
    expect(capabilityLabel(AGENT_SCOPE_MANAGE)).toBe("Can manage agents")
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
