# Trusted Channel Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move channel creation server-side into one atomic endpoint, so `Create` can be stripped from auto-REST on `taskflow_agent_channel` and `taskflow_agent_channel_member` — closing a hole where anyone could POST themselves onto a DM's roster.

**Architecture:** Three tasks, ordered so the app is never broken. Task 1 adds the endpoint (purely additive). Task 2 switches the frontend to it (works either way). Task 3 strips `Create` from auto-REST, which is only safe once nothing depends on it.

**Tech Stack:** Rust (axum, umbral ORM, `umbral::transaction`), TypeScript/React, Vitest.

## Global Constraints

- The caller is **always** added to the roster. This is what dissolves the bootstrap problem — nobody adds themselves to an empty DM, creation does.
- Every identity-bearing field is **derived, never accepted**: `project` from the validated input, `display_name` from the target's own project membership or the agent's record, `created_by_user` from the token.
- Caller must be an **active** project member (`ACTIVE_MEMBERSHIP = "active"`) → else 403.
- Each target user must be an active member of that project → else the `not_a_project_member_response()` 400 envelope (`views.rs:414`).
- Each target agent must belong to that project → else 400.
- Channel + roster land in **one `umbral::transaction`**, every insert `.on_tx(tx)`. Mirrors `create_project` (`taskflow-projects/src/views.rs:487`).
- `members: []` is legal — a channel with only its creator.
- `add_channel_member` is **not** modified. Its DM carve-out is correct for widening an existing DM.
- Rust commands run from `/home/dalmas/E/projects/local_task_tracker/backend`; TS from `.../v2_fe`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/plugins/taskflow-agents/src/views.rs` (modify) | `create_channel` handler + its input types |
| `backend/plugins/taskflow-agents/src/urls.rs` (modify) | Route registration |
| `backend/plugins/taskflow-agents/tests/create_channel.rs` (create) | Endpoint gates + atomicity |
| `v2_fe/src/lib/taskflow-api.ts` (modify) | `createTaskflowChannel` client function |
| `v2_fe/src/App.tsx` (modify) | `ensureLiveChannel` collapses to one call |
| `backend/src/rest.rs` (modify) | Strip `Create` from both tables |
| `backend/tests/rest_scope.rs` (modify) | The escalation POST is refused |

---

### Task 1: The trusted create-channel endpoint

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/views.rs` (add near `add_channel_member`, ~line 450)
- Modify: `backend/plugins/taskflow-agents/src/urls.rs`
- Test: `backend/plugins/taskflow-agents/tests/create_channel.rs` (create)

**Interfaces:**
- Consumes: `ACTIVE_MEMBERSHIP` (`views.rs:33`), `CHANNEL_ROLE_MEMBER` (`views.rs:399`), `not_a_project_member_response()` (`views.rs:414`), `TaskflowAgentChannel`, `TaskflowAgentChannelMember`, `TaskflowChannelKind`, `TaskflowChannelMemberKind`, `TaskflowProjectMember`, `TaskflowAgent` — all already imported in `views.rs`.
- Produces: `POST /api/taskflow/channels` → `201` with `{ ...channel, members: [...] }`.

- [ ] **Step 1: Write the failing tests**

Create `backend/plugins/taskflow-agents/tests/create_channel.rs`.

**The helpers that actually exist in this crate** (verified — do not invent
others): `TestApp::new()`, `app.create_user() -> i64` (support/mod.rs:189),
`seed_project() -> i64` (:477), `make_active_project_member(project, user)`
(:642), `app.post_as(user, path, body)` (:218). There is **no** `make_user` or
`seed_agent` here — `make_user` lives in `backend/tests/rest_scope.rs`, a
different crate.

An agent is created by minting one, and the response carries its id:

```rust
/// Create an agent in `project` and return its id. `POST /agents/link` returns
/// `agent_id` alongside the raw key; the tests here need the id, not the key.
async fn seed_agent_id(app: &TestApp, project: i64, label: &str) -> i64 {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(
            human,
            "/api/taskflow/agents/link",
            serde_json::json!({ "project": project, "display_name": label, "profile": label }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await["agent_id"].as_i64().expect("agent_id")
}
```

Note `link_agent` calls `ensure_project_room`, so minting an agent also creates a
shared project room. `count_channels` assertions must therefore compare against a
baseline taken *after* any agent is seeded, which the tests below do.

