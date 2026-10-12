import { describe, expect, it } from "vitest"

import {
  answerBody,
  cancelBody,
  isCancelBody,
  missingRequired,
  parseQuestionSet,
  questionState,
  type QuestionSet,
} from "./structured-questions"
import type { AgentMessage } from "./workspace-view"

const SET_JSON = JSON.stringify({
  title: "Which direction should pricing take?",
  questions: [
    {
      key: "scope",
      label: "What should change?",
      type: "radio",
      required: true,
      allow_other: true,
      options: [
        { value: "buttons", label: "Buttons only" },
        { value: "hero", label: "Hero + buttons", description: "A bigger change" },
      ],
    },
    { key: "notes", label: "Anything else?", type: "text", multiline: true },
    { key: "due", label: "By when?", type: "date" },
  ],
  submit_label: "Send answers",
})

const set = (): QuestionSet => parseQuestionSet(SET_JSON)!

describe("parseQuestionSet", () => {
  it("parses the stored JSON string", () => {
    const parsed = set()
    expect(parsed.title).toBe("Which direction should pricing take?")
    expect(parsed.questions.map((q) => q.type)).toEqual(["radio", "text", "date"])
    expect(parsed.questions[0].options?.[1].description).toBe("A bigger change")
    expect(parsed.submitLabel).toBe("Send answers")
  })

  it("returns null rather than rendering a question it cannot understand", () => {
    expect(parseQuestionSet("{ not json")).toBeNull()
    expect(parseQuestionSet(JSON.stringify({ questions: [] }))).toBeNull()
    expect(parseQuestionSet(JSON.stringify({ questions: [{ key: "a", label: "A", type: "checkbox" }] }))).toBeNull()
    // A picker with nothing to pick is not a question either.
    expect(parseQuestionSet(JSON.stringify({ questions: [{ key: "a", label: "A", type: "radio" }] }))).toBeNull()
    expect(parseQuestionSet(null)).toBeNull()
  })

  it("accepts an object (a caller that already parsed it) as well as a string", () => {
    expect(parseQuestionSet(JSON.parse(SET_JSON))?.questions).toHaveLength(3)
  })
})

describe("missingRequired", () => {
  it("names the required questions left unanswered, by their label", () => {
    expect(missingRequired(set(), {})).toEqual(["What should change?"])
    expect(missingRequired(set(), { scope: "buttons" })).toEqual([])
    // Whitespace is not an answer.
    expect(missingRequired(set(), { scope: "   " })).toEqual(["What should change?"])
  })
})

describe("answerBody", () => {
  it("composes a plain-text answer an agent can read", () => {
    const body = answerBody(set(), { scope: "hero", notes: "softer corners", due: "2026-10-20" })
    expect(body).toBe(
      [
        "Answers to “Which direction should pricing take?”:",
        "- What should change? (scope): Hero + buttons",
        "- Anything else? (notes): softer corners",
        "- By when? (due): 2026-10-20",
      ].join("\n")
    )
  })

  it("keeps an 'other' answer as the text that was typed", () => {
    expect(answerBody(set(), { scope: "Terracotta, like the logo" })).toContain(
      "- What should change? (scope): Terracotta, like the logo"
    )
  })

  it("omits questions left blank and needs no title to work", () => {
    const untitled = parseQuestionSet(JSON.stringify({ questions: [{ key: "a", label: "Pick", type: "text" }] }))!
    expect(answerBody(untitled, { a: "x" })).toBe("Answers:\n- Pick (a): x")
    expect(answerBody(set(), {})).toBe("") // nothing answered → nothing to send
  })
})

describe("cancelBody", () => {
  it("says what was cancelled, in a prefix the chat can recognise", () => {
    const body = cancelBody(set())
    expect(body).toBe("Cancelled the question: “Which direction should pricing take?”.")
    expect(isCancelBody(body)).toBe(true)
    expect(isCancelBody("Answers to something else")).toBe(false)
  })
})

describe("questionState", () => {
  const message = (overrides: Partial<AgentMessage> & { id: string }): AgentMessage =>
    ({ from: "Claude", body: "", status: "posted", time: "", ...overrides }) as AgentMessage

  const question = message({ id: "10", questions: SET_JSON })

  it("is open while nothing answers it", () => {
    expect(questionState(question, [question])).toBe("open")
    expect(questionState(question, [question, message({ id: "11", from: "user" })])).toBe("open")
  })

  it("is answered by a reply to it", () => {
    const reply = message({ id: "11", from: "user", replyTo: { id: "10", from: "Claude", excerpt: "…" } })
    expect(questionState(question, [question, reply])).toBe("answered")
  })

  it("is cancelled by a reply that says so", () => {
    const cancel = message({
      id: "11",
      from: "user",
      body: cancelBody(set()),
      replyTo: { id: "10", from: "Claude", excerpt: "…" },
    })
    expect(questionState(question, [question, cancel])).toBe("cancelled")
  })

  it("ignores replies that point at other messages", () => {
    const reply = message({ id: "11", from: "user", replyTo: { id: "9", from: "Claude", excerpt: "…" } })
    expect(questionState(question, [question, reply])).toBe("open")
  })
})
