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
  // answer this query with nothing. The whole group comes back, and neither
  // `gap` nor `pad_x` carries "spac" in its key or its value, so the label is
  // the only thing that can have matched them.
  it("matches a category label by substring, not by equality", () => {
    const filtered = filterTokenCategories(tokensDoc(), "spac")
    expect(Object.keys(filtered.categories.spacing)).toEqual(["gap", "pad_x"])
    // `spac` is ALSO a substring of `ui-monospace`, the value of `font_mono` —
    // so this query legitimately lands on two categories now, and that second
    // one is the value rule rather than this one. The query is left as `spac`
    // on purpose: it is the one the near-miss test below says is the honest way
    // to find the Spacing group, so it is the one worth reading here.
    expect(Object.keys(filtered.categories)).toEqual(["spacing", "typography"])
    expect(Object.keys(filtered.categories.typography)).toEqual(["font_mono"])
  })

  // A BOUNDARY, deliberately, and it is asserted rather than dodged: "space"
  // is not a substring of the label "Spacing" (they part company at the fifth
  // character — `spac-e` vs `spac-ing`) and no non-fuzzy rule makes it one.
  // Reaching it would need stemming or fuzzy matching, which for a token
  // filter is over-engineering and would drag in pairs nobody asked for, so
  // the honest way to find the group is `spac` (the test above). If someone
  // ever makes the match fuzzy, THIS is the test that says a decision was
  // taken.
  it("does not find the Spacing group from `space` — a deliberate boundary", () => {
    const filtered = filterTokenCategories(tokensDoc(), "space")
    expect(filtered.categories.spacing).toBeUndefined()
    expect(Object.keys(filtered.categories)).not.toContain("spacing")
    // And what the query DOES find is the value rule working, not the
    // boundary leaking: `font_mono`'s value is `ui-monospace`, whose text
    // really does contain "space". A token whose value says the word is a
    // match under the rule; the Spacing group, which says `spacing`, is not.
    expect(Object.keys(filtered.categories)).toEqual(["typography"])
    expect(Object.keys(filtered.categories.typography)).toEqual(["font_mono"])
  })

  // The case the brief got wrong twice over. `inter` is in neither the key
  // `font_sans` nor the label `Typography` — it is in the token's VALUE
  // (`Inter, ui-sans-serif`), and this is the search a project with a Google
  // Fonts set actually performs: "which token uses Inter".
  it("finds a token by its value, not just by its key or category", () => {
    const filtered = filterTokenCategories(tokensDoc(), "inter")
    expect(Object.keys(filtered.categories)).toEqual(["typography"])
    expect(Object.keys(filtered.categories.typography)).toEqual(["font_sans"])
    expect(filtered.categories.typography.font_sans).toEqual({ light: "Inter, ui-sans-serif" })
  })

  // Values are literals and are typed in whatever case the user remembers:
  // the fixture's own value carries a capital `I` (`Inter`), so this fails if
  // the value side is lowercased and the query is not, or vice versa.
  it("matches a token value case-insensitively", () => {
    const filtered = filterTokenCategories(tokensDoc(), "INTER")
    expect(Object.keys(filtered.categories)).toEqual(["typography"])
    expect(Object.keys(filtered.categories.typography)).toEqual(["font_sans"])
  })

  // A value match is per-TOKEN, like a key match — it is the category LABEL
  // that keeps a whole group, and a value is not a label. `monospace` is in
  // `font_mono`'s value and nowhere else in the document, so a rule that kept
  // the category on any match, or that let a value match reach the other
  // categories, would answer this with every token in the file.
  it("does not leak a value match into another category, or the whole group", () => {
    const filtered = filterTokenCategories(tokensDoc(), "monospace")
    expect(Object.keys(filtered.categories)).toEqual(["typography"])
    expect(Object.keys(filtered.categories.typography)).toEqual(["font_mono"])
  })

  // The next thing a user tries: the colour they can see. Both halves of the
  // pair are searchable, so the full hex finds `accent` and so does a fragment
  // of its DARK value — `818cf8` appears in no key, no label and no light
  // value, so a filter that read only `light` would answer this with nothing.
  it("finds a colour token by its hex value, full and fragment", () => {
    const full = filterTokenCategories(tokensDoc(), "#6366f1")
    expect(Object.keys(full.categories)).toEqual(["colors"])
    expect(Object.keys(full.categories.colors)).toEqual(["accent"])

    const fragment = filterTokenCategories(tokensDoc(), "818cf8")
    expect(Object.keys(fragment.categories)).toEqual(["colors"])
    expect(Object.keys(fragment.categories.colors)).toEqual(["accent"])
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
