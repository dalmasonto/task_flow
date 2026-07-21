import { describe, it, expect } from "vitest"
import { isoToDatetimeLocalInput, datetimeLocalInputToIso } from "./datetime"

// These round-trips are timezone-independent by construction: the local input
// string is the local wall-clock for a given instant, and parsing it back as
// local must land on the same instant — true in whatever tz the test runs.
describe("isoToDatetimeLocalInput / datetimeLocalInputToIso", () => {
  it("produces a local input that denotes the SAME instant as the UTC iso", () => {
    const iso = "2026-07-20T21:30:00.000Z"
    const local = isoToDatetimeLocalInput(iso)
    // `new Date(local)` parses a bare datetime-local string as LOCAL time.
    expect(new Date(local).getTime()).toBe(new Date(iso).getTime())
  })

  it("round-trips back to the original instant", () => {
    const iso = "2026-07-20T21:30:00.000Z"
    expect(datetimeLocalInputToIso(isoToDatetimeLocalInput(iso))).toBe(iso)
  })

  it("shapes the value as YYYY-MM-DDTHH:mm for a datetime-local input", () => {
    expect(isoToDatetimeLocalInput("2026-07-20T21:30:00Z")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })

  it("treats empty and invalid inputs as no value", () => {
    expect(datetimeLocalInputToIso("")).toBeNull()
    expect(isoToDatetimeLocalInput("")).toBe("")
    expect(isoToDatetimeLocalInput("not a date")).toBe("")
  })
})
