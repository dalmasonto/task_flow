import { describe, expect, it } from "vitest"
import { defaultRows } from "./token-defaults"

const missing = { version: 1, categories: { colors: { primary: { light: "a", dark: "b" }, ring: { light: "c" } } } }

describe("defaultRows", () => {
  it("lists the category's defaults the doc does not define", () => {
    const doc = { version: 1, categories: { colors: { ring: { light: "mine" } } } }
    expect(defaultRows(missing, doc, "colors")).toEqual([["primary", { light: "a", dark: "b" }]])
  })
  it("is empty for a category with no defaults", () => {
    expect(defaultRows(missing, { version: 1, categories: {} }, "spacing")).toEqual([])
  })
})
