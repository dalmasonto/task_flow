//! #1078: rename an agent and set its provider and model. What must hold:
//! 1. Owner/admin or its linked human may; another member 403, outsider 404.
//! 2. A rename keeps the agent's id, identifier and working key.
//! 3. Display names are unique per project (trimmed, case-insensitive), on
//!    rename AND on link of a new agent: 409 `name_taken`. A re-link of the
//!    same identity keeps its own name.
//! 4. provider is an allowlist; model is free text <= 80; null clears.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, make_project_member_with_role, seed_project};
use taskflow_projects::models::TaskflowProjectRole;

async fn link(app: &TestApp, user: i64, project: i64, name: &str, profile: &str) -> (u16, serde_json::Value) {
    let r = app.post_as(user, "/api/taskflow/agents/link", json!({ "project": project, "display_name": name, "profile": profile })).await;
    let s = r.status();
    (s, serde_json::from_str(&r.text()).unwrap_or_default())
}

#[tokio::test(flavor = "multi_thread")]
async fn renaming_keeps_identity_and_is_gated() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (s, b) = link(&app, linker, project, "Builder", "main").await;
    assert_eq!(s, 200, "{b}");
    let (agent, key, identifier) = (b["agent_id"].as_i64().unwrap(), b["key"].as_str().unwrap().to_string(), b["identifier"].clone());
    let dev = app.create_user().await;
    make_project_member_with_role(project, dev, TaskflowProjectRole::Developer).await;
    let outsider = app.create_user().await;
    let path = format!("/api/taskflow/agents/{agent}");

    assert_eq!(app.patch_as(dev, &path, json!({ "display_name": "Mine now" })).await.status(), 403);
    assert_eq!(app.patch_as(outsider, &path, json!({ "display_name": "Mine now" })).await.status(), 404);
    let r = app.patch_as(linker, &path, json!({ "display_name": " Builder Two ", "provider": "Anthropic", "model": "claude-opus-5-5" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b = r.json().await;
    assert_eq!(b["id"], agent);
    assert_eq!(b["display_name"], "Builder Two");
    assert_eq!(b["identifier"], identifier, "a rename changed the identity");
    assert_eq!(b["provider"], "anthropic");
    assert_eq!(b["model"], "claude-opus-5-5");
    assert_eq!(app.get_as_agent(&key, "/api/taskflow/agents/whoami").await.status(), 200, "the key stopped working");

    // Allowlist and clearing.
    assert_eq!(app.patch_as(linker, &path, json!({ "provider": "acme" })).await.status(), 400);
    assert_eq!(app.patch_as(linker, &path, json!({ "model": "x".repeat(81) })).await.status(), 400);
    assert_eq!(app.patch_as(linker, &path, json!({ "status": "online" })).await.status(), 422);
    let b = app.patch_as(linker, &path, json!({ "provider": null, "model": null })).await.json().await;
    assert_eq!(b["provider"], serde_json::Value::Null);
    assert_eq!(b["model"], serde_json::Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn display_names_are_unique_in_a_project() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let other_project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    make_project_member_with_role(other_project, owner, TaskflowProjectRole::Owner).await;
    let dev = app.create_user().await;
    make_project_member_with_role(project, dev, TaskflowProjectRole::Developer).await;

    let (s, real) = link(&app, owner, project, "reviewer (codex)", "reviewer").await;
    assert_eq!(s, 200, "{real}");
    // A new agent with the same name, any case or spacing, under another profile: 409.
    for name in ["reviewer (codex)", " Reviewer (Codex) "] {
        let (s, b) = link(&app, dev, project, name, "impostor").await;
        assert_eq!(s, 409, "{name}: {b}");
        assert_eq!(b["error"], "name_taken");
    }
    // Renaming your own agent onto it: 409.
    let (_, mine) = link(&app, dev, project, "helper", "helper").await;
    let r = app.patch_as(dev, &format!("/api/taskflow/agents/{}", mine["agent_id"]), json!({ "display_name": "REVIEWER (codex)" })).await;
    assert_eq!(r.status(), 409, "{}", r.text());
    // The real one re-linking keeps its own name; another project may use it.
    assert_eq!(link(&app, owner, project, "reviewer (codex)", "reviewer").await.0, 200);
    assert_eq!(link(&app, owner, other_project, "reviewer (codex)", "reviewer").await.0, 200);
    // Renaming to your own name in another case is fine.
    let r = app.patch_as(owner, &format!("/api/taskflow/agents/{}", real["agent_id"]), json!({ "display_name": "Reviewer (Codex)" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
}