```rust
mod support;

use serde_json::json;
use support::*;

const CREATE: &str = "/api/taskflow/channels";

// 1. The happy path: the caller lands on the roster without asking.
#[tokio::test]
async fn creator_is_added_to_the_roster() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let other = app.create_user().await;
    make_active_project_member(project, other).await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "DM",
                "members": [{ "kind": "user", "user": other }]
            }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let row = response.json().await;
    let members = row["members"].as_array().expect("members array");
    assert_eq!(members.len(), 2, "creator + the named target");
    let user_ids: Vec<i64> = members.iter().filter_map(|m| m["user"].as_i64()).collect();
    assert!(user_ids.contains(&creator), "creator must be rostered");
    assert!(user_ids.contains(&other));
    assert_eq!(row["created_by_user"], json!(creator));
}

// 2. A channel with only its creator is legal.
#[tokio::test]
async fn an_empty_member_list_yields_a_channel_with_just_the_creator() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({ "project": project, "kind": "project", "title": "Room", "members": [] }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    assert_eq!(response.json().await["members"].as_array().unwrap().len(), 1);
}

// 3. Agents can be rostered — the gap that made the one-line fix impossible.
#[tokio::test]
async fn an_agent_can_be_added_at_creation() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let agent = seed_agent_id(&app, project, "Claude").await;

    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "Claude",
                "members": [{ "kind": "agent", "agent": agent }]
            }),
        )
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let members = response.json().await["members"].as_array().unwrap().clone();
    assert!(members.iter().any(|m| m["agent"].as_i64() == Some(agent)));
    assert!(members.iter().any(|m| m["user"].as_i64() == Some(creator)));
}

// 4. Caller gate: a non-member of the project cannot create in it.
#[tokio::test]
async fn a_non_member_cannot_create_a_channel() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let outsider = app.create_user().await;

    let response = app
        .post_as(
            outsider,
            CREATE,
            json!({ "project": project, "kind": "project", "title": "Nope", "members": [] }),
        )
        .await;

    assert_eq!(response.status(), 403);
}

// 5. Target gate: you cannot roster someone who is not in the project.
#[tokio::test]
async fn an_outsider_target_is_rejected_and_nothing_is_written() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let outsider = app.create_user().await;

    let before = app.count_channels(project).await;
    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "DM",
                "members": [{ "kind": "user", "user": outsider }]
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
    assert_eq!(response.json().await["code"], json!("not_a_project_member"));
    // Atomicity: the rejected target must not leave a half-built channel.
    assert_eq!(app.count_channels(project).await, before);
}

// 6. An agent from ANOTHER project cannot be rostered.
#[tokio::test]
async fn an_agent_from_another_project_is_rejected() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let elsewhere = seed_project().await;
    let creator = app.create_user().await;
    make_active_project_member(project, creator).await;
    let foreign_agent = seed_agent_id(&app, elsewhere, "Foreign").await;

    let before = app.count_channels(project).await;
    let response = app
        .post_as(
            creator,
            CREATE,
            json!({
                "project": project,
                "kind": "direct",
                "title": "DM",
                "members": [{ "kind": "agent", "agent": foreign_agent }]
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
    assert_eq!(app.count_channels(project).await, before);
}
```

Add to `backend/plugins/taskflow-agents/tests/support/mod.rs` if absent:

```rust
    /// Channels in a project — used to assert a rejected create wrote nothing.
    pub async fn count_channels(&self, project: i64) -> i64 {
        TaskflowAgentChannel::objects()
            .filter(taskflow_agent_channel::PROJECT.eq(project))
            .fetch()
            .await
            .unwrap_or_default()
            .len() as i64
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-agents --test create_channel`
Expected: FAIL — the route does not exist, so every case gets 404.

- [ ] **Step 3: Add the input types**

In `backend/plugins/taskflow-agents/src/views.rs`, above `add_channel_member`:

```rust
/// One roster entry a client may ask for at creation. Exactly one of `user` or
/// `agent` is meaningful, selected by `kind`; the other is ignored.
#[derive(Debug, Deserialize)]
pub struct CreateChannelMemberInput {
    pub kind: String,
    #[serde(default)]
    pub user: Option<i64>,
    #[serde(default)]
    pub agent: Option<i64>,
}

/// The channel to create. Identity is NOT a body field: the creator comes from
/// the token, and `project` is validated against the caller's own memberships
/// rather than trusted.
#[derive(Debug, Deserialize)]
pub struct CreateChannelInput {
    pub project: i64,
    pub kind: TaskflowChannelKind,
    pub title: String,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub task: Option<i64>,
    #[serde(default)]
    pub members: Vec<CreateChannelMemberInput>,
}
```

