import { describe, expect, it } from "vitest"

import type { TaskflowProjectApiEndpoint, TaskflowProjectMember } from "@/api/client"

import { aboutError, aboutPatch, endpointsSummary, isLocalUrl, projectPowers, slugError, sortEndpoints } from "./project-logic"

function mem(role: TaskflowProjectMember["role"], status: TaskflowProjectMember["status"] = "active"): TaskflowProjectMember {
  return { id: 1, project: 1, member_key: "m", user: 1, display_name: "A", email: null, role, status, invited_by: null, created_at: null, joined_at: null }
}

function ep(id: number, label: string, environment: TaskflowProjectApiEndpoint["environment"], is_default = false): TaskflowProjectApiEndpoint {
  return { id, project: 1, label, base_url: "https://x", environment, health: "unknown", is_default, notes_markdown: null, last_checked_at: null, created_at: null }
}

describe("projectPowers", () => {
  it("owner/admin edit; only an owner archives and deletes", () => {
    expect(projectPowers(mem("owner"), false)).toEqual({ edit: true, owner: true })
    expect(projectPowers(mem("admin"), false)).toEqual({ edit: true, owner: false })
    expect(projectPowers(mem("developer"), false)).toEqual({ edit: false, owner: false })
    expect(projectPowers(mem("owner", "suspended"), false)).toEqual({ edit: false, owner: false })
    expect(projectPowers(undefined, true)).toEqual({ edit: true, owner: true })
  })
})

describe("slug and about form", () => {
  it("matches the handler's slug rule", () => {
    expect(slugError("taskflow-v2")).toBeNull()
    expect(slugError("a")).toMatch(/2 to 120/)
    expect(slugError("Task Flow")).toMatch(/Lowercase/)
    expect(slugError("My-Project")).toBeNull()
    expect(slugError("-x")).toMatch(/dash/)
  })

  it("sends only what changed", () => {
    const was = { name: "TaskFlow", slug: "taskflow", description: "Board" }
    expect(aboutPatch(was, { ...was })).toEqual({})
    expect(aboutPatch(was, { name: " TaskFlow v3 ", slug: "TaskFlow", description: "Board " })).toEqual({ name: "TaskFlow v3" })
    expect(aboutPatch(was, { ...was, slug: "tf-3" })).toEqual({ slug: "tf-3" })
    expect(aboutError({ name: " ", slug: "ok", description: "" })).toMatch(/name/)
    expect(aboutError({ name: "x", slug: "ok", description: "" })).toBeNull()
  })
})

describe("endpoints", () => {
  it("sorts default first, then by environment", () => {
    expect(sortEndpoints([ep(1, "Local", "local"), ep(2, "Staging", "staging"), ep(3, "Prod", "production"), ep(4, "Dev box", "local", true)]).map((e) => e.id)).toEqual([4, 3, 2, 1])
    expect(endpointsSummary([ep(1, "Prod", "production", true), ep(2, "Local", "local")])).toBe("2 environments, default Prod.")
    expect(endpointsSummary([])).toBe("None yet.")
  })

  it("knows a local address", () => {
    expect(isLocalUrl("http://localhost:8000")).toBe(true)
    expect(isLocalUrl("http://127.0.0.1")).toBe(true)
    expect(isLocalUrl("https://api.taskflow.supercodehive.com")).toBe(false)
    expect(isLocalUrl("nope")).toBe(false)
  })
})
