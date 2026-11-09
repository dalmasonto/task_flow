import { describe, expect, it } from "vitest"

import type { DbSchemaDoc } from "@/lib/db-api"

import { matchModels } from "./db-search"

const doc: DbSchemaDoc = {
  models: [
    { name: "TaskflowTask", group: "tasks", fields: [{ name: "id", type: "i64" }, { name: "assigned_agent_id", type: "i64" }] },
    { name: "TaskflowAgent", group: "agents", fields: [{ name: "id", type: "i64" }, { name: "display_name", type: "String" }] },
  ],
}

describe("matchModels", () => {
  it("returns everything for an empty query", () => {
    expect(matchModels(doc, "  ")).toHaveLength(2)
  })
  it("matches model names and field names, case-insensitively", () => {
    expect(matchModels(doc, "agent").map((m) => m.name)).toEqual(["TaskflowTask", "TaskflowAgent"])
    expect(matchModels(doc, "DISPLAY").map((m) => m.name)).toEqual(["TaskflowAgent"])
    expect(matchModels(doc, "nothing")).toEqual([])
  })
})