- [ ] **Step 4: Write the handler**

In the same file, after the input types:

```rust
/// `POST /api/taskflow/channels` — create a channel and its roster atomically.
///
/// Channel creation moved here for the same reason project creation did: a
/// channel row is meaningless without its membership, and creating the two in
/// separate client calls produced both an orphan-channel bug and a privilege
/// hole. `visible_channel_ids` decides DM access by READING the roster, so a
/// client-writable roster let anyone opt into any DM.
///
/// The caller is always added. That is not a convenience — it is what makes a
/// DM bootstrappable at all: `add_channel_member` requires an existing roster
/// row for Direct channels, which a brand-new DM has nobody to supply.
pub async fn create_channel(
    RequireAuth(caller_id): RequireAuth<i64>,
    Json(input): Json<CreateChannelInput>,
) -> Result<Response, StatusCode> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Caller gate: an active member of THIS project. Read from the table, never
    // trusted from the request.
    let caller_membership = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(input.project)
                & taskflow_project_member::USER.eq(caller_id)
                & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::FORBIDDEN)?;

    // Resolve every requested member BEFORE opening the transaction, so a bad
    // target is a clean 400 rather than a rollback. Each resolved entry carries
    // the display name from the server's own records — never the client's.
    struct Resolved {
        kind: TaskflowChannelMemberKind,
        user: Option<i64>,
        agent: Option<i64>,
        display_name: String,
        role: String,
    }

    let mut resolved: Vec<Resolved> = vec![Resolved {
        kind: TaskflowChannelMemberKind::User,
        user: Some(caller_id),
        agent: None,
        display_name: caller_membership.display_name.clone(),
        role: CHANNEL_ROLE_MEMBER.to_string(),
    }];

    for wanted in &input.members {
        match wanted.kind.as_str() {
            "user" => {
                let Some(user_id) = wanted.user else {
                    return Err(StatusCode::BAD_REQUEST);
                };
                if user_id == caller_id {
                    continue; // already rostered as the creator
                }
                let Some(member) = TaskflowProjectMember::objects()
                    .filter(
                        taskflow_project_member::PROJECT.eq(input.project)
                            & taskflow_project_member::USER.eq(user_id)
                            & taskflow_project_member::STATUS.eq(ACTIVE_MEMBERSHIP),
                    )
                    .first()
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                else {
                    return Ok(not_a_project_member_response());
                };
                resolved.push(Resolved {
                    kind: TaskflowChannelMemberKind::User,
                    user: Some(user_id),
                    agent: None,
                    display_name: member.display_name.clone(),
                    role: CHANNEL_ROLE_MEMBER.to_string(),
                });
            }
            "agent" => {
                let Some(agent_id) = wanted.agent else {
                    return Err(StatusCode::BAD_REQUEST);
                };
                let Some(agent) = TaskflowAgent::objects()
                    .filter(taskflow_agent::ID.eq(agent_id))
                    .first()
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                else {
                    return Err(StatusCode::BAD_REQUEST);
                };
                // An agent is pinned to one project by its credential; rostering
                // a foreign agent would hand it another project's traffic.
                if agent.project.id() != input.project {
                    return Err(StatusCode::BAD_REQUEST);
                }
                resolved.push(Resolved {
                    kind: TaskflowChannelMemberKind::Agent,
                    user: None,
                    agent: Some(agent_id),
                    display_name: agent.display_name.clone(),
                    role: "agent".to_string(),
                });
            }
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    }

    let project_id = input.project;
    let kind = input.kind;
    let topic = input.topic.clone();
    let task = input.task;

    // Atomic: the channel and every roster row land together or not at all. A
    // channel without its roster is invisible to its own creator and impossible
    // to join, which is exactly the orphan this replaces.
    let created = umbral::transaction(move |tx| {
        Box::pin(async move {
            let channel = TaskflowAgentChannel::objects()
                .on_tx(tx)
                .create(TaskflowAgentChannel {
                    id: 0,
                    project: ForeignKey::new(project_id),
                    title,
                    topic,
                    kind,
                    task: task.map(ForeignKey::new),
                    created_by_user: Some(ForeignKey::new(caller_id)),
                    created_by_agent: None,
                    archived: false,
                    created_at: None,
                })
                .await?;

            let mut rows = Vec::with_capacity(resolved.len());
            for entry in resolved {
                rows.push(
                    TaskflowAgentChannelMember::objects()
                        .on_tx(tx)
                        .create(TaskflowAgentChannelMember {
                            id: 0,
                            project: ForeignKey::new(project_id),
                            channel: ForeignKey::new(channel.id),
                            member_kind: entry.kind,
                            user: entry.user.map(ForeignKey::new),
                            agent: entry.agent.map(ForeignKey::new),
                            display_name: entry.display_name,
                            role: entry.role,
                            joined_at: None,
                        })
                        .await?,
                );
            }
            Ok((channel, rows))
        })
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let (channel, members) = created;
    let mut value =
        serde_json::to_value(&channel).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("members".to_string(), json!(members));
    }
    Ok((StatusCode::CREATED, Json(value)).into_response())
}
```

