/// #644: structured questions — the pure half.
///
/// A message may carry a question set (radio, select, text, date) that the chat
/// renders as a form. The ANSWERS are ordinary messages (the owner's decision:
/// no new transport), so everything here is about the two conversions that
/// carry no infrastructure with them: what a set means to the UI, and how an
/// answer or a cancellation is written back as prose.

import type { AgentMessage } from "./workspace-view"

export type QuestionKind = "radio" | "select" | "text" | "date"

export type QuestionOption = { value: string; label: string; description?: string }

export type StructuredQuestion = {
  key: string
  label: string
  type: QuestionKind
  options: QuestionOption[]
  /// Pickers only: an "Other…" free-text choice beside the options.
  allowOther: boolean
  required: boolean
  placeholder?: string
  multiline: boolean
}

export type QuestionSet = {
  title?: string
  questions: StructuredQuestion[]
  submitLabel?: string
  cancelLabel?: string
}

/// Prefix of the cancellation message, so the chat can tell a cancelled
/// question from an answered one. The agent reads the same sentence.
export const CANCEL_PREFIX = "Cancelled the question:"

/// Parse what the row stores (a JSON string, per the backend's shape) — or an
/// already-parsed object. Returns null when the payload cannot be rendered:
/// the bubble then shows that a question could not be read rather than a
/// broken form. Tolerant of unknown fields, strict about the ones it renders.
export function parseQuestionSet(raw: unknown): QuestionSet | null {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const rawQuestions = record.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null

  const questions: StructuredQuestion[] = []
  for (const entry of rawQuestions) {
    if (!entry || typeof entry !== "object") return null
    const question = entry as Record<string, unknown>
    const key = typeof question.key === "string" ? question.key.trim() : ""
    const label = typeof question.label === "string" ? question.label.trim() : ""
    const type = question.type
    if (!key || !label) return null
    if (type !== "radio" && type !== "select" && type !== "text" && type !== "date") return null

    const options: QuestionOption[] = []
    if (type === "radio" || type === "select") {
      if (!Array.isArray(question.options)) return null
      for (const rawOption of question.options) {
        if (!rawOption || typeof rawOption !== "object") return null
        const option = rawOption as Record<string, unknown>
        if (typeof option.value !== "string" || typeof option.label !== "string") return null
        options.push({
          value: option.value,
          label: option.label,
          description: typeof option.description === "string" ? option.description : undefined,
        })
      }
      if (options.length < 2) return null
    }
    questions.push({
      key,
      label,
      type,
      options,
      allowOther: question.allow_other === true && options.length > 0,
      required: question.required === true,
      placeholder: typeof question.placeholder === "string" ? question.placeholder : undefined,
      multiline: question.multiline === true,
    })
  }

  return {
    title: typeof record.title === "string" ? record.title : undefined,
    questions,
    submitLabel: typeof record.submit_label === "string" ? record.submit_label : undefined,
    cancelLabel: typeof record.cancel_label === "string" ? record.cancel_label : undefined,
  }
}

/// The required questions still unanswered — the dialog refuses to submit while
/// this is non-empty, so an agent never gets an answer that skips what it
/// marked required.
export function missingRequired(set: QuestionSet, answers: Record<string, string>): string[] {
  return set.questions
    .filter((question) => question.required && !(answers[question.key] ?? "").trim())
    .map((question) => question.label)
}

/// The reply message body for a set of answers: prose an agent reads, with the
/// question's key in parentheses so a machine can match it to what it asked.
/// Unanswered (optional) questions are omitted; nothing answered → empty
/// string, and the caller sends nothing.
export function answerBody(set: QuestionSet, answers: Record<string, string>): string {
  const lines: string[] = []
  for (const question of set.questions) {
    const answer = (answers[question.key] ?? "").trim()
    if (!answer) continue
    const shown = question.type === "radio" || question.type === "select"
      ? (question.options.find((option) => option.value === answer)?.label ?? answer)
      : answer
    lines.push(`- ${question.label} (${question.key}): ${shown}`)
  }
  if (!lines.length) return ""
  const heading = set.title ? `Answers to “${set.title}”:` : "Answers:"
  return [heading, ...lines].join("\n")
}

/// What the cancel button sends. A plain sentence, as the owner asked ("an
/// agent receives a message like 'the query was cancelled'") — and, because the
/// chat has to know too, one with a stable opening.
export function cancelBody(set: QuestionSet): string {
  return set.title
    ? `${CANCEL_PREFIX} “${set.title}”.`
    : `${CANCEL_PREFIX} the one you sent.`
}

export function isCancelBody(body: string): boolean {
  return body.trimStart().startsWith(CANCEL_PREFIX)
}

export type QuestionState = "open" | "answered" | "cancelled"

/// A question's state, derived from the thread itself — no extra field, no
/// extra write (the owner's "no new infra"): a reply to the question message
/// answers it, and one that opens with the cancel sentence cancels it.
export function questionState(question: AgentMessage, messages: AgentMessage[]): QuestionState {
  for (const message of messages) {
    if (message.replyTo?.id !== question.id) continue
    return isCancelBody(message.body) ? "cancelled" : "answered"
  }
  return "open"
}
