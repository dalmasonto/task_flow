//! #1127: who may drive an agent's terminal. Sending keys or text, answering
//! its permission prompts and dismissing them are for the project's owners
//! and admins and the human who linked the agent, never every member. A plain
//! member gets 403 `not_allowed_to_drive`.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, make_project_member_with_role, seed_project};
use taskflow_projects::models::TaskflowProjectRole;

async fn mint(app: &TestApp, user: i64, project: i64) -> (i64, String) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed");
    let body = resp.json().await;
    (
        body["agent_id"].as_i64().expect("agent_id"),
        body["key"].as_str().expect("key").to_string(),
    )
}

/// Unique per call: sessions are keyed by `session_identifier`, and these tests
/// share one database, so a fixed id makes every test after the first collide
/// with a 409.
static NEXT_SESSION: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

async fn register_session(app: &TestApp, key: &str) -> i64 {
    let n = NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resp = app
        .post_as_agent(
            key,
            "/api/taskflow/agents/sessions",
            json!({ "session_identifier": format!("test:pane:{n}"), "host": "test", "pid": 1, "cwd": "/tmp" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "register failed");
    resp.json().await["id"].as_i64().expect("session id")
}

/// Report a prompt as the agent and return its id.
async fn report(app: &TestApp, key: &str, session: i64, options_json: &str, kind: &str) -> i64 {
    let resp = app
        .post_as_agent(
            key,
            &format!("/api/taskflow/agents/sessions/{session}/prompt"),
            json!({
                "question": "Colour?",
                "options_json": options_json,
                "kind": kind,
                "fingerprint": "f1",
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "report failed: {:?}", resp.json().await);
    resp.json().await["id"].as_i64().expect("prompt id")
}

const LEGACY: &str = r#"[{"number":1,"label":"Red"},{"number":2,"label":"Green"}]"#;

/// Two questions: a single-select and a multi-select.

#[tokio::test(flavor = "multi_thread")]
async fn only_owners_admins_and_the_linked_human_drive_an_agent() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, key) = mint(&app, linker, project).await;
    let session = register_session(&app, &key).await;

    let member = app.create_user().await;
    make_project_member_with_role(project, member, TaskflowProjectRole::Developer).await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    let outsider = app.create_user().await;

    let keys = |who: i64| {
        let app = &app;
        async move { app.post_as(who, &format!("/api/taskflow/agents/{agent}/terminal-input"), json!({ "key": "Enter" })).await }
    };
    let r = keys(member).await;
    assert_eq!(r.status(), 403, "a plain member can't type into the agent");
    assert_eq!(r.json().await["error"], "not_allowed_to_drive");
    assert_eq!(keys(outsider).await.status(), 403);
    for who in [linker, admin] {
        let r = keys(who).await;
        assert!(r.status() < 300, "{who}: {}", r.status());
    }

    // Prompts: same rule for answering and for dismissing.
    let prompt = report(&app, &key, session, LEGACY, "permission").await;
    let r = app.post_as(member, &format!("/api/taskflow/prompts/{prompt}/answer"), json!({ "choice": 1 })).await;
    assert_eq!(r.status(), 403);
    assert_eq!(app.post_as(member, &format!("/api/taskflow/prompts/{prompt}/cancel"), json!({})).await.status(), 403);
    let r = app.post_as(admin, &format!("/api/taskflow/prompts/{prompt}/answer"), json!({ "choice": 1 })).await;
    assert_eq!(r.status(), 200, "an admin may answer");
    let second = report(&app, &key, session, LEGACY, "permission").await;
    let r = app.post_as(linker, &format!("/api/taskflow/prompts/{second}/cancel"), json!({})).await;
    assert_eq!(r.status(), 200, "the linked human may dismiss");
}