- [ ] **Step 5: Register the route**

In `backend/plugins/taskflow-agents/src/urls.rs`, alongside the other trusted
writes:

```rust
        // The only authorized way to CREATE a channel. Auto-REST's
        // POST /api/taskflow_agent_channel/ creates a channel with no roster —
        // an orphan its own creator cannot see — and leaves the roster table
        // client-writable, which `visible_channel_ids` then trusts.
        .route("/api/taskflow/channels", post(views::create_channel))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-agents --test create_channel`
Expected: 6 tests pass.

- [ ] **Step 7: Run the full plugin suite**

Run: `cd backend && cargo test -p taskflow-agents`
Expected: no regressions. The endpoint is purely additive at this point.

- [ ] **Step 8: Commit**

```bash
git add backend/plugins/taskflow-agents/src/views.rs \
        backend/plugins/taskflow-agents/src/urls.rs \
        backend/plugins/taskflow-agents/tests/create_channel.rs \
        backend/plugins/taskflow-agents/tests/support/mod.rs
git commit -m "feat(channels): create a channel and its roster atomically

A channel row is meaningless without its membership, and the two were
created in separate client calls. That produced an orphan-channel bug --
a failed roster write leaves a channel its own creator cannot see, because
visible_channel_ids hides a DM with no roster row -- and a privilege hole,
since the roster table had to stay client-writable for creation to work at
all.

The caller is always added. That is not a convenience: add_channel_member
requires an existing roster row for Direct channels, so a brand-new DM has
nobody who can add anybody. Creation is the only place that gap can close.

Agents can be rostered here, which add_channel_member deliberately cannot
do -- it adds people, never agents. Both facts together are why the obvious
one-line fix (make the roster table read-only) breaks channel creation
instead of securing it."
```

---

### Task 2: Point the frontend at the new endpoint

**Files:**
- Modify: `v2_fe/src/lib/taskflow-api.ts`
- Modify: `v2_fe/src/App.tsx` (`ensureLiveChannel`, ~line 4585)

**Interfaces:**
- Consumes: `POST /api/taskflow/channels` from Task 1, returning `{ ...channel, members: [...] }`.
- Produces: `createTaskflowChannel(input): Promise<TaskflowAgentChannel & { members: TaskflowAgentChannelMember[] }>`.

- [ ] **Step 1: Add the client function**

In `v2_fe/src/lib/taskflow-api.ts`, near `createTaskflowAgentChannel`:

```ts
/// Create a channel and its roster in one authorized call. The caller is added
/// server-side, so `members` lists only the OTHER participants.
///
/// Replaces the create-then-write-members sequence: that was two client calls
/// with no transaction, so a failed member write left a channel nobody could
/// see, and it required the roster table to be client-writable — which is what
/// let anyone POST themselves onto someone else's DM.
export async function createTaskflowChannel(input: {
  project: number
  kind: "direct" | "project" | "task" | "incident"
  title: string
  topic?: string | null
  task?: number | null
  members: Array<{ kind: "user"; user: number } | { kind: "agent"; agent: number }>
}): Promise<TaskflowAgentChannel & { members: TaskflowAgentChannelMember[] }> {
  const response = await fetch(`${API_BASE_URL}/api/taskflow/channels`, {
    method: "POST",
    credentials: "include",
    headers: bearerHeaders(),
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(await readErrorDetail(response, `Could not create the channel (${response.status}).`))
  }
  return (await response.json()) as TaskflowAgentChannel & {
    members: TaskflowAgentChannelMember[]
  }
}
```

