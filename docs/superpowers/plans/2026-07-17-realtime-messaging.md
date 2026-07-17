# Realtime + Messaging Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a chat message a single POST that arrives back over one correctly-routed SSE event carrying the whole row — no refetch, no duplicates, no forged senders.

**Architecture:** `umbral-realtime` emits the action as the event name (`created`) with an id-only payload, and the client's `model(name, …)` ignores `name` entirely — so 14 subscriptions on one `project:{id}` group means every handler fires on every event. We give each model its own `project:{id}:{suffix}` group so the group *is* the discriminator, add field projections on the three chat tables so their rows arrive whole, move message creation to a custom endpoint that derives sender identity server-side, and add a `client_nonce` so the SSE echo and the POST response reconcile in any order.

**Tech Stack:** Rust (umbral 0.0.10, umbral-realtime 0.0.10, sqlx/SQLite), React 19 + Vite + TypeScript, vitest (new).

**Spec:** `docs/superpowers/specs/2026-07-17-realtime-messaging-design.md`

## Global Constraints

- Group suffixes are **short labels, not table names**: `messages`, not `taskflow_agent_message`. The authoritative map is the table in the spec's "Group scheme" section. Backend and frontend must agree exactly or subscriptions silently receive nothing.
- Only the three chat tables (`taskflow_agent_message`, `taskflow_agent_channel`, `taskflow_agent_channel_member`) get `Expose::fields(...)`. The other 11 project-scoped exposures stay `Projection::IdOnly`. Do not "helpfully" project the rest — the group policy still lets any authenticated user join any project room, so every projected column is a leak until the permissions sub-project lands.
- `TaskflowProject` stays on the `taskflow:projects` group. It does not move.
- `client_nonce` is `max_length = 64`, nullable.
- The dev DB is `backend/backend.db` (gitignored). It holds seed data and throwaway rows only — recreating it is acceptable; losing the user's *code* is not.
- Never widen `Expose` to `all_fields()` anywhere in this plan.
- Commit after every task. The repo has a pre-work restore point at `374df9d`.

---

### Task 1: Model changes — `client_nonce` and `ChannelMember.project`

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/models.rs:186-203` (`TaskflowAgentChannelMember`), `:205-228` (`TaskflowAgentMessage`)

**Interfaces:**
- Produces: `TaskflowAgentMessage.client_nonce: Option<String>`; `TaskflowAgentChannelMember.project: ForeignKey<TaskflowProject>`. Tasks 2, 3, 4 and 5 all depend on both fields existing.

`TaskflowAgentChannelMember` currently has no `project` — that is exactly why it sits on the global `taskflow:agents` group today (see the comment at `backend/src/realtime.rs:64-66`). Denormalizing `project` onto it mirrors what `TaskflowAgentMessage` already does for the same reason.

- [ ] **Step 1: Add `client_nonce` to `TaskflowAgentMessage`**

In `backend/plugins/taskflow-agents/src/models.rs`, inside `TaskflowAgentMessage`, immediately after the `priority` field and before `created_at`:

```rust
    /// Client-generated correlation id. The sender renders its bubble
    /// optimistically keyed by this value, then reconciles whichever arrives
    /// first — the SSE echo or the POST response. Also the idempotency key:
    /// re-posting the same nonce to the same channel returns the stored row.
    #[umbral(string, max_length = 64)]
    pub client_nonce: Option<String>,
```

- [ ] **Step 2: Add `project` to `TaskflowAgentChannelMember`**

In the same file, inside `TaskflowAgentChannelMember`, immediately after `id` and before `channel`:

```rust
    /// Denormalized from `channel.project` so realtime can route membership
    /// events to a per-project group. `TaskflowAgentMessage` denormalizes
    /// `project` for the same reason.
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
```

`TaskflowProject` is already imported in this file (used by `TaskflowAgent`). Confirm the import is present rather than adding a duplicate:

Run: `grep -n "use taskflow_projects" backend/plugins/taskflow-agents/src/models.rs`
Expected: a line importing `TaskflowProject`. If absent, add `use taskflow_projects::models::TaskflowProject;`.

- [ ] **Step 3: Compile**

Run: `cd backend && cargo check -p taskflow-agents`
Expected: PASS.

- [ ] **Step 4: Delete the comment that the `project` field just obsoleted**

`backend/src/realtime.rs:64-66` says channel members "only carry `channel`, not `project`". That is now false. Leave the `.expose::<TaskflowAgentChannelMember>(Expose::to_group(AGENTS_GROUP))` line alone for now — Task 3 rewrites it — but delete the stale two-line comment above it so no one reads it as current.

- [ ] **Step 5: Migrate**

The dev DB may already hold `taskflow_agent_channel_member` rows. `project` is NOT NULL with no default, which SQLite cannot add to a populated table.

Run: `cd backend && ls -la backend.db && sqlite3 backend.db "select count(*) from taskflow_agent_channel_member;" 2>/dev/null || echo "table absent or sqlite3 unavailable"`

- **If the count is 0 (or the table/DB is absent):** run `cargo run -- migrate` and expect success.
- **If the count is > 0:** the dev DB holds throwaway rows only. Recreate it:

```bash
cd backend
rm -f backend.db backend.db-shm backend.db-wal
cargo run -- migrate
```

Then verify the schema landed:

Run: `cd backend && sqlite3 backend.db ".schema taskflow_agent_channel_member" && sqlite3 backend.db ".schema taskflow_agent_message" | grep client_nonce`
Expected: `project` column present on the member table; `client_nonce` present on the message table.

- [ ] **Step 6: Commit**

```bash
git add backend/plugins/taskflow-agents/src/models.rs backend/src/realtime.rs
git commit -m "feat(agents): add message client_nonce and denormalize project onto channel members

client_nonce correlates the sender's optimistic bubble with the SSE echo and
doubles as an idempotency key. ChannelMember.project mirrors the existing
denormalization on TaskflowAgentMessage so realtime can route membership
events per-project instead of to a global cross-tenant group."
```

---

### Task 2: Send endpoint — server-derived sender, membership gate, idempotency

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/views.rs` (currently 5 lines: just `health`)
- Modify: `backend/plugins/taskflow-agents/src/urls.rs:16` (currently only the health route)
- Modify: `backend/plugins/taskflow-agents/Cargo.toml` (add `serde_json`)
- Test: `backend/plugins/taskflow-agents/tests/send_message.rs` (create)

**Interfaces:**
- Consumes: `TaskflowAgentMessage.client_nonce`, `TaskflowAgentChannelMember.project` (Task 1).
- Produces: `POST /api/taskflow/agents/messages` accepting `{channel: i64, body_markdown: String, priority: Option<String>, client_nonce: Option<String>}` and returning the created `TaskflowAgentMessage` as JSON. Task 6 calls it.

Today `sendLiveMessage` (`v2_fe/src/App.tsx:4884`) posts `sender_kind`, `sender_user`, and `sender_label` in the body to unscoped auto-REST — any authenticated user can post as anyone, into any channel. This endpoint takes that decision away from the client.

- [ ] **Step 1: Write the failing tests**

Create `backend/plugins/taskflow-agents/tests/send_message.rs`:

