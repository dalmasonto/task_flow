//! #615/#616: an agent's role instructions and its project's agent instructions,
//! read by the agent through `whoami`, written only by a human through the
//! manager-gated PUT (or `link_agent` when it creates the agent).

use serde_json::{Value, json};
use taskflow_projects::models::{TaskflowProject, TaskflowProjectRole, taskflow_project};

mod support;
use support::{TestApp, make_active_project_member, make_project_member_with_role, seed_project};

/// Link an agent as `user`, optionally with instructions; returns the link body.
async fn link(
    app: &TestApp,
    user: i64,
    project: i64,
    name: &str,
    profile: &str,
    instructions: Option<&str>,
) -> Value {
    let mut body = json!({ "project": project, "display_name": name, "profile": profile });
    if let Some(md) = instructions {
        body["instructions_markdown"] = json!(md);
    }
    let resp = app.post_as(user, "/api/taskflow/agents/link", body).await;
    assert_eq!(resp.status(), 200, "link failed: {:?}", resp.json().await);
    resp.json().await
}

async fn whoami(app: &TestApp, key: &str) -> Value {
    let resp = app.get_as_agent(key, "/api/taskflow/agents/whoami").await;
    assert_eq!(resp.status(), 200);
    resp.json().await
}

fn path(agent: i64) -> String {
    format!("/api/taskflow/agents/{agent}/instructions")
}

fn ids(linked: &Value) -> (i64, String) {
    (
        linked["agent_id"].as_i64().expect("agent_id"),
        linked["key"].as_str().expect("key").to_string(),
    )
}

/// Set the project block directly (its endpoint lives in the projects plugin).
async fn set_project_instructions(project: i64, markdown: &str) {
    TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .update_values(
            json!({
                "agent_instructions_markdown": markdown,
                "agent_instructions_updated_at": chrono::Utc::now(),
            })
            .as_object()
            .cloned()
            .expect("object"),
        )
        .await
        .expect("set project instructions");
}

#[tokio::test]
async fn whoami_keeps_its_fields_and_reports_empty_blocks_when_nothing_is_set() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let linked = link(&app, user, project, "Plain", "plain", None).await;
    assert_eq!(linked["instructions_applied"], json!(false));

    let me = whoami(&app, linked["key"].as_str().unwrap()).await;
    for field in ["agent_id", "display_name", "identifier", "project", "status"] {
        assert!(me.get(field).is_some(), "whoami lost `{field}`: {me}");
    }
    assert_eq!(me["instructions"], json!({ "markdown": null, "updated_at": null }));
    assert_eq!(me["project_instructions"], json!({ "markdown": null, "updated_at": null }));
}

#[tokio::test]
async fn instructions_set_at_link_reach_whoami() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let linked = link(&app, user, project, "Rev", "rev", Some("## Role\nReview only.")).await;
    assert_eq!(linked["instructions_applied"], json!(true));

    let me = whoami(&app, linked["key"].as_str().unwrap()).await;
    assert_eq!(me["instructions"]["markdown"], json!("## Role\nReview only."));
    assert!(me["instructions"]["updated_at"].is_string(), "stamped: {me}");
}

#[tokio::test]
async fn an_edit_shows_on_the_next_whoami_with_the_same_key() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent, key) = ids(&link(&app, user, project, "Edit", "edit", None).await);

    let resp = app.put_as(user, &path(agent), json!({ "markdown": "v2 role" })).await;
    assert_eq!(resp.status(), 200);
    let saved = resp.json().await;
    assert_eq!(saved["agent_id"], json!(agent));
    assert_eq!(saved["markdown"], json!("v2 role"));
    assert!(saved["updated_at"].is_string());

    // Same key, no restart: the next whoami carries the edit. (Timestamps are
    // compared only DB-read to DB-read elsewhere: the PUT reply's `now` may carry
    // more precision than the column round-trips.)
    let me = whoami(&app, &key).await;
    assert_eq!(me["instructions"]["markdown"], json!("v2 role"));
    assert!(me["instructions"]["updated_at"].is_string());
}

