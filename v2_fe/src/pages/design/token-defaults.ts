import type { DesignTokensDoc } from "@/lib/design-api"

type TokenValue = { light: string; dark?: string }

/// The built-in shadcn defaults to show (muted, "default") under `category`:
/// the server's `missing` list minus anything the user has since added locally
/// in this unsaved editor session.
export function defaultRows(
  missing: DesignTokensDoc,
  doc: DesignTokensDoc,
  category: string
): [string, TokenValue][] {
  const own = doc.categories[category] ?? {}
  return Object.entries(missing.categories[category] ?? {}).filter(([key]) => own[key] === undefined)
}