```rust
//! The send endpoint is the only trusted write path for messages: it derives
//! the sender from the authenticated identity and refuses non-members.

use serde_json::json;

mod support;
use support::{TestApp, seed_channel_with_member, seed_channel_without_member};

#[tokio::test]
async fn derives_sender_from_identity_and_ignores_client_claims() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    // The client lies about who it is. The server must not believe it.
    let response = app
        .post_as(user, "/api/taskflow/agents/messages", json!({
            "channel": channel,
            "body_markdown": "hello",
            "sender_label": "Totally The CEO",
            "sender_user": 9999,
            "sender_kind": "agent",
        }))
        .await;

    assert_eq!(response.status(), 200);
    let row = response.json().await;
    assert_eq!(row["sender_user"], json!(user));
    assert_eq!(row["sender_kind"], json!("user"));
    assert_ne!(row["sender_label"], json!("Totally The CEO"));
}

#[tokio::test]
async fn rejects_non_member_with_403() {
    let app = TestApp::new().await;
    let (channel, outsider) = seed_channel_without_member(&app).await;

    let response = app
        .post_as(outsider, "/api/taskflow/agents/messages", json!({
            "channel": channel,
            "body_markdown": "let me in",
        }))
        .await;

    assert_eq!(response.status(), 403);
}

#[tokio::test]
async fn rejects_unknown_channel_with_404() {
    let app = TestApp::new().await;
    let (_, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(user, "/api/taskflow/agents/messages", json!({
            "channel": 999999,
            "body_markdown": "into the void",
        }))
        .await;

    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn rejects_empty_body_with_400() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(user, "/api/taskflow/agents/messages", json!({
            "channel": channel,
            "body_markdown": "   ",
        }))
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn same_nonce_twice_inserts_once_and_returns_the_stored_row() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;
    let body = json!({
        "channel": channel,
        "body_markdown": "only once",
        "client_nonce": "nonce-abc-123",
    });

    let first = app.post_as(user, "/api/taskflow/agents/messages", body.clone()).await;
    let second = app.post_as(user, "/api/taskflow/agents/messages", body).await;

    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(first.json().await["id"], second.json().await["id"]);
    assert_eq!(app.count_messages(channel).await, 1);
}

#[tokio::test]
async fn derives_project_from_the_channel() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let response = app
        .post_as(user, "/api/taskflow/agents/messages", json!({
            "channel": channel,
            "body_markdown": "scoped",
            "project": 4242,          // client-supplied project is ignored
        }))
        .await;

    let row = response.json().await;
    assert_eq!(row["project"], json!(app.project_of_channel(channel).await));
}
```

- [ ] **Step 2: Write the test support harness**

Create `backend/plugins/taskflow-agents/tests/support/mod.rs`. This app has no test harness yet, so this is the first one — check what `umbral-testing` offers before hand-rolling:

Run: `grep -rn "pub fn \|pub struct \|pub async fn " ~/.cargo/registry/src/*/umbral-testing-0.0.10/src/lib.rs | head -30`

Build `TestApp` on top of whatever it provides, exposing exactly these four methods (the tests above depend on these signatures):

```rust
impl TestApp {
    pub async fn new() -> Self;
    pub async fn post_as(&self, user_id: i64, path: &str, body: serde_json::Value) -> TestResponse;
    pub async fn count_messages(&self, channel: i64) -> i64;
    pub async fn project_of_channel(&self, channel: i64) -> i64;
}

// TestResponse needs: .status() -> u16, .json() -> serde_json::Value
pub async fn seed_channel_with_member(app: &TestApp) -> (i64, i64);     // (channel_id, member_user_id)
pub async fn seed_channel_without_member(app: &TestApp) -> (i64, i64);  // (channel_id, outsider_user_id)
```

If `umbral-testing` does not expose an in-process app builder, back the harness with a real bound server on an ephemeral port plus a `reqwest` client, and an in-memory SQLite URL (`sqlite::memory:`) so tests never touch `backend.db`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-agents --test send_message`
Expected: FAIL — the route does not exist, so every test 404s (and `send_message.rs` won't compile until `support` exists).

- [ ] **Step 4: Add `serde_json` to the plugin**

In `backend/plugins/taskflow-agents/Cargo.toml`, under `[dependencies]`:

```toml
serde_json = "1"
```

And under a new `[dev-dependencies]`:

```toml
umbral-testing = "0.0.10"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

- [ ] **Step 5: Implement the handler**

Replace the whole of `backend/plugins/taskflow-agents/src/views.rs` with:

```rust
//! HTTP handlers for the `taskflow-agents` plugin.

use serde::Deserialize;
use umbral::orm::Model;
use umbral::web::{Json, StatusCode};
use umbral_auth::Identity;

use crate::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage,
    TaskflowChannelMemberKind, TaskflowMessagePriority,
};

pub async fn health() -> &'static str {
    "taskflow-agents:ok"
}

/// The client says what it wants to say — never who it is. Sender identity,
/// project scope, and membership are all resolved server-side.
#[derive(Debug, Deserialize)]
pub struct SendMessageInput {
    pub channel: i64,
    pub body_markdown: String,
    #[serde(default)]
    pub priority: Option<TaskflowMessagePriority>,
    #[serde(default)]
    pub client_nonce: Option<String>,
}

pub async fn send_message(
    identity: Identity,
    Json(input): Json<SendMessageInput>,
) -> Result<Json<TaskflowAgentMessage>, StatusCode> {
    let body = input.body_markdown.trim();
    if body.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.chars().count() > 20_000 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let channel = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(input.channel))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    // Idempotency: the same nonce in the same channel is the same message.
    // A retry after a dropped response must not double-post.
    if let Some(nonce) = input.client_nonce.as_deref().filter(|n| !n.is_empty()) {
        let existing = TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::CHANNEL.eq(channel.id))
            .filter(taskflow_agent_message::CLIENT_NONCE.eq(nonce))
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(row) = existing {
            return Ok(Json(row));
        }
    }

    // Membership is the authorization boundary: you may only speak in rooms
    // you have joined.
    let member = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::CHANNEL.eq(channel.id))
        .filter(taskflow_agent_channel_member::USER.eq(identity.user_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    let message = TaskflowAgentMessage {
        id: 0,
        project: channel.project.clone(),
        channel: channel.id.into(),
        task: channel.task.clone(),
        sender_kind: TaskflowChannelMemberKind::User,
        sender_user: Some(identity.user_id.into()),
        sender_agent: None,
        sender_label: member.display_name.clone(),
        body_markdown: body.to_string(),
        priority: input.priority.unwrap_or(TaskflowMessagePriority::Normal),
        client_nonce: input.client_nonce.clone(),
        created_at: None,
    }
    .save()
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(message))
}
```

Adjust the ORM query syntax, the `Identity` extractor, and the `save()` return shape to whatever this Umbral version actually exposes — check a working example first:

Run: `grep -rn "objects()" /home/dalmas/E/projects/umbra/examples --include=*.rs | head -10`
Run: `grep -rn "Identity" /home/dalmas/E/projects/umbra/plugins/umbral-auth/src/lib.rs | grep -i "extract\|FromRequest" | head -5`

**Note on agent senders:** this handler only derives `sender_kind: User`. Agents authenticate by API key, and wiring that branch is the agents/MCP sub-project's job — an agent posting is not a flow this app can exercise yet. Do not stub it speculatively; a `sender_kind: Agent` branch with no caller is dead code that will rot.

- [ ] **Step 6: Register the route**

In `backend/plugins/taskflow-agents/src/urls.rs`, replace the `router()` body:

```rust
use umbral::web::{Router, get, post};

use crate::views;

pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/agents/health", get(views::health))
        // The only trusted write path for messages. Auto-REST's
        // POST /api/taskflow_agent_message/ lets the client assert its own
        // sender fields; this route derives them.
        .route("/api/taskflow/agents/messages", post(views::send_message))
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-agents --test send_message`
Expected: PASS — 6 tests.

- [ ] **Step 8: Commit**

```bash
git add backend/plugins/taskflow-agents/
git commit -m "feat(agents): add trusted send-message endpoint

POST /api/taskflow/agents/messages derives sender_kind/sender_user/
sender_label from the authenticated identity, derives project from the
channel, and 403s callers who have not joined the channel. Idempotent on
(channel, client_nonce) so a retry cannot double-post.

Auto-REST previously let any authenticated user post as any user or agent
into any channel."
```

---

### Task 3: Realtime — per-table groups, chat projections, presence

