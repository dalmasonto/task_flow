# Design-page Chat Unification (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the design page a *view over the existing chat* — design messages are ordinary Project-room messages flagged `is_design`, rendered by the same composer/message-list components as `/agents`.

**Architecture:** Add one boolean `is_design` to `TaskflowAgentMessage`. Both send paths (human + agent/MCP) accept it. The design page reuses `AgentsConversationView` (the component the floating dock already reuses) via a new `variant="design"`, pointed at the Project-room channel, displaying only `is_design` messages, with the inspected-element reference carried in the message body as a fenced `design-ref` block.

**Tech Stack:** Rust (umbral ORM, axum) plugin crate `taskflow-agents`; TypeScript MCP (`mcp/`); React + Vite + vitest frontend (`v2_fe`).

**Spec:** `docs/superpowers/specs/2026-09-20-design-chat-unification-design.md` (read it alongside this plan).

## Global Constraints

- Backend tests: **always** `cargo test --workspace` from `backend/` — a bare `cargo test` silently skips plugin crates.
- Migrations: generate with `cargo run -- makemigrations`; **never** hand-edit or regenerate an already-applied migration file (the runner tracks applied ids; a rewritten same-named file silently never re-runs).
- Frontend: the built app is what the user views — finish any FE change with `npm run build` (from `v2_fe/`), not just `npm run dev`.
- The only new message field is `is_design` (a bool). The inspected-element reference travels **in the body**, not in a new column.
- `showDesignBadge` defaults to **true** (so `/agents` is unchanged); the design rail sets it **false**.
- Follow existing code idiom: `#[serde(default)]` optionals on input DTOs, `#[umbral(default = "false")]` bools on models, `///` doc-comments.

---

## Task 1: `is_design` column on the message model + migration

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/models.rs:242-292` (struct `TaskflowAgentMessage`)
- Create: `backend/migrations/taskflow_agents/0020_add_taskflow_agent_message_is_design.json` (generated)
- Test: `backend/plugins/taskflow-agents/tests/send_message.rs`

**Interfaces:**
- Produces: `TaskflowAgentMessage.is_design: bool` (serialized as `is_design` in every message JSON projection, because `message_json` does `serde_json::to_value(message)`).

- [ ] **Step 1: Write the failing test**

Add to `backend/plugins/taskflow-agents/tests/send_message.rs`:

```rust
#[tokio::test]
async fn message_defaults_is_design_false() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": channel, "body_markdown": "plain chat" }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    // The column exists and defaults to false for an ordinary message.
    assert_eq!(row["is_design"], json!(false));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && cargo test --workspace -p taskflow-agents --test send_message message_defaults_is_design_false`
Expected: FAIL — either a compile error (field/column absent) or `is_design` is `null` rather than `false`.

- [ ] **Step 3: Add the field to the model**

In `backend/plugins/taskflow-agents/src/models.rs`, inside `struct TaskflowAgentMessage`, add after the `priority` field (line ~277), following the `archived` bool pattern at `models.rs:210`:

```rust
    /// Marks a message as belonging to the design conversation. Ordinary chat
    /// messages are `false`; the design page filters the Project-room channel to
    /// `is_design = true`. Set by the design composer (human) or explicitly by an
    /// agent via the MCP `send_message` `is_design` param.
    #[umbral(default = "false")]
    pub is_design: bool,
```

- [ ] **Step 4: Generate the migration**

Run: `cd backend && cargo run -- makemigrations`
Expected: creates `backend/migrations/taskflow_agents/0020_*.json` with a single `AddColumn` op for `is_design` (a `Boolean`, `nullable: false`, `default: "false"`) plus a fresh `snapshot_after`. Verify the filename is `0020_...` (the previous highest is `0019_widen_drifted_varchar_columns.json`) and that no existing migration file changed. Do NOT hand-edit the generated file.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && cargo test --workspace -p taskflow-agents --test send_message message_defaults_is_design_false`
Expected: PASS (the test harness applies migrations to its fresh DB, so the new column is present and defaults false).

- [ ] **Step 6: Commit**

```bash
git add backend/plugins/taskflow-agents/src/models.rs \
        backend/migrations/taskflow_agents/0020_add_taskflow_agent_message_is_design.json \
        backend/plugins/taskflow-agents/tests/send_message.rs
git commit -m "feat(messages): add is_design column to TaskflowAgentMessage"
```

---

## Task 2: Human send path accepts `is_design`

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/views.rs` — `SendMessageInput` (65-80), `send_message` multipart parse (352-423) and `.create(...)` (558-577)
- Test: `backend/plugins/taskflow-agents/tests/send_message.rs`

**Interfaces:**
- Consumes: `TaskflowAgentMessage.is_design` (Task 1).
- Produces: `POST /api/taskflow/agents/messages` honors an optional `is_design` (JSON bool or multipart `"is_design"` field), default false.

- [ ] **Step 1: Write the failing tests**

Add to `send_message.rs`:

```rust
#[tokio::test]
async fn human_send_sets_is_design_when_requested() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": channel, "body_markdown": "design ask", "is_design": true }),
        )
        .await;

    assert_eq!(response.status(), 200);
    assert_eq!(response.json().await["is_design"], json!(true));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && cargo test --workspace -p taskflow-agents --test send_message human_send_sets_is_design_when_requested`
Expected: FAIL — `is_design` comes back `false` because the input is ignored.

- [ ] **Step 3: Thread `is_design` through `send_message`**

In `views.rs`, add to `SendMessageInput` (after `targets`, ~line 79):

```rust
    /// Marks this as a design-conversation message. Absent/false = ordinary chat.
    #[serde(default)]
    pub is_design: bool,
