import { describe, expect, it } from "vitest"

import type { DesignTokensDoc } from "@/lib/design-api"
import { filterTokenCategories } from "./token-filter"

// The screen under test is the Tokens panel's search box. What it can get
// wrong is silent in every case: a query that matches nothing but shows
// everything reads as "the search does nothing"; a query whose match vanished
// reads as "that token does not exist"; and a filter that narrows the document
// it was handed deletes every hidden token on the next Save, because the panel
// saves `doc` and draws `view`. None of the three throws.
//
// So the fixture below is the FILE, deliberately: the document as
// `fetchDesignTokens` hands it over — `JSON.parse(row.content)` of
// `styles/tokens.json`, cast at that one boundary exactly as the reader casts
// it (`design-api.ts:298`). A hand-typed `DesignTokensDoc` literal could only
// agree with the type under test, so it could never show a filter reading a
// spelling the file does not carry. The shape is the backend's own
// (`tokens.rs:120-125`: a version counter plus category → key → {light,
// dark?}, `dark` omitted when a token has no dark override).
const RAW_DOC = `{
  "version": 7,
  "categories": {
    "colors": {
      "accent": { "light": "#6366f1", "dark": "#818cf8" },
      "accent_soft": { "light": "#eef2ff" },
      "border": { "light": "#e5e7eb" }
    },
    "spacing": {
      "gap": { "light": "4px" },
      "pad_x": { "light": "12px", "dark": "16px" }
    },
    "radius": {},
    "typography": {
      "font_sans": { "light": "Inter, ui-sans-serif" },
      "font_mono": { "light": "ui-monospace" }
    },
    "brand": {
      "ink": { "light": "#111111" }
    }
  }
}`

/// A fresh copy per test, so nothing one test does to a document can reach
/// another — and so the mutation test below has something to compare against.
const tokensDoc = () => JSON.parse(RAW_DOC) as DesignTokensDoc