**Files:**
- Modify: `backend/src/realtime.rs` (whole file)
- Test: `backend/tests/realtime_routing.rs` (create)

**Interfaces:**
- Consumes: `TaskflowAgentChannelMember.project` (Task 1).
- Produces: groups `project:{id}:{suffix}` per the spec's suffix table, and `project:{id}:presence`. Task 6's `taskflowGroups` builder must produce byte-identical strings.

This is the root-cause fix. `Expose` sends the action as the event name with an id-only payload, and the client's `model(name, …)` ignores `name` — so one shared group means every handler fires for every table.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/realtime_routing.rs`:

```rust
//! Regression test for the root-cause bug: a message event must not reach a
//! subscriber watching tasks. Before per-table groups, all 13 project-scoped
//! models shared `project:{id}` and every client handler fired on every event.

use serde_json::json;

#[test]
fn message_and_task_route_to_different_groups() {
    let message_group = backend::realtime::group_for("messages", &json!({"project": 7}));
    let task_group = backend::realtime::group_for("tasks", &json!({"project": 7}));

    assert_eq!(message_group, "project:7:messages");
    assert_eq!(task_group, "project:7:tasks");
    assert_ne!(message_group, task_group);
}

#[test]
fn accepts_the_fk_shapes_the_orm_actually_emits() {
    // project arrives as a bare number, a string, or {id: N} depending on
    // serialization — value_to_group_id already handles all three.
    assert_eq!(backend::realtime::group_for("messages", &json!({"project": 7})), "project:7:messages");
    assert_eq!(backend::realtime::group_for("messages", &json!({"project": "7"})), "project:7:messages");
    assert_eq!(backend::realtime::group_for("messages", &json!({"project": {"id": 7}})), "project:7:messages");
}

#[test]
fn falls_back_to_the_projects_group_when_project_is_missing() {
    assert_eq!(backend::realtime::group_for("messages", &json!({})), "taskflow:projects");
}

#[test]
fn group_policy_accepts_per_table_groups_and_presence() {
    assert!(backend::realtime::can_join_group("project:7:messages"));
    assert!(backend::realtime::can_join_group("project:7:presence"));
    assert!(backend::realtime::can_join_group("taskflow:projects"));
    assert!(!backend::realtime::can_join_group("project:"));
    assert!(!backend::realtime::can_join_group("nonsense"));
    // The global agents group is retired — it was a cross-tenant fanout.
    assert!(!backend::realtime::can_join_group("taskflow:agents"));
}
```

This requires `backend` to be usable as a library. Check:

Run: `grep -n "\[lib\]\|\[\[bin\]\]" backend/Cargo.toml`

If there is no `[lib]`, add one alongside the existing binary:

```toml
[lib]
name = "backend"
path = "src/lib.rs"
```

…and create `backend/src/lib.rs` re-exporting the modules `main.rs` already declares (`pub mod realtime;` at minimum). Keep `main.rs` as the binary. If that restructure fights the existing `main.rs` module layout, put the tests in `backend/src/realtime.rs` as a `#[cfg(test)] mod tests` block instead and drop the `backend::` prefix — the assertions are what matter, not their location.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && cargo test --test realtime_routing`
Expected: FAIL — `group_for` and `can_join_group` do not exist.

- [ ] **Step 3: Rewrite `backend/src/realtime.rs`**

```rust
//! Realtime wiring for the TaskFlow workspace API.
//!
//! The browser subscribes over the Umbral realtime helper at `/realtime/client.js`.
//!
//! **Why per-table groups.** `Expose` sends the *action* as the event name
//! ("created"/"updated"/"deleted") with a projected payload; the table name
//! never reaches the wire, and the client's `model(name, …)` treats `name` as a
//! label only. So a single shared `project:{id}` group means every subscriber
//! receives every model's events and cannot tell them apart — ids collide
//! across tables. The group carries the discriminator instead:
//! `project:{id}:{suffix}`.
//!
//! Chat tables project their fields so the frontend renders straight from the
//! event. Everything else stays id-only and is refetched over authenticated
//! REST — projected columns reach every group member, and the group policy
//! below still admits any authenticated user to any project room.

use serde_json::Value;
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentCredential,
    TaskflowAgentMessage, TaskflowAgentSession, TaskflowAgentTerminalFrame,
};
use taskflow_projects::models::{
    TaskflowProject, TaskflowProjectApiEndpoint, TaskflowProjectInvite, TaskflowProjectMember,
};
use taskflow_tasks::models::{
    TaskflowTask, TaskflowTaskActivity, TaskflowTaskRelation, TaskflowTaskSession,
};
use umbral_realtime::{Expose, PresenceSpec, RealtimePlugin};

const PROJECTS_GROUP: &str = "taskflow:projects";

/// Group suffixes. These strings are a contract with the frontend's
/// `taskflowGroups` builder in `v2_fe/src/lib/taskflow-api.ts` — they are short
/// labels, not table names, and the two lists must stay identical.
const MESSAGES: &str = "messages";
const CHANNELS: &str = "channels";
const CHANNEL_MEMBERS: &str = "channel_members";
const TASKS: &str = "tasks";
const TASK_RELATIONS: &str = "task_relations";
const TASK_ACTIVITY: &str = "task_activity";
const TASK_SESSIONS: &str = "task_sessions";
const AGENTS: &str = "agents";
const AGENT_SESSIONS: &str = "agent_sessions";
const AGENT_CREDENTIALS: &str = "agent_credentials";
const TERMINAL_FRAMES: &str = "terminal_frames";
const PROJECT_MEMBERS: &str = "project_members";
const PROJECT_INVITES: &str = "project_invites";
const API_ENDPOINTS: &str = "api_endpoints";
const PRESENCE: &str = "presence";

/// Fields the chat tables put on the wire. Whitelists, not `all_fields()` —
/// every column named here is visible to everyone in the room.
const MESSAGE_FIELDS: &[&str] = &[
    "id", "project", "channel", "task", "client_nonce", "sender_kind", "sender_user",
    "sender_agent", "sender_label", "body_markdown", "priority", "created_at",
];
const CHANNEL_FIELDS: &[&str] = &[
    "id", "project", "title", "topic", "kind", "task", "archived", "created_at",
];
const CHANNEL_MEMBER_FIELDS: &[&str] = &[
    "id", "project", "channel", "member_kind", "user", "agent", "display_name", "role", "joined_at",
];

