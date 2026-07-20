# Free-text "Other" Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human answering an agent's `AskUserQuestion` from the dashboard tick numbered options **and** type a free-text "Other" value, submitted together and replayed into the terminal.

**Architecture:** The hook synthesizes the "Other" option the harness hides from it; the dashboard renders it as a text box; the backend stores the text beside the numeric answer; the MCP replays it by navigating to the "Type something" field and injecting the text with `send-keys -l` (message-delivery style), not through the key whitelist.

**Tech Stack:** Rust/axum + umbral (backend), React/TypeScript (frontend), Node/TypeScript (MCP + hook), tmux `send-keys`.

## Global Constraints

- **Other = option count + 1**, label `"Type something"`, discriminator `isOther: true`. A `"Chat about this"` row sits at count + 2 and is NEVER navigated to. (Measured from two live screenshots, 2026-07-21.)
- **Scope: multi-select only.** Synthesize Other for `multiSelect` questions; single-select Other and multi-question sets with Other are follow-ups.
- **Free text goes in via `send-keys -l`**, sanitized through the existing `sanitizeForPane` (strips newlines). Never through the `sendKeyToPane` whitelist.
- **Keystroke choreography is a hypothesis until verified live.** Task 4 ends with a mandatory live run; guessing terminal keys produced six bugs in this feature's neighbours.
- `max_length` on a umbral string field is a validation bound, NOT a SQLite column type — widening or adding one needs **no migration** (confirmed for `options_json`).
- Text bound: **2000 chars** per Other value.

---

### Task 1: Backend accepts and stores the Other text

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/models.rs:404-420` (add `answer_text_json` column; add `is_other` to nothing here — options are JSON)
- Modify: `backend/plugins/taskflow-agents/src/views.rs:3095-3120` (`AnswerPromptInput`), `:3180-3250` (`answer_prompt` validation + storage), and the `PromptOptionPayload` struct near `:3187`
- Modify: `backend/src/realtime.rs` (`PROMPT_FIELDS`, add `"answer_text_json"`)
- Test: `backend/plugins/taskflow-agents/tests/prompt_answers.rs` (append)

**Interfaces:**
- Consumes: existing `answer_prompt`, `prompt_questions()`, `PromptOptionPayload`.
- Produces: `AnswerPromptInput.texts: Option<Vec<Option<String>>>`; a stored `answer_text_json` column (nullable text); `PromptOptionPayload.is_other: bool`.

- [ ] **Step 1: Write the failing test** — append to `prompt_answers.rs`. Uses a SET-shaped options_json whose question carries an `is_other` option (number 4):

```rust
/// A multi-select whose 4th option is the synthetic "Other" text field.
/// `isOther` is camelCase because the JS hook writes it that way — the Rust
/// struct renames to match (see Step 4).
const WITH_OTHER: &str = r#"[
  {"question":"Pick","kind":"multi","options":[
    {"number":1,"label":"A"},{"number":2,"label":"B"},{"number":3,"label":"C"},
    {"number":4,"label":"Type something","isOther":true}]}
]"#;

#[tokio::test]
async fn an_other_pick_stores_its_text() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, WITH_OTHER, "set").await;
    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[1, 4]], "texts": ["my own take"] }),
        )
        .await;
    assert_eq!(resp.status(), 200, "answering with Other text must succeed");
    let body = resp.json().await;
    assert_eq!(body["answer_json"], json!("[1,4]"));
    assert_eq!(body["answer_text_json"], json!("[\"my own take\"]"));
}

