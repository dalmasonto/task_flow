/// The Tokens panel's category vocabulary, and the search box's filter.
///
/// A module rather than exports from `token-editor.tsx`, for the reason
/// `design-comments.ts` gives: a `.tsx` that exports non-components costs a
/// `react-refresh/only-export-components` error apiece, and this round holds
/// the repo's lint baseline fixed. `CATEGORY_LABELS` moved here with the filter
/// because the labels are a search surface — the list and the search must agree
/// on what a category is called, so there is one definition and not two.

import type { DesignTokensDoc } from "@/lib/design-api"

/// Mirrors the backend's `KNOWN_CATEGORIES` (taskflow-design/src/tokens.rs:30).
/// Rendered in this fixed order (even when empty) so the editor's shape is
/// stable regardless of which categories a project has actually populated —
/// and so an empty group still offers its add-token form.
export const CATEGORY_ORDER = ["colors", "spacing", "radius", "typography", "shadows", "custom"]

const CATEGORY_LABELS: Record<string, string> = {
  colors: "Colors",
  spacing: "Spacing",
  radius: "Radius",
  typography: "Typography",
  shadows: "Shadows",
  custom: "Custom",
}

/// What a category is called on screen. A category the backend allows but this
/// table predates is drawn by its raw key, which is also what it is searched
/// by — see `filterTokenCategories`.
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

/// The document narrowed to the tokens a query asks for: a case-insensitive
/// substring match over the token's key AND over its category's label, so
/// `spac` finds `pad_x` and `gap` (their label says "Spacing") and `accent`
/// finds `accent` and `accent_soft` and nothing else.
///
/// Substring is the whole rule, and it is narrow on purpose: the label
/// "Spacing" is found by `spac`, `paci`, `spacing` — but NOT by `space`, which
/// is not a substring of it (the two part company at the fifth character).
/// Bridging that near-miss needs stemming or fuzzy matching, which would also
/// pull in query/token pairs nobody asked for, so it is not done here.
///
/// Three things this owes its caller, all of them the difference between a
/// search box and a bug:
///
/// * An empty or whitespace-only query returns the document UNCHANGED. A stray
///   space must not blank the panel.
/// * A query that matches nothing returns an empty `categories`, not the
///   document: the caller draws its own nothing-matched line, and handing back
///   everything would make a dead query look like an unapplied one.
/// * The document handed in is never touched. The build below is a copy — this
///   is the whole point. The panel draws the filtered view but SAVES `doc`, so
///   a filter that narrowed `doc` in place would write every hidden token out
///   of `styles/tokens.json` on the next Save. That is data loss, and it is one
///   `delete` away at all times.
export function filterTokenCategories(doc: DesignTokensDoc, query: string): DesignTokensDoc {
  const needle = query.trim().toLowerCase()
  if (!needle) return doc

  const categories: DesignTokensDoc["categories"] = {}
  for (const [category, tokens] of Object.entries(doc.categories)) {
    // A label match keeps the whole group — a user searching "spacing" wants
    // the spacing tokens, whose keys say nothing about spacing. A key match
    // keeps only the keys that matched.
    const labelMatches = categoryLabel(category).toLowerCase().includes(needle)
    const kept = Object.entries(tokens).filter(
      ([key]) => labelMatches || key.toLowerCase().includes(needle)
    )
    // A group with nothing left in it is not a search result: the caller draws
    // a group per category it is given, and an empty one would answer a query
    // with "No colors tokens yet." — which is both false and a dead end.
    if (!kept.length) continue
    categories[category] = Object.fromEntries(kept)
  }
  // `version` travels with the document: it is part of the file's content
  // (`putDesignTokens` writes `JSON.stringify(doc)`), so a filter that dropped
  // it would have the next Save reset the file's own counter.
  return { ...doc, categories }
}