/// Build the configured realtime plugin.
pub fn plugin() -> RealtimePlugin {
    RealtimePlugin::new()
        // The SPA uses bearer tokens for REST, so accept the same Authorization
        // header for SSE/WS handshakes. Session cookies still work for /admin.
        .identity_resolver(|headers| async move {
            umbral_auth::resolve_identity(&headers)
                .await
                .map(|identity| identity.user_id)
        })
        // Still permissive: any authenticated user may join any project room.
        // Row-level membership checks land with the permissions sub-project.
        .group_policy_fn(|user, group| user.is_some() && can_join_group(group))
        // Presence gets its own group. Matching every `project:` prefix would
        // now spin up one presence set per table.
        .with_presence(PresenceSpec::matching(|group| {
            group.starts_with("project:") && group.ends_with(":presence")
        }))
        // Project list changes. Id-only; clients refetch via REST.
        .expose::<TaskflowProject>(Expose::to_group(PROJECTS_GROUP))
        // Chat: fields projected so the frontend never refetches.
        .expose::<TaskflowAgentMessage>(
            Expose::to_group_with(|ev| group_for(MESSAGES, &ev.instance)).fields(MESSAGE_FIELDS),
        )
        .expose::<TaskflowAgentChannel>(
            Expose::to_group_with(|ev| group_for(CHANNELS, &ev.instance)).fields(CHANNEL_FIELDS),
        )
        .expose::<TaskflowAgentChannelMember>(
            Expose::to_group_with(|ev| group_for(CHANNEL_MEMBERS, &ev.instance))
                .fields(CHANNEL_MEMBER_FIELDS),
        )
        // Everything else: id-only, client refetches the one row that changed.
        .expose::<TaskflowProjectMember>(Expose::to_group_with(|ev| group_for(PROJECT_MEMBERS, &ev.instance)))
        .expose::<TaskflowProjectInvite>(Expose::to_group_with(|ev| group_for(PROJECT_INVITES, &ev.instance)))
        .expose::<TaskflowProjectApiEndpoint>(Expose::to_group_with(|ev| group_for(API_ENDPOINTS, &ev.instance)))
        .expose::<TaskflowTask>(Expose::to_group_with(|ev| group_for(TASKS, &ev.instance)))
        .expose::<TaskflowTaskRelation>(Expose::to_group_with(|ev| group_for(TASK_RELATIONS, &ev.instance)))
        .expose::<TaskflowTaskActivity>(Expose::to_group_with(|ev| group_for(TASK_ACTIVITY, &ev.instance)))
        .expose::<TaskflowTaskSession>(Expose::to_group_with(|ev| group_for(TASK_SESSIONS, &ev.instance)))
        .expose::<TaskflowAgent>(Expose::to_group_with(|ev| group_for(AGENTS, &ev.instance)))
        .expose::<TaskflowAgentCredential>(Expose::to_group_with(|ev| group_for(AGENT_CREDENTIALS, &ev.instance)))
        .expose::<TaskflowAgentSession>(Expose::to_group_with(|ev| group_for(AGENT_SESSIONS, &ev.instance)))
        .expose::<TaskflowAgentTerminalFrame>(Expose::to_group_with(|ev| group_for(TERMINAL_FRAMES, &ev.instance)))
}

/// `project:{id}:{suffix}` for a row carrying a `project` FK, else the
/// project-level group.
pub fn group_for(suffix: &str, instance: &Value) -> String {
    instance
        .get("project")
        .and_then(value_to_group_id)
        .map(|id| format!("project:{id}:{suffix}"))
        .unwrap_or_else(|| PROJECTS_GROUP.to_string())
}

/// Which groups a client may join. Extracted so it is testable without a
/// running server.
pub fn can_join_group(group: &str) -> bool {
    if group == PROJECTS_GROUP {
        return true;
    }
    let Some(rest) = group.strip_prefix("project:") else {
        return false;
    };
    let Some((id, suffix)) = rest.split_once(':') else {
        return false;
    };
    !id.is_empty() && ALL_SUFFIXES.contains(&suffix)
}

const ALL_SUFFIXES: &[&str] = &[
    MESSAGES, CHANNELS, CHANNEL_MEMBERS, TASKS, TASK_RELATIONS, TASK_ACTIVITY, TASK_SESSIONS,
    AGENTS, AGENT_SESSIONS, AGENT_CREDENTIALS, TERMINAL_FRAMES, PROJECT_MEMBERS, PROJECT_INVITES,
    API_ENDPOINTS, PRESENCE,
];

