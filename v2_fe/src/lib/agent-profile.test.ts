import { describe, expect, it } from "vitest"

import { PROFILE_PATTERN, profileOf } from "./agent-profile"

describe("agent profiles", () => {
  it("reads the profile from the end of an agent identifier", () => {
    expect(profileOf("agent:2:claude--main-:main")).toBe("main")
    expect(profileOf("agent:2:codex:reviewer")).toBe("reviewer")
  })

  it("gives nothing for an identifier that does not end in a profile", () => {
    expect(profileOf("agent:2:Weird Name:Not A Profile")).toBe("")
  })

  it("accepts identifier-like profiles only", () => {
    for (const ok of ["main", "reviewer", "qa-2", "build_bot"]) expect(PROFILE_PATTERN.test(ok)).toBe(true)
    for (const bad of ["", "Main", "in api bamain", "-x", "a".repeat(33)]) expect(PROFILE_PATTERN.test(bad)).toBe(false)
  })
})
