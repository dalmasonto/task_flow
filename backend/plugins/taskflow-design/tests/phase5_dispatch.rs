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
async fn the_dispatched_flag_follows_the_destination_room() {
    // The message this endpoint writes carries `is_design`, and that flag is
    // DERIVED from the room the message lands in — the same rule both send paths
    // follow. A hardcoded `false` was correct only by coincidence: the DM
    // `find_or_create_dm` resolves is an ordinary room today, so nothing in the
    // existing dispatch tests can tell a derived flag from a literal one, and a
    // future change of destination would have stored a flag that lies.
    //
    // So this test supplies the missing half of that statement: the room the
    // dispatch RESOLVES is design-marked, and the stored flag must say so. The
    // state is arranged directly (a `Direct` room carrying the marker), which the
    // API cannot produce — `create_channel` never sets either marker and
    // `ensure_project_rooms` marks only the project's design room — exactly as the
    // agents plugin's design-room tests seed rooms the API cannot produce. The
    // assertion is about the DERIVATION, not about the state.
    use taskflow_agents::models::{
        TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind,
        TaskflowChannelMemberKind, taskflow_agent_channel, taskflow_agent_message,
    };
    use umbral::orm::ForeignKey;

    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;
    let user_id = user.id;
    let (agent_id, _key) = seed_agent(project_id, "Builder").await;

    // The rooms first, deterministically: the project-write signal also creates
    // them, and racing it would leave two design-marked rooms.
    taskflow_agents::views::ensure_project_rooms(project_id)
        .await
        .expect("ensure the project's rooms");

    // Move the marker onto the DM the dispatch will resolve, leaving the project
    // with exactly one design-marked room (the rule the marker guard enforces).
    let design = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(project_id) & taskflow_agent_channel::IS_DESIGN.eq(true))
        .first()
        .await
        .expect("load design room")
        .expect("the ensure created a design room");
    let mut unmarked = design;
    unmarked.is_design = false;
    TaskflowAgentChannel::objects()
        .save(unmarked)
        .await
        .expect("unmark the design room");

    let dm = TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project_id),
            title: "Builder".to_string(),
            topic: None,
            kind: TaskflowChannelKind::Direct,
            task: None,
            created_by_user: Some(ForeignKey::new(user_id)),
            created_by_agent: None,
            archived: false,
            is_public: false,
            is_design: true,
            created_at: None,
        })
        .await
        .expect("seed the design-marked DM");
    for (kind, member_user, member_agent) in [
        (TaskflowChannelMemberKind::User, Some(ForeignKey::new(user_id)), None),
        (TaskflowChannelMemberKind::Agent, None, Some(ForeignKey::new(agent_id))),
    ] {
        TaskflowAgentChannelMember::objects()
            .create(TaskflowAgentChannelMember {
                id: 0,
                project: ForeignKey::new(project_id),
                channel: ForeignKey::new(dm.id),
                member_kind: kind,
                user: member_user,
                agent: member_agent,
                display_name: "Builder".to_string(),
                role: "member".to_string(),
                joined_at: None,
            })
            .await
            .expect("seed DM roster");
    }

    // A comment to dispatch.
    let created = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/comments"),
            &json!({
                "page_path": "/settings",
                "component_name": null,
                "element_path": "main > section",
                "src_ref": null,
                "viewport": "laptop",
                "rect": {"x": 1, "y": 2, "w": 30, "h": 40},
                "body": "make it quieter"
            }),
        )
        .await;
    assert_eq!(created.status(), 201, "{}", created.text());
    let comment_id = created.json()["id"].as_i64().expect("comment id");

    let res = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/dispatch"),
            &json!({ "comment_ids": [comment_id], "agent_id": agent_id }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let dispatched_id = res.json()["message_id"].as_i64().expect("message id");

    // The OTHER message-writing path in this file, the prompt bar, resolves its
    // DM the same way and must derive the same flag — it had no coverage at all
    // before this test (the existing prompt test asserts the response, not the row).
    let prompted = app
        .post_json_as(
            user_id,
            &format!("/api/design/{project_id}/prompt"),
            &json!({ "agent_id": agent_id, "text": "make it quieter" }),
        )
        .await;
    assert_eq!(prompted.status(), 201, "{}", prompted.text());
    let prompted_id = prompted.json()["message_id"].as_i64().expect("message id");

    for (id, which) in [
        (dispatched_id, "the dispatched message"),
        (prompted_id, "the prompt-bar message"),
    ] {
        let row = TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::ID.eq(id))
            .first()
            .await
            .expect("load the message")
            .expect("the message exists");
        assert_eq!(
            row.channel.id(),
            dm.id,
            "{which} landed in the room the dispatch resolved"
        );
        assert!(
            row.is_design,
            "{which}: the flag is derived from the destination room, so a design-marked destination stores true"
        );
    }
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