fn value_to_group_id(value: &Value) -> Option<String> {
    match value {
        Value::Number(n) => n.as_i64().map(|id| id.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(obj) => obj.get("id").and_then(value_to_group_id),
        _ => None,
    }
}
```

Note what this deletes: `AGENTS_GROUP` (`taskflow:agents`) is gone. It existed only because `ChannelMember` had no `project`, and it fanned every project's membership events out to every authenticated user.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && cargo test --test realtime_routing`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify the whole backend still builds**

Run: `cd backend && cargo check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/realtime.rs backend/tests/realtime_routing.rs backend/Cargo.toml backend/src/lib.rs
git commit -m "fix(realtime): route each model to its own per-project group

Expose sends the action as the event name with an id-only payload, and the
client's model(name,...) ignores name entirely -- so 13 models sharing
project:{id} meant every subscriber received every model's events with no way
to tell them apart. The group now carries the discriminator.

Chat tables project their fields so the frontend renders from the event
instead of refetching. Presence moves to project:{id}:presence, which stops
it matching all 14 per-table groups. The global taskflow:agents group is
retired -- ChannelMember.project makes per-project routing possible, ending a
cross-tenant membership fanout."
```

---

### Task 4: Seed a real chat workspace

**Files:**
- Create: `backend/src/seed/chat.rs`
- Modify: `backend/src/seed/mod.rs`

**Interfaces:**
- Consumes: `TaskflowAgentChannelMember.project` (Task 1).
- Produces: `seed::chat()` — one project, one channel, and a member row for the seeded dev user. Task 8 deletes the frontend fixtures, so without this dev boots into a genuinely empty screen.

`seed::all()` currently runs only `credentials::test_credentials()`.

- [ ] **Step 1: Read the existing seed step to copy its idempotency pattern**

Run: `cat backend/src/seed/credentials.rs`

Every seed step short-circuits on a non-empty table (see the `all()` doc comment in `seed/mod.rs`). Match that shape exactly.

- [ ] **Step 2: Write `backend/src/seed/chat.rs`**

```rust
//! A minimal live chat workspace so a fresh dev DB has something real to
//! render. The frontend has no fixtures — what you see here is what you get.

use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowChannelKind,
    TaskflowChannelMemberKind,
};
use taskflow_projects::models::TaskflowProject;
use umbral::orm::Model;

/// Idempotent: short-circuits if any channel already exists.
pub async fn dev_workspace() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if TaskflowAgentChannel::objects().count().await? > 0 {
        return Ok(());
    }

    let Some(user) = first_dev_user().await? else {
        // credentials::test_credentials() runs first; if there is no user we
        // have nothing to make a member of, so leave the DB alone rather than
        // seeding a channel nobody can post to.
        return Ok(());
    };

    let project = TaskflowProject {
        id: 0,
        name: "TaskFlow v2".to_string(),
        slug: "taskflow-v2".to_string(),
        ..Default::default()
    }
    .save()
    .await?;

    let channel = TaskflowAgentChannel {
        id: 0,
        project: project.id.into(),
        title: "Project room".to_string(),
        topic: Some("Shared room for this project.".to_string()),
        kind: TaskflowChannelKind::Project,
        task: None,
        created_by_user: Some(user.id.into()),
        created_by_agent: None,
        archived: false,
        created_at: None,
    }
    .save()
    .await?;

    TaskflowAgentChannelMember {
        id: 0,
        project: project.id.into(),
        channel: channel.id.into(),
        member_kind: TaskflowChannelMemberKind::User,
        user: Some(user.id.into()),
        agent: None,
        display_name: user.username.clone(),
        role: "member".to_string(),
        joined_at: None,
    }
    .save()
    .await?;

    Ok(())
}
```

Fill in `first_dev_user()` and the `TaskflowProject` construction against the real model — `TaskflowProject` has required fields beyond name/slug (`owner`, `status`, …) and may not implement `Default`. Check both before writing:

Run: `sed -n '72,96p' backend/plugins/taskflow-projects/src/models.rs`
Run: `grep -n "username\|pub id" backend/src/seed/credentials.rs`

- [ ] **Step 3: Register the step**

In `backend/src/seed/mod.rs`, add `pub mod chat;` beside `pub mod credentials;`, extend the module doc list with a `chat` line, and make `all()` run it **after** credentials (it needs the dev user):

```rust
pub async fn all() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    credentials::test_credentials().await?;
    chat::dev_workspace().await?;
    Ok(())
}
```

- [ ] **Step 4: Verify it seeds, and that it is idempotent**

```bash
cd backend
rm -f backend.db backend.db-shm backend.db-wal
cargo run -- migrate
timeout 20 cargo run &  # boots, auto-migrates, seeds
sleep 12 && kill %1 || true
sqlite3 backend.db "select count(*) from taskflow_agent_channel; select count(*) from taskflow_agent_channel_member;"
```
Expected: `1` and `1`.

Then boot a second time and re-count — the short-circuit must hold:

```bash
timeout 20 cargo run & ; sleep 12 && kill %1 || true
sqlite3 backend.db "select count(*) from taskflow_agent_channel;"
```
Expected: still `1`, not `2`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/seed/
git commit -m "feat(seed): seed a dev chat workspace

The frontend fixtures are being deleted, so a fresh DB needs a real project,
channel, and membership or dev boots into an empty screen. Idempotent, and
runs after credentials since it needs the dev user."
```

---

### Task 5: Regenerate the typed client

**Files:**
- Modify: `v2_fe/src/api/client.d.ts`, `v2_fe/src/api/client.js` (both generated — never hand-edit)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `TaskflowAgentMessage.client_nonce` and `TaskflowAgentChannelMember.project` in the generated types. Tasks 6–8 rely on both.

- [ ] **Step 1: Regenerate**

The header of `client.d.ts` gives the command:

```bash
cd backend && cargo run -- gen-client --out ../v2_fe/src/api
```

- [ ] **Step 2: Verify the new fields landed**

Run: `grep -n "client_nonce" v2_fe/src/api/client.d.ts`
Expected: present on `TaskflowAgentMessage` and `TaskflowAgentMessageCreate`.

Run: `grep -n "project" v2_fe/src/api/client.d.ts | grep -i "channelmember" -A2 -B2`
Expected: `project: number` on `TaskflowAgentChannelMember`.

- [ ] **Step 3: Typecheck the frontend against the new client**

Run: `cd v2_fe && npx tsc -b --noEmit`
Expected: errors *only* where `createChannelMember` omits the now-required `project` — Task 6 fixes those. Record the exact list; if anything else breaks, investigate before proceeding.

- [ ] **Step 4: Commit**

```bash
git add v2_fe/src/api/
git commit -m "chore(client): regenerate typed client for client_nonce and member.project"
```

---

### Task 6: Frontend API layer — per-table groups, no N+1, new send

**Files:**
- Modify: `v2_fe/src/lib/taskflow-api.ts` (lines 53-57, 123-166, 262-264, 302-325)

**Interfaces:**
- Consumes: Task 3's group strings; Task 2's endpoint; Task 5's types.
- Produces:
  - `taskflowGroups.projects: string`, `taskflowGroups.presence(projectId): string`, `taskflowGroups.forTable(table, projectId): string`
  - `sendTaskflowAgentMessage(input: SendMessageInput): Promise<TaskflowAgentMessage>` where `SendMessageInput = {channel: number; body_markdown: string; priority?: TaskflowAgentMessagePriority; client_nonce?: string}`
  - `subscribeToTaskflowWorkspaceEvents(projectId, onEvent)` — unchanged signature, correct behavior
  - `realtimeTablesWithInlineRows: readonly RealtimeTableName[]`

Task 8 depends on all of these.

- [ ] **Step 1: Replace `taskflowGroups` (lines 53-57)**

```ts
/// Group suffixes are a contract with backend/src/realtime.rs — short labels,
/// not table names. A mismatch fails silently: the subscription opens and
/// simply never fires.
const realtimeGroupSuffixes = {
  [taskflowTables.members]: "project_members",
  [taskflowTables.invites]: "project_invites",
  [taskflowTables.apiEndpoints]: "api_endpoints",
  [taskflowTables.tasks]: "tasks",
  [taskflowTables.taskRelations]: "task_relations",
  [taskflowTables.taskActivity]: "task_activity",
  [taskflowTables.taskSessions]: "task_sessions",
  [taskflowTables.agents]: "agents",
  [taskflowTables.agentCredentials]: "agent_credentials",
  [taskflowTables.agentSessions]: "agent_sessions",
  [taskflowTables.agentChannels]: "channels",
  [taskflowTables.agentChannelMembers]: "channel_members",
  [taskflowTables.agentMessages]: "messages",
  [taskflowTables.terminalFrames]: "terminal_frames",
} as const satisfies Record<Exclude<RealtimeTableName, typeof taskflowTables.projects>, string>

export const taskflowGroups = {
  projects: "taskflow:projects",
  presence: (projectId: number | string) => `project:${projectId}:presence`,
  forTable: (table: keyof typeof realtimeGroupSuffixes, projectId: number | string) =>
    `project:${projectId}:${realtimeGroupSuffixes[table]}`,
} as const
```

The `satisfies` is load-bearing: it makes a table added to `taskflowTables` without a suffix a compile error rather than a silent dead subscription.

- [ ] **Step 2: Declare which tables carry inline rows (after line 141)**

```ts
/// Chat tables project their fields (backend/src/realtime.rs), so their events
/// carry the whole row and need no refetch. Everything else is id-only.
export const realtimeTablesWithInlineRows = [
  taskflowTables.agentMessages,
  taskflowTables.agentChannels,
  taskflowTables.agentChannelMembers,
] as const satisfies readonly RealtimeTableName[]

export function realtimeEventHasInlineRow(table: RealtimeTableName): boolean {
  return (realtimeTablesWithInlineRows as readonly string[]).includes(table)
}
```

- [ ] **Step 3: Delete `agentGlobalRealtimeTables` and fold members into the project-scoped list**

Replace lines 123-141. `agentChannelMembers` now has `project` and routes per-project like everything else — the global `taskflow:agents` group no longer exists:

```ts
const projectScopedRealtimeTables = [
  taskflowTables.members,
  taskflowTables.invites,
  taskflowTables.apiEndpoints,
  taskflowTables.tasks,
  taskflowTables.taskRelations,
  taskflowTables.taskActivity,
  taskflowTables.taskSessions,
  taskflowTables.agents,
  taskflowTables.agentCredentials,
  taskflowTables.agentSessions,
  taskflowTables.agentChannels,
  taskflowTables.agentChannelMembers,
  taskflowTables.agentMessages,
  taskflowTables.terminalFrames,
] satisfies RealtimeTableName[]
```

- [ ] **Step 4: Fix the subscriptions (lines 302-325)**

```ts
export function subscribeToTaskflowWorkspace(projectId: number, onChange: () => void) {
  const subscriptions = projectScopedRealtimeTables.map((table) =>
    taskflowApi.on(table as TableName, onAnyModelChange(onChange), {
      group: taskflowGroups.forTable(table, projectId),
    })
  )
  return () => closeAll(subscriptions)
}

export function subscribeToTaskflowWorkspaceEvents(projectId: number, onEvent: (event: TaskflowRealtimeEvent) => void) {
  const subscriptions = projectScopedRealtimeTables.map((table) =>
    taskflowApi.on(table as TableName, onRealtimeModelChange(table, onEvent), {
      group: taskflowGroups.forTable(table, projectId),
    })
  )
  return () => closeAll(subscriptions)
}
```

Each table now listens on its own group, so `onRealtimeModelChange(table, …)`'s `table` label is finally true. Previously every subscription fired on every event and stamped it with whichever table it happened to be watching.

- [ ] **Step 5: Point `sendTaskflowAgentMessage` at the trusted endpoint (lines 262-264)**

```ts
/// What the client is allowed to say. sender_kind/sender_user/sender_label and
/// project are derived server-side from the authenticated identity and the
/// channel — the client cannot assert them.
export type SendMessageInput = {
  channel: number
  body_markdown: string
  priority?: TaskflowAgentMessage["priority"]
  client_nonce?: string
}

export async function sendTaskflowAgentMessage(input: SendMessageInput): Promise<TaskflowAgentMessage> {
  const token = getStoredToken()
  const response = await fetch(`${API_BASE_URL}/api/taskflow/agents/messages`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "You are not a member of this channel."
        : `Could not send the message (${response.status}).`
    )
  }
  return response.json()
}
```

Drop the now-unused `TaskflowAgentMessageCreate` import if nothing else uses it.

- [ ] **Step 6: Set `project` on created channel members**

`createTaskflowAgentChannelMember` now needs `project` (Task 5's typecheck flagged the call sites). Keep the thin wrapper as-is — the callers in `App.tsx` supply the field. Task 8 updates them.

- [ ] **Step 7: Typecheck**

Run: `cd v2_fe && npx tsc -b --noEmit`
Expected: remaining errors only in `App.tsx` at the `createChannelMember` call site and `sendTaskflowAgentMessage` call site — Task 8 fixes those.

- [ ] **Step 8: Commit**

```bash
git add v2_fe/src/lib/taskflow-api.ts
git commit -m "fix(fe): subscribe per-table and post messages to the trusted endpoint