// Free text only makes sense where the question actually has an Other option
// AND that option was picked — otherwise a caller could smuggle text into a
// plain question the terminal has no field to type it in.
#[tokio::test]
async fn text_without_an_other_pick_is_refused() {
    let f = fixture().await;
    // SET const has no is_other option.
    let prompt = report(&f.app, &f.key, f.session, SET, "set").await;
    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[2], [1, 3]], "texts": ["nope", null] }),
        )
        .await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn over_long_other_text_is_refused() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, WITH_OTHER, "set").await;
    let big = "x".repeat(2001);
    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[4]], "texts": [big] }),
        )
        .await;
    assert_eq!(resp.status(), 400);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p taskflow-agents --test prompt_answers an_other_pick_stores_its_text text_without_an_other_pick_is_refused over_long_other_text_is_refused`
Expected: FAIL — `answer_text_json` field missing / `texts` ignored (200 where 400 expected).

- [ ] **Step 3: Add the model column** — in `models.rs`, after `answer_json` (`:420`):

```rust
    /// Free-text "Other" answers as JSON: one entry per question, `null` where
    /// the question has no Other pick. e.g. `["my own take"]` or `[null,"x"]`.
    /// A validation bound, not a column type — no migration.
    #[umbral(string, max_length = 40000)]
    pub answer_text_json: Option<String>,
```

- [ ] **Step 4: Add `is_other` to the option payload** — in `views.rs` near `PromptOptionPayload`:

```rust
#[derive(Debug, Deserialize)]
struct PromptOptionPayload {
    number: i64,
    // The hook writes this as camelCase `isOther`; rename so serde matches.
    #[serde(rename = "isOther", default)]
    is_other: bool,
}
```

- [ ] **Step 5: Extend the input** — in `AnswerPromptInput` (`:3095`), after `cancel`:

```rust
    /// One free-text value per question, `null` where the question has no Other
    /// pick. Only valid where that question has an `is_other` option and its
    /// number is in the answer set.
    #[serde(default)]
    pub texts: Option<Vec<Option<String>>>,
