import { describe, expect, it } from "vitest"

import { parseRepo } from "./project-new-logic"

describe("parseRepo", () => {
  it("accepts the short form and the URLs people paste", () => {
    for (const ok of ["dalmasonto/matchday", " dalmasonto/matchday ", "https://github.com/dalmasonto/matchday", "github.com/dalmasonto/matchday.git", "https://github.com/dalmasonto/matchday/tree/main", "git@github.com:dalmasonto/matchday.git"])
      expect(parseRepo(ok), ok).toBe("dalmasonto/matchday")
  })
  it("refuses what can't be a repo", () => {
    for (const bad of ["", "matchday", "dalmasonto/", "/matchday", "dal masonto/matchday", "owner/..", "https://gitlab.com/a/b", "-x/y"]) expect(parseRepo(bad), bad).toBeNull()
  })
})
