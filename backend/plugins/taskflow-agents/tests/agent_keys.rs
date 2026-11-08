//! #1136: rotate and revoke an agent's keys. What must hold:
//! 1. Rotation returns a new key that works; the old key is a 401 at once.
//! 2. The new key keeps the old key's scopes and denials.
//! 3. Revoking one key stops it; revoking again is the same answer.
//! 4. Who: owner/admin and the linked human may; a developer gets 403, an
//!    outsider 404. A key of another agent can't be revoked through this one.
//! 5. Two rotations at once leave exactly ONE active key.
//! 6. Each change writes one audit row.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, make_project_member_with_role, seed_project};
use taskflow_agents::models::{TaskflowAgentCredential, taskflow_agent_credential};
use taskflow_projects::models::TaskflowProjectRole;
use taskflow_tasks::models::{TaskflowTaskActivity, taskflow_task_activity};

async fn mint(app: &TestApp, user: i64, project: i64, label: &str) -> (i64, String) {
    let r = app
        .post_as(user, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b = r.json().await;
    (b["agent_id"].as_i64().unwrap(), b["key"].as_str().unwrap().to_string())
}

async fn whoami(app: &TestApp, key: &str) -> u16 {
    app.get_as_agent(key, "/api/taskflow/agents/whoami").await.status()
}

async fn active_keys(agent: i64) -> Vec<TaskflowAgentCredential> {
    TaskflowAgentCredential::objects()
        .filter(taskflow_agent_credential::AGENT.eq(agent) & taskflow_agent_credential::STATUS.eq("active"))
        .fetch()
        .await
        .unwrap()
}

async fn audits(project: i64, action: &str) -> usize {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::PROJECT.eq(project) & taskflow_task_activity::ACTION.eq(action))
        .fetch()
        .await
        .unwrap()
        .len()
}