- [ ] **Step 2: Collapse `ensureLiveChannel`**

In `v2_fe/src/App.tsx`, replace the body of `ensureLiveChannel` — from
`const channel = await createTaskflowAgentChannel({` through
`return channel.id` — with:

```ts
    // The other participants; the server adds the caller. A DM is named for who
    // it is with: an agent DM rosters that agent, a human DM that person, and a
    // shared room every active member plus every agent.
    const members: Array<{ kind: "user"; user: number } | { kind: "agent"; agent: number }> = []
    if (chat.mode === "direct" && chat.liveMemberUserId) {
      members.push({ kind: "user", user: chat.liveMemberUserId })
    } else if (chat.mode === "direct") {
      const agentId = liveWorkspace.agents.find((c) => c.id === chat.liveAgentId)?.id ?? chat.liveAgentId
      if (agentId) members.push({ kind: "agent", agent: agentId })
    } else {
      for (const member of liveWorkspace.members) {
        if (member.status === "active" && member.user && member.user !== currentUser?.id) {
          members.push({ kind: "user", user: member.user })
        }
      }
      for (const agent of liveWorkspace.agents) members.push({ kind: "agent", agent: agent.id })
    }

    const channel = await createTaskflowChannel({
      project: projectId,
      kind: chat.mode === "direct" ? "direct" : "project",
      title: chat.mode === "direct" ? chat.title : "Project room",
      topic: chat.detail,
      members,
    })

    onWorkspaceUpdate((workspace) => ({
      ...workspace,
      agentChannels: upsertById(workspace.agentChannels, channel),
      agentChannelMembers: channel.members.reduce(
        (current, member) => upsertById(current, member),
        workspace.agentChannelMembers
      ),
    }))
    return channel.id
```

Then delete the now-unused `createChannelMember` helper (`App.tsx:4569-4583`)
and remove `createTaskflowAgentChannel` / `createTaskflowAgentChannelMember`
from the import list at the top if nothing else references them.

- [ ] **Step 3: Typecheck and lint**

Run: `cd v2_fe && npx tsc --noEmit && npm run lint 2>&1 | tail -2`
Expected: `tsc` exit 0. Lint reports **4 pre-existing errors** — that count must
not increase. (Baseline verified 2026-07-20: 4 errors in `App.tsx:2161`,
`message-attachments.tsx:730`, and `client.d.ts`.)

- [ ] **Step 4: Run the frontend tests**

Run: `cd v2_fe && npx vitest run`
Expected: 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add v2_fe/src/lib/taskflow-api.ts v2_fe/src/App.tsx
git commit -m "refactor(chat): create a channel in one authorized call

ensureLiveChannel created the channel, then wrote each roster row in a
separate request. Two client calls with no transaction between them, so a
failed member write left a channel its own creator could not see.

It also silently dropped members: addUser returned early when
currentUser?.id was falsy, with no error, so a channel could be created
without its creator on the roster and nothing said so.

Both are gone. The server adds the caller and every roster row inside one
transaction, and the response carries the members back so the workspace
updates from real rows rather than optimistic ones."
```

---

### Task 3: Strip `Create` from auto-REST

**Files:**
- Modify: `backend/src/rest.rs:282-285`
- Test: `backend/tests/rest_scope.rs`

**Interfaces:**
- Consumes: the endpoint from Task 1 and the frontend from Task 2 — nothing
  depends on auto-REST channel creation once those land.
- Produces: no new API.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/rest_scope.rs`, following its existing style
(`make_user(username, is_superuser)`, `make_project`, `make_member`, `get_as`,
`post_as`):

