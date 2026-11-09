/// The models list's search (database.html's "Find a model or field"): a model
/// shows when its name, or any of its fields' names, contains the query.
import type { DbModel, DbSchemaDoc } from "@/lib/db-api"

export function matchModels(doc: DbSchemaDoc, query: string): DbModel[] {
  const q = query.trim().toLowerCase()
  if (!q) return doc.models
  return doc.models.filter((m) => m.name.toLowerCase().includes(q) || m.fields.some((f) => f.name.toLowerCase().includes(q)))
}
