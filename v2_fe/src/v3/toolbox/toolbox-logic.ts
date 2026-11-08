/// Pure rules for the v3 Toolbox page (tested in toolbox-logic.test.ts).
import type { ToolboxEntry, ToolboxIndexEntry, ToolboxKind, ToolboxVersion } from "@/lib/toolbox-api"

export function countKinds(entries: ToolboxIndexEntry[]): Record<ToolboxKind, number> {
  const out: Record<ToolboxKind, number> = { memory: 0, script: 0 }
  for (const e of entries) out[e.kind] += 1
  return out
}

/// Entries of `kind` matching every word of `query` (name, title,
/// description, tags). Retired entries sink to the bottom; otherwise most
/// recently updated first.
export function filterEntries(entries: ToolboxIndexEntry[], kind: ToolboxKind, query: string): ToolboxIndexEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return entries
    .filter((e) => e.kind === kind)
    .filter((e) => {
      if (!words.length) return true
      const hay = `${e.name} ${e.title} ${e.description} ${e.tags.join(" ")}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .sort(
      (a, b) =>
        Number(a.status === "deprecated") - Number(b.status === "deprecated") ||
        (Date.parse(b.updated_at ?? "") || 0) - (Date.parse(a.updated_at ?? "") || 0) ||
        a.name.localeCompare(b.name),
    )
}

/// The kind tab to open on: what the selected entry is, else memories unless
/// there are only scripts.
export function initialKind(entries: ToolboxIndexEntry[], selected: string | null): ToolboxKind {
  const hit = selected ? entries.find((e) => e.name === selected) : undefined
  if (hit) return hit.kind
  const c = countKinds(entries)
  return c.memory === 0 && c.script > 0 ? "script" : "memory"
}

export type VersionRow = Pick<ToolboxVersion, "version" | "author_label" | "note" | "vetted_by" | "created_at"> & { current: boolean }

/// The version list, current first. The current version has no snapshot row
/// of its own (the entry row is it), so it's synthesised from the entry; each
/// older row diffs against the row above it, the version that replaced it.
export function versionRows(entry: Pick<ToolboxEntry, "author_label" | "updated_at">, current: number, history: ToolboxVersion[]): VersionRow[] {
  return [
    { version: current, author_label: entry.author_label, note: null, vetted_by: null, created_at: entry.updated_at, current: true },
    ...history.filter((v) => v.version !== current).map((v) => ({ version: v.version, author_label: v.author_label, note: v.note, vetted_by: v.vetted_by, created_at: v.created_at, current: false })),
  ]
}

export function statusLabel(status: ToolboxIndexEntry["status"]): string | null {
  if (status === "deprecated") return "Retired"
  if (status === "draft") return "Draft"
  return null
}