```rust
// The escalation this whole change exists to stop: visible_channel_ids decides
// DM access by READING the roster, so a client-writable roster let a project
// member opt into any DM with one POST.
#[tokio::test]
async fn a_member_cannot_post_themselves_onto_someone_elses_dm() {
    let seed = seed().await;
    let intruder = make_user("intruder", false).await;
    make_member(seed.project, intruder, TaskflowMembershipStatus::Active).await;

    let (status, _) = post_as(
        intruder,
        "/api/taskflow_agent_channel_member/",
        json!({
            "project": seed.project,
            "channel": seed.private_dm,
            "member_kind": "user",
            "user": intruder,
            "display_name": "intruder",
            "role": "member"
        }),
    )
    .await;

    // Create is not an exposed action on this resource any more.
    assert!(
        status == 403 || status == 404 || status == 405,
        "roster create must be refused, got {status}"
    );

    // And the DM is still invisible to them.
    let (_, body) = get_as(intruder, false, "/api/taskflow_agent_channel/").await;
    let ids: Vec<i64> = body["results"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|c| c["id"].as_i64())
        .collect();
    assert!(!ids.contains(&seed.private_dm), "DM must stay hidden");
}

#[tokio::test]
async fn auto_rest_cannot_create_a_channel() {
    let seed = seed().await;
    let member = make_user("creator_via_rest", false).await;
    make_member(seed.project, member, TaskflowMembershipStatus::Active).await;

    let (status, _) = post_as(
        member,
        "/api/taskflow_agent_channel/",
        json!({ "project": seed.project, "kind": "direct", "title": "Sneaky" }),
    )
    .await;

    assert!(
        status == 403 || status == 404 || status == 405,
        "channel create must go through POST /api/taskflow/channels, got {status}"
    );
}
```

`seed()` must expose a `private_dm` — a Direct channel rostered to a different
user. Extend the existing `Seed` struct and `seed()` to create one, mirroring how
it already creates a project and tasks.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && cargo test --test rest_scope`
Expected: both new tests FAIL — creates currently return 201.

- [ ] **Step 3: Strip the create action**

In `backend/src/rest.rs`, replace the `chat` block (lines 282-285):

```rust
    let chat = CHANNEL_SCOPED_TABLES.iter().map(|table| {
        let column = if *table == "taskflow_agent_channel" { "id" } else { "channel" };
        let config = ResourceConfig::new(*table).scope_async(channel_scope(column));
        match *table {
            // Channels are created ONLY through POST /api/taskflow/channels,
            // which writes the channel and its roster in one transaction. An
            // auto-REST create makes a channel with no roster — invisible to its
            // own creator, and impossible to join, because add_channel_member
            // needs a roster row that was never written. Update/Delete stay: the
            // frontend renames and archives, still row-scoped.
            "taskflow_agent_channel" => config.views([
                Action::List,
                Action::Retrieve,
                Action::Update,
                Action::Delete,
            ]),
            // Roster rows are ACCESS-GRANTING: `visible_channel_ids` reads this
            // table to decide who may see a DM. Left writable, any project member
            // could POST themselves a row and the read scope would honour it —
            // the same escalation `taskflow_project_member` is read-only to
            // prevent. Rows come from channel creation or the trusted
            // POST /api/taskflow/channels/{channel}/members.
            "taskflow_agent_channel_member" => config.views([Action::List, Action::Retrieve]),
            _ => config,
        }
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && cargo test --test rest_scope`
Expected: both new tests pass, and the pre-existing scope tests still pass.

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && cargo test`
Expected: no regressions across all packages.

- [ ] **Step 6: Commit**

```bash
git add backend/src/rest.rs backend/tests/rest_scope.rs
git commit -m "fix(rest): roster rows are access-granting, so stop letting clients write them

visible_channel_ids reads taskflow_agent_channel_member to decide who may
see a direct channel. That table was create-able through auto-REST, so any
project member could POST themselves a roster row and the check honoured
it -- one request to read a DM they were locked out of.

scope_async governs reads only. It filters which rows come back from
list/retrieve/update/delete and never touched create, which is precisely
the escalation taskflow_project_member was made read-only to prevent. The
same reasoning, one table later.

Channel create is stripped too: an auto-REST create writes a channel with
no roster, which visible_channel_ids then hides from its own creator.
Update and Delete stay so the frontend can still rename and archive."
```

---

## Verification

After all three tasks:

```bash
cd /home/dalmas/E/projects/local_task_tracker/backend && cargo test
cd ../v2_fe && npx tsc --noEmit && npx vitest run && npm run lint 2>&1 | tail -2
```

Then, in a running app: start a new DM with an agent and with a human. Both must
create successfully and appear for both participants — that is the path Task 3
would break if Task 2 were skipped.