14 subscriptions shared one project group, so every handler fired on every
event and fetchAndApplyRealtimeEvent issued up to 14 GETs per message against
tables that had not changed -- upserting unrelated rows that happened to share
an id. Each table now has its own group.

Messages post to /api/taskflow/agents/messages, which derives sender identity
server-side instead of trusting the request body."
```

---

### Task 7: The reconcile reducer, with tests

**Files:**
- Create: `v2_fe/src/lib/message-store.ts`
- Create: `v2_fe/src/lib/message-store.test.ts`
- Modify: `v2_fe/package.json`, `v2_fe/vite.config.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PendingMessage = { client_nonce: string; body_markdown: string; priority: TaskflowAgentMessage["priority"]; channel: number; status: "pending" | "failed" }
  export type ChatMessage = TaskflowAgentMessage | PendingMessage
  export function isPending(m: ChatMessage): m is PendingMessage
  export function addPending(messages: ChatMessage[], pending: PendingMessage): ChatMessage[]
  export function reconcile(messages: ChatMessage[], row: TaskflowAgentMessage): ChatMessage[]
  export function markFailed(messages: ChatMessage[], nonce: string): ChatMessage[]
  export function markRetrying(messages: ChatMessage[], nonce: string): ChatMessage[]
  export function findPending(messages: ChatMessage[], nonce: string): PendingMessage | undefined
  export function removeMessage(messages: ChatMessage[], id: number): ChatMessage[]
  ```
  Task 8 imports all of these.

This is the one place the SSE-echo-vs-POST-response race lives, it is a pure function, and the frontend has no tests at all today. That combination is why it gets the project's first vitest suite.

- [ ] **Step 1: Add vitest**

```bash
cd v2_fe && npm install -D vitest@^3
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Add to `vite.config.ts` (it already imports `defineConfig` from `vite`; switch the import to `vitest/config` so the `test` key typechecks):

```ts
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
```

- [ ] **Step 2: Write the failing tests**

Create `v2_fe/src/lib/message-store.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  addPending,
  findPending,
  isPending,
  markFailed,
  markRetrying,
  reconcile,
  removeMessage,
} from "./message-store"
import type { ChatMessage, PendingMessage } from "./message-store"
import type { TaskflowAgentMessage } from "@/api/client"

const pending = (nonce: string): PendingMessage => ({
  client_nonce: nonce,
  body_markdown: "hello",
  priority: "normal",
  channel: 1,
  status: "pending",
})

const row = (id: number, nonce: string | null): TaskflowAgentMessage => ({
  id,
  project: 1,
  channel: 1,
  task: null,
  client_nonce: nonce,
  sender_kind: "user",
  sender_user: 1,
  sender_agent: null,
  sender_label: "dev",
  body_markdown: "hello",
  priority: "normal",
  created_at: "2026-07-17T10:00:00Z",
})

describe("reconcile", () => {
  it("replaces the pending bubble when the SSE echo arrives first", () => {
    const messages: ChatMessage[] = addPending([], pending("n1"))
    const next = reconcile(messages, row(10, "n1"))

    expect(next).toHaveLength(1)
    expect(isPending(next[0])).toBe(false)
    expect((next[0] as TaskflowAgentMessage).id).toBe(10)
  })

  it("is a no-op when the POST response arrives after the echo already reconciled", () => {
    const messages: ChatMessage[] = addPending([], pending("n1"))
    const afterEcho = reconcile(messages, row(10, "n1"))
    const afterPost = reconcile(afterEcho, row(10, "n1"))

    expect(afterPost).toHaveLength(1)
    expect((afterPost[0] as TaskflowAgentMessage).id).toBe(10)
  })

  it("keeps the position of the pending bubble it replaces", () => {
    let messages: ChatMessage[] = [row(1, null)]
    messages = addPending(messages, pending("n1"))
    messages = [...messages, row(2, null)]

    const next = reconcile(messages, row(10, "n1"))

    expect(next.map((m) => (isPending(m) ? "pending" : m.id))).toEqual([1, 10, 2])
  })

  it("inserts a row from another sender that matches no pending bubble", () => {
    const next = reconcile([], row(10, null))

    expect(next).toHaveLength(1)
    expect((next[0] as TaskflowAgentMessage).id).toBe(10)
  })

  it("inserts a row whose nonce belongs to another client's pending bubble", () => {
    // A nonce we never issued: another tab sent it. Insert, do not reconcile.
    const next = reconcile(addPending([], pending("mine")), row(10, "theirs"))

    expect(next).toHaveLength(2)
  })

  it("updates in place when the same id arrives twice", () => {
    const first = reconcile([], row(10, null))
    const edited = { ...row(10, null), body_markdown: "edited" }
    const next = reconcile(first, edited)

    expect(next).toHaveLength(1)
    expect((next[0] as TaskflowAgentMessage).body_markdown).toBe("edited")
  })
})

describe("markFailed", () => {
  it("flips the pending bubble to failed and leaves it in place", () => {
    const next = markFailed(addPending([], pending("n1")), "n1")

    expect(next).toHaveLength(1)
    expect((next[0] as PendingMessage).status).toBe("failed")
  })
})

describe("retry", () => {
  it("finds the failed bubble by nonce so a retry can reuse its body", () => {
    const messages = markFailed(addPending([], pending("n1")), "n1")

    expect(findPending(messages, "n1")?.body_markdown).toBe("hello")
  })

  it("flips a failed bubble back to pending without duplicating it", () => {
    const failed = markFailed(addPending([], pending("n1")), "n1")
    const next = markRetrying(failed, "n1")

    expect(next).toHaveLength(1)
    expect((next[0] as PendingMessage).status).toBe("pending")
  })

  it("reconciles a retry to one row — the endpoint is idempotent on the nonce", () => {
    // Retry reuses the nonce, so the server returns the row the first attempt
    // actually saved. Two attempts, one bubble.
    let messages: ChatMessage[] = addPending([], pending("n1"))
    messages = markFailed(messages, "n1")
    messages = markRetrying(messages, "n1")
    messages = reconcile(messages, row(10, "n1"))

    expect(messages).toHaveLength(1)
    expect((messages[0] as TaskflowAgentMessage).id).toBe(10)
  })
})

describe("removeMessage", () => {
  it("drops a saved row by id and leaves pending bubbles alone", () => {
    const messages = addPending([row(10, null)], pending("n1"))
    const next = removeMessage(messages, 10)

    expect(next).toHaveLength(1)
    expect(isPending(next[0])).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd v2_fe && npm test`
Expected: FAIL — `./message-store` does not exist.

- [ ] **Step 4: Implement `v2_fe/src/lib/message-store.ts`**

