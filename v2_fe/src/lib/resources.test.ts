import { describe, expect, it } from "vitest"

import {
  MAX_LINKS_PER_SET,
  MAX_SETS,
  MAX_SET_NAME,
  addSet,
  appendLinks,
  normalizeResources,
  parsePastedLinks,
  removeLink,
  removeSet,
  setNameProblem,
  toggleSet,
  type ResourceLink,
  type ResourcesDoc,
} from "./resources"

describe("normalizeResources", () => {
  it("returns an empty document for anything unusable", () => {
    for (const raw of [null, "nope", 7, {}, { sets: "nope" }]) {
      expect(normalizeResources(raw).sets).toEqual([])
    }
  })
  it("drops malformed sets but keeps valid ones", () => {
    const doc = normalizeResources({ version: 1, sets: [
      { id: "s1", name: "Inter", enabled: true, links: [{ rel: "preconnect", href: "https://a.example" }] },
      { name: "No id" }, "nonsense", null,
    ]})
    expect(doc.sets.map((s) => s.id)).toEqual(["s1"])
  })
  it("defaults enabled to true when absent", () => {
    const doc = normalizeResources({ sets: [{ id: "s1", name: "X", links: [] }] })
    expect(doc.sets[0].enabled).toBe(true)
  })

  // The wire contract, mirrored from `resources.rs`. Every field is always
  // serialised there, so `null` arrives for the optional ones; and `validate`
  // counts an EMPTY STRING as present, so a document that carried `script: null`
  // beside `href` would be refused with a message naming a cause the caller
  // never intended. Absence is therefore the only safe spelling — and it is a
  // shape rule, never a look at the url's own characters.
  it("drops the wire's nulls and blanks to absent fields, keeping each url in its own shape", () => {
    const doc = normalizeResources({ version: 2, sets: [
      { id: "s1", name: "Fonts", enabled: true, links: [
        { rel: null, href: "https://fonts.example/css2?family=Inter", crossorigin: true, script: null, isScript: false, isAsync: null },
        { rel: "preconnect", href: "https://stranded.example", crossorigin: null, script: "https://cdn.example/x.js", isScript: true, isAsync: true },
      ]},
    ]})
    expect(doc.version).toBe(2)
    const [link, script] = doc.sets[0].links
    // `toStrictEqual`, not `toEqual`: only this catches a key that is present
    // and undefined, which is the difference under test here.
    expect(link).toStrictEqual({ href: "https://fonts.example/css2?family=Inter", crossorigin: true, isScript: false, isAsync: false })
    expect(script).toStrictEqual({ script: "https://cdn.example/x.js", crossorigin: false, isScript: true, isAsync: true })
  })

  it("drops a link with no address, and a set with no id or no name", () => {
    const doc = normalizeResources({ sets: [
      { id: "s1", name: "A", links: [
        { rel: "stylesheet" }, { href: "" }, { href: "https://ok.example/x.css", isScript: false },
      ] },
      { id: "", name: "No id", links: [] },
      { id: "s2", name: "  ", links: [] },
      { id: "s3", name: "Not an array", links: "nope" },
    ]})
    expect(doc.sets.map((s) => s.id)).toEqual(["s1", "s3"])
    expect(doc.sets[0].links.map((l) => l.href)).toEqual(["https://ok.example/x.css"])
    expect(doc.sets[1].links).toEqual([])
  })

  it("treats only an explicit false as disabled", () => {
    const doc = normalizeResources({ sets: [
      { id: "s1", name: "A", enabled: false, links: [] },
      { id: "s2", name: "B", enabled: null, links: [] },
    ]})
    expect(doc.sets.map((s) => s.enabled)).toEqual([false, true])
  })
})

