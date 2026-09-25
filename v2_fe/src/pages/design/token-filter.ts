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

/// A token's own VALUE, as a search surface: both halves of its light/dark
/// pair. This is the surface a user reaches for by *reading* — `inter` for the
/// font stack they pasted in, `#6366f1` for the colour they can see — and it is
/// the one that is nowhere in the key the token is filed under (`font_sans`
/// says nothing about Inter). A token with no dark override has only the one
/// string, so `dark` is checked only when it is there.
///
/// The parameter is `unknown` rather than the two optional strings it used to
/// be, because that type described what `DesignTokensDoc` PROMISES and nothing
/// checks the promise: the document arrives as
/// `JSON.parse(row.content) as DesignTokensDoc` (`design-api.ts`), so this is
/// handed whatever a hand-edited `styles/tokens.json` held. A half that is not a
/// string contributes nothing to the match, and a value that is not an object
/// matches nothing at all — the same rule as a missing half's empty string,
/// which cannot match either (the caller has already returned for a needle that
/// trims to nothing). Both shapes are TypeErrors otherwise — `value.light` on
/// `null`, and `.toLowerCase()` on a number — thrown from the search box's own
/// filter, which takes the panel down instead of narrowing it.
///
/// This file's promise is narrow and is the whole of it: the SEARCH does not
/// throw. The editor reads these same halves and still will — `token-editor.tsx`
/// reads `value.light` on the token — so a `{"accent": null}` document is not
/// usable either way; the difference is that searching it no longer crashes the
/// panel showing it.
function valueMatches(value: unknown, needle: string): boolean {
  if (typeof value !== "object" || value === null) return false
  const { light, dark } = value as { light?: unknown; dark?: unknown }
  return halfMatches(light, needle) || halfMatches(dark, needle)
}

/// One half of a token's value, as a search surface: its lowercased text, or
/// `""` for a half that is absent, `null`, or not a string at all.
function halfMatches(half: unknown, needle: string): boolean {
  return (typeof half === "string" ? half.toLowerCase() : "").includes(needle)
}

/// The document narrowed to the tokens a query asks for: a case-insensitive
/// substring match over the token's key, over its category's label, and over
/// the token's own value. So `spac` finds `pad_x` and `gap` (their label says
/// "Spacing" — it also finds `font_mono`, whose value `ui-monospace` contains
/// it), `accent` finds `accent` and `accent_soft` and nothing else, and `inter`
/// finds the typography token whose value is `Inter, ui-sans-serif` — which is
/// the search a project that has added a Google Fonts set actually performs:
/// which token uses the font I pasted in.
///
/// The three surfaces are not equal in what they keep. A key match and a value
/// match keep the ONE token that matched; only a label match keeps the whole
/// group, because a user searching "spacing" wants the spacing tokens, whose
/// keys and values say nothing about spacing.
///
/// Substring is the whole rule, and it is narrow on purpose: the label
/// "Spacing" is found by `spac`, `paci`, `spacing` — but NOT by `space`, which
/// is not a substring of it (the two part company at the fifth character).
/// Bridging that near-miss needs stemming or fuzzy matching, which would also
/// pull in query/token pairs nobody asked for, so it is not done here. The
/// boundary is a decision rather than drift, and `token-filter.test.ts`
/// asserts it so the next person does not rediscover it as a bug.
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
    // The category's own value is the same cast one level up, and the guard is
    // the same rule: `{"colors": null}` is a document the reader cannot render,
    // and `Object.entries(null)` would throw here rather than let the search
    // narrow — a category with nothing readable in it is simply not a search
    // result, exactly like the empty group below.
    const raw: unknown = tokens
    const entries = typeof raw === "object" && raw !== null ? Object.entries(raw) : []
    // A label match keeps the whole group — a user searching "spacing" wants
    // the spacing tokens, whose keys say nothing about spacing. A key match
    // keeps only the keys that matched, and a value match only the token whose
    // value matched (see `valueMatches`).
    const labelMatches = categoryLabel(category).toLowerCase().includes(needle)
    const kept = entries.filter(
      ([key, value]) =>
        labelMatches || key.toLowerCase().includes(needle) || valueMatches(value, needle)
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
