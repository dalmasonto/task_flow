import { describe, expect, it } from "vitest"

import { colourUses, rootClasses, typeAndSpacing } from "./inspect-logic"

describe("inspect logic", () => {
  const snippet = '<h3 class="text-sm font-medium text-foreground bg-muted/50 px-1 border border-border hover:bg-accent"><span class="text-xs">x</span></h3>'
  it("reads the element's own classes", () => {
    expect(rootClasses(snippet)).toContain("px-1")
    expect(rootClasses(snippet)).not.toContain("text-xs")
    expect(rootClasses("<div>no class</div>")).toEqual([])
  })
  it("finds token colours by role, not sizes or variants", () => {
    expect(colourUses(rootClasses(snippet))).toEqual([
      { role: "Text", token: "foreground" },
      { role: "Background", token: "muted" },
      { role: "Border", token: "border" },
    ])
  })
  it("finds type and spacing classes", () => {
    expect(typeAndSpacing(rootClasses(snippet))).toEqual(["text-sm", "font-medium", "px-1"])
  })
})
