import { describe, expect, it } from "vitest"

import { firstName, greeting, homeLine, weekStart } from "./home-logic"

describe("home-logic", () => {
  it("greets by the hour", () => {
    expect(greeting(8)).toBe("Good morning")
    expect(greeting(14)).toBe("Good afternoon")
    expect(greeting(20)).toBe("Good evening")
    expect(greeting(2)).toBe("Good evening")
  })
  it("starts the week on Monday", () => {
    const sun = weekStart(new Date(2026, 10, 8, 15))
    expect([sun.getDay(), sun.getDate()]).toEqual([1, 2])
    const mon = weekStart(new Date(2026, 10, 2, 9))
    expect(mon.getDate()).toBe(2)
  })
  it("writes the line", () => {
    expect(homeLine(5, 3, 4)).toBe("5 agents are working across 3 projects. 4 things are waiting on you.")
    expect(homeLine(1, 1, 1)).toBe("1 agent is working across 1 project. 1 thing is waiting on you.")
    expect(homeLine(0, 2, 0)).toBe("No agent is working right now. Nothing is waiting on you.")
  })
  it("takes a first name, never an email", () => {
    expect(firstName("dalmas ogembo")).toBe("Dalmas")
    expect(firstName("probe@example.com")).toBe("")
    expect(firstName(null)).toBe("")
  })
})
