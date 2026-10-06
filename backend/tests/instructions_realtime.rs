//! #615/#616 realtime: every column-only write of an agent or project row is
//! still announced to the dashboard.
//!
//! `update_values` fires `bulk_post_save` only, and the `Expose` registrations in
//! `backend/src/realtime.rs` listen to the per-row `post_save`. The liveness
//! writes (register / heartbeat / close) and both instruction PUTs are
//! column-only writes (a whole-row save would let a heartbeat revert an
//! instructions edit), so each one re-announces its row explicitly. This file
//! boots the real realtime plugin and reads the events off the real registry —
//! a plugin harness registers no `Expose` and could only assert a proxy.

use std::collections::HashSet;
use std::time::Duration;

use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::{Value, json};
use tokio::sync::mpsc::Receiver;
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_realtime::{Event, Realtime};
use umbral_testing::{TestClient, boot};

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};

async fn make_user(username: &str) -> (i64, String) {
    let user = AuthUser::objects()
        .create(AuthUser {
            id: 0,
            username: username.to_string(),
            email: format!("{username}@example.test"),
            password_hash: "x".to_string(),
            is_active: true,
            is_staff: false,
            is_superuser: false,
            date_joined: chrono::Utc::now(),
            last_login: None,
            email_verified_at: None,
        })
        .await
        .expect("create AuthUser");
    let (_, plaintext) = AuthToken::create_for(&user, "test")
        .await
        .expect("mint token");
    (user.id, plaintext.0)
}

async fn make_project(slug: &str) -> i64 {
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: slug.to_string(),
            slug: slug.to_string(),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            github_auto_mirror: false,
            agent_instructions_markdown: None,
            agent_instructions_updated_at: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn make_owner(project: i64, user: i64) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("User {user}"),
            email: None,
            role: TaskflowProjectRole::Owner,
            status: TaskflowMembershipStatus::Active,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

fn hdr(v: String) -> HeaderValue {
    HeaderValue::from_str(&v).expect("header")
}

/// Wait for the next event on `rx`; panics with `why` if none arrives.
async fn next(rx: &mut Receiver<Event>, why: &str) -> (String, String, Value) {
    let ev = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap_or_else(|_| panic!("no realtime event: {why}"))
        .expect("connection closed");
    (ev.channel, ev.event, ev.data)
}

/// Everything already buffered.
fn drain(rx: &mut Receiver<Event>) -> Vec<(String, String, Value)> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push((ev.channel, ev.event, ev.data));
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_and_instruction_writes_reach_realtime() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            .plugin(umbral_storage::StoragePlugin::new().media("/media", "./media"))
            .plugin(TaskflowProjectsPlugin)
            .plugin(taskflow_tasks::TaskflowTasksPlugin)
            .plugin(TaskflowAgentsPlugin)
            .plugin(backend::realtime::plugin())
    })
    .await;

    let (owner, token) = make_user("rt-instr-owner").await;
    let project = make_project("rt-instr-project").await;
    make_owner(project, owner).await;
    let client =
        TestClient::new(taskflow_agents::urls::router().merge(taskflow_projects::urls::router()));

    client.set_default_header(AUTHORIZATION, hdr(format!("Bearer {token}")));
    let link = client
        .post_json(
            "/api/taskflow/agents/link",
            &json!({ "project": project, "display_name": "claude", "profile": "main" }),
        )
        .await;
    assert_eq!(link.status(), 200, "link failed");
    let linked: Value = link.body_json();
    let key = linked["key"].as_str().expect("key").to_string();
    let agent = linked["agent_id"].as_i64().expect("agent_id");

    let agents_group = format!("project:{project}:agents");
    let (_a, mut agents_rx) = Realtime::registry()
        .register(None, HashSet::from([agents_group.clone()]), 64)
        .await
        .expect("register agents listener");
    let (_p, mut projects_rx) = Realtime::registry()
        .register(None, HashSet::from(["taskflow:projects".to_string()]), 64)
        .await
        .expect("register projects listener");
    let want = (
        agents_group.clone(),
        "updated".to_string(),
        json!({ "id": agent }),
    );

    // Liveness: register, heartbeat, close — each still lights the dashboard dot.
    client.set_default_header(AUTHORIZATION, hdr(format!("Agent {key}")));
    let session = client
        .post_json(
            "/api/taskflow/agents/sessions",
            &json!({ "session_identifier": "rt-instr:1", "host": "t", "pid": 1, "cwd": "/tmp" }),
        )
        .await;
    assert_eq!(session.status(), 200, "register failed");
    let session: Value = session.body_json();
    let session = session["id"].as_i64().expect("session id");
    assert_eq!(
        next(&mut agents_rx, "register brings the agent online").await,
        want
    );

    let hb = client
        .post_json(
            &format!("/api/taskflow/agents/sessions/{session}/heartbeat"),
            &json!({ "status": "busy" }),
        )
        .await;
    assert_eq!(hb.status(), 200, "heartbeat failed");
    assert_eq!(
        next(&mut agents_rx, "a heartbeat updates the agent").await,
        want
    );

    let closed = client
        .post_json(
            &format!("/api/taskflow/agents/sessions/{session}/close"),
            &json!({}),
        )
        .await;
    assert_eq!(closed.status(), 200, "close failed");
    assert_eq!(
        next(&mut agents_rx, "close takes the agent offline").await,
        want
    );
    assert!(
        drain(&mut agents_rx).is_empty(),
        "one event per liveness write"
    );

    // The agent instructions PUT announces a real change, and only a real one.
    client.set_default_header(AUTHORIZATION, hdr(format!("Bearer {token}")));
    let agent_path = format!("/api/taskflow/agents/{agent}/instructions");
    let put = client
        .put_json(&agent_path, &json!({ "markdown": "You review." }))
        .await;
    assert_eq!(put.status(), 200);
    assert_eq!(
        next(&mut agents_rx, "an instructions edit reaches the dashboard").await,
        want
    );
    let same = client
        .put_json(&agent_path, &json!({ "markdown": "You review." }))
        .await;
    assert_eq!(same.status(), 200);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        drain(&mut agents_rx).is_empty(),
        "a no-op save announces nothing"
    );

    // The project PUT likewise, on the project-list group.
    drain(&mut projects_rx);
    let project_path = format!("/api/taskflow/projects/{project}/agent-instructions");
    let put = client
        .put_json(&project_path, &json!({ "markdown": "Use pnpm." }))
        .await;
    assert_eq!(put.status(), 200);
    assert_eq!(
        next(
            &mut projects_rx,
            "a project instructions edit reaches the dashboard"
        )
        .await,
        (
            "taskflow:projects".to_string(),
            "updated".to_string(),
            json!({ "id": project })
        )
    );
    let same = client
        .put_json(&project_path, &json!({ "markdown": "Use pnpm." }))
        .await;
    assert_eq!(same.status(), 200);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        drain(&mut projects_rx).is_empty(),
        "a no-op save announces nothing"
    );
}
