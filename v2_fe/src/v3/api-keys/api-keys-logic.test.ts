import { describe, expect, it } from "vitest"

import type { TaskflowAgentCredential } from "@/api/client"

import { activeKey, applyScopes, capabilitySummary, checkedFrom, sameChecks } from "./api-keys-logic"

function cred(id: number, agent: number, status: TaskflowAgentCredential["status"], created: string, scopes: string | null = null, denied: string | null = null): TaskflowAgentCredential {
  return { id, project: 1, agent, issued_by: 1, name: "main", key_prefix: "tfk_ab", key_hash: "", status, scopes, denied_scopes: denied, expires_at: null, revoked_at: null, created_at: created }
}

describe("activeKey", () => {
  it("is the newest active credential", () => {
    const creds = [cred(1, 7, "active", "2026-11-01T00:00:00Z"), cred(2, 7, "active", "2026-11-05T00:00:00Z"), cred(3, 7, "revoked", "2026-11-07T00:00:00Z"), cred(4, 8, "active", "2026-11-08T00:00:00Z")]
    expect(activeKey(7, creds)?.id).toBe(2)
    expect(activeKey(9, creds)).toBeUndefined()
  })
})

describe("checkedFrom / capabilitySummary", () => {
  it("reads the defaults, denials and grants", () => {
    const plain = checkedFrom(cred(1, 7, "active", ""))
    expect(plain["tasks:write"]).toBe(true)
    expect(plain["agents:manage"]).toBe(false)
    expect(capabilitySummary(plain)).toBe("6 of 7, agent launching off")
    const denied = checkedFrom(cred(1, 7, "active", "", null, '["design:write","toolbox:write","chat:send"]'))
    expect(capabilitySummary(denied)).toBe("3 switched off")
    expect(capabilitySummary(checkedFrom(cred(1, 7, "active", "", '["agents:manage"]')))).toBe("All 7 on")
    expect(sameChecks(plain, { ...plain })).toBe(true)
    expect(sameChecks(plain, denied)).toBe(false)
  })

  it("fails closed on an unreadable denial", () => {
    expect(capabilitySummary(checkedFrom(cred(1, 7, "active", "", null, "garbage")))).toBe("6 switched off")
  })
})

describe("applyScopes", () => {
  it("rewrites only that agent's active keys", () => {
    const creds = [cred(1, 7, "active", ""), cred(2, 7, "revoked", ""), cred(3, 8, "active", "")]
    const out = applyScopes(creds, { agent_id: 7, scopes: [], denied_scopes: ["design:write"], capabilities: [], credentials_updated: 1 })
    expect(out.map((c) => c.denied_scopes)).toEqual(['["design:write"]', null, null])
  })
})
