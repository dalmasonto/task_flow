/// The Database diagram's pure rules (#885): where each table sits, which
/// lines connect them, which tables relate to the one being edited, and which
/// colour a group gets. No React, so it is unit-tested.

import type { DbField, DbModel, DbSchemaDoc } from "@/lib/db-api"

/// Five distinct hues, cycled by group — the same chart tokens the mocks use.
export const GROUP_TONES = [
  { dot: "bg-chart-1", line: "var(--chart-1)" },
  { dot: "bg-chart-2", line: "var(--chart-2)" },
  { dot: "bg-chart-3", line: "var(--chart-3)" },
  { dot: "bg-chart-4", line: "var(--chart-4)" },
  { dot: "bg-chart-5", line: "var(--chart-5)" },
] as const

/// Groups in first-seen order; a model without one is in "" (shown as "Other").
export function groupsOf(doc: DbSchemaDoc): string[] {
  const seen: string[] = []
  for (const m of doc.models) {
    const g = m.group ?? ""
    if (!seen.includes(g)) seen.push(g)
  }
  return seen
}

export function toneFor(doc: DbSchemaDoc, group: string | undefined) {
  const i = groupsOf(doc).indexOf(group ?? "")
  return GROUP_TONES[(i < 0 ? 0 : i) % GROUP_TONES.length]
}

export const TABLE_W = 260
const COL_GAP = 80
const ROW_H = 28
const HEAD_H = 44
const ROW_GAP = 60

/// One column per group, tables stacked down it. Deterministic, so the diagram
/// does not jump between reloads; the person can still drag tables around.
export function layoutModels(doc: DbSchemaDoc): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  groupsOf(doc).forEach((group, col) => {
    let y = 0
    for (const m of doc.models.filter((x) => (x.group ?? "") === group)) {
      out.set(m.name, { x: col * (TABLE_W + COL_GAP), y })
      y += HEAD_H + m.fields.length * ROW_H + ROW_GAP
    }
  })
  return out
}

export type DbEdge = { id: string; source: string; target: string; field: string; targetField: string | null; selfJoin: boolean }

/// The column a relation points at: the target's primary key, else its `id`,
/// else its first field. Null for a model with no fields.
export function keyField(model: DbModel | undefined): string | null {
  if (!model) return null
  return (model.fields.find((f) => f.primary_key) ?? model.fields.find((f) => f.name === "id") ?? model.fields[0])?.name ?? null
}

/// One line per fk field, from that field (column to column) to the key of
/// the model it points at.
export function fkEdges(doc: DbSchemaDoc): DbEdge[] {
  const byName = new Map(doc.models.map((m) => [m.name, m]))
  return doc.models.flatMap((m) =>
    m.fields
      .filter((f) => f.type === "fk" && f.fk && byName.has(f.fk.model))
      .map((f) => ({
        id: `${m.name}.${f.name}`,
        source: m.name,
        target: f.fk!.model,
        field: f.name,
        targetField: keyField(byName.get(f.fk!.model)),
        selfJoin: f.fk!.model === m.name,
      })),
  )
}

/// A relation the person likely meant but typed as a plain integer: an i64
/// field named after another model (`author` is not, `user` / `user_id` are).
export function suggestedTarget(doc: DbSchemaDoc, field: { name: string; type: string }): string | null {
  if (field.type !== "i64" || field.name === "id") return null
  const base = field.name.toLowerCase().replace(/_id$/, "")
  return doc.models.find((m) => m.name.toLowerCase() === base || m.name.toLowerCase().endsWith(base))?.name ?? null
}

/// The model itself, what it points at and what points at it — the tables kept
/// bright while it is open in the editor; the rest are faded.
export function relatedModels(doc: DbSchemaDoc, name: string): Set<string> {
  const related = new Set([name])
  for (const e of fkEdges(doc)) {
    if (e.source === name) related.add(e.target)
    if (e.target === name) related.add(e.source)
  }
  return related
}

/// Replace one model in the document (or append it), returning a new document.
export function withModel(doc: DbSchemaDoc, model: DbModel, previousName?: string): DbSchemaDoc {
  const key = previousName ?? model.name
  const exists = doc.models.some((m) => m.name === key)
  return {
    ...doc,
    models: exists ? doc.models.map((m) => (m.name === key ? model : m)) : [...doc.models, model],
  }
}

/// The connection points a relation joins: every field row has a source and
/// a target on BOTH edges (db-table-node), so a line can leave and enter on
/// the sides that face each other instead of looping around a table.
export type Side = "l" | "r"
export const sourceHandle = (field: string, side: Side = "r") => `s:${side}:${field}`
export const targetHandle = (field: string, side: Side = "l") => `t:${side}:${field}`

/// Which sides face each other: target to the right → leave right, enter
/// left; to the left → leave left, enter right. A self-join, or two tables
/// in the same column (overlapping horizontally), leave and enter on the
/// right: a bracket beside the column instead of a loop around a table.
export function facingSides(sourceX: number, targetX: number, selfJoin: boolean, width = TABLE_W): { from: Side; to: Side } {
  if (selfJoin || Math.abs(targetX - sourceX) < width) return { from: "r", to: "r" }
  return targetX > sourceX ? { from: "r", to: "l" } : { from: "l", to: "r" }
}

/// A join table for a many-to-many: two or more relations, and nothing else
/// but its own key and timestamps (BlogTag: id, blog → Blog, tag → Tag).
export function isJoinModel(model: DbModel): boolean {
  const fks = model.fields.filter((f) => f.type === "fk")
  if (fks.length < 2) return false
  return model.fields.every((f) => f.type === "fk" || f.primary_key || f.name === "id" || /^(created|updated)_at$/.test(f.name))
}

export type Cardinality = "N:1" | "1:1" | "M:N"

/// What a relation line says: a unique fk is one-to-one, a join table's fks
/// are each half of a many-to-many, any other fk is many-to-one.
export function cardinality(model: DbModel, field: Pick<DbField, "unique">): Cardinality {
  if (isJoinModel(model)) return "M:N"
  return field.unique ? "1:1" : "N:1"
}
