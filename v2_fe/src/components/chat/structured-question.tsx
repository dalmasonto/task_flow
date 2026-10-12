/// #644: a message's structured question set, rendered.
///
/// The bubble carries a compact CARD (what was asked, and whether it still
/// needs an answer); the DIALOG is the form itself — radio cards, a select,
/// text and date inputs — and its two exits are ordinary messages: the answers,
/// or a cancellation sentence the agent reads.

import * as React from "react"
import { CalendarIcon, CheckIcon, CircleHelpIcon, SendIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  answerBody,
  missingRequired,
  parseQuestionSet,
  type QuestionSet,
  type StructuredQuestion,
} from "@/lib/structured-questions"
import { cn } from "@/lib/utils"

/// The red marker the owner asked for: pulsing while an answer is owed. Two
/// sizes — the card's small one, and the floating action button's.
export function QuestionBeacon({ className, size = "sm" }: { className?: string; size?: "sm" | "lg" }) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)} aria-hidden>
      <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/60")} />
      <span
        className={cn(
          "relative inline-flex items-center justify-center rounded-full bg-red-500 text-white",
          size === "sm" ? "size-4" : "size-6"
        )}
      >
        <CircleHelpIcon className={size === "sm" ? "size-3" : "size-4"} />
      </span>
    </span>
  )
}

