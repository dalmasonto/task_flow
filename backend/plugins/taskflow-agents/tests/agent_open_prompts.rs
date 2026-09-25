//! #127: `GET /api/taskflow/agents/prompts` returns the CALLER agent's OPEN
//! (pending) prompts, scoped to its own agent id. The MCP hydrates its message
//! gate from this on connect/reconnect so a prompt raised while the realtime
//! stream was down (or already pending at MCP startup) still pauses chat delivery
//! instead of letting it type into the open prompt.

use serde_json::json;

mod support;
use support::{TestApp, make_active_project_member, seed_project};

async fn mint(app: &TestApp, user: i64, project: i64, display: &str) -> (i64, String) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": display, "profile": display }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed");
    let b = resp.json().await;
    (
        b["agent_id"].as_i64().expect("agent_id"),
        b["key"].as_str().expect("key").to_string(),
    )
}

static NEXT_SESSION: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

async fn register_session(app: &TestApp, key: &str) -> i64 {
    let n = NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resp = app
        .post_as_agent(
            key,
            "/api/taskflow/agents/sessions",
            json!({ "session_identifier": format!("op:pane:{n}"), "host": "t", "pid": 1, "cwd": "/tmp" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "register failed");
    resp.json().await["id"].as_i64().expect("session id")
}

async fn report(app: &TestApp, key: &str, session: i64) -> i64 {
    let resp = app
        .post_as_agent(
            key,
            &format!("/api/taskflow/agents/sessions/{session}/prompt"),
            json!({
                "question": "Colour?",
                "options_json": r#"[{"number":1,"label":"Red"}]"#,
                "kind": "single",
                "fingerprint": "f1",
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "report failed: {:?}", resp.json().await);
    resp.json().await["id"].as_i64().expect("prompt id")
}

#[tokio::test]
async fn lists_only_the_callers_pending_prompts() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_a1, key1) = mint(&app, user, project, "claude").await;
    let (_a2, key2) = mint(&app, user, project, "codex").await;

    let session = register_session(&app, &key1).await;
    let prompt = report(&app, &key1, session).await;

    // Agent 1 sees its own pending prompt.
    let resp = app.get_as_agent(&key1, "/api/taskflow/agents/prompts").await;
    assert_eq!(resp.status(), 200);
    let items = resp.json().await;
    let arr = items.as_array().expect("array");
    assert_eq!(arr.len(), 1, "expected one open prompt, got {arr:?}");
    assert_eq!(arr[0]["id"].as_i64().unwrap(), prompt);
    assert_eq!(arr[0]["status"].as_str().unwrap(), "pending");

    // Agent 2 (same project) sees NONE — the endpoint is scoped to the caller's
    // own agent id, so another agent's open prompt never blocks this pane.
    let resp2 = app.get_as_agent(&key2, "/api/taskflow/agents/prompts").await;
    assert_eq!(resp2.json().await.as_array().expect("array").len(), 0);
}

#[tokio::test]
async fn answered_prompts_are_not_listed() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_a, key) = mint(&app, user, project, "claude").await;
    let session = register_session(&app, &key).await;
    let prompt = report(&app, &key, session).await;

    let ans = app
        .post_as(user, &format!("/api/taskflow/prompts/{prompt}/answer"), json!({ "choice": 1 }))
        .await;
    assert_eq!(ans.status(), 200, "answer failed: {:?}", ans.json().await);

    // Resolved → no longer "open", so hydration won't keep the gate blocked.
    let resp = app.get_as_agent(&key, "/api/taskflow/agents/prompts").await;
    assert_eq!(resp.json().await.as_array().expect("array").len(), 0);
}

#[tokio::test]
async fn requires_agent_auth() {
    let app = TestApp::new().await;
    let resp = app.get_noauth("/api/taskflow/agents/prompts").await;
    assert_eq!(resp.status(), 401);
}

