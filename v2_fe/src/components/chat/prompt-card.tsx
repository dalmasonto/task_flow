import { AlertCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { type TaskflowWorkspace } from "@/lib/taskflow-api"
import { useEffect, useMemo, useState } from "react"


/// Child route element for /dashboard/agents/:conversationId. Reads the resolved
/// conversation + handlers from the layout's <Outlet/> context and renders the
/// message thread, composer, and the agent-DM-aware minimizable terminal. When
/// the route param doesn't resolve to a real chat it falls back to the empty
/// state, so a stale or hand-typed id never renders a broken conversation.

/// One option as stored in a prompt's `options_json`.
export type AgentPromptOption = { number: number; label: string; description?: string; preview?: string; isOther?: boolean }


/// One question and its options.
export type AgentPromptQuestion = { question: string; kind: string; options: AgentPromptOption[] }


/// The questions a prompt is asking, in either stored shape.
///
/// `AskUserQuestion` accepts SEVERAL questions per call. Rows written before
/// that was supported hold a bare option list for one question, and they are
/// still in the table — reading one must keep working, because an unrenderable
/// prompt leaves its agent blocked with no way to answer.
function parsePromptQuestions(
  optionsJson: string,
  fallbackKind: string,
  fallbackQuestion: string
): AgentPromptQuestion[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(optionsJson)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return []

  // The discriminator is a nested `options` array: the set shape wraps each
  // question, the legacy shape IS the option list.
  const isSet = parsed.every((e) => typeof e === "object" && e !== null && "options" in e)
  if (!isSet) {
    return [{ question: fallbackQuestion, kind: fallbackKind, options: parsed as AgentPromptOption[] }]
  }
  return (parsed as Array<Partial<AgentPromptQuestion>>)
    .map((e) => ({
      question: typeof e.question === "string" ? e.question : fallbackQuestion,
      kind: typeof e.kind === "string" ? e.kind : "single",
      options: Array.isArray(e.options) ? e.options : [],
    }))
    .filter((q) => q.options.length > 0)
}


/// Where an unsent selection is kept across a reload.
///
/// The QUESTION already survives a refresh — prompts are server rows and the
/// workspace refetches pending ones on load. What did not survive was a
/// half-made choice, which matters more now that answering is a deliberate
/// submit and a prompt can carry several questions: answer two of three, hit
/// refresh, lose both.
///
/// Deliberately NOT a persisted copy of the question itself. The server owns
/// that, and a local duplicate goes stale in a nasty way — the agent is
/// cancelled or someone answers from another tab, and this client would still
/// render a live question against a prompt that no longer exists.
export const PROMPT_DRAFT_PREFIX = "taskflow.promptDraft."


function loadPromptDraft(promptId: number, questionCount: number): number[][] | null {
  try {
    const raw = window.localStorage.getItem(`${PROMPT_DRAFT_PREFIX}${promptId}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    // A draft saved against a DIFFERENT set of questions must not be applied —
    // the prompt was re-reported with a new shape and the indexes would no
    // longer line up with the questions on screen.
    if (!Array.isArray(parsed) || parsed.length !== questionCount) return null
    return parsed.map((set) => (Array.isArray(set) ? set.filter((n) => typeof n === "number") : []))
  } catch {
    return null
  }
}


function savePromptDraft(promptId: number, sets: number[][]): void {
  try {
    window.localStorage.setItem(`${PROMPT_DRAFT_PREFIX}${promptId}`, JSON.stringify(sets))
  } catch {
    // A full or disabled store must never break answering the question.
  }
}


function clearPromptDraft(promptId: number): void {
  try {
    window.localStorage.removeItem(`${PROMPT_DRAFT_PREFIX}${promptId}`)
  } catch {
    /* nothing to recover from */
  }
}


/// The yellow box above the composer: a question the agent is BLOCKED on.
///
/// This is not a notification — the agent is stopped at a keypress until someone
/// answers, so it is rendered where a reply would be typed, in the one place the
/// human is already looking.
export function AgentPromptCard({
  prompt,
  onAnswer,
}: {
  prompt: TaskflowWorkspace["agentPrompts"][number]
  onAnswer: (promptId: number, answers: number[][], cancel?: boolean, texts?: (string | null)[]) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const questions = useMemo(
    () => parsePromptQuestions(prompt.options_json, prompt.kind, prompt.question),
    [prompt.options_json, prompt.kind, prompt.question]
  )

  // One selection set per question, positionally aligned with `questions`,
  // seeded from any draft left by a previous visit.
  const [selected, setSelected] = useState<number[][]>(
    () => loadPromptDraft(prompt.id, questions.length) ?? questions.map(() => [])
  )

  // One Other-text value per question, "" where none. Indexed like `questions`.
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ""))

  // Persist every change, so a reload mid-answer does not discard the work.
  useEffect(() => {
    if (selected.some((set) => set.length > 0)) savePromptDraft(prompt.id, selected)
  }, [prompt.id, selected])

  const toggle = (qIndex: number, number: number) => {
    setError(null)
    // Single-select: picking a listed option clears any Other text, so the two
    // can't both count (the effective answer must be exactly one).
    if (questions[qIndex]?.kind !== "multi") {
      setTexts((cur) => cur.map((t, i) => (i === qIndex ? "" : t)))
    }
    setSelected((current) =>
      current.map((set, i) => {
        if (i !== qIndex) return set
        // Radio vs checkbox, mirroring how the agent's own terminal behaves.
        return questions[i]?.kind === "multi"
          ? set.includes(number)
            ? set.filter((n) => n !== number)
            : [...set, number].sort((a, b) => a - b)
          : [number]
      })
    )
  }

  // Effective selection per question: the toggled numbers, plus the Other
  // option's number when its text box is non-empty. A filled Other box counts
  // as picking Other even if the human never clicked it.
  const effective = questions.map((q, i) => {
    const other = q.options.find((o) => o.isOther)
    const hasText = Boolean(other && (texts[i] ?? "").trim())
    // Single-select (#30): exactly ONE answer. A filled Other box IS the answer
    // and supersedes any picked option; otherwise the picked option stands.
    if (q.kind !== "multi") {
      if (hasText) return [other!.number]
      return [...(selected[i] ?? [])]
    }
    // Multi-select: a filled Other box counts as an extra pick.
    const picks = [...(selected[i] ?? [])]
    if (hasText && !picks.includes(other!.number)) picks.push(other!.number)
    return picks.sort((a, b) => a - b)
  })

  // The agent is woken once, with the whole set. Answering questions one at a
  // time would replay digits into a screen the terminal has already left.
  const complete = questions.length > 0 && effective.every((set) => set.length > 0)

  const submit = async (cancel = false) => {
    if (!complete || pending) return
    setPending(true)
    setError(null)
    try {
      await onAnswer(prompt.id, effective, cancel, texts.map((t) => (t.trim() ? t : null)))
      // Answered: the draft has served its purpose and would otherwise be
      // re-applied if this prompt id were ever rendered again.
      clearPromptDraft(prompt.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not answer.")
      setPending(false)
    }
  }

  // #48: a prompt with no options is not a broken row — it is a tool-approval
  // request whose terminal screen could not be parsed with certainty, reported
  // deliberately without options so nothing can type a digit into a screen we
  // did not understand. Render it read-only: the agent IS blocked, and silently
  // showing nothing is what left these invisible in the first place.
  if (!questions.length) {
    return (
      <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
        <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
          <AlertCircleIcon className="size-4 shrink-0" />
          <p className="text-sm font-medium">Agent is blocked, waiting on you</p>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{prompt.question}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Answer this in the agent's terminal — the on-screen options could not be read, so they
          aren't offered here.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
        <AlertCircleIcon className="size-4 shrink-0" />
        <p className="text-sm font-medium">Agent is waiting for your answer</p>
      </div>
      {/* Bounded and scrollable: three questions with previews ran past the
          bottom of the card and the submit button could not be reached at all
          — the only way to answer was to zoom the whole browser out. */}
      <div className="mt-1 max-h-[45vh] overflow-y-auto pr-1">
      {questions.map((q, qIndex) => (
        <div key={qIndex} className={qIndex === 0 ? "" : "mt-4"}>
          <p className="mt-2 text-sm text-foreground">
            {questions.length > 1 ? (
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                {qIndex + 1}/{questions.length}
              </span>
            ) : null}
            {q.question}
          </p>

          <div className="mt-3 space-y-1.5">
        {q.options.map((option) => {
          const active = selected[qIndex]?.includes(option.number) ?? false
          return option.isOther ? (
            <div
              key={option.number}
              className="rounded-md border border-transparent bg-background/60 px-2.5 py-2"
            >
              <label className="mb-1 block text-xs text-muted-foreground">{option.label}</label>
              <textarea
                value={texts[qIndex] ?? ""}
                disabled={pending}
                rows={2}
                placeholder="Type your own answer…"
                onChange={(e) => {
                  setError(null)
                  setTexts((cur) => cur.map((t, i) => (i === qIndex ? e.target.value : t)))
                  // Single-select: typing Other deselects any picked option.
                  if (q.kind !== "multi" && e.target.value.trim()) {
                    setSelected((cur) => cur.map((set, i) => (i === qIndex ? [] : set)))
                  }
                }}
                className="w-full resize-y rounded border bg-background px-2 py-1 text-sm"
              />
            </div>
          ) : (
            <button
              key={option.number}
              type="button"
              disabled={pending}
              // Always a toggle now, never an immediate send: with several
              // questions the agent must not be woken until every one of them
              // has an answer.
              onClick={() => toggle(qIndex, option.number)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition disabled:opacity-60",
                active
                  ? "border-amber-500 bg-amber-100 dark:bg-amber-900/40"
                  : "border-transparent bg-background/60 hover:border-amber-300"
              )}
            >
              <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                {q.kind === "multi" ? (active ? "[x]" : "[ ]") : `${option.number}.`}
              </span>
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                {option.description ? (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                ) : null}
                {/* Shown only for the chosen option: previews are often long
                    (a mockup, a diff, a config block) and rendering every one
                    at once buries the question itself. */}
                {option.preview && active ? (
                  <span className="mt-2 block overflow-x-auto whitespace-pre rounded border bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                    {option.preview}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
          </div>
        </div>
      ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!complete || pending} onClick={() => void submit()}>
          {pending ? "Sending…" : "Submit answers"}
        </Button>
        {/* Cancel is the OTHER option on the terminal's review screen, and that
            screen only exists for a question SET — a single question submits the
            moment it is answered, so there is no cancel key to press. Gated on
            `complete` for the same reason submit is: the agent has to replay
            every answer to reach the review screen. */}
        {questions.length > 1 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!complete || pending}
            onClick={() => void submit(true)}
          >
            Cancel
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {complete
            ? "The agent resumes as soon as you send."
            : questions.length > 1
              ? "Answer every question, then submit."
              : "Choose an option, then submit."}
        </span>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
