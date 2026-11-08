import { describe, expect, it } from "vitest"

import type { ToolboxIndexEntry, ToolboxVersion } from "@/lib/toolbox-api"

import { countKinds, filterEntries, initialKind, versionRows } from "./toolbox-logic"

function e(name: string, kind: ToolboxIndexEntry["kind"], status: ToolboxIndexEntry["status"] = "approved", updated = "2026-11-01T00:00:00Z", tags: string[] = []): ToolboxIndexEntry {
  return { id: 1, kind, name, title: name, description: `about ${name}`, status, version: 1, tags, language: null, entrypoint: null, requires_env: [], last_run_at: null, last_run_ok: false, run_ok_count: 0, run_fail_count: 0, author_label: "x", updated_at: updated }
}

const ENTRIES = [
  e("deploy-backend", "script", "approved", "2026-11-07T00:00:00Z", ["deploy"]),
  e("restart-renderer", "script", "deprecated", "2026-11-08T00:00:00Z"),
  e("migrate-prod", "script", "approved", "2026-11-05T00:00:00Z", ["deploy"]),
  e("base-branch", "memory"),
]

describe("toolbox lists", () => {
  it("counts, filters, sorts retired last", () => {
    expect(countKinds(ENTRIES)).toEqual({ memory: 1, script: 3 })
    expect(filterEntries(ENTRIES, "script", "").map((x) => x.name)).toEqual(["deploy-backend", "migrate-prod", "restart-renderer"])
    expect(filterEntries(ENTRIES, "script", "deploy").map((x) => x.name)).toEqual(["deploy-backend", "migrate-prod"])
  })

  it("opens on the selected entry's kind", () => {
    expect(initialKind(ENTRIES, "migrate-prod")).toBe("script")
    expect(initialKind(ENTRIES, null)).toBe("memory")
    expect(initialKind(ENTRIES.filter((x) => x.kind === "script"), null)).toBe("script")
  })
})

describe("versionRows", () => {
  it("puts the current version first", () => {
    const history: ToolboxVersion[] = [
      { version: 2, description: "", author_label: "b", note: "fix", vetted_by: null, vetted_note: null, created_at: null },
      { version: 1, description: "", author_label: "a", note: null, vetted_by: "r", vetted_note: null, created_at: null },
    ]
    const rows = versionRows({ author_label: "c", updated_at: null }, 3, history)
    expect(rows.map((r) => [r.version, r.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ])
  })
})
