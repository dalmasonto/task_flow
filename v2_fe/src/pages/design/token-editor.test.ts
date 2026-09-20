import { describe, it, expect } from "vitest"
import { parseSizeValue } from "./token-editor"

/// `parseSizeValue` backs the numeric+unit controls for spacing/radius/
/// typography tokens: a token is stored as one CSS-length string ("8px"),
/// but the control binds two plain inputs (number + unit) to it. Get the
/// split wrong and either the number field shows NaN or the unit field eats
/// part of the number.
describe("parseSizeValue", () => {
  it("splits a simple pixel length", () => {
    expect(parseSizeValue("8px")).toEqual({ num: 8, unit: "px" })
  })

  it("splits a decimal rem length", () => {
    expect(parseSizeValue("1.5rem")).toEqual({ num: 1.5, unit: "rem" })
  })

  it("splits a negative length", () => {
    expect(parseSizeValue("-4px")).toEqual({ num: -4, unit: "px" })
  })

  it("splits a percentage", () => {
    expect(parseSizeValue("50%")).toEqual({ num: 50, unit: "%" })
  })

  it("treats a unitless number as an empty unit", () => {
    expect(parseSizeValue("0")).toEqual({ num: 0, unit: "" })
  })

  it("tolerates whitespace between the number and the unit", () => {
    expect(parseSizeValue("12 px")).toEqual({ num: 12, unit: "px" })
  })

  it("returns null for a keyword value", () => {
    expect(parseSizeValue("nonsense")).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(parseSizeValue("")).toBeNull()
  })

  it("returns null for a shadow-shaped multi-value string", () => {
    expect(parseSizeValue("0 1px 2px rgba(0,0,0,0.1)")).toBeNull()
  })

  it("returns null for a value starting with a unit, not a number", () => {
    expect(parseSizeValue("px12")).toBeNull()
  })
})
