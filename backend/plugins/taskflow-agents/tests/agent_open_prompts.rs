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
