import { describe, expect, it } from "vitest"

import { MAX_LINKS_PER_SET, normalizeResources, type ResourceLink } from "@/lib/resources"
import { pasteIntoSet, refusalErrors } from "./resource-editor"

// The repo tests the pure helpers a component exports, not the rendered
// component (`token-editor.test.ts` does the same for `parseSizeValue`). These
// two are the editor's decisions that a user SEES: what the paste box says
// afterwards, and whether a refused save says anything at all.

const link = (href: string): ResourceLink => ({
  rel: "stylesheet",
  href,
  crossorigin: false,
  isScript: false,
  isAsync: false,
})

const empty = normalizeResources({
  version: 1,
  sets: [{ id: "s1", name: "Inter", enabled: true, links: [] }],
})

const full = normalizeResources({
  version: 1,
  sets: [
    {
      id: "s1",
      name: "Inter",
      enabled: true,
      links: Array.from({ length: MAX_LINKS_PER_SET }, (_, i) => link(`https://a${i}.example`)),
    },
  ],
})

describe("pasteIntoSet", () => {
  it("appends the pasted tags and reports how many landed", () => {
    const { doc, outcome } = pasteIntoSet(empty, "s1", '<link rel="stylesheet" href="https://b.example/x.css">')
    expect(doc.sets[0].links.map((l) => l.href)).toEqual(["https://b.example/x.css"])
    expect(outcome).toEqual({ message: "Added 1 link.", warn: false })
  })

  it("caps the set and says what the cap turned away", () => {
    const text = Array.from({ length: MAX_LINKS_PER_SET + 1 }, (_, i) => `<link href="https://b${i}.example">`).join("\n")
    const { doc, outcome } = pasteIntoSet(empty, "s1", text)
    expect(doc.sets[0].links).toHaveLength(MAX_LINKS_PER_SET)
    expect(outcome.warn).toBe(true)
    expect(outcome.message).toContain(String(MAX_LINKS_PER_SET))
  })

  it("says nothing was pasted when the text carries no tag with a url", () => {
    const { doc, outcome } = pasteIntoSet(empty, "s1", "just some words")
    expect(doc).toBe(empty)
    expect(outcome.warn).toBe(true)
    expect(outcome.message).toMatch(/no <link>/i)
  })

  // `appendLinks` answers `added: 0` for two different reasons — a full set and
  // an id that is not in the document — so the message cannot be written from
  // `added` alone. Unreachable today (the box belongs to a rendered row), which
  // is exactly why it is worth pinning: the wrong message would otherwise be
  // shipped by the first caller that ever passes a stale id.
  it("says the set is gone, NOT that it is at the limit, for an unknown id", () => {
    const { doc, outcome } = pasteIntoSet(empty, "nope", '<link href="https://b.example">')
    expect(doc).toBe(empty)
    expect(outcome.warn).toBe(true)
    expect(outcome.message).toMatch(/no longer/i)
    expect(outcome.message).not.toMatch(/limit/i)

    // The two causes must not produce the same sentence.
    const capped = pasteIntoSet(full, "s1", '<link href="https://b.example">')
    expect(capped.outcome.message).not.toBe(outcome.message)
  })
})

describe("refusalErrors", () => {
  it("hands the validator's own messages straight back", () => {
    const errors = [{ line: 3, rule: "resources", message: '"javascript:alert(1)" is not an https address' }]
    expect(refusalErrors(errors)).toBe(errors)
  })

  // A refusal the user cannot see is the failure class this phase exists to
  // remove, and an EMPTY error list renders as nothing at all (the editor's
  // block is `errors?.length ? … : null`). Nothing today sends a refusal with
  // no detail; that is not a reason to render one as a save that did nothing.
  it("still says something when a refusal arrives with no detail", () => {
    const out = refusalErrors([])
    expect(out).toHaveLength(1)
    expect(out[0].message).toMatch(/refused/i)
    expect(out[0].line).toBe(0)
  })
})