describe("set edits", () => {
  const base = normalizeResources({ version: 1, sets: [
    { id: "s1", name: "Inter", enabled: true,  links: [] },
    { id: "s2", name: "Analytics", enabled: false, links: [] },
  ]})

  it("toggleSet flips only the named set", () => {
    // Needs a second FALSE set, or this cannot fail. Written first against
    // `base` — where `s1` is already `true` — the assertions were "s2 became
    // true, s1 stayed true", which an implementation that forces EVERY set
    // enabled satisfies. The false pin is the half with teeth.
    const both = normalizeResources({ version: 1, sets: [
      { id: "s1", name: "Inter", enabled: false, links: [] },
      { id: "s2", name: "Analytics", enabled: false, links: [] },
    ]})
    const out = toggleSet(both, "s2")
    expect(out.sets.find((s) => s.id === "s2")!.enabled).toBe(true)
    expect(out.sets.find((s) => s.id === "s1")!.enabled).toBe(false)
  })

  // "Only the named set" is not the same claim as "s2 became true" — a toggle
  // that forced every set enabled would pass the test above, so pin the flip
  // in the other direction too.
  it("toggleSet flips a true set to false without touching its input", () => {
    const before = JSON.stringify(base)
    const out = toggleSet(base, "s1")
    expect(out).not.toBe(base)
    expect(out.sets.map((s) => [s.id, s.enabled])).toEqual([["s1", false], ["s2", false]])
    expect(JSON.stringify(base)).toBe(before)
  })

  it("toggleSet returns the same document for an unknown id, and never mutates", () => {
    const before = JSON.stringify(base)
    expect(toggleSet(base, "nope")).toBe(base)
    toggleSet(base, "s1")
    expect(JSON.stringify(base)).toBe(before)
  })

  it("addSet appends with a fresh id, and refuses a duplicate name", () => {
    const { doc, id } = addSet(base, "Display")
    expect(doc.sets).toHaveLength(3)
    expect(doc.sets[2].id).toBe(id)
    expect(doc.sets[2].enabled).toBe(true)
    // Refusal is by identity plus an empty id — the same contract createGroup
    // has, so the caller reads "nothing happened" the same way.
    const dup = addSet(doc, "  inter  ")
    expect(dup.doc).toBe(doc)
    expect(dup.id).toBe("")
  })

  it("addSet refuses a blank name", () => {
    expect(addSet(base, "   ").doc).toBe(base)
  })

  it("removeSet drops exactly one set", () => {
    const out = removeSet(base, "s1")
    expect(out.sets.map((s) => s.id)).toEqual(["s2"])
    expect(removeSet(base, "nope")).toBe(base)
  })

  // The server's caps, mirrored (see this task's Interfaces). Without these the
  // UI happily builds a document `resources::validate` refuses, and the user
  // meets the refusal at Save with no way to see which row caused it.
  it("addSet refuses at the set cap", () => {
    const full = normalizeResources({ version: 1, sets:
      Array.from({ length: MAX_SETS }, (_, i) => ({ id: `s${i}`, name: `S${i}`, enabled: true, links: [] })) })
    expect(addSet(full, "One more").doc).toBe(full)
    expect(addSet(full, "One more").id).toBe("")
  })

  it("addSet refuses a name past the server's limit", () => {
    expect(addSet(base, "x".repeat(MAX_SET_NAME + 1)).doc).toBe(base)
    expect(addSet(base, "x".repeat(MAX_SET_NAME)).doc).not.toBe(base)
  })

  // The server measures the name in `chars()`, i.e. code points. Measuring
  // UTF-16 units here would refuse a 60-emoji name the server accepts — a
  // refusal with no message anywhere, which is the failure mode the mirror
  // exists to prevent.
  it("addSet stores the trimmed name and counts the cap in characters", () => {
    const { doc, id } = addSet(base, "  Display  ")
    expect(doc.sets[2].name).toBe("Display")
    expect(doc.sets[2].id).toBe(id)
    expect(addSet(base, "🎨".repeat(MAX_SET_NAME)).doc).not.toBe(base)
    expect(addSet(base, "🎨".repeat(MAX_SET_NAME + 1)).doc).toBe(base)
  })

  it("appendLinks stops at the per-set cap and reports what it skipped", () => {
    const link = (href: string) => ({ rel: "stylesheet", href, crossorigin: false, isScript: false, isAsync: false })
    const full = normalizeResources({ version: 1, sets: [{ id: "s1", name: "X", enabled: true,
      links: Array.from({ length: MAX_LINKS_PER_SET }, () => link("https://a.example")) }] })
    const out = appendLinks(full, "s1", [link("https://b.example")])
    expect(out.added).toBe(0)
    expect(out.skipped).toBe(1)
    expect(out.doc).toBe(full)
    // With room it takes what fits and says so.
    const partial = appendLinks(base, "s1", [link("https://c.example"), link("https://d.example")])
    expect(partial.added).toBe(2)
    expect(partial.skipped).toBe(0)
    expect(partial.doc.sets.find((s) => s.id === "s1")!.links).toHaveLength(2)
  })

  it("appendLinks reports every link as skipped when the set is unknown", () => {
    const out = appendLinks(base, "nope", [
      { rel: "stylesheet", href: "https://a.example", crossorigin: false, isScript: false, isAsync: false },
    ])
    expect(out.doc).toBe(base)
    expect(out.added).toBe(0)
    expect(out.skipped).toBe(1)
  })

  // Filling from the tail would pass a count-only assertion while silently
  // reordering what the user pasted.
  it("appendLinks fills the remaining room from the front", () => {
    const link = (href: string) => ({ rel: "stylesheet", href, crossorigin: false, isScript: false, isAsync: false })
    const nearly = normalizeResources({ version: 1, sets: [{ id: "s1", name: "X", enabled: true,
      links: Array.from({ length: MAX_LINKS_PER_SET - 1 }, (_, i) => link(`https://a${i}.example`)) }] })
    const out = appendLinks(nearly, "s1", [link("https://first.example"), link("https://second.example")])
    expect(out.added).toBe(1)
    expect(out.skipped).toBe(1)
    expect(out.doc.sets[0].links).toHaveLength(MAX_LINKS_PER_SET)
    expect(out.doc.sets[0].links[MAX_LINKS_PER_SET - 1].href).toBe("https://first.example")
  })

  // MAX_HREF is deliberately NOT mirrored: the paste path must not drop or
  // truncate what the user pasted, because "a url is limited to 2048
  // characters" is a message they can act on. This test fails the day someone
  // adds the cap here "for symmetry".
  it("appendLinks does not judge a url — the server owns that refusal", () => {
    const long = `https://a.example/${"x".repeat(3000)}`
    const out = appendLinks(base, "s1", [
      { rel: "stylesheet", href: long, crossorigin: false, isScript: false, isAsync: false },
    ])
    expect(out.added).toBe(1)
    expect(out.doc.sets[0].links[0].href).toBe(long)
  })
})

