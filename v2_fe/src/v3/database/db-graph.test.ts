import { describe, expect, it } from "vitest"

import type { DbSchemaDoc } from "@/lib/db-api"

import { fkEdges, groupsOf, layoutModels, relatedModels, toneFor, withModel } from "./db-graph"

const doc: DbSchemaDoc = {
  models: [
    { name: "Project", group: "projects", fields: [{ name: "id", type: "i64" }] },
    {
      name: "Agent",
      group: "agents",
      fields: [
        { name: "id", type: "i64" },
        { name: "project", type: "fk", fk: { model: "Project" } },
      ],
    },
    {
      name: "Task",
      group: "projects",
      fields: [
        { name: "project", type: "fk", fk: { model: "Project" } },
        { name: "parent", type: "fk", fk: { model: "Task" }, optional: true },
      ],
    },
    { name: "Note", fields: [{ name: "body", type: "Text" }] },
  ],
}

describe("db diagram rules", () => {
  it("lists groups in first-seen order, ungrouped last as empty", () => {
    expect(groupsOf(doc)).toEqual(["projects", "agents", ""])
  })

  it("puts each group in its own column and stacks tables without overlap", () => {
    const pos = layoutModels(doc)
    expect(pos.get("Project")!.x).toBe(pos.get("Task")!.x)
    expect(pos.get("Task")!.y).toBeGreaterThan(pos.get("Project")!.y)
    expect(pos.get("Agent")!.x).toBeGreaterThan(pos.get("Project")!.x)
  })

  it("draws one line per fk, marking a self-join", () => {
    expect(fkEdges(doc).map((e) => [e.id, e.selfJoin])).toEqual([
      ["Agent.project", false],
      ["Task.project", false],
      ["Task.parent", true],
    ])
  })

  it("keeps a model, what it points at and what points at it bright", () => {
    expect([...relatedModels(doc, "Project")].sort()).toEqual(["Agent", "Project", "Task"])
    expect([...relatedModels(doc, "Note")]).toEqual(["Note"])
  })

  it("gives every group a stable colour", () => {
    expect(toneFor(doc, "projects")).toBe(toneFor(doc, "projects"))
    expect(toneFor(doc, "projects")).not.toBe(toneFor(doc, "agents"))
  })

  it("replaces a renamed model in place, or appends a new one", () => {
    const renamed = withModel(doc, { name: "Member", fields: [] }, "Note")
    expect(renamed.models.map((m) => m.name)).toEqual(["Project", "Agent", "Task", "Member"])
    expect(withModel(doc, { name: "New", fields: [] }).models).toHaveLength(5)
  })
})
