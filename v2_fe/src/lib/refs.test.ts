import { describe, expect, it } from "vitest"

import { formatRef, parseRefHref, refHref, splitRefs, type RefSegment } from "./refs"

const refs = (text: string) => splitRefs(text).filter((s): s is Extract<RefSegment, { type: "ref" }> => s.type === "ref")

describe("splitRefs: the typed tags", () => {
  it("reads each kind", () => {
    expect(refs("#TSK12 #MSG3456 #GHI7 #GHP44 #NOTE3").map((r) => [r.kind, r.id])).toEqual([
      ["task", 12],
      ["message", 3456],
      ["github-issue", 7],
      ["github-pr", 44],
      ["note", 3],
    ])
  })
  it("is case-insensitive and keeps the raw text", () => {
    expect(refs("see #tsk5")[0]).toEqual({ type: "ref", kind: "task", id: 5, repo: undefined, raw: "#tsk5" })
  })
  it("reads a repo qualifier on GitHub tags", () => {
    expect(refs("#GHI12@acme/api and #GHP3@a.b/c-d")).toMatchObject([
      { kind: "github-issue", id: 12, repo: "acme/api" },
      { kind: "github-pr", id: 3, repo: "a.b/c-d" },
    ])
  })
  it("keeps surrounding text in order", () => {
    expect(splitRefs("Fix #TSK1, then #MSG2.")).toEqual([
      { type: "text", value: "Fix " },
      { type: "ref", kind: "task", id: 1, repo: undefined, raw: "#TSK1" },
      { type: "text", value: ", then " },
      { type: "ref", kind: "message", id: 2, repo: undefined, raw: "#MSG2" },
      { type: "text", value: "." },
    ])
  })
})

describe("splitRefs: punctuation after a repo qualifier", () => {
  it("leaves a sentence-ending period as text", () => {
    expect(splitRefs("see #GHI12@acme/app. and")).toEqual([
      { type: "text", value: "see " },
      { type: "ref", kind: "github-issue", id: 12, repo: "acme/app", raw: "#GHI12@acme/app" },
      { type: "text", value: ". and" },
    ])
  })
  it("leaves a trailing comma as text", () => {
    expect(refs("#GHP3@acme/app, then")).toMatchObject([{ kind: "github-pr", id: 3, repo: "acme/app", raw: "#GHP3@acme/app" }])
  })
  it("keeps dots inside a name", () => {
    expect(refs("#GHI1@a.b/c.d")).toMatchObject([{ repo: "a.b/c.d" }])
  })
})

describe("splitRefs: what is NOT a reference", () => {
  it("leaves a bare #123 as plain text", () => {
    expect(splitRefs("the #1 priority, see #886")).toEqual([{ type: "text", value: "the #1 priority, see #886" }])
  })
  it("ignores tags glued to a word or a path, and trailing letters", () => {
    expect(refs("abc#TSK1 /x/#MSG2 #TSK12abc")).toEqual([])
  })
  it("needs a number", () => {
    expect(refs("#TSK #MSG #GHI")).toEqual([])
  })
  it("gives [] for empty input", () => {
    expect(splitRefs("")).toEqual([])
  })
})

describe("splitRefs: legacy forms still resolve", () => {
  it("TASK#12", () => expect(refs("TASK#12")).toMatchObject([{ kind: "task", id: 12 }]))
  it("task#12 (any case)", () => expect(refs("task#12")).toMatchObject([{ kind: "task", id: 12 }]))
  it("#gh12", () => expect(refs("#gh12")).toMatchObject([{ kind: "github-issue", id: 12, repo: undefined }]))
  it("#GH12", () => expect(refs("#GH12")).toMatchObject([{ kind: "github-issue", id: 12 }]))
  it("owner/repo#gh12", () => expect(refs("acme/api#gh12")).toMatchObject([{ kind: "github-issue", id: 12, repo: "acme/api" }]))
  it("#msg12 and #MSG12 are the same", () => {
    expect(refs("#msg12 #MSG12").map((r) => [r.kind, r.id])).toEqual([
      ["message", 12],
      ["message", 12],
    ])
  })
})

describe("formatRef / refHref round trip", () => {
  it("formats canonically", () => {
    expect(formatRef({ kind: "github-pr", id: 4, repo: "acme/api" })).toBe("#GHP4@acme/api")
    expect(formatRef({ kind: "task", id: 9 })).toBe("#TSK9")
  })
  it("encodes and decodes a link fragment", () => {
    for (const r of [
      { kind: "task", id: 1 },
      { kind: "github-issue", id: 2, repo: "acme/api" },
      { kind: "note", id: 3 },
    ] as const) {
      expect(parseRefHref(refHref(r))).toEqual({ ...r, repo: "repo" in r ? r.repo : undefined })
    }
    expect(parseRefHref("#task-1")).toBeNull()
    expect(parseRefHref(undefined)).toBeNull()
  })
})
