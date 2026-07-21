# Create Task Dialog — Real Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and render the Create Task dialog's fields (owner, operator, due, estimate, review gate) that today are dropped, and track task creators as human or agent.

**Architecture:** Add five columns to `TaskflowTask`, wire the dashboard create + the agent create-handler to set them, and replace the dialog's free-text fields with live-data dropdowns and a date+time picker. Reader-before-writer: the read/render path lands before the create path sends real values, so main never shows a half-built dialog.

**Tech Stack:** Rust/axum + umbral (backend), React/TypeScript + shadcn (frontend). Frontend client types are GENERATED — never hand-edited.

## Global Constraints

- **Agent references are bare `i64`, not `ForeignKey`** — `taskflow-agents` depends on `taskflow-tasks`, so a `ForeignKey<TaskflowAgent>` would be a crate cycle. `operator_agent_id` and `created_by_agent_id` match the existing `assigned_agent_id`. Human columns (`operator_user`, `created_by`) ARE `ForeignKey<AuthUser>`.
- **`created_by_agent_id` is NOT client-writable** — stamped only by `create_task_as_agent` from the credential.
- **Regenerate client types after the model change:** `cd backend && cargo run -- gen-client --out ../v2_fe/src/api` — never hand-edit `v2_fe/src/api/client.d.ts`.
- **Migration is a new-named file** from `cargo run -- makemigrations`, never a rewrite of an applied one.
- **Estimate parse:** leading integer = minutes (`"90"`, `"90 min"` → 90); no leading integer → null.
- Owner = `assigned_user`; Operator = `operator_user` XOR `operator_agent_id`; exactly one operator column set.

---

### Task 1: Backend — columns, migration, create input, agent-creator stamp

**Files:**
- Modify: `backend/plugins/taskflow-tasks/src/models.rs:87-90` (add 5 columns after `assigned_agent_id`)
- Modify: `backend/plugins/taskflow-agents/src/views.rs:1993-1998` (`create_task_as_agent` stamps `created_by_agent_id`)
- Generate: a migration under `backend/migrations/taskflow_tasks/`
- Generate: `v2_fe/src/api/client.d.ts` (via gen-client)
- Test: `backend/tests/rest_scope.rs` (auto-REST create round-trips the new columns), `backend/plugins/taskflow-agents/tests/agent_tasks.rs` (new; agent create stamps `created_by_agent_id`)

**Interfaces:**
- Produces: `TaskflowTask.{review_gate, estimate_minutes, operator_user, operator_agent_id, created_by_agent_id}`; the same names on the generated `TaskflowTaskCreate`.

- [ ] **Step 1: Add the columns** — in `models.rs`, immediately after `assigned_agent_id` (`:87`):

```rust
    /// What a human must approve before this task can ship. Free text/markdown.
    #[umbral(string, max_length = 4000, widget = "textarea")]
    pub review_gate: Option<String>,
    /// Estimate in minutes. The dialog takes free text and parses a leading int.
    pub estimate_minutes: Option<i64>,
    /// Operator if a human (the executor, distinct from the owner).
    #[umbral(on_delete = "set_null")]
    pub operator_user: Option<ForeignKey<AuthUser>>,
    /// Operator if an agent. Bare i64 for the same cycle reason as
    /// `assigned_agent_id` — taskflow-tasks cannot depend on taskflow-agents.
    pub operator_agent_id: Option<i64>,
    /// Creator if an agent (human creators use `created_by`). Bare i64, same
    /// cycle reason. Set only by the agent create-handler, never a client.
    pub created_by_agent_id: Option<i64>,
```

- [ ] **Step 2: Fix every `TaskflowTask { … }` initializer the compiler flags** — run `cargo build -p taskflow-tasks 2>&1 | grep E0063` to find them; add the five fields (all `None`) to each. Known sites: `create_task_as_agent` (views.rs, agents plugin) and any seed/test constructors. Do NOT guess — let the compiler list them.

- [ ] **Step 3: Stamp the agent creator** — in `create_task_as_agent` (`views.rs:1983` initializer), set:

