//! The `:prompts` broadcast a cancel MUST emit.
//!
//! `mcp/src/prompt-gate.ts` holds the gate closed from its own cached state and
//! re-evaluates on the `:prompts` event (`mcp/src/events.ts` routes every action,
//! `cancelled` included). So a cancel that only writes the row leaves a RUNNING
//! agent blocked until its next reconnect — which is the bug, not the fix.
//!
//! Why this lives in the backend crate rather than beside the plugin's other
//! prompt tests: the broadcast is not in the plugin at all. It is
//! `Expose::<TaskflowAgentPrompt>` in `backend/src/realtime.rs`, which subscribes
//! to the ORM's per-row `post_save:taskflow_agent_prompt` signal and projects
//! `PROMPT_FIELDS` onto `project:{id}:prompts`. A plugin test harness registers
//! no `Expose`, so it could only assert a proxy for this; here the real plugin is
//! booted and the event is read off the real [`Realtime`] registry, the same way
//! `realtime_dm_privacy.rs` reads a message's.
//!
//! Mutation-checked (see the task report): rewriting the cancel's write as a
//! bulk `update_values` leaves the ROW cancelled but emits `bulk_post_save`,
//! which `Expose` never sees — this test fails, the plugin's
//! `list_open_prompts_as_agent` test does not. That is the half only this file
//! can see.

use std::collections::HashSet;
use std::time::Duration;

use http::header::{AUTHORIZATION, HeaderValue};
use serde_json::json;
use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser, token::AuthToken};
use umbral_realtime::Realtime;
use umbral_testing::{TestClient, boot};

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};

/// A real user plus the bearer token their requests authenticate with.
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
        .expect("mint bearer token");
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
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn make_member(project: i64, user: i64) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("User {user}"),
            email: None,
            role: TaskflowProjectRole::Developer,
            status: TaskflowMembershipStatus::Active,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

fn bearer(token: &str) -> HeaderValue {
    HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header")
}

fn agent_key(key: &str) -> HeaderValue {
    HeaderValue::from_str(&format!("Agent {key}")).expect("agent header")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_prompt_broadcasts_the_prompts_event() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            // `TaskflowMessageAttachment` declares a FileField, so the app will
            // not build without a storage backend.
            .plugin(umbral_storage::StoragePlugin::new().media("/media", "./media"))
            .plugin(TaskflowProjectsPlugin)
            .plugin(taskflow_tasks::TaskflowTasksPlugin)
            .plugin(TaskflowAgentsPlugin)
            // The production realtime wiring: THIS is what carries the Expose
            // registrations the assertion below is about.
            .plugin(backend::realtime::plugin())
    })
    .await;

    let (user, token) = make_user("cancel-broadcast-user").await;
    let project = make_project("cancel-broadcast-project").await;
    make_member(project, user).await;

    let client = TestClient::new(taskflow_agents::urls::router());

    // Arrange the prompt through the real routes, so the row under test is the
    // one the app itself writes.
    client.set_default_header(AUTHORIZATION, bearer(&token));
    let link = client
        .post_json(
            "/api/taskflow/agents/link",
            &json!({ "project": project, "display_name": "claude", "profile": "main" }),
        )
        .await;
    assert_eq!(link.status(), 200, "link failed");
    let linked: serde_json::Value = link.body_json();
    let key = linked["key"].as_str().expect("agent key").to_string();

    client.set_default_header(AUTHORIZATION, agent_key(&key));
    let session = client
        .post_json(
            "/api/taskflow/agents/sessions",
            &json!({ "session_identifier": "broadcast:pane:1", "host": "t", "pid": 1, "cwd": "/tmp" }),
        )
        .await;
    assert_eq!(session.status(), 200, "register session failed");
    let session_body: serde_json::Value = session.body_json();
    let session_id = session_body["id"].as_i64().expect("session id");

    let reported = client
        .post_json(
            &format!("/api/taskflow/agents/sessions/{session_id}/prompt"),
            &json!({
                "question": "Colour?",
                "options_json": r#"[{"number":1,"label":"Red"}]"#,
                "kind": "single",
                "fingerprint": "f1",
            }),
        )
        .await;
    assert_eq!(reported.status(), 200, "report failed");
    let reported_body: serde_json::Value = reported.body_json();
    let prompt = reported_body["id"].as_i64().expect("prompt id");

    // Subscribe exactly as the SSE transport does — the registry, not the
    // policy (admission is `may_join`'s business and is tested elsewhere).
    let group = format!("project:{project}:prompts");
    let (_conn, mut rx) = Realtime::registry()
        .register(None, HashSet::from([group.clone()]), 16)
        .await
        .expect("register a realtime connection");

    // The human dismisses the card.
    client.set_default_header(AUTHORIZATION, bearer(&token));
    let cancelled = client
        .post_json(&format!("/api/taskflow/prompts/{prompt}/cancel"), &json!({}))
        .await;
    assert_eq!(cancelled.status(), 200, "cancel failed");

    // Without this event a RUNNING agent stays gated until it reconnects.
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect(
            "no :prompts event was broadcast — a cancel that only writes the row leaves \
             the agent's message gate closed until its next reconnect, which is the bug",
        )
        .expect("the connection closed before the event arrived");

    assert_eq!(
        event.channel, group,
        "the event must land on the project's prompts group"
    );
    assert_eq!(event.event, "updated", "a save, not a create");
    assert_eq!(
        event.data["id"],
        json!(prompt),
        "the projection must name the row the gate has to re-evaluate"
    );
    assert_eq!(
        event.data["status"],
        json!("cancelled"),
        "`mcp/src/events.ts` routes on this event, and the gate opens on the status \
         it carries: a projection that still said `pending` would leave it shut"
    );
}