/// What the bubble shows for a message carrying questions. `state` is derived
/// by the thread (`questionState`); an answered or cancelled set is a record,
/// not an ask, and stops demanding attention.
export function QuestionCard({
  raw,
  state,
  onOpen,
  compact = false,
}: {
  raw: string
  state: "open" | "answered" | "cancelled"
  onOpen: (set: QuestionSet) => void
  compact?: boolean
}) {
  const set = React.useMemo(() => parseQuestionSet(raw), [raw])
  if (!set) {
    return (
      <div className="rounded-lg border border-amber-300/70 bg-amber-50/60 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        This message carries a question form this client could not read.
      </div>
    )
  }
  const required = set.questions.filter((question) => question.required).length
  return (
    <div
      className={cn(
        "rounded-xl border bg-background/70",
        state === "open" ? "border-red-300/80 dark:border-red-500/40" : "border-border",
        compact ? "p-2" : "p-3"
      )}
    >
      <div className="flex items-start gap-2">
        {state === "open" ? <QuestionBeacon className="mt-0.5" /> : null}
        {state === "answered" ? <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : null}
        {state === "cancelled" ? <XIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
        <div className="min-w-0 flex-1">
          <p className={cn("font-medium", compact ? "text-xs" : "text-sm")}>
            {set.title ?? "A few quick questions"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {set.questions.length} question{set.questions.length === 1 ? "" : "s"}
            {required ? ` · ${required} required` : ""}
            {state === "answered" ? " · answered" : state === "cancelled" ? " · cancelled" : ""}
          </p>
        </div>
        {state === "open" ? (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => onOpen(set)}>
            Answer
          </Button>
        ) : null}
      </div>
      {/* The questions themselves, so the thread says what was asked even
          before the dialog is opened. */}
      <ul className={cn("mt-2 space-y-0.5 text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
        {set.questions.slice(0, 4).map((question) => (
          <li key={question.key} className="truncate">
            • {question.label}
          </li>
        ))}
        {set.questions.length > 4 ? <li>…and {set.questions.length - 4} more</li> : null}
      </ul>
    </div>
  )
}

/// The form. One state per question key; `other:<key>` marks the free-text
/// choice on a picker that allows one.
export function QuestionDialog({
  set,
  onAnswer,
  onCancel,
  onClose,
}: {
  set: QuestionSet
  /// Send the composed answer as a reply message.
  onAnswer: (body: string) => void
  /// Send the cancellation sentence as a reply message.
  onCancel: () => void
  onClose: () => void
}) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const missing = missingRequired(set, answers)
  const canSend = missing.length === 0

  const answer = (key: string, value: string) => setAnswers((current) => ({ ...current, [key]: value }))
  const body = answerBody(set, answers)

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] w-[min(560px,calc(100vw-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QuestionBeacon size="sm" />
            {set.title ?? "A few quick questions"}
          </DialogTitle>
          <DialogDescription>
            Your answers go back as one message the agent can read. Nothing is sent until you submit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {set.questions.map((question) => (
            <QuestionField
              key={question.key}
              question={question}
              value={answers[question.key] ?? ""}
              onChange={(value) => answer(question.key, value)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {set.cancelLabel ?? "Cancel question"}
          </Button>
          <div className="flex items-center gap-2">
            {missing.length ? (
              <span className="text-xs text-muted-foreground">Still needed: {missing.join(", ")}</span>
            ) : null}
            <Button type="button" disabled={!canSend || !body} onClick={() => onAnswer(body)}>
              <SendIcon className="size-4" />
              {set.submitLabel ?? "Send answers"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: StructuredQuestion
  value: string
  onChange: (value: string) => void
}) {
  const otherKey = `other:${question.key}`
  const isOther = value.startsWith(otherKey) || (value.length > 0 && question.options.every((o) => o.value !== value))
  const otherText = isOther ? (value.startsWith(otherKey) ? value.slice(otherKey.length) : value) : ""

  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-sm font-medium">
        {question.label}
        {question.required ? <span className="ml-1 text-red-500">*</span> : null}
      </legend>

      {question.type === "radio" ? (
        <div className="grid gap-1.5">
          {question.options.map((option) => {
            const selected = value === option.value
            return (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg border p-2 transition-colors",
                  selected ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/50"
                )}
              >
                <input
                  type="radio"
                  name={question.key}
                  className="mt-0.5"
                  checked={selected}
                  onChange={() => onChange(option.value)}
                />
                <span className="min-w-0">
                  <span className="block text-sm">{option.label}</span>
                  {option.description ? (
                    <span className="block text-xs text-muted-foreground">{option.description}</span>
                  ) : null}
                </span>
              </label>
            )
          })}
          {question.allowOther ? (
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border p-2 transition-colors",
                isOther ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/50"
              )}
            >
              <input
                type="radio"
                name={question.key}
                className="mt-0.5"
                checked={isOther}
                onChange={() => onChange(`${otherKey}`)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">Other…</span>
                <input
                  type="text"
                  aria-label={`Other answer for ${question.label}`}
                  value={otherText}
                  disabled={!isOther}
                  placeholder="Type your own"
                  onFocus={() => onChange(`${otherKey}`)}
                  onChange={(event) => onChange(`${otherKey}${event.target.value}`)}
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-ring disabled:opacity-50"
                />
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      {question.type === "select" ? (
        <div className="grid gap-1.5">
          <select
            aria-label={question.label}
            value={question.options.some((option) => option.value === value) ? value : isOther ? otherKey : ""}
            onChange={(event) =>
              onChange(event.target.value === otherKey ? `${otherKey}` : event.target.value)
            }
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          >
            <option value="">Choose…</option>
            {question.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {question.allowOther ? <option value={otherKey}>Other…</option> : null}
          </select>
          {isOther ? (
            <input
              type="text"
              aria-label={`Other answer for ${question.label}`}
              value={otherText}
              placeholder="Type your own"
              onChange={(event) => onChange(`${otherKey}${event.target.value}`)}
              className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
            />
          ) : null}
        </div>
      ) : null}

      {question.type === "text" ? (
        question.multiline ? (
          <textarea
            aria-label={question.label}
            rows={3}
            value={value}
            placeholder={question.placeholder}
            onChange={(event) => onChange(event.target.value)}
            className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          />
        ) : (
          <input
            type="text"
            aria-label={question.label}
            value={value}
            placeholder={question.placeholder}
            onChange={(event) => onChange(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          />
        )
      ) : null}

      {question.type === "date" ? (
        <div className="flex items-center gap-2">
          <CalendarIcon className="size-4 text-muted-foreground" />
          <input
            type="date"
            aria-label={question.label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          />
        </div>
      ) : null}
    </fieldset>
  )
}

/// The floating "needs an answer" control the owner asked for — shown whenever
/// the open conversation holds an unanswered question.
export function QuestionActionButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      data-slot="question-action"
      onClick={onClick}
      title={count === 1 ? "1 question needs an answer" : `${count} questions need answers`}
      aria-label={count === 1 ? "1 question needs an answer" : `${count} questions need answers`}
      className="pointer-events-auto flex items-center gap-2 rounded-full border border-red-300/70 bg-background/95 py-1 pl-1 pr-3 text-xs font-medium text-foreground shadow-lg transition hover:bg-red-50 dark:border-red-500/40 dark:hover:bg-red-950/40"
    >
      <QuestionBeacon />
      {count === 1 ? "1 question needs an answer" : `${count} questions need answers`}
    </button>
  )
}