```rust
            created_by: None,
            created_by_agent_id: Some(agent.agent_id),
            assigned_user: None,
            operator_user: None,
            operator_agent_id: None,
            review_gate: None,
            estimate_minutes: None,
            assigned_agent_id,
```

(keep the existing fields; this adds the new ones with the creator stamped.)

- [ ] **Step 4: Generate the migration**

Run: `cd backend && cargo run -- makemigrations`
Expected: `Wrote migrations/taskflow_tasks/000N_..._task_*.json` with five AddColumn ops. Confirm it is a NEW file.

- [ ] **Step 5: Failing test — auto-REST create round-trips the new columns** — append to `backend/tests/rest_scope.rs` (it already has `post_as`/`get_as` and a seeded active member `alice`/project `project_p`):

```rust
// The dialog persists owner/operator/due/estimate/review through the auto-REST
// create; before these columns existed they were silently dropped.
#[tokio::test]
async fn task_create_round_trips_the_new_columns() {
    let seed = /* reuse the fixture's alice + project_p */;
    let (status, body) = post_as(
        seed.alice,
        "/api/taskflow_task/",
        json!({
            "project": seed.project_p,
            "title": "with real fields",
            "description_markdown": "d",
            "review_gate": "human signs off",
            "estimate_minutes": 90,
            "operator_agent_id": 7,
            "created_by": seed.alice,
        }),
    )
    .await;
    assert_eq!(status, 201, "create failed: {body:?}");
    let id = body["id"].as_i64().unwrap();
    let (_s, got) = get_as(seed.alice, false, &format!("/api/taskflow_task/{id}")).await;
    assert_eq!(got["review_gate"], json!("human signs off"));
    assert_eq!(got["estimate_minutes"], json!(90));
    assert_eq!(got["operator_agent_id"], json!(7));
    assert_eq!(got["created_by"], json!(seed.alice));
}
```

(Adapt the seed access to match `rest_scope.rs`'s existing `Seed`/`app()` pattern — read the file's other tests first.)

- [ ] **Step 6: Failing test — the agent handler stamps the creator** — create `backend/plugins/taskflow-agents/tests/agent_tasks.rs`, modelled on `prompt_answers.rs` (mint + register_session helpers):

```rust
#[tokio::test]
async fn an_agent_created_task_records_the_agent_as_creator() {
    let f = fixture().await; // mint agent, get key + agent_id
    let resp = f.app.post_as_agent(&f.key, "/api/taskflow/agents/tasks",
        json!({ "title": "by the agent", "description_markdown": "d" })).await;
    assert_eq!(resp.status(), 200);
    let body = resp.json().await;
    assert_eq!(body["created_by_agent_id"], json!(f.agent_id));
    assert_eq!(body["created_by"], serde_json::Value::Null);
}
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-agents --test agent_tasks && cargo test --test rest_scope task_create_round_trips_the_new_columns`
Expected: PASS.

- [ ] **Step 8: Full backend suite**

Run: `cd backend && cargo test --workspace`
Expected: all pass (was 152; now higher).

- [ ] **Step 9: Regenerate the client types**

Run: `cd backend && cargo run -- gen-client --out ../v2_fe/src/api`
Expected: `v2_fe/src/api/client.d.ts` now has the five fields on `TaskflowTask` and `TaskflowTaskCreate`. Verify: `grep -c "review_gate\|estimate_minutes\|operator_user\|operator_agent_id\|created_by_agent_id" v2_fe/src/api/client.d.ts` ≥ 5.

- [ ] **Step 10: Verify the frontend still compiles with the new types**

