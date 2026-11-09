/// Sample-row cells (#885): typed back from the text a person types.

import type { DbField } from "@/lib/db-api"

/// Parse a cell's text back into the field's type. Pure, for tests.
export function parseCell(field: DbField, text: string): unknown {
  if (text === "") return field.optional ? null : ""
  if (field.type === "i64" || field.type === "f64") {
    const n = Number(text)
    return Number.isFinite(n) ? n : text
  }
  if (field.type === "bool") return text === "true"
  if (field.type === "Json") {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}
