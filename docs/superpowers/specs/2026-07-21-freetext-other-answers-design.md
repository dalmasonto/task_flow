# Design: free-text "Other" answers for dashboard prompts

**Date:** 2026-07-21
**Status:** draft, for review

## Problem

A human answering an agent's `AskUserQuestion` from the dashboard can only pick
numbered options. The terminal offers a free-text **"Other"** escape — type your
own answer alongside (or instead of) the numbered choices — and the dashboard
cannot. The request: on a multi-select, tick some options **and** type a
free-text value, submitted together as one answer.

Free text must be part of the answer, not a separate follow-up. An
`AskUserQuestion` is a **blocking** decision point: the agent is frozen until it
is answered, and everything in the answer is seen atomically at that instant. A
note delivered as a chat message afterwards arrives after the agent has already
unblocked and acted on the selections — too late to shape the decision it was
meant to shape. So the free text has to travel *inside* the prompt answer, which
means the terminal's "Other" field.

## Two facts established by observation

Both confirmed from live screenshots on 2026-07-21, not inferred:

1. **The hook never sees "Other".** The captured `toolInput` for a 3-option
   question contains exactly `options[0..2]` and no "Other" entry. The harness
   appends "Other" in its own render layer. **So the dashboard must synthesize
   the Other option itself.**

2. **The new Claude Code TUI is arrow-based.** The caret starts on the first
   option; Down/Up moves it; **Enter toggles** the highlighted option. "Other"
   is a text field that **cannot be toggled while empty** — it becomes
   selectable only once it has text, and Enter selects/deselects it. Below the
   options is a **Submit** affordance that advances to the existing "Submit
   answers / Cancel" review screen.

   Number keys still toggle plain options (our existing replay relies on this),
   but the Other field is a text field, so reaching and filling it is
   arrow-and-type, not a number press.

## Scope

**In:** a single multi-select question with an Other free-text field, combined
with numbered selections, answered from the dashboard and replayed into the
terminal. Single-select Other and multi-question sets containing Other follow
the same data model and are natural extensions, but the first target is the
multi-select case the user asked for.

**Out:** free-text-only prompts (no numbered options); rich/multiline Other
input; validating free text against anything (it is free by nature).

## Surfacing "Other" (hook → dashboard)

The hook appends a synthetic Other option to each question it reports:

```jsonc
{ "number": <N+1>, "label": "Type something", "isOther": true }
```

where `N` is the count of the question's real options. The dashboard renders an
`isOther` option as a **text input** rather than a button. `isOther` is the
discriminator the frontend keys on; nothing downstream infers "Other" from the
label text.

**The terminal option layout — measured, not guessed.** Two live screenshots
(a 3-option and a 4-option multi-select) pin it:

```
1..N        the real options
N+1         "Type something"   <- the Other free-text field
            Submit             (advances to the review screen)
N+2         "Chat about this"  <- harness escape, never touched
```

So Other sits at **N+1** (its label is literally "Type something"), and the
"Chat about this" row the earlier draft feared sits *after* it at **N+2** —
harmless, because we never navigate to it. This was the design's highest risk (a
trailing row shifting Other's index and making every derived keystroke off by
one); the measurement resolves it to a deterministic rule: **Other = option
count + 1**. Implementation still asserts the rule against the live TUI on first
run — belt and suspenders — but it is no longer an unknown.

## Data model

The free text rides beside the existing numeric answer, one string per question:

- `answer_json` — unchanged. The chosen numbers per question, e.g. `[[1,3]]`.
  When Other is chosen, its synthetic number appears here like any other pick.
- `answer_text_json` — new. One entry per question: the Other text, or `null`
  where the question has no Other pick. e.g. `["my own take", null]`.

A single-question prompt keeps `answer_json` flat (`[1,3]`) as today;
`answer_text_json` is `["my own take"]` or absent. The parallel-array shape
mirrors how `answer_json` already carries one set per question, so readers gain
one field, not a new structure.

## Backend

`answer_prompt` gains an optional `texts: Vec<Option<String>>` input, validated
alongside the existing `answers`:

| Rule | Failure |
|---|---|
| `texts.len()` matches the question count when present | 400 |
| A non-null text only where that question actually has an Other option | 400 |
| Each text within a length bound (e.g. 2000 chars) | 400 |
| Other's number present in the answer set whenever its text is non-null | 400 |

Stored to `answer_text_json`. The `answer`/`answer_json` handling is unchanged.
`TaskflowAgentPrompt` gains an `answer_text_json` column (nullable text, same
40000-ish bound as `options_json`); `max_length` is a validation constraint, not
a SQLite column type, so **no migration is required** — confirmed the same way as
the `options_json` widening.

## MCP replay — mechanism settled, choreography measured

The mechanism is decided:

- **Toggles:** arrow-navigate to each option and `Enter`, matching the new TUI —
  or numbers where they are known to work. Paced by `sendKeySequence` (90ms
  between keys) so the re-rendering TUI does not drop any.
- **Other text:** `send-keys -l "<text>"` — the literal-text injection message
  delivery already uses, so arbitrary characters and length are handled without
  the key whitelist. Sanitized through the existing `sanitizeForPane` (strips
  newlines, which would submit early).
- **Select Other:** `Enter` once the field has text.
- **Submit:** advance to the review screen, then the existing
  `REVIEW_SUBMIT` = `["1", "Enter"]`.

Other's option number is now known (**N+1**, above). What remains unmeasured is
the **navigation choreography** — how many Downs reach Other from the caret's
resting place after the number-toggles, whether pressing `N+1` jumps straight to
the field, and how "Submit" is reached from there. These are NOT specified here;
they are determined by observing the live TUI during implementation and pinned in
a pure keystroke-builder function. This is deliberate: guessing terminal
choreography produced five separate bugs in this feature's neighbours, every one
caught only by live testing.

To keep the builder testable and the choreography honest, the replay is a pure
function `keystrokesForPromptWithText(...) -> string[]` (or an extension of
`keystrokesForPrompt`) that returns the full ordered sequence, including a
literal-text marker the sender expands via `send-keys -l`. The sender
distinguishes a "type this literally" step from a "press this key" step.

## Testing

- **Unit (mcp):** the keystroke builder — a multi-select with Other produces
  toggles, then the text-injection step, then select, then review submit, in
  order; no Other pick produces the existing sequence unchanged; the text step
  carries the exact string.
- **Backend:** `texts` validated and stored; text without a matching Other pick
  refused; over-length refused; a set stores one text per question.
- **Frontend:** an `isOther` option renders an input; the submit is gated on the
  same completeness rule, treating a non-empty Other text as a satisfied pick.
- **Live end-to-end before merge — mandatory.** Tests prove the *logic*; only a
  live run proves the *choreography*. Answer a real multi-select-with-Other from
  the dashboard and confirm the terminal records the same selections and text.

## Sequencing

Layered so nothing breaks between commits — readers tolerate the new fields
before the hook writes them:

1. Backend accepts and stores `texts` / `answer_text_json` (additive).
2. MCP keystroke builder handles the Other/text case (behind the data it reads).
3. Frontend renders the Other input and sends `texts`.
4. Hook synthesizes the Other option (the writer, last) — only after the live
   choreography is confirmed, so a half-working Other is never surfaced.

## Provenance

Requested 2026-07-21 during live testing of multi-question prompts. Builds on the
keystroke-replay and review-screen work landed the same day
(`multi-question-prompts` branch). The `send-keys -l` injection idea — reusing
message delivery for the Other text instead of typing it through the key
whitelist — is what makes the free-text case tractable.