Run: `cd v2_fe && npx tsc --noEmit`
Expected: exit 0 (the new optional fields don't break existing reads).

- [ ] **Step 11: Commit**

```bash
git add backend/plugins/taskflow-tasks/src/models.rs backend/plugins/taskflow-agents/src/views.rs backend/migrations/taskflow_tasks backend/tests/rest_scope.rs backend/plugins/taskflow-agents/tests/agent_tasks.rs v2_fe/src/api/client.d.ts
git commit -m "feat(tasks): persist review gate, estimate, operator, and creator"
```

---

### Task 2: Frontend read path — helpers, mapping, details render

**Files:**
- Create: `v2_fe/src/lib/tasks.ts`, `v2_fe/src/lib/tasks.test.ts`
- Modify: `v2_fe/src/App.tsx:1066-1094` (`mapLiveTasks`), the details sheet Info rows (`:4005-4034`), and the `Task` type (`:~340`) to carry the new display values

**Interfaces:**
- Consumes: `TaskflowWorkspace` `members` + `agents` for name resolution.
- Produces: `parseEstimateMinutes(text) => number | null`, `formatEstimateMinutes(min) => string`, `resolveActorName(kind, {user, agentId}, members, agents) => string`.

- [ ] **Step 1: Failing tests** — `tasks.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { parseEstimateMinutes, formatEstimateMinutes } from "./tasks"

describe("parseEstimateMinutes", () => {
  it("reads a leading integer as minutes", () => {
    expect(parseEstimateMinutes("90")).toBe(90)
    expect(parseEstimateMinutes("90 min")).toBe(90)
    expect(parseEstimateMinutes("  120  ")).toBe(120)
  })
  it("returns null when there is no leading integer", () => {
    expect(parseEstimateMinutes("")).toBeNull()
    expect(parseEstimateMinutes("about an hour")).toBeNull()
  })
})

describe("formatEstimateMinutes", () => {
  it("formats minutes, and null as a dash", () => {
    expect(formatEstimateMinutes(90)).toBe("90 min")
    expect(formatEstimateMinutes(null)).toBe("—")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd v2_fe && npx vitest run src/lib/tasks.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `tasks.ts`**

```ts
/** Parse a free-text estimate into whole minutes, or null. Leading int wins. */
export function parseEstimateMinutes(text: string): number | null {
  const match = text.trim().match(/^(\d+)/)
  return match ? Number(match[1]) : null
}

/** Render an estimate for display. */
export function formatEstimateMinutes(minutes: number | null | undefined): string {
  return typeof minutes === "number" ? `${minutes} min` : "—"
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd v2_fe && npx vitest run src/lib/tasks.test.ts` → PASS.

- [ ] **Step 5: Map the new columns in `mapLiveTasks`** — replace the placeholder lines (`estimate: "Live"`, the `review:` ternary, `operatorName`, and add a creator) with real values. Resolve operator/creator names from `members`/`agents` passed into `mapLiveTasks` (thread them through — the caller has `liveWorkspace`). Concretely:

```ts
// mapLiveTasks(tasks, members, agents)
operatorName: task.operator_user
  ? (members.find((m) => m.user === task.operator_user)?.display_name ?? `User #${task.operator_user}`)
  : task.operator_agent_id
    ? (agents.find((a) => a.id === task.operator_agent_id)?.display_name ?? `Agent #${task.operator_agent_id}`)
    : assignee,
estimate: formatEstimateMinutes(task.estimate_minutes),
review: task.review_gate ?? (task.status === "partial_done" ? "Waiting for human review." : "No explicit review gate."),
createdBy: task.created_by_agent_id
  ? (agents.find((a) => a.id === task.created_by_agent_id)?.display_name ?? `Agent #${task.created_by_agent_id}`)
  : task.created_by
    ? (members.find((m) => m.user === task.created_by)?.display_name ?? `User #${task.created_by}`)
    : "Unknown",
```

Add `createdBy: string` to the `Task` type. Update both `mapLiveTasks` call sites to pass `members`/`agents` (from the summary/workspace).

- [ ] **Step 6: Render in the details sheet** — the sheet already shows `Info label="Estimate"`, `Info label="Operator"`, and renders `task.review`. Add a `Info label="Created by" value={task.createdBy}` row beside them (`:4005-4006`). These now read real values via Step 5.

- [ ] **Step 7: Verify**

Run: `cd v2_fe && npx tsc --noEmit && npx vitest run`
Expected: tsc 0; all tests pass (baseline + new).

- [ ] **Step 8: Commit**

```bash
git add v2_fe/src/lib/tasks.ts v2_fe/src/lib/tasks.test.ts v2_fe/src/App.tsx
git commit -m "feat(tasks): render persisted estimate, operator, review, creator"
```

---

### Task 3: Frontend create dialog — dropdowns, date+time, estimate, labels, payload

**Files:**
- Modify: `v2_fe/src/App.tsx` — the Create Task `<form>` (`:7472+`), `handleCreateTask` (`:2483-2557`)

**Interfaces:**
- Consumes: `parseEstimateMinutes`, the workspace `members`/`agents`, `currentUser`.

**Note:** the current form is uncontrolled (`FormData` in `handleCreateTask`). shadcn `Select` and the date picker are CONTROLLED — add local `useState` for owner (`{id,label}`), operator (`"user:N"|"agent:N"|""`), and due (ISO string). `handleCreateTask` reads those from state, not `FormData`, for these three fields; title/status/priority/tags/description/notes/review stay on `FormData`.

- [ ] **Step 1: Owner + Operator dropdowns** — replace the Owner and Operator text inputs with shadcn `Select`s. Owner options = active `members` (value = user id, label = display_name). Operator options = active `members` then `agents`, each option value encoding its kind, e.g. `user:3` / `agent:7`, so submit can route it. Keep a "leave unassigned" empty option on both.

- [ ] **Step 2: Due date+time picker** — replace the Due text input with a shadcn date picker + a time input (or a `datetime-local` input if a shadcn datetime is not present — check `v2_fe/src/components/ui` first). Its value is an ISO string for `due_at`, or null when empty.

- [ ] **Step 3: Estimate + labels** — Estimate input placeholder → `"minutes, e.g. 90"`. Relabel "Description, markdown" → "Description" with a `<span className="text-xs text-muted-foreground">you can write in markdown</span>` help line; same for Notes.

- [ ] **Step 4: Build the real payload** — in `handleCreateTask`, replace the `createTaskflowTask({...})` body (`:2537`) with:

```ts
const operator = String(formData.get("operator") ?? "")  // "user:3" | "agent:7" | ""
const [opKind, opId] = operator.split(":")
void createTaskflowTask({
  project: projectId,
  title,
  description_markdown: description || `### Outcome\n${review}`,
  notes_markdown: notes || null,
  status: toLiveStatus(status),
  priority: toLivePriority(priority),
  sort_order: projectTasks.length,
  assigned_user: ownerUserId ?? null,          // from the Owner select
  assignee_label: ownerLabel,
  operator_user: opKind === "user" ? Number(opId) : null,
  operator_agent_id: opKind === "agent" ? Number(opId) : null,
  due_at: dueIso ?? null,                       // from the date+time picker
  estimate_minutes: parseEstimateMinutes(estimate),
  review_gate: review || null,
  created_by: currentUser?.id ?? null,
})
```

Keep the optimistic local `newTask` for snappy UI, but its display fields should now mirror what will persist (owner/operator names, formatted estimate) so the pre-refetch bubble matches the reloaded row.

- [ ] **Step 5: Verify**

Run: `cd v2_fe && npx tsc --noEmit && npx vitest run && npx eslint src --ext .ts,.tsx`
Expected: tsc 0; tests pass; eslint no NEW errors over the 4 baseline.

- [ ] **Step 6: Commit**

```bash
git add v2_fe/src/App.tsx
git commit -m "feat(tasks): real dropdowns, date+time, and persisted create payload"
```

- [ ] **Step 7: LIVE VERIFICATION (interactive, mandatory)**

Rebuild/reload the frontend. Create a task with: an owner (member), an agent operator, a due date+time, an estimate ("90"), and a review gate. Reload the page. Confirm in the details sheet that owner, operator (agent name), due, "90 min", the review gate, and "Created by" all survive the reload. Create one via the MCP `create_task` and confirm its "Created by" shows the agent. Only then is the workstream done.

---

## Notes for the executor

- Tasks 1–2 are reader-side and land first; the dialog still submits the old payload until Task 3, so main is never broken mid-way.
- Task 3 Step 7 is not autonomous — it needs the running app and a human.
- Do NOT hand-edit `client.d.ts`; regenerate (Task 1 Step 9). If gen-client changes unrelated lines, that is expected — commit the whole regenerated file.
- The optimistic local `Task` shape (mock) still exists; this plan makes its live-mapped values real without removing the demo scaffold.