// --- The session term ------------------------------------------------------
//
// The gate is per-PANE, and a pane is a session. Without a session term this
// endpoint reported a `pending` prompt on a session that no longer exists, and
// the MCP's gate — hydrated from exactly this list — shut on a question nobody's
// terminal was showing: every message for the LIVE session queued behind it for
// ever, while `whoami` said connected and the event stream answered 200. These
// three tests are the contract: a dead session's prompt is not open, a live
// session's still is, and an agent with NO live session keeps all of them.

async fn open_ids(app: &TestApp, key: &str) -> Vec<i64> {
    let resp = app.get_as_agent(key, "/api/taskflow/agents/prompts").await;
    assert_eq!(resp.status(), 200);
    resp.json()
        .await
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["id"].as_i64().expect("prompt id"))
        .collect()
}

/// A prompt on a session whose process is GONE — crashed, never closed — must not
/// be reported as something the agent is blocked on. The stale session is not
/// deleted here: a killed MCP leaves `status = connected` behind for ever, which
/// is why liveness, not status alone, is the rule.
#[tokio::test]
async fn a_pending_prompt_on_a_dead_session_is_not_open() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent, key) = mint(&app, user, project, "claude").await;

    // The LIVE session — the agent as it is now.
    let live = register_session(&app, &key).await;
    let live_prompt = report(&app, &key, live).await;

    // An older session of the SAME agent whose process died without closing, and
    // the prompt it was showing when it died.
    let dead = register_session(&app, &key).await;
    let dead_prompt = report(&app, &key, dead).await;
    app.backdate_session_heartbeat(dead, 600).await;

    let ids = open_ids(&app, &key).await;
    assert!(
        ids.contains(&live_prompt),
        "the live session's prompt must stay open — the fix must not be 'return \
         fewer rows'. got {ids:?}"
    );
    assert!(
        !ids.contains(&dead_prompt),
        "a prompt on a session that stopped heartbeating is still reported as \
         open, so the gate latches on a question no live terminal is showing. \
         got {ids:?}"
    );
}

/// The explicit half of the same rule: a session closed through the API is gone,
/// and its prompt stops blocking the session that replaced it.
#[tokio::test]
async fn a_pending_prompt_on_a_closed_session_is_not_open() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent, key) = mint(&app, user, project, "claude").await;

    let live = register_session(&app, &key).await;
    let live_prompt = report(&app, &key, live).await;

    let old = register_session(&app, &key).await;
    let old_prompt = report(&app, &key, old).await;

    // Precondition: while it is open the prompt IS listed (so the assertion
    // below is about the close, not about the prompt never being seen).
    assert_eq!(open_ids(&app, &key).await, vec![live_prompt, old_prompt]);

    let closed = app
        .post_as_agent(&key, &format!("/api/taskflow/agents/sessions/{old}/close"), json!({}))
        .await;
    assert_eq!(closed.status(), 200, "close failed");

    assert_eq!(
        open_ids(&app, &key).await,
        vec![live_prompt],
        "a prompt on a CLOSED session must not block the live one"
    );
}

/// The fallback, and the #127 guarantee it defends: an agent that cannot reach
/// the backend long enough for its heartbeats to lapse is STILL blocked. The
/// session is stale here only because nothing could beat — the pane may well be
/// sitting on the prompt — so answering "nothing is open" would let the
/// reconnect's catch-up type chat into it.
#[tokio::test]
async fn a_blocked_agent_with_no_live_session_still_reports_its_prompt() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent, key) = mint(&app, user, project, "claude").await;

    let only = register_session(&app, &key).await;
    let prompt = report(&app, &key, only).await;

    // Its ONE session goes stale: no live session of this agent remains.
    app.backdate_session_heartbeat(only, 600).await;

    assert_eq!(
        open_ids(&app, &key).await,
        vec![prompt],
        "with no live session at all the prompt must STILL be reported: scoping \
         by liveness alone would open the gate mid-outage and deliver chat into \
         the prompt that is still on the screen (#127)"
    );
}
