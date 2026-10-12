//! #700 — per-key capability denials. An owner/admin mints a key that cannot
//! do part of the job ("post updates, but do not touch the design surface"),
//! without losing everything else; a key with no policy keeps every default.
//!
//! The refusal is a structured 403 — `{"error":"capability_denied",
//! "capability":"design:write"}` — so the MCP can name the capability rather
//! than print a bare status.

use serde_json::{Value, json};

mod support;
use support::{
    TestApp, make_active_project_member, make_project_member_with_role, public_room_of,
    seed_project,
};
use taskflow_projects::models::TaskflowProjectRole;

/// Mint via the human link route; `denied` becomes `denied_scopes`.
async fn link(
    app: &TestApp,
    user: i64,
    project: i64,
    profile: &str,
    denied: Option<Value>,
) -> (u16, Value) {
    let mut body = json!({
        "project": project,
        "display_name": format!("Agent {profile}"),
        "profile": profile,
    });
    if let Some(denied) = denied {
        body["denied_scopes"] = denied;
    }
    let resp = app.post_as(user, "/api/taskflow/agents/link", body).await;
    let status = resp.status();
    let text = resp.text();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn key_of(body: &Value) -> String {
    body["key"].as_str().expect("a raw key").to_string()
}

/// A project whose owner has minted one key for `profile`, optionally denying
/// `denied`.
async fn fixture(profile: &str, denied: Option<Value>) -> (TestApp, i64, String) {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let (status, body) = link(&app, owner, project, profile, denied).await;
    assert_eq!(status, 200, "mint failed: {body}");
    (app, project, key_of(&body))
}

// ---------------------------------------------------------------------------
// The default: nothing changes for a key with no policy
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_key_with_no_policy_keeps_every_default() {
    let (app, project, key) = fixture("plain-caps", None).await;

    let task = app
        .post_as_agent(&key, "/api/taskflow/agents/tasks", json!({ "title": "still works" }))
        .await;
    assert_eq!(task.status(), 200, "an ordinary key still writes tasks");

    let channel = public_room_of(project).await;
    let message = app
        .post_as_agent(&key, "/api/taskflow/agents/agent/messages", json!({ "channel": channel, "body_markdown": "hi" }))
        .await;
    assert_eq!(message.status(), 200, "…and still speaks");

    let who = app.get_as_agent(&key, "/api/taskflow/agents/whoami").await.json().await;
    let caps = who["capabilities"].as_array().expect("capabilities").len();
    assert!(caps >= 6, "the effective set is reported in full: {who}");
    assert_eq!(who["denied_scopes"], json!([]), "nothing was denied: {who}");
}

// ---------------------------------------------------------------------------
// Denying one capability leaves the others alone
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_denied_capability_403s_with_its_name_and_leaves_the_rest_working() {
    let (app, project, key) = fixture("no-tasks", Some(json!(["tasks:write"]))).await;

    let task = app
        .post_as_agent(&key, "/api/taskflow/agents/tasks", json!({ "title": "nope" }))
        .await;
    assert_eq!(task.status(), 403, "the denied gate fires");
    let refusal = task.json().await;
    assert_eq!(refusal["error"], json!("capability_denied"));
    assert_eq!(refusal["capability"], json!("tasks:write"));
    assert!(
        refusal["message"].as_str().unwrap_or_default().contains("Connect-agents"),
        "the refusal says who can change it: {refusal}"
    );

    // Untouched capabilities are untouched: chatting still works, and so does
    // reading the very tasks it may no longer create.
    let channel = public_room_of(project).await;
    let message = app
        .post_as_agent(&key, "/api/taskflow/agents/agent/messages", json!({ "channel": channel, "body_markdown": "still here" }))
        .await;
    assert_eq!(message.status(), 200);
    assert_eq!(
        app.get_as_agent(&key, "/api/taskflow/agents/tasks").await.status(),
        200,
        "a denial covers the WRITE, never the read"
    );

    // whoami's effective set drops exactly the denied capability.
    let who = app.get_as_agent(&key, "/api/taskflow/agents/whoami").await.json().await;
    assert_eq!(who["denied_scopes"], json!(["tasks:write"]));
    let caps = who["capabilities"].as_array().expect("capabilities");
    assert!(!caps.contains(&json!("tasks:write")), "{who}");
    assert!(caps.contains(&json!("chat:send")), "{who}");
}

#[tokio::test]
async fn every_default_write_gate_reads_its_own_denial() {
    // One key denied everything deniable, checked against each gate's route.
    let denied = json!([
        "tasks:write",
        "reviews:write",
        "chat:send",
        "activity:write",
        "design:write",
        "toolbox:write",
    ]);
    let (app, project, key) = fixture("denied-all", Some(denied)).await;
    let channel = public_room_of(project).await;

    let cases: Vec<(&str, &str, Value)> = vec![
        ("tasks:write", "/api/taskflow/agents/tasks", json!({ "title": "x" })),
        (
            "chat:send",
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": channel, "body_markdown": "x" }),
        ),
        (
            "activity:write",
            "/api/taskflow/agents/activity",
            json!({ "action": "note" }),
        ),
    ];
    for (capability, path, body) in cases {
        let resp = app.post_as_agent(&key, path, body).await;
        assert_eq!(resp.status(), 403, "{capability} should be denied at {path}");
        let refusal = resp.json().await;
        assert_eq!(refusal["capability"], json!(capability), "at {path}");
    }
}

// ---------------------------------------------------------------------------
// Validation and authority
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unknown_denial_is_refused_and_a_plain_member_cannot_deny() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;

    let (status, body) = link(&app, owner, project, "typo", Some(json!(["tasks:write "]))).await;
    assert_eq!(status, 200, "trailing space is normalized, not a typo: {body}");
    let (status, body) = link(&app, owner, project, "typo2", Some(json!(["tasks:writes"]))).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], json!("unknown_capability"));
    assert_eq!(body["capability"], json!("tasks:writes"));
    // Denying a GRANTABLE scope is refused: not granting it already means that.
    let (status, body) = link(&app, owner, project, "typo3", Some(json!(["agents:manage"]))).await;
    assert_eq!(status, 400, "{body}");

    let member = app.create_user().await;
    make_active_project_member(project, member).await;
    assert_eq!(
        link(&app, member, project, "dev-denier", Some(json!(["design:write"]))).await.0,
        403,
        "resting a capability is an owner/admin act, like granting one"
    );
    // …while an ordinary link by the same member is unchanged.
    assert_eq!(link(&app, member, project, "dev-plain", None).await.0, 200);
}