#[tokio::test]
async fn whoami_returns_the_project_instructions_beside_the_role() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_, key) = ids(&link(&app, user, project, "Both", "both", Some("role text")).await);
    set_project_instructions(project, "project text").await;

    let me = whoami(&app, &key).await;
    assert_eq!(me["instructions"]["markdown"], json!("role text"));
    assert_eq!(me["project_instructions"]["markdown"], json!("project text"));
    assert!(me["project_instructions"]["updated_at"].is_string());
}

#[tokio::test]
async fn an_admin_may_edit_any_agent_but_another_developer_may_not() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let developer = app.create_user().await;
    make_active_project_member(project, developer).await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    let viewer = app.create_user().await;
    make_project_member_with_role(project, viewer, TaskflowProjectRole::Viewer).await;
    let (agent, key) = ids(&link(&app, linker, project, "Gated", "gated", Some("mine")).await);

    assert_eq!(app.put_as(developer, &path(agent), json!({ "markdown": "theirs" })).await.status(), 403);
    assert_eq!(app.put_as(viewer, &path(agent), json!({ "markdown": "theirs" })).await.status(), 403);
    assert_eq!(whoami(&app, &key).await["instructions"]["markdown"], json!("mine"));

    assert_eq!(app.put_as(admin, &path(agent), json!({ "markdown": "admin's" })).await.status(), 200);
    assert_eq!(whoami(&app, &key).await["instructions"]["markdown"], json!("admin's"));
}

#[tokio::test]
async fn a_non_member_gets_404() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let stranger = app.create_user().await;
    let (agent, _) = ids(&link(&app, linker, project, "Hidden", "hidden", None).await);

    assert_eq!(app.put_as(stranger, &path(agent), json!({ "markdown": "x" })).await.status(), 404);
    assert_eq!(app.put_as(linker, &path(999_999_999), json!({ "markdown": "x" })).await.status(), 404);
}

#[tokio::test]
async fn the_agent_cannot_write_its_own_instructions() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent, key) = ids(&link(&app, user, project, "Self", "self", Some("set by a human")).await);

    let status = app.put_as_agent(&key, &path(agent), json!({ "markdown": "I am root now" })).await.status();
    assert!(matches!(status, 401 | 403), "an agent key must not write, got {status}");
    assert_eq!(whoami(&app, &key).await["instructions"]["markdown"], json!("set by a human"));
}

#[tokio::test]
async fn a_no_op_save_keeps_the_timestamp_and_a_blank_save_clears() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent, key) = ids(&link(&app, user, project, "Same", "same", Some("same")).await);
    let t0 = whoami(&app, &key).await["instructions"]["updated_at"].clone();
    assert!(t0.is_string());

    // Same text again: nothing changed, so nothing is stamped (no spurious MCP notice).
    let same = app.put_as(user, &path(agent), json!({ "markdown": "same" })).await;
    assert_eq!(same.status(), 200);
    assert_eq!(same.json().await["updated_at"], t0);

    // Whitespace clears and stamps.
    let cleared = app.put_as(user, &path(agent), json!({ "markdown": "  \n " })).await;
    assert_eq!(cleared.status(), 200);
    let cleared = cleared.json().await;
    assert_eq!(cleared["markdown"], Value::Null);
    assert!(cleared["updated_at"].is_string());
    let after = whoami(&app, &key).await;
    assert_eq!(after["instructions"]["markdown"], Value::Null);
    let t1 = after["instructions"]["updated_at"].clone();

    // null on an already-clear agent is a no-op too.
    let again = app.put_as(user, &path(agent), json!({ "markdown": null })).await;
    assert_eq!(again.status(), 200);
    assert_eq!(again.json().await["updated_at"], t1);
}

#[tokio::test]
async fn relinking_by_another_member_does_not_overwrite_the_instructions() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let other = app.create_user().await;
    make_active_project_member(project, other).await;
    let first = link(&app, linker, project, "Shared", "shared", Some("linker's role")).await;
    assert_eq!(first["instructions_applied"], json!(true));

    // Same (project, name, profile) → the same agent; the re-link mints a key but
    // must not touch instructions it has no right to change.
    let relinked = link(&app, other, project, "Shared", "shared", Some("hijack")).await;
    assert_eq!(relinked["agent_id"], first["agent_id"]);
    assert_eq!(relinked["instructions_applied"], json!(false));
    let me = whoami(&app, relinked["key"].as_str().unwrap()).await;
    assert_eq!(me["instructions"]["markdown"], json!("linker's role"));
}