// One bad link makes `resources::validate` refuse the WHOLE document, and the
// manifest then contributes nothing — so a single pasted `javascript:` url
// silently removes every font in the project. That refusal names the url, but
// without a way to remove the row the user's only fix is to delete the set and
// paste again. Hence a per-link remove, not just a per-set one.
describe("removeLink", () => {
  const doc = normalizeResources({ sets: [{ id: "s1", name: "X", enabled: true, links: [
    { href: "https://a.example", isScript: false },
    { href: "https://b.example", isScript: false },
    { href: "https://c.example", isScript: false },
  ]}]})

  it("drops exactly the addressed link and keeps the order of the rest", () => {
    const out = removeLink(doc, "s1", 1)
    expect(out.sets[0].links.map((l) => l.href)).toEqual(["https://a.example", "https://c.example"])
  })

  it("returns the same document for an unknown set or an index out of range", () => {
    expect(removeLink(doc, "nope", 0)).toBe(doc)
    expect(removeLink(doc, "s1", 3)).toBe(doc)
    expect(removeLink(doc, "s1", -1)).toBe(doc)
  })
})


// "Add set" that does nothing is the failure the caps mirror exists to prevent
// ("it appears to work, and the save then fails"), so the refusal has to say
// which rule it broke — from the same place that decides it.
describe("setNameProblem", () => {
  const base = normalizeResources({ version: 1, sets: [
    { id: "s1", name: "Inter", enabled: true, links: [] },
  ]})
  const full = normalizeResources({ version: 1, sets:
    Array.from({ length: MAX_SETS }, (_, i) => ({ id: `s${i}`, name: `S${i}`, enabled: true, links: [] })) })

  const cases: [ResourcesDoc, string][] = [
    [base, "Display"],
    [base, "   "],
    [base, "inter"],
    [base, "  Inter  "],
    [base, "x".repeat(MAX_SET_NAME)],
    [base, "x".repeat(MAX_SET_NAME + 1)],
    [base, "\u{1F3A8}".repeat(MAX_SET_NAME + 1)],
    [full, "One more"],
    [full, "s0"],
  ]

  // This table cannot fail unless `addSet`'s delegation to `setNameProblem` is
  // broken — it pins that the two AGREE, not the rules themselves (blank, cap
  // and duplicate are pinned by the tests above and by "names the rule that was
  // broken" below). It is kept because it is the only pin on the shared
  // predicate, and the two drifting apart is a refusal with no message anywhere.
  it("delegates to setNameProblem, so the refusal and its message cannot disagree", () => {
    for (const [doc, name] of cases) {
      expect([name, setNameProblem(doc, name) !== null]).toEqual([name, addSet(doc, name).id === ""])
    }
  })

  it("names the rule that was broken", () => {
    expect(setNameProblem(base, "   ")).toMatch(/name/i)
    expect(setNameProblem(base, "INTER")).toMatch(/already/i)
    expect(setNameProblem(base, "x".repeat(MAX_SET_NAME + 1))).toContain(String(MAX_SET_NAME))
    expect(setNameProblem(full, "One more")).toContain(String(MAX_SETS))
    expect(setNameProblem(base, "Display")).toBeNull()
  })
})