```

Extend the normalised tuple type (line 339-347) and both branches to carry the bool. Add `bool` to the tuple type after `Vec<FilePart>`. In the multipart branch: declare `let mut is_design_field: Option<String> = None;` beside the other field vars (~357), add `"is_design" => is_design_field = Some(value),` to the match (~365), and after the `targets` parse add:

```rust
        // A design-composer message flags itself; anything but "true" is false.
        let is_design = is_design_field
            .as_deref()
            .map(|s| s.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
```

Return `is_design` as the new last tuple element in the multipart branch (after `files`). In the JSON branch return `input.is_design` as the last element. Bind it in the destructuring `let (channel_id, ..., files, is_design) = ...`. Finally, in the `.create(TaskflowAgentMessage { ... })` (line 558-575), add `is_design,` before `created_at: None`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && cargo test --workspace -p taskflow-agents --test send_message`
Expected: PASS (both new tests and the existing ones — the default-false path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/plugins/taskflow-agents/src/views.rs backend/plugins/taskflow-agents/tests/send_message.rs
git commit -m "feat(messages): human send path honors is_design"
```

---

## Task 3: Agent send path + MCP tool accept `is_design`

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/views.rs` — `AgentSendMessageInput` (1324-1331), `send_message_as_agent` multipart parse (1361-1423) and `.create(...)` (1498-1515)
- Modify: `mcp/src/server.ts` — the `send_message` tool (schema + forwarded body)
- Test: `backend/plugins/taskflow-agents/tests/send_message.rs` (agent path; reuse the agent-auth helper used by other agent tests)

**Interfaces:**
- Consumes: `TaskflowAgentMessage.is_design` (Task 1).
- Produces: `POST /api/taskflow/agents/agent/messages` honors optional `is_design`; the MCP `send_message` tool exposes an `is_design` boolean param forwarded verbatim.

- [ ] **Step 1: Find the agent-auth test helper**

Run: `grep -n "post_as_agent\|RequireAgent\|agent/messages\|seed_.*agent" backend/plugins/taskflow-agents/tests/support/mod.rs backend/plugins/taskflow-agents/tests/agent_read_api.rs`
Note the helper name for posting as an agent (e.g. `post_as_agent`) and the agent/channel seed helper. Use those exact names in Step 2.

- [ ] **Step 2: Write the failing test**

Add to `send_message.rs` (adapt the helper names to what Step 1 found):

```rust
#[tokio::test]
async fn agent_send_honors_is_design_param() {
    let app = TestApp::new().await;
    // Reuse the same seeding the other agent-path tests use to get an agent
    // credential + a channel the agent is a member of.
    let (channel, agent) = seed_channel_with_agent(&app).await;

    let response = app
        .post_as_agent(
            agent,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": channel, "body_markdown": "design reply", "is_design": true }),
        )
        .await;

    assert_eq!(response.status(), 200);
    assert_eq!(response.json().await["is_design"], json!(true));
}
```

If `seed_channel_with_agent` / `post_as_agent` do not exist under those names, use the actual equivalents found in Step 1 (do not invent helpers — the agent read/tasks tests already post as an agent).

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && cargo test --workspace -p taskflow-agents --test send_message agent_send_honors_is_design_param`
Expected: FAIL — `is_design` returns `false`.

- [ ] **Step 4: Thread `is_design` through `send_message_as_agent`**

In `views.rs`, add to `AgentSendMessageInput` (after `client_nonce`, ~1330):

```rust
    /// Agent-set design flag. The agent passes `true` when answering a design
    /// request; there is no server inference (no targets/reply linkage on this
    /// path), so an omitted value defaults to false.
    #[serde(default)]
    pub is_design: bool,
```

Extend the tuple (1361-1366) with a trailing `bool`. In the multipart branch add `let mut is_design_field: Option<String> = None;`, the `"is_design" => is_design_field = Some(value),` match arm, and the same `eq_ignore_ascii_case("true")` parse as Task 2; return it last. In the JSON branch return `input.is_design` last. Bind it in the destructuring. In the `.create(...)` at 1498-1515 add `is_design,` before `created_at: None`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && cargo test --workspace -p taskflow-agents --test send_message`
Expected: PASS.

- [ ] **Step 6: Add the `is_design` param to the MCP `send_message` tool**

In `mcp/src/server.ts`, locate the `send_message` tool definition (search `send_message`). Add an `is_design` boolean to its input schema with a description, e.g.:

```ts
is_design: z
  .boolean()
  .optional()
  .describe(
    "Set true when this message answers a DESIGN request (an inspect/design-ref message from the design page). It then appears in the design conversation, not just general chat."
  ),
```

In the handler that POSTs to `/api/taskflow/agents/agent/messages`, include `is_design` in the JSON body when provided (mirror how `priority`/`client_nonce` are forwarded). Then typecheck: `cd mcp && npm run build` (or the repo's MCP build script — check `mcp/package.json`).

- [ ] **Step 7: Commit**

```bash
git add backend/plugins/taskflow-agents/src/views.rs backend/plugins/taskflow-agents/tests/send_message.rs mcp/src/server.ts
git commit -m "feat(messages): agent send + MCP send_message honor is_design"
```

---

## Task 4: Read path — filter messages by `is_design`

**Files:**
- Modify: `v2_fe/src/lib/taskflow-api.ts:540-551` (`fetchChannelMessages`)
- Test: `backend/plugins/taskflow-agents/tests/send_message.rs` (or a new `tests/message_filter.rs`) — verify the auto-REST list filters by `is_design`

**Interfaces:**
- Consumes: `is_design` column (Task 1) + write paths (Tasks 2–3).
- Produces: `fetchChannelMessages(channelId, page, opts?: { isDesign?: boolean })` — when `opts.isDesign` is true, requests only design rows.

- [ ] **Step 1: Write the failing backend test**

The message list is auto-REST (`taskflow_agent_message` → `.views([List, Retrieve])`, channel-scoped). Confirm a boolean field filter works end-to-end. Add to `send_message.rs`:

```rust
#[tokio::test]
async fn message_list_filters_by_is_design() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    for (body, is_design) in [("plain", false), ("designy", true)] {
        let r = app
            .post_as(user, "/api/taskflow/agents/messages",
                json!({ "channel": channel, "body_markdown": body, "is_design": is_design }))
            .await;
        assert_eq!(r.status(), 200);
    }

    // The auto-REST list endpoint the frontend uses, filtered to design rows.
    let listed = app
        .get_as(user, &format!("/api/rest/taskflow_agent_message/?channel={channel}&is_design=true"))
        .await;
    assert_eq!(listed.status(), 200);
    let body = listed.json().await;
    let rows = body["results"].as_array().expect("results array");
    assert_eq!(rows.len(), 1, "only the design row should match");
    assert_eq!(rows[0]["body_markdown"], json!("designy"));
}
```

> The exact list URL/verb helper (`get_as`) and the auto-REST path prefix (`/api/rest/...` vs another mount) must match this repo — confirm with `grep -n "get_as\|/api/rest\|fn list" backend/plugins/taskflow-agents/tests/support/mod.rs backend/src/rest.rs` and adjust the path/helper before running. The assertion (design filter returns exactly the design row) is the invariant.

- [ ] **Step 2: Run to verify it fails or reveals the real path**

Run: `cd backend && cargo test --workspace -p taskflow-agents --test send_message message_list_filters_by_is_design`
Expected: FAIL first because the URL/helper needs correcting; once corrected, it should PASS if auto-REST already supports boolean field filters (the frontend already filters by `channel` the same way). If it still fails because boolean filtering is unsupported, add `is_design` to the message resource's allowed filters in `backend/src/rest.rs` (see how `channel` filtering is enabled for `taskflow_agent_message`) and re-run.

- [ ] **Step 3: Make the test pass**

Correct the path/helper (and, only if needed, whitelist the `is_design` filter in `rest.rs`). Re-run until PASS.

- [ ] **Step 4: Add the frontend filter option**

Replace `fetchChannelMessages` in `v2_fe/src/lib/taskflow-api.ts:540-551` with:

```ts
export async function fetchChannelMessages(
  channelId: number,
  page = 1,
  opts?: { isDesign?: boolean }
): Promise<ServerPage<TaskflowAgentMessage>> {
  let query = taskflowApi
    .from(taskflowTables.agentMessages)
    .filter(opts?.isDesign ? { channel: channelId, is_design: true } : { channel: channelId })
    .orderBy("-created_at", "-id")
    .param("page", page)
  const res = await query.list()
  return { rows: res.results, count: res.count, pageSize: res.page_size, totalPages: res.total_pages }
}
```

Also add `is_design?: boolean` to the `TaskflowAgentMessage` API row type (search its declaration in `taskflow-api.ts` / the generated types) so the field is typed on read.

- [ ] **Step 5: Typecheck**

Run: `cd v2_fe && npx tsc -b`
Expected: no type errors (all existing `fetchChannelMessages(id, page)` callers still compile — the third arg is optional).

- [ ] **Step 6: Commit**

```bash
git add v2_fe/src/lib/taskflow-api.ts backend/plugins/taskflow-agents/tests/send_message.rs backend/src/rest.rs
git commit -m "feat(messages): filter channel message list by is_design"
```

---

## Task 5: `design-ref` body codec (encode / parse / strip)

**Files:**
- Create: `v2_fe/src/lib/design-ref.ts`
- Test: `v2_fe/src/lib/design-ref.test.ts`

**Interfaces:**
- Produces:
  - `type DesignRef = { pagePath?: string; componentName?: string; elementPath?: string; srcRef?: string; viewport?: string }`
  - `encodeDesignRef(ref: DesignRef): string` — a fenced ```` ```design-ref\n{json}\n``` ```` block.
  - `appendDesignRef(body: string, ref: DesignRef): string` — body + blank line + encoded block.
  - `parseDesignRef(body: string): DesignRef | null` — the first `design-ref` block's parsed object, or null.
  - `stripDesignRef(body: string): string` — body with the `design-ref` block removed (for display).

- [ ] **Step 1: Write the failing tests**

`v2_fe/src/lib/design-ref.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { appendDesignRef, encodeDesignRef, parseDesignRef, stripDesignRef, type DesignRef } from "./design-ref"

const ref: DesignRef = { pagePath: "pages/home.js", elementPath: "div>button.cta", srcRef: "home.js:42", viewport: "desktop" }

describe("design-ref codec", () => {
  it("round-trips a ref through encode/parse", () => {
    expect(parseDesignRef(encodeDesignRef(ref))).toEqual(ref)
  })
  it("appends the block after the body and parse recovers it", () => {
    const body = appendDesignRef("please tighten this", ref)
    expect(body.startsWith("please tighten this")).toBe(true)
    expect(parseDesignRef(body)).toEqual(ref)
  })
  it("strips the block for display, leaving the prose", () => {
    const body = appendDesignRef("please tighten this", ref)
    expect(stripDesignRef(body).trim()).toBe("please tighten this")
  })
  it("returns null and passes through when there is no block", () => {
    expect(parseDesignRef("just chatting")).toBeNull()
    expect(stripDesignRef("just chatting")).toBe("just chatting")
  })
  it("fails soft on a malformed block", () => {
    const bad = "hi\n\n```design-ref\n{not json\n```"
    expect(parseDesignRef(bad)).toBeNull()
    expect(stripDesignRef(bad).trim()).toBe("hi")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v2_fe && npx vitest run src/lib/design-ref.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `design-ref.ts`**

```ts
/// The inspected-element reference that rides along with a design message. It is
/// encoded as a fenced ```design-ref``` block inside the message body (Phase 1
/// carries no new column), rendered as a chip and stripped from the displayed
/// prose. Parsing fails soft: a malformed block is treated as no ref.
export type DesignRef = {
  pagePath?: string
  componentName?: string
  elementPath?: string
  srcRef?: string
  viewport?: string
}

const FENCE = /```design-ref\s*\n([\s\S]*?)\n```/

export function encodeDesignRef(ref: DesignRef): string {
  return "```design-ref\n" + JSON.stringify(ref) + "\n```"
}

export function appendDesignRef(body: string, ref: DesignRef): string {
  const trimmed = body.trimEnd()
  return trimmed.length ? `${trimmed}\n\n${encodeDesignRef(ref)}` : encodeDesignRef(ref)
}

export function parseDesignRef(body: string): DesignRef | null {
  const match = body.match(FENCE)
  if (!match) return null
  try {
    const value = JSON.parse(match[1]) as unknown
    if (value && typeof value === "object") return value as DesignRef
    return null
  } catch {
    return null
  }
}

export function stripDesignRef(body: string): string {
  return body.replace(FENCE, "").trimEnd()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd v2_fe && npx vitest run src/lib/design-ref.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add v2_fe/src/lib/design-ref.ts v2_fe/src/lib/design-ref.test.ts
git commit -m "feat(design): add design-ref body codec"
```

---

## Task 6: Surface `isDesign` + parsed `designRef` on the frontend message model

**Files:**
- Modify: `v2_fe/src/lib/workspace-view.ts:110-138` (`AgentMessage` type)
- Modify: `v2_fe/src/lib/live-mappers.ts:994-1028` (the channel-message mapper: pending + posted branches)
- Modify: `v2_fe/src/lib/message-store.ts` (the pending record shape — add `is_design`)
- Test: `v2_fe/src/lib/live-mappers.test.ts` (create if absent) OR extend the nearest existing mapper test

**Interfaces:**
- Consumes: `parseDesignRef` / `stripDesignRef` (Task 5); `is_design` API field (Task 4).
- Produces: `AgentMessage.isDesign: boolean` and `AgentMessage.designRef: DesignRef | null` on every mapped message; the displayed `body` has the design-ref block stripped.

- [ ] **Step 1: Write the failing test**

Confirm the mapper's exported name first: `grep -n "export function map.*ChannelMessages\|export function map.*Messages" v2_fe/src/lib/live-mappers.ts`. Then add a test (adapt the fixture shape to the real `TaskflowAgentMessage` row + the mapper's signature — check an existing call site for the arguments it needs):

```ts
import { describe, expect, it } from "vitest"
// import { mapLiveChannelMessages } from "./live-mappers"  // use the real name

describe("channel message mapper — design", () => {
  it("surfaces isDesign, parses designRef, and strips the block from body", () => {
    // Build the minimal workspace/args the mapper needs (mirror an existing test
    // or the call site in use-agent-chat.ts). The message row has:
    //   is_design: true,
    //   body_markdown: "tighten this\n\n```design-ref\n{\"pagePath\":\"pages/home.js\"}\n```"
    // Assert on the single mapped message:
    //   msg.isDesign === true
    //   msg.designRef?.pagePath === "pages/home.js"
    //   msg.body === "tighten this"
  })
})
```

Fill in the fixture concretely using the real mapper signature (do not leave the assertions as comments — the comment above only documents the intended shape; write the executable test).

- [ ] **Step 2: Run to verify it fails**

Run: `cd v2_fe && npx vitest run src/lib/live-mappers.test.ts`
Expected: FAIL — `isDesign`/`designRef` undefined and `body` still contains the block.

- [ ] **Step 3: Extend the `AgentMessage` type**

In `workspace-view.ts`, add to `AgentMessage` (after `canEdit`, line ~137):

```ts
  /// True when this message belongs to the design conversation (is_design on the
  /// server row). Drives the design rail filter and the /agents "Design" badge.
  isDesign?: boolean
  /// The inspected-element reference parsed out of the body's design-ref block,
  /// or null. Rendered as a chip; the block itself is stripped from `body`.
  designRef?: import("./design-ref").DesignRef | null
```

- [ ] **Step 4: Map the fields**

In `live-mappers.ts`, import the codec at the top: `import { parseDesignRef, stripDesignRef } from "./design-ref"`.

In the **posted** branch (1012-1027) change `body` and add the two fields:

```ts
        body: stripDesignRef(message.body_markdown),
        isDesign: message.is_design ?? false,
        designRef: parseDesignRef(message.body_markdown),
```

In the **pending** branch (995-1008) add (the optimistic bubble should render as design immediately in the rail):

```ts
        body: stripDesignRef(message.body_markdown),
        isDesign: message.is_design ?? false,
        designRef: parseDesignRef(message.body_markdown),
```

(Keep the existing `body: message.body_markdown` replaced, not duplicated.)

- [ ] **Step 5: Carry `is_design` on the pending record**

In `v2_fe/src/lib/message-store.ts`, add an optional `is_design?: boolean` to the pending message type and let `addPending` accept/store it (find `addPending` and the pending type; mirror how `priority` is carried).

- [ ] **Step 6: Run to verify it passes + typecheck**

Run: `cd v2_fe && npx vitest run src/lib/live-mappers.test.ts && npx tsc -b`
Expected: PASS + no type errors.

- [ ] **Step 7: Commit**

```bash
git add v2_fe/src/lib/workspace-view.ts v2_fe/src/lib/live-mappers.ts v2_fe/src/lib/message-store.ts v2_fe/src/lib/live-mappers.test.ts
git commit -m "feat(chat): surface isDesign + parsed designRef on messages"
```

---

## Task 7: `AgentChatBubble` — design badge + design-ref chip

**Files:**
- Modify: `v2_fe/src/components/chat/bubbles.tsx:141-215` (props + header meta row) and the body-render region (~285-296)
- Test: `v2_fe/src/components/chat/bubbles.test.tsx` (create; use `@testing-library/react` if present — confirm with `grep -n "@testing-library/react" v2_fe/package.json`)

**Interfaces:**
- Consumes: `AgentMessage.isDesign` / `AgentMessage.designRef` (Task 6).
- Produces: `AgentChatBubble` accepts `showDesignBadge?: boolean` (default true). Renders a "Design" badge when `showDesignBadge && message.isDesign`. Renders a compact chip when `message.designRef` is set.

- [ ] **Step 1: Write the failing test**

If `@testing-library/react` is available:

```tsx
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { AgentChatBubble } from "./bubbles"

const base = { id: "1", from: "user", time: "now", body: "hi", status: "posted" as const }

describe("AgentChatBubble design affordances", () => {
  it("shows the Design badge when enabled and the message is design", () => {
    render(<AgentChatBubble message={{ ...base, isDesign: true }} showDesignBadge />)
    expect(screen.getByText(/design/i)).toBeInTheDocument()
  })
  it("hides the badge in the design rail (showDesignBadge=false)", () => {
    render(<AgentChatBubble message={{ ...base, isDesign: true }} showDesignBadge={false} />)
    expect(screen.queryByText(/^design$/i)).toBeNull()
  })
  it("renders the design-ref chip when a ref is present", () => {
    render(<AgentChatBubble message={{ ...base, designRef: { pagePath: "pages/home.js" } }} />)
    expect(screen.getByText(/home\.js/i)).toBeInTheDocument()
  })
})
```

If `@testing-library/react` is NOT installed, skip the render test and instead assert the badge logic by extracting a tiny pure helper `shouldShowDesignBadge(showDesignBadge, isDesign)` into `bubbles.tsx` and unit-testing that with vitest. Prefer the render test when the library exists.

- [ ] **Step 2: Run to verify it fails**

Run: `cd v2_fe && npx vitest run src/components/chat/bubbles.test.tsx`
Expected: FAIL — prop unsupported, no badge/chip.

- [ ] **Step 3: Add the prop + badge**

In `bubbles.tsx`, add `showDesignBadge = true` to the destructured props and its type (`showDesignBadge?: boolean`) in the `AgentChatBubble` signature (141-153). In the header meta row, after the priority badge block (line ~207-211), add:

```tsx
          {showDesignBadge && message.isDesign ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary ring-1 ring-primary/20">
              Design
            </span>
          ) : null}
```

- [ ] **Step 4: Add the design-ref chip**

Just above the rendered-markdown body (the `renderedRef` container, around the attachments render at ~285-296), add:

```tsx
        {message.designRef ? (
          <div className="mb-2 inline-flex max-w-full items-center gap-1 truncate rounded-md border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
            <CrosshairIcon className="size-3 shrink-0" />
            <span className="truncate">
              {message.designRef.componentName ?? message.designRef.pagePath ?? "element"}
              {message.designRef.srcRef ? ` · ${message.designRef.srcRef}` : ""}
            </span>
          </div>
        ) : null}
```

Import `CrosshairIcon` from `lucide-react` at the top of `bubbles.tsx` if not already imported.

- [ ] **Step 5: Run to verify it passes + typecheck**

Run: `cd v2_fe && npx vitest run src/components/chat/bubbles.test.tsx && npx tsc -b`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add v2_fe/src/components/chat/bubbles.tsx v2_fe/src/components/chat/bubbles.test.tsx
git commit -m "feat(chat): design badge + design-ref chip in message bubble"
```

---

## Task 8: `AgentsConversationView` — `variant="design"`, context chip, badge plumbing

**Files:**
- Modify: `v2_fe/src/components/chat/conversation-view.tsx` — props (27-43), `handleSendMessage` (331-356), the composer chip area, and the `AgentChatBubble` render call site
- Test: build + typecheck (this component is composer+list wired to props; behavior is covered by Task 5/6/7 units and the Task 10 manual pass)

**Interfaces:**
- Consumes: `appendDesignRef` (Task 5); `AgentChatBubble` `showDesignBadge` (Task 7).
- Produces: `AgentsConversationView` extra optional props:
  - `variant?: "full" | "compact" | "design"`
  - `contextChip?: { label: string; ref: DesignRef } | null`
  - `onClearContextChip?: () => void`
  - `showDesignBadge?: boolean` (default true)
  When `variant === "design"` and a `contextChip` is set, the composer appends `encodeDesignRef(contextChip.ref)` to the sent body and clears the chip. `showDesignBadge` is forwarded to every `AgentChatBubble`.

- [ ] **Step 1: Extend the props**

Update the destructure + type (27-43):

```tsx
  variant = "full",
  contextChip = null,
  onClearContextChip,
  showDesignBadge = true,
}: AgentsOutletContext & {
  variant?: "full" | "compact" | "design"
  contextChip?: { label: string; ref: import("@/lib/design-ref").DesignRef } | null
  onClearContextChip?: () => void
  showDesignBadge?: boolean
}) {
  const compact = variant === "compact"
  const isDesign = variant === "design"
```

Import `appendDesignRef` at the top: `import { appendDesignRef } from "@/lib/design-ref"`.

- [ ] **Step 2: Append the design-ref on send**

In `handleSendMessage` (331-356), after computing `trimmedMessage` and before `onSendMessage(...)`, build the outgoing body:

```tsx
    const outgoingBody =
      isDesign && contextChip ? appendDesignRef(trimmedMessage, contextChip.ref) : trimmedMessage
```

Pass `outgoingBody` instead of `trimmedMessage` to `onSendMessage(selectedChat, outgoingBody, ...)`. After the existing reset block (before `requestAnimationFrame(focusComposer)`), add `onClearContextChip?.()`.

> Note: `is_design=true` is NOT set here — it is applied by the design rail's own `onSendMessage` wiring (Task 9/10), keeping this component send-agnostic. This component only encodes the ref.

- [ ] **Step 3: Render the context chip above the composer**

Just above the composer `<form>` (the input region), add (only shows in the design rail when a chip is present):

```tsx
        {isDesign && contextChip ? (
          <div className="mx-4 mb-1 inline-flex items-center gap-1 self-start rounded-md border bg-muted/50 px-2 py-1 text-xs">
            <span className="truncate">{contextChip.label}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onClearContextChip?.()}
              aria-label="Remove selection"
            >
              ×
            </button>
          </div>
        ) : null}
```

- [ ] **Step 4: Forward `showDesignBadge` to bubbles**

At the `AgentChatBubble` render call site (search `<AgentChatBubble`), add `showDesignBadge={showDesignBadge}`.

- [ ] **Step 5: Hide the top header chrome in the design variant**

The header row at 391 is hidden when `compact`. Extend it to also hide in the design rail: change `compact && "hidden"` to `(compact || isDesign) && "hidden"` (the design rail draws its own context; a second title bar is noise).

- [ ] **Step 6: Typecheck + build**

Run: `cd v2_fe && npx tsc -b && npm run build`
Expected: no type errors; `/agents` and the dock are unchanged (they pass no `contextChip`, `showDesignBadge` defaults true, `variant` unchanged).

- [ ] **Step 7: Commit**

```bash
git add v2_fe/src/components/chat/conversation-view.tsx
git commit -m "feat(chat): AgentsConversationView design variant + context chip"
```

---

## Task 9: Send plumbing — `sendTaskflowAgentMessage` + `sendLiveMessage` accept `isDesign`

**Files:**
- Modify: `v2_fe/src/lib/taskflow-api.ts` (`sendTaskflowAgentMessage` payload type — search its definition)
- Modify: `v2_fe/src/components/chat/use-agent-chat.ts:115-195` (`sendLiveMessage`) and the pending `addPending` call (146-156)
- Test: typecheck (integration behavior verified in Task 10)

**Interfaces:**
- Consumes: human send `is_design` (Task 2); `addPending` `is_design` (Task 6 Step 5).
- Produces: `sendLiveMessage(chat, body, priority, files, targets?, opts?: { isDesign?: boolean })` — sends `is_design: true` and marks the optimistic bubble design when `opts.isDesign`.

- [ ] **Step 1: Add `is_design` to the send API payload**

In `taskflow-api.ts`, find `sendTaskflowAgentMessage`. Add `is_design?: boolean` to its input/body type and include it in the JSON body (and, for the multipart branch if it builds FormData, append `"is_design"` as `"true"`/`"false"`). Mirror how `priority` is included.

- [ ] **Step 2: Thread `isDesign` through `sendLiveMessage`**

Add a trailing optional param to `sendLiveMessage` (115-121):

```ts
    targets: TargetMember[] = [],
    opts?: { isDesign?: boolean }
```

In the `addPending(...)` call (148-155) add `is_design: opts?.isDesign ?? false,`. In the `sendTaskflowAgentMessage({...})` call (159-167) add `is_design: opts?.isDesign ?? false,`.

- [ ] **Step 3: Typecheck**

Run: `cd v2_fe && npx tsc -b`
Expected: no errors — the new param is optional, existing callers unaffected.

- [ ] **Step 4: Commit**

```bash
git add v2_fe/src/lib/taskflow-api.ts v2_fe/src/components/chat/use-agent-chat.ts
git commit -m "feat(chat): sendLiveMessage carries is_design"
```

---

## Task 10: `DesignSurfacePage` — mount the chat rail, drop the prompt bar, reflow layout

**Files:**
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx` — remove `DesignPromptBar` mount (422-…) + its `logsByAgent`/`terminal_frames` buffering (83, 129-142); add the left chat rail; move `LeftPanel` (Pages/Components/Tokens) into the right column beside `DesignInspector` (interim, until Phase 2 tabs)
- Reference (read, don't duplicate): `v2_fe/src/App.tsx:2488-2502` and `chat-dock.tsx` for how `useAgentChat` is instantiated and which `AgentsOutletContext` fields it produces
- Test: `npm run build` + a manual verification pass (canvas + realtime page; a full render test is out of scope)

**Interfaces:**
- Consumes: `useAgentChat` (shared workspace), `AgentsConversationView` design variant (Task 8), `sendLiveMessage` `isDesign` (Task 9), `fetchChannelMessages` `isDesign` (Task 4), `AgentMessage.isDesign` (Task 6).

- [ ] **Step 1: Instantiate the chat context for the design rail**

Read `chat-dock.tsx` and `App.tsx:2488-2502` to see exactly how `useAgentChat` is called (what workspace/project/currentUser/onWorkspaceUpdate it takes) and how it exposes `selectedChat`, `onSendMessage`, `onLoadOlder`, `currentUser`, etc. In `DesignSurfacePage`, obtain the same workspace/context (via the same context/provider the dock uses) and select the **Project-room** chat (the `mode: "channel"` project chat — see `use-agent-chat.ts` `ensureLiveChannel` / `mapLiveChannelChats`).

- [ ] **Step 2: Build the design-filtered chat context**

Derive a design-scoped `AgentsOutletContext` for the rail:

```tsx
// Only design messages render in the rail, even though the shared workspace
// holds the whole channel. The initial + older fetches are is_design-scoped
// (Task 4) so "latest 20 design first, older on scroll" is correct.
const designChat = useMemo(
  () => (projectRoomChat ? { ...projectRoomChat, messages: projectRoomChat.messages.filter((m) => m.isDesign) } : null),
  [projectRoomChat]
)
```

- The rail's `onSendMessage` wraps `sendLiveMessage(chat, body, priority, files, targets, { isDesign: true })`.
- The rail's `onLoadOlder` calls the design hook's older-page loader, which must pass `{ isDesign: true }` to `fetchChannelMessages`. If the shared `useAgentChat` does not expose an is_design-scoped loader, add an `isDesign` option to the hook's first-page effect (`use-agent-chat.ts:359-386`) and `loadOlderMessages` (388) — a small option threaded to the `fetchChannelMessages(channelId, page, { isDesign })` calls — and instantiate a design-scoped loader. Keep `/agents` unaffected (option defaults off).
- The initial fetch for the rail must be is_design-scoped too (same option on the first-page effect).

- [ ] **Step 3: Provide the inspect selection as the context chip**

```tsx
const contextChip = selection
  ? {
      label: selection.componentName ?? selection.pagePath ?? "Selected element",
      ref: {
        pagePath: selection.pagePath,
        componentName: selection.componentName,
        elementPath: selection.elementPath,
        srcRef: selection.srcRef,
        viewport: selection.viewport,
      },
    }
  : null
```

(Map from the real `SelectionState` shape in `design-selection.ts` — adjust field names to what it actually carries.)

- [ ] **Step 4: Reflow the layout**

Replace the body (372-420) + bottom prompt bar (422-…) so the three columns fill the height with no bottom bar:

```tsx
      <div className="flex min-h-0 flex-1">
        {/* LEFT: the design chat rail — the reusable chat, filtered to design. */}
        <aside className="flex w-[380px] shrink-0 flex-col border-r">
          {designChat ? (
            <AgentsConversationView
              {...designOutletContext}
              selectedChat={designChat}
              variant="design"
              showDesignBadge={false}
              contextChip={contextChip}
              onClearContextChip={() => setSelection(null)}
            />
          ) : (
            <EmptyCanvas message={"Loading design conversation…"} />
          )}
        </aside>

        {/* MIDDLE: the canvas (unchanged). */}
        <main className="relative min-w-0 flex-1">
          {/* ...existing error / empty / DesignCanvas block, unchanged... */}
        </main>

        {/* RIGHT: interim — inspector + the pages/components/tokens panel that
            used to sit on the left. Phase 2 turns this into proper tabs. */}
        <aside className="hidden w-[340px] shrink-0 flex-col overflow-y-auto border-l lg:flex">
          {/* NOTE (2026-09-25): this sketch predates the inspector's rework, and
              its prop names are the Phase 1 ones. `onCommentCreated` has been
              renamed to `onCommentsChanged` (corrected here — a reader copying
              this block would otherwise pass a prop that no longer exists); the
              rest are also gone: `selection` is now `selections` + `activeIndex`
              and `onDeselect` is `onClear`. The current contract is
              `v2_fe/src/pages/design/design-inspector.tsx` — read that. */}
          <DesignInspector
            selection={selection}
            manifest={manifest}
            projectId={projectId}
            onDeselect={() => setSelection(null)}
            onCommentsChanged={() => refreshComments()}
          />
          <LeftPanel
            manifest={manifest}
            sandboxToken={sandboxToken}
            section={leftSection}
            onSection={setLeftSection}
            projectId={projectId}
            onFilesChanged={() => setContentEpoch((e) => e + 1)}
            onOpenRoute={(route) => addArtboard(route, deviceIds[0] ?? DEFAULT_DEVICE_ID)}
          />
        </aside>
      </div>
```

- [ ] **Step 5: Remove the prompt bar and its dead plumbing**

Delete the `<div className="relative"><DesignPromptBar .../></div>` block, the `DesignPromptBar` import, and the now-unused `logsByAgent` state (83) + the `terminal_frames` buffering in the realtime effect (129-142). Keep the `design_files` / `design_comments` realtime groups. Remove `promptAgentId` if it is now unused (check for other references first).

- [ ] **Step 6: Typecheck + build**

Run: `cd v2_fe && npx tsc -b && npm run build`
Expected: clean build. Fix any unused-import / dead-variable errors from Step 5.

- [ ] **Step 7: Manual verification pass**

Start the app (`cd v2_fe && npm run dev` against a running backend) and verify:
1. The design page shows the chat rail on the left with a composer fixed at the bottom; no "agent output appears here" bar remains.
2. The rail shows only design messages (send a design message and a plain `/agents` message to the Project room — only the design one appears in the rail; both appear in `/agents`, the design one badged).
3. Inspect an element → a context chip appears in the rail composer → send → the sent bubble shows the design-ref chip and the raw block is not visible as text.
4. Scroll up in the rail loads older design messages (20-at-a-time behavior).
5. Attaching an image in the rail renders inline and opens the media lightbox (reuse confirmed).
6. `/agents` and the floating dock are visually unchanged.

- [ ] **Step 8: Commit**

```bash
git add v2_fe/src/pages/design/DesignSurfacePage.tsx v2_fe/src/components/chat/use-agent-chat.ts
git commit -m "feat(design): design page reuses chat rail, drops custom prompt bar"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §1 model → Task 1; §2 write paths + design-ref → Tasks 2, 3, 5, 8; §3 read filter → Task 4; §4 rail reuse → Tasks 8, 10; §5 badge → Tasks 6, 7; §6 layout skeleton → Task 10. All covered.
- **Interim layout note:** the current left `LeftPanel` (Pages/Components/Tokens) is relocated into the right column in Task 10 — a Phase-1 interim that Phase 2's tabs supersede. This is the one place the plan goes beyond the spec's §6 wording; flagged for user confirmation.
- **Type consistency:** `DesignRef`, `encodeDesignRef`/`appendDesignRef`/`parseDesignRef`/`stripDesignRef` (Task 5) are used consistently in Tasks 6, 8; `isDesign`/`designRef` on `AgentMessage` (Task 6) are consumed in Tasks 7, 10; the `{ isDesign?: boolean }` fetch/send option is spelled the same across Tasks 4, 9, 10.
- **Verify-before-code hooks:** Tasks 3, 4, 6, 7 include a `grep` step to confirm real helper/mapper/library names in THIS repo before writing tests (harness helpers and mapper names were not all pinned during planning).
