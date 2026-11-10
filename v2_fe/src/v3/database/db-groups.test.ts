import { describe, expect, it } from "vitest"

import type { DbSchemaDoc } from "@/lib/db-api"

import { addRelation, deleteGroup, effectiveGroups, fieldNameFor, groupTone, nextColor, slugify, slugTaken, upsertGroup } from "./db-groups"

const doc: DbSchemaDoc = {
  groups: [{ slug: "blog", name: "Blog", color: "chart-2" }],
  models: [
    { name: "User", group: "accounts", fields: [{ name: "id", type: "i64", primary_key: true }] },
    { name: "Blog", group: "blog", fields: [{ name: "id", type: "i64", primary_key: true }] },
    { name: "Tag", group: "blog", fields: [{ name: "id", type: "i64", primary_key: true }] },
    { name: "Loose", fields: [] },
  ],
}

describe("groups", () => {
  it("slugifies names", () => {
    expect(slugify("  My Blog Stuff! ")).toBe("my-blog-stuff")
    expect(slugify("Ünïcode café")).toBe("unicode-cafe")
  })
  it("lists stored groups, then free labels models use (with a colour)", () => {
    const g = effectiveGroups(doc)
    expect(g.map((x) => [x.slug, x.name, x.explicit])).toEqual([
      ["blog", "Blog", true],
      ["accounts", "accounts", false],
    ])
    expect(g[1].color).not.toBe("chart-2")
  })
  it("colours by the stored colour; ungrouped is muted", () => {
    expect(groupTone(doc, "blog").dot).toBe("bg-chart-2")
    expect(groupTone(doc, undefined).dot).toContain("muted")
  })
  it("picks an unused colour for a new group", () => {
    expect(nextColor(doc)).not.toBe("chart-2")
  })
  it("renaming a slug moves its models; an implicit group becomes stored", () => {
    const next = upsertGroup(doc, { slug: "people", name: "People", color: "chart-3" }, "accounts")
    expect(next.groups?.map((g) => g.slug)).toEqual(["blog", "people"])
    expect(next.models.find((m) => m.name === "User")?.group).toBe("people")
  })
  it("saving any group stores the free labels too, so their colours stay put", () => {
    const before = groupTone(doc, "accounts")
    const next = upsertGroup(doc, { slug: "tags", name: "Tags", color: "chart-5" })
    expect(next.groups?.map((g) => g.slug)).toEqual(["blog", "accounts", "tags"])
    expect(groupTone(next, "accounts")).toEqual(before)
  })
  it("deleting a group keeps its models, ungrouped", () => {
    const next = deleteGroup(doc, "blog")
    expect(next.groups?.map((g) => g.slug)).toEqual(["accounts"])
    expect(next.models.filter((m) => m.group === "blog")).toEqual([])
    expect(next.models).toHaveLength(4)
  })
  it("knows a taken slug, except the one being edited", () => {
    expect(slugTaken(doc, "blog")).toBe(true)
    expect(slugTaken(doc, "blog", "blog")).toBe(false)
    expect(slugTaken(doc, "accounts")).toBe(true)
  })
})

describe("addRelation", () => {
  it("many-to-one and one-to-one add a field", () => {
    const m1 = addRelation(doc, "Blog", "User", "many-to-one")
    expect(m1.added).toEqual({ model: "Blog", field: "user" })
    const blog = m1.doc.models.find((m) => m.name === "Blog")!
    expect(blog.fields.at(-1)).toMatchObject({ name: "user", type: "fk", fk: { model: "User" } })
    const o1 = addRelation(m1.doc, "Blog", "User", "one-to-one")
    expect(o1.added.field).toBe("user_2")
    expect(o1.doc.models.find((m) => m.name === "Blog")!.fields.at(-1)?.unique).toBe(true)
  })
  it("many-to-many creates the join model in the source's group", () => {
    const r = addRelation(doc, "Blog", "Tag", "many-to-many")
    expect(r.added).toEqual({ model: "BlogTag" })
    const join = r.doc.models.find((m) => m.name === "BlogTag")!
    expect(join.group).toBe("blog")
    expect(join.fields.map((f) => [f.name, f.fk?.model ?? null])).toEqual([
      ["id", null],
      ["blog", "Blog"],
      ["tag", "Tag"],
    ])
    // A second one gets a fresh name.
    expect(addRelation(r.doc, "Blog", "Tag", "many-to-many").added.model).toBe("BlogTag2")
  })
  it("names fields from model names", () => {
    expect(fieldNameFor("TaskflowProject")).toBe("taskflow_project")
  })
})