describe("parsePastedLinks", () => {
  it("parses the Google Fonts triple", () => {
    const links = parsePastedLinks(`
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">
    `)
    expect(links).toHaveLength(3)
    expect(links[1].crossorigin).toBe(true)
    expect(links[2].rel).toBe("stylesheet")
  })
  it("picks up a script tag, and carries NO href", () => {
    const [l] = parsePastedLinks('<script src="https://cdn.example/x.js" async></script>')
    expect(l.isScript).toBe(true)
    expect(l.script).toBe("https://cdn.example/x.js")
    // The wire contract, and the reason it is asserted rather than trusted:
    // the server refuses a link carrying BOTH url fields, and an EMPTY STRING
    // counts as carried (`""` is present, not absent). Emitting `href: ""`
    // beside a script would be refused with a message naming a cause the
    // caller never intended. Assert absence, not emptiness.
    expect(l.href).toBeUndefined()
    expect(l.rel).toBeUndefined()
  })

  // `toBeUndefined` passes for an omitted key AND for one present-and-undefined,
  // so it cannot pin the promise above on its own; `toStrictEqual` can. Also
  // the only place `isAsync` is pinned: `defer` must not set it.
  it("omits the url field belonging to the other shape, and pins the shape's own fields", () => {
    expect(parsePastedLinks('<script src="https://cdn.example/x.js" defer></script>')[0]).toStrictEqual({
      script: "https://cdn.example/x.js", crossorigin: false, isScript: true, isAsync: false,
    })
    expect(parsePastedLinks('<link rel="dns-prefetch" href="https://a.example">')[0]).toStrictEqual({
      rel: "dns-prefetch", href: "https://a.example", crossorigin: false, isScript: false, isAsync: false,
    })
  })

  it("a link shape carries NO script field, for the same reason", () => {
    const [l] = parsePastedLinks('<link rel="stylesheet" href="https://ok.example/x.css">')
    expect(l.isScript).toBe(false)
    expect(l.script).toBeUndefined()
  })
  it("ignores anything that is not a link or script", () => {
    expect(parsePastedLinks("<div>hello</div><p>rel=\"stylesheet\"</p>")).toEqual([])
  })
  it("does not reject unsafe urls itself — validation is the server's job", () => {
    // The client must not silently drop what the user pasted; the server
    // refuses it with a message the user can act on. Parse only.
    expect(parsePastedLinks('<link rel="stylesheet" href="javascript:alert(1)">')).toHaveLength(1)
  })

  // HTML allows unquoted values, bare attributes and any case for names, and a
  // hand-edited snippet is exactly what this box is for.
  it("reads unquoted and bare attributes, whatever the case", () => {
    const [l] = parsePastedLinks("<LINK REL=preconnect HREF=https://a.example crossorigin>")
    expect(l.rel).toBe("preconnect")
    expect(l.href).toBe("https://a.example")
    expect(l.crossorigin).toBe(true)
    expect(l.isScript).toBe(false)
  })

  // There is nowhere in the document shape to put inline code, and a link with
  // no address is refused by the server with a message about a row the user
  // cannot see — so a tag with no url is not a link at all.
  it("skips a tag that carries no url", () => {
    expect(parsePastedLinks("<script>console.log(1)</script>")).toEqual([])
    expect(parsePastedLinks('<link rel="stylesheet">')).toEqual([])
  })
})

// The paste path is the only way links enter a document, so it must go through
// `appendLinks`; this is the composition Step 3's box performs.
describe("pasted links into a set", () => {
  it("goes through the capped helper, reporting the cap it hit", () => {
    const parsed: ResourceLink[] = parsePastedLinks('<script src="https://cdn.example/x.js"></script>')
    const doc = normalizeResources({ version: 1, sets: [{ id: "s1", name: "X", enabled: true, links:
      Array.from({ length: MAX_LINKS_PER_SET }, (_, i) => ({ rel: "stylesheet", href: `https://a${i}.example`, crossorigin: false, isScript: false, isAsync: false })) }] })
    const out = appendLinks(doc, "s1", parsed)
    expect(out.added).toBe(0)
    expect(out.skipped).toBe(1)
    expect(out.doc).toBe(doc)
  })
})
