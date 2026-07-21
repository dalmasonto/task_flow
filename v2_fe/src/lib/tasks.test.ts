import { describe, it, expect } from "vitest"
import { parseEstimateMinutes, formatEstimateMinutes } from "./tasks"

describe("parseEstimateMinutes", () => {
  it("reads a leading integer as minutes", () => {
    expect(parseEstimateMinutes("90")).toBe(90)
    expect(parseEstimateMinutes("90 min")).toBe(90)
    expect(parseEstimateMinutes("  120  ")).toBe(120)
  })
  it("returns null when there is no leading integer", () => {
    expect(parseEstimateMinutes("")).toBeNull()
    expect(parseEstimateMinutes("about an hour")).toBeNull()
  })
})

describe("formatEstimateMinutes", () => {
  it("formats minutes, and null as a dash", () => {
    expect(formatEstimateMinutes(90)).toBe("90 min")
    expect(formatEstimateMinutes(null)).toBe("—")
  })
})