```

- [ ] **Step 6: Validate + store** — in `answer_prompt`, after the per-question loop (`:3230`) and before setting status:

```rust
    // Free text, if present: one per question, only where that question has an
    // Other option that was actually picked, and within the length bound.
    let texts: Vec<Option<String>> = match &input.texts {
        None => vec![None; questions.len()],
        Some(t) if t.len() == questions.len() => t.clone(),
        Some(_) => return Err(StatusCode::BAD_REQUEST),
    };
    for ((text, set), question) in texts.iter().zip(sets.iter()).zip(questions.iter()) {
        let Some(text) = text else { continue };
        if text.chars().count() > 2000 {
            return Err(StatusCode::BAD_REQUEST);
        }
        // The Other option is the one flagged is_other; its number must be in
        // this question's answer set, or there is no field the text belongs to.
        let other = question.options.iter().find(|o| o.is_other);
        match other {
            Some(o) if set.contains(&o.number) => {}
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    }
```

Then, after the `answer_json` assignment (`:3250`):

```rust
    prompt.answer_text_json = if texts.iter().any(Option::is_some) {
        Some(serde_json::to_string(&texts).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
    } else {
        None
    };
```

- [ ] **Step 7: Project it on the realtime wire** — in `realtime.rs`, add `"answer_text_json"` to `PROMPT_FIELDS` so the MCP receives it.

- [ ] **Step 8: Run to verify pass**

Run: `cargo test -p taskflow-agents --test prompt_answers`
Expected: PASS (all prior + 3 new).

- [ ] **Step 9: Full backend suite**

Run: `cd backend && cargo test --workspace`
Expected: all pass (was 149; now 152).

- [ ] **Step 10: Commit**

```bash
git add backend/plugins/taskflow-agents/src/models.rs backend/plugins/taskflow-agents/src/views.rs backend/src/realtime.rs backend/plugins/taskflow-agents/tests/prompt_answers.rs
git commit -m "feat(prompts): accept and store free-text Other answers"
```

---

### Task 2: Dashboard renders the Other text box and sends the text

**Files:**
- Modify: `v2_fe/src/App.tsx:5061` (`AgentPromptOption` gains `isOther`), `:5150-5240` (the `AgentPromptCard` render + `complete` gate + `submit`), `:4867-4869` (`handleAnswerPrompt`), `:4565`/`:5107` (the two `onAnswer*` signatures)
- Modify: `v2_fe/src/lib/taskflow-api.ts:616-628` (`answerAgentPrompt` sends `texts`)

**Interfaces:**
- Consumes: `answerAgentPrompt(promptId, answers, cancel, texts)`.
- Produces: `AgentPromptOption.isOther?: boolean`; the card collects a `string` per question and passes `texts: (string|null)[]`.

- [ ] **Step 1: Extend the option type** (`App.tsx:5061`):

```tsx
type AgentPromptOption = { number: number; label: string; description?: string; preview?: string; isOther?: boolean }
```

- [ ] **Step 2: Send `texts` from the API helper** (`taskflow-api.ts:616`):

```tsx
export async function answerAgentPrompt(
  promptId: number,
  answers: number[][],
  cancel = false,
  texts: (string | null)[] = []
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/prompts/${promptId}/answer`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify({
      ...(answers.length > 1
        ? { answers }
        : (answers[0] ?? []).length > 1
          ? { choices: answers[0] }
          : { choice: answers[0]?.[0] }),
      ...(cancel ? { cancel: true } : {}),
      ...(texts.some((t) => t != null) ? { texts } : {}),
    }),
  })
  // ...existing error handling unchanged
}
```

- [ ] **Step 3: Thread the signatures** — update both `onAnswer`/`onAnswerPrompt` types (`:5107`, `:4565`) to `(promptId: number, answers: number[][], cancel?: boolean, texts?: (string|null)[]) => Promise<void>` and `handleAnswerPrompt` (`:4867`):

```tsx
  const handleAnswerPrompt = useCallback(
    async (promptId: number, answers: number[][], cancel = false, texts: (string | null)[] = []) => {
      await answerAgentPrompt(promptId, answers, cancel, texts)
    },
    []
  )
```

- [ ] **Step 4: Per-question Other text state** — in `AgentPromptCard`, beside `selected`:

```tsx
  // One Other-text value per question, "" where none. Indexed like `questions`.
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ""))
```

- [ ] **Step 5: Render the Other option as a text input** — in the option map, branch on `option.isOther`:

```tsx
          {q.options.map((option, oIndex) =>
            option.isOther ? (
              <div key={option.number} className="rounded-md border border-transparent bg-background/60 px-2.5 py-2">
                <label className="mb-1 block text-xs text-muted-foreground">{option.label}</label>
                <textarea
                  value={texts[qIndex] ?? ""}
                  disabled={pending}
                  rows={2}
                  placeholder="Type your own answer…"
                  onChange={(e) =>
                    setTexts((cur) => cur.map((t, i) => (i === qIndex ? e.target.value : t)))
                  }
                  className="w-full resize-y rounded border bg-background px-2 py-1 text-sm"
                />
              </div>
            ) : (
              /* existing button branch unchanged, keyed by option.number */
              <button /* … */ />
            )
          )}
```

- [ ] **Step 6: Count a filled Other box as a satisfied pick** — the `complete` gate and the submitted answer must treat non-empty Other text as selecting the Other option's number:

```tsx
  // Effective selection per question: the toggled numbers, plus the Other
  // option's number when its text box is non-empty.
  const effective = questions.map((q, i) => {
    const other = q.options.find((o) => o.isOther)
    const picks = [...(selected[i] ?? [])]
    if (other && (texts[i] ?? "").trim() && !picks.includes(other.number)) picks.push(other.number)
    return picks.sort((a, b) => a - b)
  })
  const complete = questions.length > 0 && effective.every((set) => set.length > 0)
```

Then `submit` sends `effective` and `texts` (mapping "" → null):

```tsx
  const submit = async (cancel = false) => {
    if (!complete || pending) return
    setPending(true)
    setError(null)
    try {
      await onAnswer(prompt.id, effective, cancel, texts.map((t) => (t.trim() ? t : null)))
      clearPromptDraft(prompt.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not answer.")
      setPending(false)
    }
  }
```

Update the Submit/Cancel `onClick` to `() => void submit()` / `() => void submit(true)`.

- [ ] **Step 7: Verify tsc + tests**

Run: `cd v2_fe && npx tsc --noEmit && npx vitest run`
Expected: tsc exit 0; 21 tests pass.

- [ ] **Step 8: Commit**

```bash
git add v2_fe/src/App.tsx v2_fe/src/lib/taskflow-api.ts
git commit -m "feat(prompts): render an Other text box on the dashboard"
```

---

### Task 3: Hook synthesizes the Other option

**Files:**
- Modify: `mcp/hooks/taskflow-hook.mjs:223-254` (`reportPrompt`)

**Interfaces:**
- Consumes: `toolInput.questions[].options`, `multiSelect`.
- Produces: each `multiSelect` question's stored `options` gains a final `{ number: N+1, label: "Type something", isOther: true }`.

- [ ] **Step 1: Append the synthetic Other** — in the `questions` map inside `reportPrompt`, after building `options`:

```js
  const questions = usable.map((question) => {
    const options = question.options.map((option, index) => ({
      number: index + 1,
      label: String(option.label ?? "").slice(0, 200),
      description: String(option.description ?? "").slice(0, 500),
      ...(option.preview ? { preview: String(option.preview).slice(0, 4000) } : {}),
    }));
    // The terminal appends a free-text "Type something" row at N+1 that the hook
    // never sees (it is added in the harness render layer). Synthesize it so the
    // dashboard can offer the same free-text answer. Multi-select only for now.
    if (question.multiSelect) {
      options.push({ number: options.length + 1, label: "Type something", isOther: true });
    }
    return {
      question: String(question.question ?? question.header ?? "Agent is asking").slice(0, 2000),
      kind: question.multiSelect ? "multi" : "single",
      options,
    };
  });
```

- [ ] **Step 2: Syntax check**

Run: `node --check mcp/hooks/taskflow-hook.mjs`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git add mcp/hooks/taskflow-hook.mjs
git commit -m "feat(prompts): hook synthesizes the Other option for multi-select"
```

---

### Task 4: MCP replays the Other answer into the terminal

**Files:**
- Modify: `mcp/src/tmux.ts` (add `typeTextToPane`, a step-based `sendKeySteps`)
- Modify: `mcp/src/prompts.ts` (add `stepsForPrompt` producing `KeyStep[]`; the Other choreography)
- Modify: `mcp/src/events.ts` (`PromptEvent` gains `answer_text_json`)
- Modify: `mcp/src/index.ts:198-217` (use `stepsForPrompt` + `sendKeySteps`)
- Test: `mcp/src/prompts.test.ts`, `mcp/src/tmux.test.ts`

**Interfaces:**
- Consumes: `keystrokesForPrompt`, `sendKeySequence`, `parseQuestions`, `parseAnswerSets`.
- Produces: `type KeyStep = { key: string } | { text: string }`; `stepsForPrompt(...) => KeyStep[]`; `sendKeySteps(steps, target, deps)`.

- [ ] **Step 1: Failing test — the step builder for a plain (no-Other) answer is unchanged, just wrapped as key steps** (`prompts.test.ts`):

```ts
import { stepsForPrompt } from "./prompts.js";

describe("stepsForPrompt", () => {
  it("wraps a plain multi-select as key steps, identical to keystrokesForPrompt", () => {
    const opts = JSON.stringify([
      { question: "Q", kind: "multi", options: [{ number: 1, label: "A" }, { number: 2, label: "B" }] },
    ]);
    expect(stepsForPrompt(opts, "set", "Q", "[[1]]", null, null)).toEqual([
      { key: "1" }, { key: "Right" }, { key: "1" }, { key: "Enter" },
    ]);
  });

  // The choreography below is a HYPOTHESIS pinned here so a change is visible;
  // it is corrected against the live TUI in Step 8. All-arrows: walk down
  // toggling picks, type into "Type something", Enter to select it, Down to
  // Submit, Enter to review, then Submit answers.
  it("navigates to Other, injects the text, and submits (hypothesis)", () => {
    const opts = JSON.stringify([
      { question: "Q", kind: "multi", options: [
        { number: 1, label: "A" }, { number: 2, label: "B" }, { number: 3, label: "C" },
        { number: 4, label: "Type something", isOther: true }] },
    ]);
    // Picked option 1 and Other(4); Other text carried in answer_text_json.
    expect(stepsForPrompt(opts, "set", "Q", "[[1,4]]", null, '["my take"]')).toEqual([
      { key: "Enter" },            // toggle option 1 (caret starts on it)
      { key: "Down" },             // -> 2
      { key: "Down" },             // -> 3
      { key: "Down" },             // -> 4 = "Type something"
      { text: "my take" },         // type into the field
      { key: "Enter" },            // select Other
      { key: "Down" },             // -> Submit
      { key: "Enter" },            // activate -> review screen
      { key: "1" }, { key: "Enter" }, // Submit answers
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mcp && npx vitest run src/prompts.test.ts`
Expected: FAIL — `stepsForPrompt` not a function.

- [ ] **Step 3: Add `PromptOption.isOther` + the step builder** (`prompts.ts`):

```ts
export interface PromptOption {
  number: number;
  label: string;
  description?: string;
  isOther?: boolean;
}

export type KeyStep = { key: string } | { text: string };

/** The Other free-text value per question, parallel to the answer sets. */
export function parseAnswerTexts(answerTextJson: string | null, count: number): (string | null)[] {
  if (!answerTextJson) return Array(count).fill(null);
  try {
    const parsed: unknown = JSON.parse(answerTextJson);
    if (Array.isArray(parsed)) {
      return Array.from({ length: count }, (_, i) =>
        typeof parsed[i] === "string" ? (parsed[i] as string) : null,
      );
    }
  } catch { /* fall through */ }
  return Array(count).fill(null);
}

/**
 * The full ordered steps for an answered prompt. Without any Other text this is
 * `keystrokesForPrompt` wrapped as `{key}` steps. With Other text on a single
 * multi-select question, it walks the arrow-based flow the new TUI uses (see the
 * hypothesis in the test — verified live before this ships).
 */
export function stepsForPrompt(
  optionsJson: string,
  kind: string,
  question: string,
  answerJson: string | null,
  answer: number | null,
  answerTextJson: string | null,
  intent: PromptIntent = "submit",
): KeyStep[] {
  const questions = parseQuestions(optionsJson, kind, question);
  const sets = parseAnswerSets(answerJson, answer);
  const texts = parseAnswerTexts(answerTextJson, questions.length);

  // Only the scoped case gets the Other flow: one multi-select question whose
  // Other option was picked with text. Everything else uses the proven path.
  const single = questions.length === 1 ? questions[0] : undefined;
  const other = single?.options.find((o) => o.isOther);
  const otherPicked =
    other && sets[0]?.includes(other.number) && (texts[0] ?? "").length > 0;

  if (!otherPicked || intent === "cancel") {
    return keystrokesForPrompt(optionsJson, kind, question, answerJson, answer, intent)
      .map((key) => ({ key }));
  }

  const steps: KeyStep[] = [];
  // Walk down the list from the caret's start on option 1, toggling picks.
  for (let i = 0; i < single!.options.length; i++) {
    const opt = single!.options[i]!;
    if (opt.isOther) {
      steps.push({ text: texts[0]! }, { key: "Enter" }); // type, then select Other
    } else if (sets[0]!.includes(opt.number)) {
      steps.push({ key: "Enter" }); // toggle this pick
    }
    if (i < single!.options.length - 1) steps.push({ key: "Down" });
  }
  steps.push({ key: "Down" }, { key: "Enter" }); // to Submit, activate -> review
  steps.push({ key: "1" }, { key: "Enter" });    // Submit answers
  return steps;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the step sender** (`tmux.ts`) — a literal-text typer plus a step dispatcher:

```ts
/** Type literal text into a pane (message-delivery style), newlines stripped. */
export async function typeTextToPane(text: string, target?: string): Promise<void> {
  const base = target ? ["-t", target] : [];
  const clean = sanitizeForPane(text, 2000);
  if (clean.length) await run("tmux", ["send-keys", ...base, "-l", clean]);
}

/** Send a mixed sequence of key presses and literal-text injections, paced. */
export async function sendKeySteps(
  steps: import("./prompts.js").KeyStep[],
  target: string | undefined,
  deps: KeySequenceDeps & { typeText?: (t: string, target?: string) => Promise<void> } = {},
): Promise<void> {
  const sendKey = deps.sendKey ?? sendKeyToPane;
  const typeText = deps.typeText ?? typeTextToPane;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delayMs = deps.delayMs ?? KEY_SEQUENCE_DELAY_MS;
  for (let i = 0; i < steps.length; i++) {
    if (i > 0) await sleep(delayMs);
    const step = steps[i]!;
    if ("text" in step) await typeText(step.text, target);
    else await sendKey(step.key, target);
  }
}
```

- [ ] **Step 6: Test the sender** (`tmux.test.ts`):

```ts
import { sendKeySteps } from "./tmux.js";

describe("sendKeySteps", () => {
  it("presses keys and types text in order, paced", async () => {
    const log: string[] = [];
    await sendKeySteps(
      [{ key: "Enter" }, { text: "hello" }, { key: "1" }],
      "%0",
      { sendKey: async (k) => void log.push(`key:${k}`), typeText: async (t) => void log.push(`text:${t}`), sleep: async () => {} },
    );
    expect(log).toEqual(["key:Enter", "text:hello", "key:1"]);
  });
});
```

- [ ] **Step 7: Wire into delivery** — `events.ts` `PromptEvent` gains `answer_text_json?: string | null`; `index.ts:198-217` swaps `keystrokesForPrompt`+`sendKeySequence` for:

```ts
          const steps = stepsForPrompt(
            prompt.options_json ?? "",
            prompt.kind,
            prompt.question,
            prompt.answer_json,
            prompt.answer,
            prompt.answer_text_json ?? null,
            prompt.status === "cancelled" ? "cancel" : "submit",
          );
          if (!steps.length) return;
          await sendKeySteps(steps, pane);
```

Update imports: `stepsForPrompt` from `./prompts.js`, `sendKeySteps` from `./tmux.js`.

- [ ] **Step 8: Verify build + all MCP tests**

Run: `cd mcp && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc 0; all tests pass; build clean.

- [ ] **Step 9: Commit the logic**

```bash
git add mcp/src/prompts.ts mcp/src/prompts.test.ts mcp/src/tmux.ts mcp/src/tmux.test.ts mcp/src/events.ts mcp/src/index.ts
git commit -m "feat(prompts): replay a free-text Other answer into the terminal"
```

- [ ] **Step 10: LIVE VERIFICATION (mandatory, interactive)**

Reconnect the session. Ask a real multi-select question. In the DASHBOARD, tick one option and type into the Other box, submit. Watch the terminal:

- **All picks + the typed text recorded** → choreography correct, done.
- **Wrong option toggled / off by one** → the Down count or caret-start assumption is wrong; adjust the loop in `stepsForPrompt` and re-verify.
- **Stuck on the field or review screen** → the select-Other Enter or the Down-to-Submit step is wrong; adjust and re-verify.

Confirm the DB row: `answer_json` includes the Other number, `answer_text_json` holds the text, and the agent's recorded answer matches. Only merge after a clean run.

---

## Notes for the executor

- Tasks 1–3 are autonomous and TDD'd. **Task 4 Step 10 is not autonomous** — it needs the human and a running app, because the choreography is the one thing tests cannot prove.
- Order is reader-before-writer: backend (Task 1) and frontend (Task 2) tolerate the new shape before the hook (Task 3) emits it, so main never breaks between commits.
- Do NOT hardcode Other's number as a literal — always derive it from the `isOther` flag, so a future layout change surfaces as a failed live check, not a silent wrong toggle.
