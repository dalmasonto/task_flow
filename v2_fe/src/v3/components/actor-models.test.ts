import { describe, expect, it } from "vitest"

import { agentModelId } from "./actor-models"

describe("agentModelId (#1078)", () => {
  it("prefers the stated model, then provider, then a guess", () => {
    expect(agentModelId({ model: "claude-opus-5-5", runtime: "codex-cli", display_name: "x" })).toBe("claude")
    expect(agentModelId({ provider: "google", display_name: "Helper" })).toBe("gemini")
    expect(agentModelId({ provider: "other", runtime: "codex", display_name: "x" })).toBe("codex")
    expect(agentModelId({ display_name: "DeepSeek (api)" })).toBe("deepseek")
    expect(agentModelId({ display_name: "Helper" })).toBeNull()
    expect(agentModelId(null)).toBeNull()
  })
})