```ts
import type { TaskflowAgentMessage } from "@/api/client"

/// A message the sender has typed but the server has not yet acknowledged.
/// Keyed by client_nonce, never by id — the server assigns ids, and the SSE
/// echo frequently beats the POST response on localhost, so an id-keyed
/// optimistic bubble cannot be matched against its own echo.
export type PendingMessage = {
  client_nonce: string
  body_markdown: string
  priority: TaskflowAgentMessage["priority"]
  channel: number
  status: "pending" | "failed"
}

export type ChatMessage = TaskflowAgentMessage | PendingMessage

export function isPending(message: ChatMessage): message is PendingMessage {
  return !("id" in message)
}

export function addPending(messages: ChatMessage[], pending: PendingMessage): ChatMessage[] {
  return [...messages, pending]
}

/// Fold a saved row in, from either the SSE echo or the POST response.
/// Order-independent by construction: match the pending bubble by nonce first,
/// then fall back to id, then insert. Whichever arrives second finds the row
/// already there and updates it in place.
export function reconcile(messages: ChatMessage[], row: TaskflowAgentMessage): ChatMessage[] {
  const byNonce = row.client_nonce
    ? messages.findIndex((m) => isPending(m) && m.client_nonce === row.client_nonce)
    : -1
  const index = byNonce >= 0 ? byNonce : messages.findIndex((m) => !isPending(m) && m.id === row.id)

  if (index < 0) return [...messages, row]
  return [...messages.slice(0, index), row, ...messages.slice(index + 1)]
}

export function markFailed(messages: ChatMessage[], nonce: string): ChatMessage[] {
  return setPendingStatus(messages, nonce, "failed")
}

/// Flip a failed bubble back to pending for a retry. The retry reuses the same
/// nonce, so the send endpoint's idempotency means a first attempt that
/// actually landed returns its stored row rather than posting twice.
export function markRetrying(messages: ChatMessage[], nonce: string): ChatMessage[] {
  return setPendingStatus(messages, nonce, "pending")
}

export function findPending(messages: ChatMessage[], nonce: string): PendingMessage | undefined {
  return messages.find((m): m is PendingMessage => isPending(m) && m.client_nonce === nonce)
}

function setPendingStatus(
  messages: ChatMessage[],
  nonce: string,
  status: PendingMessage["status"]
): ChatMessage[] {
  return messages.map((m) => (isPending(m) && m.client_nonce === nonce ? { ...m, status } : m))
}

export function removeMessage(messages: ChatMessage[], id: number): ChatMessage[] {
  return messages.filter((m) => isPending(m) || m.id !== id)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd v2_fe && npm test`
Expected: PASS — 11 tests.

- [ ] **Step 6: Commit**

```bash
git add v2_fe/src/lib/message-store.ts v2_fe/src/lib/message-store.test.ts v2_fe/package.json v2_fe/package-lock.json v2_fe/vite.config.ts
git commit -m "feat(fe): add nonce-keyed message reconcile reducer

Keys optimistic bubbles by client_nonce rather than a temp id, so the SSE echo
and the POST response reconcile to the same row in either order -- the echo
usually wins on localhost, which an id-keyed bubble cannot survive without a
duplicate flash.

First vitest suite in this frontend: the race lives here and the function is
pure."
```

---

### Task 8: App.tsx — one store, optimistic send, no fixtures

**Files:**
- Modify: `v2_fe/src/App.tsx` — realtime apply (~2206-2262), send/channel (~4830-4935), fixtures (~750-910), `mapLiveChannelMessages` (~1636-1659)

**Interfaces:**
- Consumes: Task 6's `taskflowGroups` / `sendTaskflowAgentMessage` / `realtimeEventHasInlineRow`; Task 7's `message-store` reducer.

The three-store split (`liveWorkspace.agentMessages`, `threadMessagesByAgent`, `channelMessagesById`) and the silent mock fallback collapse here.

- [ ] **Step 1: Skip the refetch for tables that carry inline rows**

In `fetchAndApplyRealtimeEvent` (~line 2206), before the `switch (event.table)`:

```ts
      // Chat tables project their fields server-side, so the event already
      // carries the row. Refetching it would be a round-trip for data we hold.
      if (realtimeEventHasInlineRow(event.table)) {
        applyRealtimeRow(event, event.row as never, projectId)
        return
      }
```

Then delete the `agentMessages`, `agentChannels`, and `agentChannelMembers` cases from the switch — they are now unreachable.

- [ ] **Step 2: Route message events through the reducer**

In `applyRealtimeRow`'s `case taskflowTables.agentMessages`, replace the `upsertById` call:

```ts
        case taskflowTables.agentMessages: {
          const message = row as TaskflowWorkspace["agentMessages"][number]
          if (message.project !== projectId) return
          applyWorkspaceUpdate(projectId, (workspace) => ({
            ...workspace,
            agentMessages: reconcile(workspace.agentMessages, message),
          }))
          break
        }
```

`TaskflowWorkspace["agentMessages"]` becomes `ChatMessage[]` — update the type in `taskflow-api.ts` and let the typechecker find the read sites.

In `applyRealtimeDeletion`, the `agentMessages` case must switch from the generic `removeById` to
`removeMessage` from the reducer: `removeById` is constrained to `T extends { id: number }`, and a
`PendingMessage` has no `id`, so it will not typecheck against `ChatMessage[]`.

- [ ] **Step 3: Rewrite `sendLiveMessage` (~4884)**

```ts
  const sendLiveMessage = async (
    chat: AgentChatContext,
    body: string,
    priority: MessagePriority,
    attachments: AgentAttachment[]
  ) => {
    const projectId = liveId(project.id)
    if (!projectId || !liveWorkspace) {
      throw new Error("Select a live project before sending project chat messages.")
    }

    const channelId = await ensureLiveChannel(chat)
    const nonce = crypto.randomUUID()
    const body_markdown = appendAttachmentMarkdown(body, attachments)

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: addPending(workspace.agentMessages, {
        client_nonce: nonce,
        body_markdown,
        priority: toLiveMessagePriority(priority),
        channel: channelId,
        status: "pending",
      }),
    }))

    try {
      const saved = await sendTaskflowAgentMessage({
        channel: channelId,
        body_markdown,
        priority: toLiveMessagePriority(priority),
        client_nonce: nonce,
      })
      // Reconcile the response as well as the SSE echo. Whichever lands first
      // wins and the other is a no-op — they key on the same nonce. Relying on
      // the echo alone would strand the bubble as pending whenever SSE is down,
      // even though the message saved fine.
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
      }))
    } catch (error) {
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce),
      }))
      throw error
    }
  }
```

The double-reconcile is safe by construction — Task 7's "no-op when the POST response arrives after the echo already reconciled" test is exactly this path.

- [ ] **Step 4: Set `project` on created channel members (~4847)**

`createChannelMember` must now pass `project: projectId`. Find its definition and thread the project id through — Task 5's typecheck named the exact call site.

- [ ] **Step 5: Delete the mock fallback**

- In `handleSendMessage` (~4907): delete the entire `if (liveWorkspace) { … } return` / mock-message branch, keeping only the live path. Without a workspace, surface the existing error rather than fabricating a message.
- Delete `threadMessagesByAgent` and `channelMessagesById` state and every read of them.
- Delete the `agentThreads` and `agentChannelThreads` fixtures (~750-910) and any helper only they used.

Run: `grep -n "threadMessagesByAgent\|channelMessagesById\|agentThreads\|agentChannelThreads" v2_fe/src/App.tsx`
Expected: no matches when done.

- [ ] **Step 6: Wire retry on a failed send**

A failed bubble needs a way back. This is what the endpoint's nonce idempotency is for — the retry
reuses the original nonce, so if the first attempt actually landed and only the response was lost, the
server returns the stored row instead of posting a second message.

```ts
  const retryLiveMessage = async (nonce: string) => {
    const failed = findPending(liveWorkspace?.agentMessages ?? [], nonce)
    if (!failed) return

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentMessages: markRetrying(workspace.agentMessages, nonce),
    }))

    try {
      const saved = await sendTaskflowAgentMessage({
        channel: failed.channel,
        body_markdown: failed.body_markdown,
        priority: failed.priority,
        client_nonce: nonce,          // same nonce: the send endpoint is idempotent
      })
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: reconcile(workspace.agentMessages, saved),
      }))
    } catch (error) {
      onWorkspaceUpdate((workspace) => ({
        ...workspace,
        agentMessages: markFailed(workspace.agentMessages, nonce),
      }))
      setMessageError(error instanceof Error ? error.message : "Could not send the message.")
    }
  }
```

