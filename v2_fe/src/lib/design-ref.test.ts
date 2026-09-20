import { describe, expect, it } from "vitest"
import { appendDesignRef, encodeDesignRef, parseDesignRef, stripDesignRef, type DesignRef } from "./design-ref"

const ref: DesignRef = { pagePath: "pages/home.js", elementPath: "div>button.cta", srcRef: "home.js:42", viewport: "desktop" }

describe("design-ref codec", () => {
  it("round-trips a ref through encode/parse", () => {
    expect(parseDesignRef(encodeDesignRef(ref))).toEqual(ref)
  })
  it("appends the block after the body and parse recovers it", () => {
    const body = appendDesignRef("please tighten this", ref)
    expect(body.startsWith("please tighten this")).toBe(true)
    expect(parseDesignRef(body)).toEqual(ref)
  })
  it("strips the block for display, leaving the prose", () => {
    const body = appendDesignRef("please tighten this", ref)
    expect(stripDesignRef(body).trim()).toBe("please tighten this")
  })
  it("returns null and passes through when there is no block", () => {
    expect(parseDesignRef("just chatting")).toBeNull()
    expect(stripDesignRef("just chatting")).toBe("just chatting")
  })
  it("fails soft on a malformed block", () => {
    const bad = "hi\n\n```design-ref\n{not json\n```"
    expect(parseDesignRef(bad)).toBeNull()
    expect(stripDesignRef(bad).trim()).toBe("hi")
  })
})