#[tokio::test(flavor = "multi_thread")]
async fn rotating_a_key_stops_the_old_one_and_keeps_its_scopes() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, old_key) = mint(&app, linker, project, "Rotor").await;
    assert_eq!(whoami(&app, &old_key).await, 200);

    // Give the key a denial, so carrying it over is visible.
    let old = active_keys(agent).await.remove(0);
    let mut v = serde_json::Map::new();
    v.insert("denied_scopes".into(), json!(r#"["tasks:write"]"#));
    TaskflowAgentCredential::objects().filter(taskflow_agent_credential::ID.eq(old.id)).update_values(v).await.unwrap();

    let r = app.post_as(linker, &format!("/api/taskflow/agents/{agent}/rotate-key"), json!({})).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    let b = r.json().await;
    let new_key = b["key"].as_str().unwrap().to_string();
    assert_eq!(b["revoked"], 1);
    assert!(b["credential"].get("key_hash").is_none(), "never the hash: {b}");

    assert_eq!(whoami(&app, &old_key).await, 401, "the old key still works");
    assert_eq!(whoami(&app, &new_key).await, 200, "the new key doesn't");
    let now = active_keys(agent).await;
    assert_eq!(now.len(), 1);
    assert_eq!(now[0].denied_scopes.as_deref(), Some(r#"["tasks:write"]"#), "denials were dropped");
    assert_eq!(audits(project, "agent_key_rotated").await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_one_key_stops_it_and_is_idempotent() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, key) = mint(&app, linker, project, "Revokee").await;
    let (other_agent, other_key) = mint(&app, linker, project, "Bystander").await;
    let cred = active_keys(agent).await.remove(0).id;
    let other_cred = active_keys(other_agent).await.remove(0).id;

    // Another agent's key through this agent's path: 404, and it still works.
    let r = app.post_as(owner, &format!("/api/taskflow/agents/{agent}/credentials/{other_cred}/revoke"), json!({})).await;
    assert_eq!(r.status(), 404, "{}", r.text());
    assert_eq!(whoami(&app, &other_key).await, 200);

    let path = format!("/api/taskflow/agents/{agent}/credentials/{cred}/revoke");
    let r = app.post_as(owner, &path, json!({})).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    assert_eq!(r.json().await["credential"]["status"], "revoked");
    assert_eq!(whoami(&app, &key).await, 401);
    // Again: the same answer, no second audit row.
    assert_eq!(app.post_as(owner, &path, json!({})).await.status(), 200);
    assert_eq!(audits(project, "agent_key_revoked").await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_owners_admins_and_the_linked_human_manage_keys() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, key) = mint(&app, linker, project, "Guarded").await;
    let cred = active_keys(agent).await.remove(0).id;
    let dev = app.create_user().await;
    make_project_member_with_role(project, dev, TaskflowProjectRole::Developer).await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    let outsider = app.create_user().await;

    let rotate = format!("/api/taskflow/agents/{agent}/rotate-key");
    let revoke = format!("/api/taskflow/agents/{agent}/credentials/{cred}/revoke");
    for (who, want) in [(dev, 403), (outsider, 404)] {
        assert_eq!(app.post_as(who, &rotate, json!({})).await.status(), want, "rotate as {who}");
        assert_eq!(app.post_as(who, &revoke, json!({})).await.status(), want, "revoke as {who}");
    }
    assert_eq!(whoami(&app, &key).await, 200, "a refused call changed the key");
    assert_eq!(app.post_as(admin, &rotate, json!({})).await.status(), 201, "an admin may");
    assert_eq!(whoami(&app, &key).await, 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_rotations_at_once_leave_one_active_key() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, _) = mint(&app, linker, project, "Racer").await;
    let path = format!("/api/taskflow/agents/{agent}/rotate-key");
    for _ in 0..5 {
        let (a, b) = tokio::join!(app.post_as(linker, &path, json!({})), app.post_as(linker, &path, json!({})));
        let active = active_keys(agent).await;
        assert_eq!(active.len(), 1, "statuses {} {}: {} active keys", a.status(), b.status(), active.len());
        // The one left is a key someone was handed.
        let handed: Vec<String> = [&a, &b]
            .iter()
            .filter(|r| r.status() == 201)
            .map(|r| serde_json::from_str::<serde_json::Value>(&r.text()).unwrap()["credential"]["key_prefix"].as_str().unwrap().to_string())
            .collect();
        assert!(handed.contains(&active[0].key_prefix), "the active key {} was never returned", active[0].key_prefix);
    }
}

/// #1136 review blocker: `link` with an existing agent's name and profile used
/// to mint a fresh key AS that agent for any member, with no denials.
#[tokio::test(flavor = "multi_thread")]
async fn re_linking_someone_elses_agent_is_refused() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, key) = mint(&app, linker, project, "Victim").await;
    let viewer = app.create_user().await;
    make_project_member_with_role(project, viewer, TaskflowProjectRole::Viewer).await;

    let body = json!({ "project": project, "display_name": "Victim", "profile": "Victim" });
    let r = app.post_as(viewer, "/api/taskflow/agents/link", body.clone()).await;
    assert_eq!(r.status(), 403, "{}", r.text());
    assert_eq!(r.json().await["error"], "not_allowed_to_relink");
    assert_eq!(active_keys(agent).await.len(), 1, "a refused re-link minted a key");
    assert_eq!(whoami(&app, &key).await, 200);
}

/// The linked human re-linking ("lost my key") is a rotation: the old key
/// stops, and the owner's denials survive.
#[tokio::test(flavor = "multi_thread")]
async fn re_linking_your_own_agent_rotates_and_keeps_denials() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, old_key) = mint(&app, linker, project, "Mine").await;
    let cred = active_keys(agent).await.remove(0).id;
    let mut v = serde_json::Map::new();
    v.insert("denied_scopes".into(), json!(r#"["tasks:write"]"#));
    TaskflowAgentCredential::objects().filter(taskflow_agent_credential::ID.eq(cred)).update_values(v).await.unwrap();

    let r = app.post_as(linker, "/api/taskflow/agents/link", json!({ "project": project, "display_name": "Mine", "profile": "Mine" })).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let b = r.json().await;
    assert_eq!(b["agent_id"], agent);
    assert_eq!(b["relinked"], true);
    assert_eq!(b["revoked"], 1);
    assert_eq!(b["denied_scopes"], json!(["tasks:write"]), "the response hid the carried denial: {b}");
    let new_key = b["key"].as_str().unwrap().to_string();
    assert_eq!(whoami(&app, &old_key).await, 401);
    assert_eq!(whoami(&app, &new_key).await, 200);
    let now = active_keys(agent).await;
    assert_eq!(now.len(), 1);
    assert_eq!(now[0].denied_scopes.as_deref(), Some(r#"["tasks:write"]"#));
}

/// An agent with `agents:manage` makes NEW agents; it never re-keys one.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_re_key_an_existing_agent() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let (victim, victim_key) = mint(&app, owner, project, "Target").await;
    let r = app
        .post_as(owner, "/api/taskflow/agents/link", json!({ "project": project, "display_name": "Manager", "profile": "mgr", "scopes": ["agents:manage"] }))
        .await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let mgr_key = r.json().await["key"].as_str().unwrap().to_string();

    let r = app.post_as_agent(&mgr_key, "/api/taskflow/agents/agent/agents", json!({ "display_name": "Target", "profile": "Target" })).await;
    assert_eq!(r.status(), 409, "{}", r.text());
    assert_eq!(r.json().await["error"], "agent_exists");
    assert_eq!(active_keys(victim).await.len(), 1);
    assert_eq!(whoami(&app, &victim_key).await, 200);
    // A new name still works.
    assert_eq!(app.post_as_agent(&mgr_key, "/api/taskflow/agents/agent/agents", json!({ "display_name": "Fresh", "profile": "fresh" })).await.status(), 200);
}

/// #1136 review: revoke every key, then rotate: the denial must survive.
#[tokio::test(flavor = "multi_thread")]
async fn rotating_after_every_key_is_revoked_keeps_denials() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let linker = app.create_user().await;
    make_active_project_member(project, linker).await;
    let (agent, _) = mint(&app, linker, project, "Sneaky").await;
    let cred = active_keys(agent).await.remove(0).id;
    let mut v = serde_json::Map::new();
    v.insert("denied_scopes".into(), json!(r#"["tasks:write"]"#));
    TaskflowAgentCredential::objects().filter(taskflow_agent_credential::ID.eq(cred)).update_values(v).await.unwrap();

    assert_eq!(app.post_as(linker, &format!("/api/taskflow/agents/{agent}/credentials/{cred}/revoke"), json!({})).await.status(), 200);
    let r = app.post_as(linker, &format!("/api/taskflow/agents/{agent}/rotate-key"), json!({})).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    assert_eq!(r.json().await["revoked"], 0);
    assert_eq!(active_keys(agent).await[0].denied_scopes.as_deref(), Some(r#"["tasks:write"]"#), "the denial was dropped");
}
