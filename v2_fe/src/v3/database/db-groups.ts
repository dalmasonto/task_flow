/// Model groups on the Database page: named, coloured sections managed in one
/// place (the group dialog), stored in the schema document's `groups` and
/// referenced by a model's `group` slug. Pure, so it is unit-tested.
///
/// A model may name a group that has no entry (an agent's free label from
/// before groups existed). Such a group still shows, under its slug, with a
/// default colour, until someone gives it a name and colour in the dialog.
import type { DbField, DbGroup, DbModel, DbSchemaDoc } from "@/lib/db-api"

/// The colours a group may take: theme tokens, so they follow light and dark.
/// Must match GROUP_COLORS in backend/plugins/taskflow-db/src/schema_doc.rs.
export const GROUP_COLORS = [
  { id: "chart-1", label: "Blue", dot: "bg-chart-1", line: "var(--chart-1)" },
  { id: "chart-2", label: "Orange", dot: "bg-chart-2", line: "var(--chart-2)" },
  { id: "chart-3", label: "Green", dot: "bg-chart-3", line: "var(--chart-3)" },
  { id: "chart-4", label: "Amber", dot: "bg-chart-4", line: "var(--chart-4)" },
  { id: "chart-5", label: "Violet", dot: "bg-chart-5", line: "var(--chart-5)" },
  { id: "running", label: "Teal", dot: "bg-running", line: "var(--running)" },
  { id: "review", label: "Purple", dot: "bg-review", line: "var(--review)" },
  { id: "blocked", label: "Yellow", dot: "bg-blocked", line: "var(--blocked)" },
  { id: "failed", label: "Red", dot: "bg-failed", line: "var(--failed)" },
  { id: "done", label: "Emerald", dot: "bg-done", line: "var(--done)" },
  { id: "idle", label: "Grey", dot: "bg-idle", line: "var(--idle)" },
] as const

export type GroupColor = (typeof GROUP_COLORS)[number]
const UNGROUPED = { dot: "bg-muted-foreground/50", line: "var(--muted-foreground)" }

/// `My Blog Stuff!` → `my-blog-stuff`.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

export type EffectiveGroup = DbGroup & { explicit: boolean }

/// Every group the page shows, in order: the stored groups first, then any
/// group a model names that has no entry (named by its slug, given a colour
/// no other group uses yet). Models without a group go under "Ungrouped", not listed here.
export function effectiveGroups(doc: DbSchemaDoc): EffectiveGroup[] {
  const stored = (doc.groups ?? []).map((g) => ({ ...g, explicit: true }))
  const known = new Set(stored.map((g) => g.slug))
  const implicit: EffectiveGroup[] = []
  for (const m of doc.models) {
    const slug = m.group?.trim()
    if (!slug || known.has(slug)) continue
    known.add(slug)
    const used = new Set([...stored, ...implicit].map((g) => g.color))
    const color = (GROUP_COLORS.find((c) => !used.has(c.id)) ?? GROUP_COLORS[(stored.length + implicit.length) % GROUP_COLORS.length]).id
    implicit.push({ slug, name: slug, color, explicit: false })
  }
  return [...stored, ...implicit]
}

/// The dot class and line colour for a model's group.
export function groupTone(doc: DbSchemaDoc, slug: string | undefined): { dot: string; line: string } {
  if (!slug) return UNGROUPED
  const g = effectiveGroups(doc).find((x) => x.slug === slug)
  const c = GROUP_COLORS.find((x) => x.id === g?.color)
  return c ? { dot: c.dot, line: c.line } : UNGROUPED
}

/// The first colour no group uses yet (so a new group stands out).
export function nextColor(doc: DbSchemaDoc): GroupColor["id"] {
  const used = new Set(effectiveGroups(doc).map((g) => g.color))
  return (GROUP_COLORS.find((c) => !used.has(c.id)) ?? GROUP_COLORS[0]).id
}

/// Every group the page shows, all stored with the colour they have now, so a
/// free label's colour never shifts when another group changes.
function materialized(doc: DbSchemaDoc): DbGroup[] {
  return effectiveGroups(doc).map(({ slug, name, color }) => ({ slug, name, color }))
}

/// Create or edit a group. Renaming its slug moves every model that used the
/// old one. Free labels become stored groups, keeping their colours.
export function upsertGroup(doc: DbSchemaDoc, group: DbGroup, previousSlug?: string): DbSchemaDoc {
  const from = previousSlug ?? group.slug
  const groups = materialized(doc)
  const at = groups.findIndex((g) => g.slug === from)
  if (at >= 0) groups[at] = group
  else groups.push(group)
  const models = from === group.slug ? doc.models : doc.models.map((m) => (m.group === from ? { ...m, group: group.slug } : m))
  return { ...doc, groups, models }
}

/// Delete a group: its models stay, ungrouped.
export function deleteGroup(doc: DbSchemaDoc, slug: string): DbSchemaDoc {
  return {
    ...doc,
    groups: materialized(doc).filter((g) => g.slug !== slug),
    models: doc.models.map((m) => (m.group === slug ? { ...m, group: undefined } : m)),
  }
}

/// Is this slug free for a new group (or the one being edited)?
export function slugTaken(doc: DbSchemaDoc, slug: string, editing?: string): boolean {
  return slug !== editing && effectiveGroups(doc).some((g) => g.slug === slug)
}

/// `TaskflowProject` → `taskflow_project`: the field name a relation to that model gets.
export function fieldNameFor(model: string): string {
  return model.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
}

export type RelationKind = "many-to-one" | "one-to-one" | "many-to-many"

/// Add a relation from `from` to `to`. Many-to-one and one-to-one add a field
/// to `from` (unique for one-to-one). Many-to-many creates the join model
/// (`BlogTag`: `blog` → Blog, `tag` → Tag) in `from`'s group, and leaves both
/// models as they are. Returns the new document and what was added.
export function addRelation(doc: DbSchemaDoc, from: string, to: string, kind: RelationKind): { doc: DbSchemaDoc; added: { model: string; field?: string } } {
  const source = doc.models.find((m) => m.name === from)
  if (!source) return { doc, added: { model: from } }
  if (kind === "many-to-many") {
    let name = `${from}${to === from ? "Link" : to}`
    for (let n = 2; doc.models.some((m) => m.name === name); n++) name = `${from}${to}${n}`
    const a = fieldNameFor(from)
    const b = to === from ? `related_${a}` : fieldNameFor(to)
    const join: DbModel = {
      name,
      group: source.group,
      fields: [
        { name: "id", type: "i64", primary_key: true },
        { name: a, type: "fk", indexed: true, fk: { model: from, on_delete: "cascade" } },
        { name: b, type: "fk", indexed: true, fk: { model: to, on_delete: "cascade" } },
      ],
    }
    return { doc: { ...doc, models: [...doc.models, join] }, added: { model: name } }
  }
  const base = fieldNameFor(to)
  let field = base
  for (let n = 2; source.fields.some((f) => f.name === field); n++) field = `${base}_${n}`
  const f: DbField = { name: field, type: "fk", fk: { model: to, on_delete: "cascade" }, ...(kind === "one-to-one" ? { unique: true } : {}) }
  return {
    doc: { ...doc, models: doc.models.map((m) => (m.name === from ? { ...m, fields: [...m.fields, f] } : m)) },
    added: { model: from, field },
  }
}