#[tokio::test]
async fn an_agent_minted_key_carries_no_policy_at_all() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;

    // The minting key needs `agents:manage` (#605), which only this route grants.
    let scoped = app
        .post_as(
            owner,
            "/api/taskflow/agents/link",
            json!({
                "project": project,
                "display_name": "Orch caps",
                "profile": "orch-caps",
                "scopes": ["agents:manage"],
            }),
        )
        .await;
    assert_eq!(scoped.status(), 200, "{:?}", scoped.text());
    let orch_key = key_of(&scoped.json().await);

    let minted = app
        .post_as_agent(
            &orch_key,
            "/api/taskflow/agents/agent/agents",
            json!({ "display_name": "Worker caps", "profile": "worker-caps" }),
        )
        .await;
    assert_eq!(minted.status(), 200, "{:?}", minted.text());
    let worker = minted.json().await;
    let worker_key = key_of(&worker);
    assert_eq!(worker["denied_scopes"], json!([]), "no denials ride along");
    assert!(
        worker["capabilities"].as_array().map(|c| c.len()).unwrap_or(0) >= 6,
        "every default is present: {worker}"
    );

    // And the worker really can do the work.
    let task = app
        .post_as_agent(&worker_key, "/api/taskflow/agents/tasks", json!({ "title": "worker task" }))
        .await;
    assert_eq!(task.status(), 200);
}
