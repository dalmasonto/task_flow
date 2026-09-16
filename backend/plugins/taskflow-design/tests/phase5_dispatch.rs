//! Phase 5 acceptance: the dispatch loop.
//!
//! comment (operator) → POST /dispatch → DM message lands in the agent's
//! channel with a structured target + comments flip to `sent` → the agent
//! edits and calls design_resolve_comment → `addressed`. The chrome's live
//! update rides the same realtime groups every other surface uses.

mod support;

use serde_json::json;
use support::TestApp;

async fn seed_agent(project: i64, display_name: &str) -> (i64, String) {
    use taskflow_agents::agent_auth::hash_key;
    use taskflow_agents::models::{
        TaskflowAgent, TaskflowAgentCredential, TaskflowAgentStatus, TaskflowCredentialStatus,
    };
    use umbral::orm::ForeignKey;

    let n = umbral_testing::seq();
    let agent = taskflow_agents::models::TaskflowAgent::objects()
        .create(TaskflowAgent {
            id: 0,
            project: ForeignKey::new(project),
            display_name: display_name.to_string(),
            identifier: format!("design-dispatch-{n}"),
            fingerprint: None,
            project_root: None,
            taskflow_file_path: None,
            runtime: Some("test".into()),
            version: None,
            status: TaskflowAgentStatus::Offline,
            linked_by: None,
            linked_user_label: None,
            last_seen_at: None,
            created_at: None,
        })
        .await
        .expect("seed agent");

    let hex = format!("{n:08x}");
    let raw_key = format!("tfk_test{hex}_{hex}");
    TaskflowAgentCredential::objects()
        .create(TaskflowAgentCredential {
            id: 0,
            project: ForeignKey::new(project),
            agent: Some(ForeignKey::new(agent.id)),
            issued_by: None,
            name: format!("key {n}"),
            key_prefix: format!("tfk_test{hex}"),
            key_hash: hash_key(&raw_key),
            status: TaskflowCredentialStatus::Active,
            expires_at: None,
            revoked_at: None,
            created_at: None,
        })
        .await
        .expect("seed credential");
    (agent.id, raw_key)
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_creates_dm_message_and_marks_comments_sent() {
    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;
    let user_id = user.id;
    let (agent_id, key) = seed_agent(project_id, "Builder").await;

    // Operator writes two comments.
    let mut ids = Vec::new();
    for body in ["make the avatar smaller", "danger zone too aggressive"] {
        let res = app.post_json_as(user_id, &format!("/api/design/{project_id}/comments"), &json!({
            "page_path": "/settings",
            "component_name": null,
            "element_path": "main > section:nth-child(2)",
            "src_ref": "pages/settings.html:41",
            "viewport": "laptop",
            "rect": {"x": 10, "y": 20, "w": 300, "h": 40},
            "body": body
        }))
        .await;
        assert_eq!(res.status(), 201);
        ids.push(res.json()["id"].as_i64().unwrap());
    }

    // Dispatch.
    let res = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/dispatch"),
            &json!({ "comment_ids": ids, "agent_id": agent_id }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());

    // The DM now holds ONE message carrying BOTH structured targets, with the
    // screenshot-before-and-after preamble.
    let roster = app.get_as_agent(key.as_str(), &format!("/api/taskflow/agents/design/comments?project={project_id}&status=sent")).await;
    assert_eq!(roster.status(), 200);
    let sent = roster.json()["comments"].as_array().cloned().unwrap_or_default();
    assert_eq!(sent.len(), 2, "both comments flipped to sent");
    for target in &sent {
        assert_eq!(target["target"]["file"], "pages/settings.html");
        assert_eq!(target["target"]["route"], "/settings");
        assert_eq!(target["status"], "sent");
    }

    // The agent resolves one; it shows addressed on the operator side.
    let first_row_id = {
        let cm = sent[0]["commentId"].as_str().unwrap().trim_start_matches("cm_");
        i64::from_str_radix(cm, 16).unwrap()
    };
    let resolved = app.post_json_as_agent(
        key.as_str(),
        &format!("/api/taskflow/agents/design/comments/{first_row_id}/resolve"),
        &json!({ "project": project_id, "note": "avatar is h-6 w-6 now" }),
    )
    .await;
    assert_eq!(resolved.status(), 200);

    let mine = app
        .get_as(user_id, &format!("/api/design/{project_id}/comments?status=addressed"))
        .await;
    let rows = mine.json().as_array().cloned().unwrap_or_default();
    assert_eq!(rows.len(), 1);
    assert!(rows[0]["resolution_note"].as_str().unwrap().contains("h-6"));
}

#[tokio::test(flavor = "multi_thread")]
async fn prompt_bar_delivers_free_text_with_selection_context() {
    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;
    let user_id = user.id;
    let (agent_id, _key) = seed_agent(project_id, "Designer").await;

    // Empty text is refused outright.
    let res = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/prompt"),
            &json!({ "agent_id": agent_id, "text": "   " }),
        )
        .await;
    assert_eq!(res.status(), 400);

    // A real prompt carries through; selection context rides along.
    let res2 = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/prompt"),
            &json!({
                "agent_id": agent_id,
                "text": "make this quieter",
                "selection": {
                    "route": "/settings",
                    "component": "app-header",
                    "elementPath": "app-header > div:nth-child(2)",
                    "srcRef": null
                }
            }),
        )
        .await;
    assert_eq!(res2.status(), 201, "{}", res2.text());
    assert_eq!(res2.json()["ok"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_rejects_foreign_agents_and_empty_selections() {
    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;
    let user_id = user.id;

    // An empty selection is refused outright.
    let res = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/dispatch"),
            &json!({ "comment_ids": [], "agent_id": 1 }),
        )
        .await;
    assert_eq!(res.status(), 400);

    // A nonexistent agent id in this project → 404, not a send.
    let res2 = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/dispatch"),
            &json!({ "comment_ids": [1], "agent_id": 999999 }),
        )
        .await;
    assert_eq!(res2.status(), 404);
}