#[tokio::test]
async fn a_body_without_the_markdown_key_is_rejected_and_changes_nothing() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent, key) = ids(&link(&app, user, project, "Keep", "keep", Some("keep me")).await);

    let status = app.put_as(user, &path(agent), json!({})).await.status();
    assert!((400..500).contains(&status), "expected 4xx, got {status}");
    assert_eq!(whoami(&app, &key).await["instructions"]["markdown"], json!("keep me"));
}

/// The agent whose whole-row save the `pre_save` probe below interleaves with,
/// and whether the probe ran. Process-wide because a signal subscription is.
static RACE_AGENT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);
static RACE_FIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// I1: register/heartbeat/close must write ONLY the liveness columns. Before the
/// fix each loaded the whole agent row and `Manager::save`d it back, so an
/// instructions PUT landing between that load and that save was reverted.
///
/// The interleaving is forced, not hoped for: a `pre_save:taskflow_agent`
/// subscriber runs INLINE between `Manager::save`'s load and its write, and it
/// performs the "concurrent PUT" there. A whole-row save then writes the stale
/// markdown back over it (the bug); a column-only write never fires `pre_save`,
/// so the probe never runs and the PUT's value simply stands.
#[tokio::test]
async fn liveness_writes_never_revert_an_instructions_edit() {
    use std::sync::atomic::Ordering;
    use taskflow_agents::models::{TaskflowAgent, taskflow_agent};

    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (agent, key) = ids(&link(&app, user, project, "Racer", "racer", None).await);

    let put = app.put_as(user, &path(agent), json!({ "markdown": "v1" })).await;
    assert_eq!(put.status(), 200);
    let v1_at = whoami(&app, &key).await["instructions"]["updated_at"].clone();
    assert!(v1_at.is_string());

    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        umbral::signals::subscribe_async("pre_save:taskflow_agent", |payload| {
            let id = payload["instance"]["id"].as_i64();
            async move {
                if id != Some(RACE_AGENT.load(Ordering::SeqCst)) || RACE_FIRED.swap(true, Ordering::SeqCst) {
                    return;
                }
                TaskflowAgent::objects()
                    .filter(taskflow_agent::ID.eq(id.unwrap()))
                    .update_values(
                        json!({
                            "instructions_markdown": "edited mid-heartbeat",
                            "instructions_updated_at": chrono::Utc::now(),
                        })
                        .as_object()
                        .cloned()
                        .expect("object"),
                    )
                    .await
                    .expect("concurrent edit");
            }
        });
    });
    RACE_AGENT.store(agent, Ordering::SeqCst);

    // Every liveness path: register, heartbeat (with a hint), close.
    let session = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/sessions",
            json!({ "session_identifier": "race:1", "host": "box", "pid": 1 }),
        )
        .await;
    assert_eq!(session.status(), 200);
    let session = session.json().await["id"].as_i64().expect("session id");
    let hb = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/sessions/{session}/heartbeat"),
            json!({ "status": "busy" }),
        )
        .await;
    assert_eq!(hb.status(), 200);
    let closed = app
        .post_as_agent(&key, &format!("/api/taskflow/agents/sessions/{session}/close"), json!({}))
        .await;
    assert_eq!(closed.status(), 200);

    let row = app.agent(agent).await;
    if RACE_FIRED.load(Ordering::SeqCst) {
        // A whole-row save ran; the edit made inside it must survive it.
        assert_eq!(
            row.instructions_markdown.as_deref(),
            Some("edited mid-heartbeat"),
            "a liveness write reverted a concurrent instructions edit"
        );
    } else {
        // Column-only writes: the PUT's value and stamp are untouched.
        assert_eq!(row.instructions_markdown.as_deref(), Some("v1"));
        assert_eq!(whoami(&app, &key).await["instructions"]["updated_at"], v1_at);
    }
    // Liveness itself still landed.
    assert_eq!(row.status, taskflow_agents::models::TaskflowAgentStatus::Offline);
    assert!(row.last_seen_at.is_some());
}