Thread `retryLiveMessage` down to `AgentChatBubble` (~5441) and render a retry control on bubbles whose
`status` is `"failed"`.

- [ ] **Step 7: Fix the sort/order mismatch**

`fetchTaskflowWorkspace` orders `-created_at` DESC (`taskflow-api.ts:217`) and `mapLiveChannelMessages` re-sorts ASC (`App.tsx:1643-1648`). Change the fetch to `.orderBy("created_at", "id")` and keep the mapper's sort as the guard for realtime inserts. Pending bubbles have no `created_at` — sort them last, they are the newest thing in the room:

```ts
    .sort((a, b) => {
      if (isPending(a) && isPending(b)) return 0
      if (isPending(a)) return 1
      if (isPending(b)) return -1
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
      return aTime - bTime || a.id - b.id
    })
```

`mapLiveChannelMessages` must also map a `PendingMessage` to an `AgentMessage` with `status: "sending"` (or `"failed"`), so the bubble renders while unacknowledged.

- [ ] **Step 8: Typecheck and test**

Run: `cd v2_fe && npx tsc -b --noEmit && npm test`
Expected: both PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add v2_fe/src/App.tsx v2_fe/src/lib/taskflow-api.ts
git commit -m "refactor(fe): collapse chat onto one store and send optimistically

Messages lived in liveWorkspace.agentMessages, threadMessagesByAgent, and
channelMessagesById at once, with hardcoded fixtures as a silent fallback
whenever liveWorkspace was null -- so every render path had to ask whether it
was live or mock. Now there is one store and one path.

Chat realtime events carry the row inline, so the per-event refetch is gone."
```

---

### Task 9: Stop the file picker from lying

**Files:**
- Modify: `v2_fe/src/App.tsx:5061-5079` (`handleFileSelect`), and the attach control in the composer

`handleFileSelect` reads a `File` only for its name/size/type and synthesizes `path: /uploads/pending/${file.name}` — a path nothing serves and no agent can read. The file is never uploaded. There is no attachment model, no `FileField`, no `.media()` route, and no multipart handler in the backend (see the spec's out-of-scope list). A control that accepts a file and silently drops it is worse than an absent one.

URL and project-path attachments stay: they flatten to markdown links that genuinely resolve.

- [ ] **Step 1: Remove the file input and its handler**

Delete `handleFileSelect` and the `<input type="file">` it feeds. Replace the attach-file control with a disabled button carrying an honest tooltip — "File upload is coming soon" — rather than removing the affordance entirely, so the UI still shows where it will live.

- [ ] **Step 2: Check for orphans**

Run: `grep -n "attachmentKindFromFile\|formatBytes\|handleFileSelect" v2_fe/src/App.tsx`
Delete whatever is now unreferenced.

- [ ] **Step 3: Typecheck**

Run: `cd v2_fe && npx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add v2_fe/src/App.tsx
git commit -m "fix(fe): disable file attach instead of faking an upload

handleFileSelect fabricated /uploads/pending/<name> for a file that was never
uploaded and that no agent could read. The backend has no attachment model,
storage route, or multipart handler yet. Disabled with an honest affordance
until the attachments sub-project; URL and project-path attachments still
work, since those links resolve."
```

---

### Task 10: End-to-end verification

**Files:** none — this task proves the goal or sends us back.

Every prior task tested a piece. This one tests the claim: *one POST, one event, no refetch, no duplicate.*

- [ ] **Step 1: Boot both sides**

```bash
cd backend && cargo run &
cd v2_fe && npm run dev &
```

- [ ] **Step 2: Verify the traffic claim — the whole point of the rework**

Log in, open the project room, open DevTools → Network (filter: Fetch/XHR), clear it, and send one message.

Expected: **exactly one** request — `POST /api/taskflow/agents/messages`. Zero `GET /api/taskflow_agent_message/{id}`. Zero GETs against any other table.

If any `GET /api/taskflow_*` appears, the inline-row path in Task 8 Step 1 is not firing — do not proceed.

Before this rework the same action produced one POST plus up to 14 GETs, most against tables that had not changed.

- [ ] **Step 3: Verify the message renders once**

The bubble must appear immediately, then settle to its saved form without flashing, duplicating, or reordering. Watch for a duplicate that appears and vanishes — that means nonce reconcile is not matching.

- [ ] **Step 4: Verify the SSE stream carries the row**

DevTools → Network → the `/realtime/sse` request → EventStream.

Expected: an event named `created` whose data is the full message row — `body_markdown`, `sender_label`, `client_nonce`, and the rest. Not `{"id": 42}`.

- [ ] **Step 5: Verify cross-client delivery**

Open a second browser window logged in as the same user, in the same room. Send from window A.

Expected: the message appears in B within a beat, without B issuing any GET. B holds no pending bubble for that nonce, so it inserts by id.

- [ ] **Step 6: Verify no cross-table bleed**

With the room open, change a task (drag a card on the board in another tab).

Expected: no message-related request, no chat re-render. Previously this fired the chat subscription's handler and issued `GET /api/taskflow_agent_message/{task_id}` — fetching an unrelated message that happened to share the task's id, and upserting it into the room.

- [ ] **Step 7: Verify the sender cannot lie**

```bash
TOKEN="<copy from localStorage['taskflow.auth.token']>"
curl -s -X POST http://localhost:8000/api/taskflow/agents/messages \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"channel":1,"body_markdown":"am i the ceo","sender_label":"CEO","sender_user":9999,"sender_kind":"agent"}' | jq
```

Expected: `sender_label` is the caller's own display name, `sender_kind` is `"user"`, `sender_user` is the caller's id. The claims are ignored.

- [ ] **Step 8: Verify idempotency end-to-end**

Run the same curl twice with `"client_nonce":"dupe-test-1"`.

Expected: identical `id` both times, and one bubble in the UI.

- [ ] **Step 9: Verify the empty state is honest**

```bash
cd backend && rm -f backend.db backend.db-shm backend.db-wal && cargo run
```

Log in. Expected: the seeded project room, and **no fixture agents or fabricated threads**. If any chat content appears that Task 4 did not seed, a fixture survived Task 8 Step 5.

- [ ] **Step 10: Full check, then commit**

```bash
cd backend && cargo test && cargo check
cd v2_fe && npx tsc -b --noEmit && npm test && npm run lint
```
Expected: all PASS.

```bash
git commit --allow-empty -m "test: verify realtime messaging end-to-end

One POST, one SSE event carrying the row, zero refetches. No cross-table
handler bleed. Forged sender fields ignored. Nonce idempotency holds."
```

---

## Notes for the implementer

**The bug you are fixing, in one paragraph.** `umbral-realtime` sends `event: created` / `data: {"id": 42}` — the table name is never on the wire. The browser client's `model(name, handlers, {group})` documents `name` as "the model label, for readability only" and delegates to `subscribe(group, routes)`. So 14 subscriptions on `project:{id}` are 14 subscriptions to the same firehose. Each stamps incoming events with the table it *thinks* it watches, and the app then GETs that table by an id belonging to a different table. It usually succeeds, which is why this looks like "too many requests" rather than a crash.

**Do not "fix" this upstream mid-plan.** The framework's id-only default deserves a discriminator, and that is queued as its own piece of work. Changing a published crate under this app while also reworking the app doubles the surface under test.

**If a step's code does not match reality, trust reality.** The Rust in Tasks 2 and 4 is written against the models as read on 2026-07-17; the ORM query builder and `Identity` extractor syntax were not executed. Check `/home/dalmas/E/projects/umbra/examples` for a working call and follow it. The *intent* of each step is what must survive — the exact syntax is a best guess.
