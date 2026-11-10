import { describe, expect, it } from "vitest"

import type { DbModel, DbSchemaDoc } from "@/lib/db-api"

import { fkEdges, groupsOf, keyField, layoutModels, relatedModels, suggestedTarget, toneFor, withModel } from "./db-graph"

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

describe("column-to-column relations", () => {
  it("points each fk at the target's key column", () => {
    expect(fkEdges(doc).map((e) => [e.id, e.targetField])).toEqual([
      ["Agent.project", "id"],
      ["Task.project", "id"],
      // The fixture's Task has no id or declared key: its first field is.
      ["Task.parent", "project"],
    ])
  })
  it("prefers a declared primary key, then id, then the first field", () => {
    expect(keyField({ name: "A", fields: [{ name: "code", type: "String", primary_key: true }, { name: "id", type: "i64" }] })).toBe("code")
    expect(keyField({ name: "B", fields: [{ name: "x", type: "String" }, { name: "id", type: "i64" }] })).toBe("id")
    expect(keyField({ name: "C", fields: [{ name: "x", type: "String" }] })).toBe("x")
    expect(keyField(undefined)).toBeNull()
  })
  it("suggests a relation for an integer named after a model", () => {
    const d: DbSchemaDoc = { models: [{ name: "User", fields: [] }, { name: "Blog", fields: [] }] }
    expect(suggestedTarget(d, { name: "user_id", type: "i64" })).toBe("User")
    expect(suggestedTarget(d, { name: "user", type: "i64" })).toBe("User")
    expect(suggestedTarget(d, { name: "author", type: "i64" })).toBeNull()
    expect(suggestedTarget(d, { name: "user", type: "String" })).toBeNull()
  })
})

describe("facingSides", () => {
  it("leaves and enters on the sides that face each other", async () => {
    const { facingSides } = await import("./db-graph")
    expect(facingSides(0, 300, false)).toEqual({ from: "r", to: "l" })
    expect(facingSides(300, 0, false)).toEqual({ from: "l", to: "r" })
    expect(facingSides(0, 0, true)).toEqual({ from: "r", to: "r" })
    // Same column: a bracket on the right, not a loop around the table.
    expect(facingSides(0, 20, false)).toEqual({ from: "r", to: "r" })
  })
})

describe("relationship kinds", () => {
  it("tells many-to-one, one-to-one and a many-to-many join apart", async () => {
    const { cardinality, isJoinModel } = await import("./db-graph")
    const join: DbModel = { name: "BlogTag", fields: [{ name: "id", type: "i64", primary_key: true }, { name: "blog", type: "fk", fk: { model: "Blog" } }, { name: "tag", type: "fk", fk: { model: "Tag" } }] }
    const blog: DbModel = { name: "Blog", fields: [{ name: "id", type: "i64" }, { name: "title", type: "String" }, { name: "author", type: "fk", fk: { model: "User" } }, { name: "category", type: "fk", fk: { model: "Category" } }] }
    expect(isJoinModel(join)).toBe(true)
    expect(isJoinModel(blog)).toBe(false)
    expect(cardinality(join, join.fields[1])).toBe("M:N")
    expect(cardinality(blog, blog.fields[2])).toBe("N:1")
    expect(cardinality({ name: "UserProfile", fields: [] }, { unique: true })).toBe("1:1")
  })
})
