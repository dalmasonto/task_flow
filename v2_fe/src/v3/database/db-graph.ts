/// The Database diagram's pure rules (#885): where each table sits, which
/// lines connect them, which tables relate to the one being edited, and which
/// colour a group gets. No React, so it is unit-tested.

import type { DbModel, DbSchemaDoc } from "@/lib/db-api"

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

export type DbEdge = { id: string; source: string; target: string; field: string; selfJoin: boolean }

/// One line per fk field, from the model holding it to the model it points at.
export function fkEdges(doc: DbSchemaDoc): DbEdge[] {
  const names = new Set(doc.models.map((m) => m.name))
  return doc.models.flatMap((m) =>
    m.fields
      .filter((f) => f.fk && names.has(f.fk.model))
      .map((f) => ({
        id: `${m.name}.${f.name}`,
        source: m.name,
        target: f.fk!.model,
        field: f.name,
        selfJoin: f.fk!.model === m.name,
      })),
  )
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