describe("filterTokenCategories", () => {
  // "No filter" has to mean the UNFILTERED panel, empty groups included: the
  // panel draws every category in its fixed order whether or not it has
  // tokens, and that is how a brand-new project gets its first spacing token —
  // through the add form of an empty group. A filter that dropped `radius`
  // here would take that form away.
  it("keeps the whole document for an empty query", () => {
    const filtered = filterTokenCategories(tokensDoc(), "")
    expect(Object.keys(filtered.categories)).toEqual([
      "colors",
      "spacing",
      "radius",
      "typography",
      "brand",
    ])
    expect(filtered.version).toBe(7)
  })

  // The whitespace case is the one a reader hits by accident: a stray space
  // typed or pasted into the box. Matching that literally matches no key and
  // no label, so the panel would blank itself while the box looks empty.
  it("keeps the whole document for a whitespace-only query", () => {
    const filtered = filterTokenCategories(tokensDoc(), "   ")
    expect(Object.keys(filtered.categories)).toEqual([
      "colors",
      "spacing",
      "radius",
      "typography",
      "brand",
    ])
  })

  // A key match narrows to the keys that matched — every one of them, and
  // nothing else in that category or any other. Keeping the whole `colors`
  // category here would answer a search for one token with three.
  it("keeps every token whose key matches, and drops the rest of the category", () => {
    const filtered = filterTokenCategories(tokensDoc(), "accent")
    expect(Object.keys(filtered.categories)).toEqual(["colors"])
    expect(Object.keys(filtered.categories.colors)).toEqual(["accent", "accent_soft"])
    expect(filtered.categories.colors.accent).toEqual({ light: "#6366f1", dark: "#818cf8" })
  })

  it("matches a token key case-insensitively", () => {
    const filtered = filterTokenCategories(tokensDoc(), "FONT_SANS")
    expect(Object.keys(filtered.categories)).toEqual(["typography"])
    expect(Object.keys(filtered.categories.typography)).toEqual(["font_sans"])
  })

  // The category label is a search surface too, and a match on it keeps the
  // whole group: `gap` and `pad_x` carry no "spacing" in their keys, so
  // searching keys alone would empty the category the user was looking for.
  it("keeps a whole category when the query matches its label", () => {
    const filtered = filterTokenCategories(tokensDoc(), "spacing")
    expect(Object.keys(filtered.categories)).toEqual(["spacing"])
    expect(Object.keys(filtered.categories.spacing)).toEqual(["gap", "pad_x"])
  })

  // Substring, not equality: "spac" is a user mid-word, "Spacing" is what the
  // label says. An equality test — or a `startsWith` on the whole label — would
  // answer this query with nothing.
  it("matches a category label by substring, not by equality", () => {
    const filtered = filterTokenCategories(tokensDoc(), "spac")
    expect(Object.keys(filtered.categories)).toEqual(["spacing"])
    expect(Object.keys(filtered.categories.spacing)).toEqual(["gap", "pad_x"])
  })

  // The near-miss, pinned because the plan promised the opposite: task-17's
  // brief says "`space` finds every spacing token", and it cannot — "space" is
  // not a substring of "spacing" (they part company at the fifth character,
  // `spac-e` vs `spac-ing`), and no non-fuzzy rule makes it one. This does NOT
  // mean the search is broken: `spac` above finds it, and the panel draws its
  // nothing-matched line naming the query, so a dead query is legible rather
  // than blank. If the rule is ever meant to bridge near-misses, it is the
  // matching rule that has to change (stemming/fuzzy), and this test is the
  // one that will say so.
  it("answers nothing for a near-miss of a category label", () => {
    expect(filterTokenCategories(tokensDoc(), "space").categories).toEqual({})
  })

  it("matches a category label case-insensitively", () => {
    const filtered = filterTokenCategories(tokensDoc(), "TYPO")
    expect(Object.keys(filtered.categories)).toEqual(["typography"])
    expect(Object.keys(filtered.categories.typography)).toEqual(["font_sans", "font_mono"])
  })

  // Categories outside the known six are legal in the document and are drawn
  // by their raw key (`CATEGORY_LABELS` has no entry for them). They have to
  // stay searchable — a label lookup without the `?? category` fallback is
  // either a throw or, worse, a category that renders but cannot be found.
  it("matches a category the panel has no label for, by its own key", () => {
    const filtered = filterTokenCategories(tokensDoc(), "brand")
    expect(Object.keys(filtered.categories)).toEqual(["brand"])
    expect(Object.keys(filtered.categories.brand)).toEqual(["ink"])
  })

  // Nothing matched: an empty map, not the document back. Returning the whole
  // document would make a query that found nothing look like a query that was
  // never applied, and returning every category with an empty map would fill
  // the panel with "No colors tokens yet." — which is false, and the panel has
  // its own nothing-matched line to draw instead.
  it("returns no categories at all when nothing matches", () => {
    const filtered = filterTokenCategories(tokensDoc(), "zzz")
    expect(filtered.categories).toEqual({})
    expect(filtered.version).toBe(7)
  })

  // A label match on a group that has no tokens is not a search result: the
  // panel would draw the empty group and its "No radius tokens yet." line
  // under a query that matched nothing anybody can see.
  it("keeps a category out when the query only matches an empty one", () => {
    expect(filterTokenCategories(tokensDoc(), "radius").categories).toEqual({})
  })

  // The data-loss one. The panel saves `doc` and draws the filtered view, so a
  // filter that narrows its input in place — rather than building a new
  // document — leaves the hidden tokens one Save away from being deleted from
  // `styles/tokens.json`. The first assertion proves the call narrowed
  // something; the rest prove it narrowed a copy.
  it("leaves the document it was handed untouched", () => {
    const doc = tokensDoc()
    const filtered = filterTokenCategories(doc, "accent")
    expect(Object.keys(filtered.categories.colors)).toEqual(["accent", "accent_soft"])
    expect(Object.keys(doc.categories.colors)).toEqual(["accent", "accent_soft", "border"])
    expect(Object.keys(doc.categories)).toEqual([
      "colors",
      "spacing",
      "radius",
      "typography",
      "brand",
    ])
    expect(doc.categories.spacing.pad_x).toEqual({ light: "12px", dark: "16px" })
  })
})
