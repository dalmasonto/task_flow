//! #1123: design pin threads. What must hold: the author comes from the auth
//! gate; `page_version` is a real version of the comment's OWN page (and a
//! page-less component comment takes none); a person's reply notifies only the
//! agent the comment was sent to; the thread comes back root first, replies in
//! order, with `resolved`, `resolution_note` and `sent_to`; other projects get
//! nothing.

mod support;

use serde_json::json;
use support::{TestApp, sample_header_component, sample_settings_page, sample_tokens, seed_agent};
use taskflow_agents::models::{TaskflowAgentMessage, taskflow_agent_message};

async fn comment(app: &TestApp, user: i64, project: i64, component: Option<&str>) -> i64 {
    let res = app
        .post_json_as(user, &format!("/api/design/{project}/comments"), &json!({
            "page_path": "/settings",
            "component_name": component,
            "element_path": "main > section:nth-child(2)",
            "src_ref": "pages/settings.html:41",
            "viewport": "laptop",
            "rect": {"x": 10, "y": 20, "w": 300, "h": 40},
            "body": "make the avatar smaller"
        }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    res.json()["id"].as_i64().unwrap()
}

/// Write the settings page (with what it composes) `times` times: versions
/// 1..=times of `pages/settings.html` exist afterwards.
async fn seed_page(app: &TestApp, user: i64, project: i64, times: usize) {
    for (path, content) in [("styles/tokens.css", sample_tokens()), ("components/app-header.js", sample_header_component())] {
        let r = app.put_json_as(user, &format!("/api/design/{project}/file"), &json!({ "path": path, "content": content })).await;
        assert!(matches!(r.status(), 200 | 201), "{path}: {}", r.text());
    }
    for _ in 0..times {
        let r = app
            .put_json_as(user, &format!("/api/design/{project}/file"), &json!({ "path": "pages/settings.html", "content": sample_settings_page() }))
            .await;
        assert!(matches!(r.status(), 200 | 201), "{}", r.text());
    }
}

async fn notices_to(project: i64, agent: i64) -> Vec<String> {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::PROJECT.eq(project) & taskflow_agent_message::TARGET_AGENT.eq(agent))
        .fetch()
        .await
        .unwrap()
        .into_iter()
        .filter(|m| m.sender_label == taskflow_agents::wakeups::SENDER_LABEL)
        .map(|m| m.body_markdown)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pin_thread_carries_replies_versions_and_one_notice() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (builder, builder_key) = seed_agent(project, "Builder").await;
    let (bystander, _) = seed_agent(project, "Bystander").await;
    // Two saves of the page: versions 1 and 2 exist.
    seed_page(&app, user.id, project, 2).await;
    let id = comment(&app, user.id, project, None).await;
    let res = app
        .post_json_as(user.id, &format!("/api/design/{project}/dispatch"), &json!({ "comment_ids": [id], "agent_id": builder }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let before = notices_to(project, builder).await.len();

    // A person replies: the sent-to agent is told, by name, flattened.
    let r = app
        .post_json_as(user.id, &format!("/api/design/{project}/comments/{id}/replies"), &json!({ "body": "still too big\non mobile" }))
        .await;
    assert_eq!(r.status(), 201, "{}", r.text());
    assert_eq!(r.json()["author_kind"], "user");
    let told = notices_to(project, builder).await;
    assert_eq!(told.len(), before + 1, "one notice for the reply");
    let last = told.last().unwrap();
    assert!(last.contains(&format!("design comment #{id}")) && last.contains("still too big") && !last.contains('\n'), "{last}");
    assert!(notices_to(project, bystander).await.is_empty(), "only the sent-to agent is told");

    // The agent replies with "fixed in v2": no notice for an agent's reply.
    let a = app
        .post_json_as_agent(&builder_key, &format!("/api/taskflow/agents/design/comments/{id}/replies"), &json!({ "body": "fixed", "page_version": 2 }))
        .await;
    assert_eq!(a.status(), 201, "{}", a.text());
    assert_eq!(a.json()["author_label"], "Builder", "the author comes from the gate");
    assert_eq!(notices_to(project, builder).await.len(), before + 1);

    // Versions: one that doesn't exist, and a forged author field, are refused.
    for bad in [json!({ "body": "x", "page_version": 99 }), json!({ "body": "x", "author_label": "dalmas" }), json!({ "body": "  " })] {
        let r = app.post_json_as(user.id, &format!("/api/design/{project}/comments/{id}/replies"), &bad).await;
        assert!(matches!(r.status(), 400 | 422), "{bad} → {}", r.status());
    }

    // The thread, in order, with the root's resolve state and who it went to.
    let t = app.get_as(user.id, &format!("/api/design/{project}/comments/{id}/thread")).await;
    assert_eq!(t.status(), 200, "{}", t.text());
    let t = t.json();
    assert_eq!(t["sent_to"]["label"], "Builder");
    assert_eq!(t["root"]["resolved"], false);
    assert_eq!(t["root"]["thread_id"], format!("c{id}"), "the first reply set thread_id");
    let replies = t["replies"].as_array().unwrap();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["author_kind"], "user");
    assert_eq!(replies[1]["page_version"], 2);

    // Resolving shows on the root.
    let res = app
        .post_json_as_agent(&builder_key, &format!("/api/taskflow/agents/design/comments/{id}/resolve"), &json!({ "project": project, "note": "h-6 now" }))
        .await;
    assert_eq!(res.status(), 200);
    let t = app.get_as_agent(&builder_key, &format!("/api/taskflow/agents/design/comments/{id}/thread")).await.json();
    assert_eq!(t["root"]["resolved"], true);
    assert_eq!(t["root"]["resolution_note"], "h-6 now");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_component_comment_takes_no_version_and_other_projects_get_nothing() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (other, other_project) = app.create_member_with_project().await;
    let (_, foreign_key) = seed_agent(other_project, "Foreign").await;
    seed_page(&app, user.id, project, 1).await;
    let id = comment(&app, user.id, project, Some("app-header")).await;

    let r = app
        .post_json_as(user.id, &format!("/api/design/{project}/comments/{id}/replies"), &json!({ "body": "x", "page_version": 1 }))
        .await;
    assert_eq!(r.status(), 400, "a component comment has no page version");
    let r = app.post_json_as(user.id, &format!("/api/design/{project}/comments/{id}/replies"), &json!({ "body": "x" })).await;
    assert_eq!(r.status(), 201, "a null version is fine");

    // No dispatch yet: a person's reply notifies nobody, and sent_to is null.
    let t = app.get_as(user.id, &format!("/api/design/{project}/comments/{id}/thread")).await.json();
    assert!(t["sent_to"].is_null());

    // Other projects: a member of another project and a foreign agent.
    assert_eq!(app.get_as(other.id, &format!("/api/design/{project}/comments/{id}/thread")).await.status(), 403);
    assert_eq!(
        app.post_json_as(other.id, &format!("/api/design/{project}/comments/{id}/replies"), &json!({ "body": "x" })).await.status(),
        403
    );
    assert_eq!(app.get_as_agent(&foreign_key, &format!("/api/taskflow/agents/design/comments/{id}/thread")).await.status(), 404);
    assert_eq!(
        app.post_json_as_agent(&foreign_key, &format!("/api/taskflow/agents/design/comments/{id}/replies"), &json!({ "body": "x" })).await.status(),
        404
    );
}

/// Process-wide count of `post_save:design_comment` events per comment id.
fn saves() -> &'static std::sync::Mutex<std::collections::HashMap<i64, usize>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<i64, usize>>> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        umbral::signals::subscribe_async("post_save:design_comment", |payload| {
            let id = payload["instance"]["id"].as_i64();
            async move {
                if let Some(id) = id {
                    *saves().lock().unwrap().entry(id).or_default() += 1;
                }
            }
        });
        std::sync::Mutex::new(std::collections::HashMap::new())
    })
}

/// #1123 review: the first reply must not write the comment row back whole. A
/// whole-row save of the row the handler loaded would revert a resolve or a
/// dispatch that landed in between (the #1097 class). That save is exactly
/// what fires `post_save`; setting `thread_id` alone does not. So the first
/// reply must fire no `post_save` on its comment, and still set `thread_id`.
#[tokio::test(flavor = "multi_thread")]
async fn the_first_reply_sets_thread_id_without_rewriting_the_comment_row() {
    let app = TestApp::new().await;
    let _ = saves();
    let (user, project) = app.create_member_with_project().await;
    let id = comment(&app, user.id, project, None).await;
    let before = saves().lock().unwrap().get(&id).copied().unwrap_or(0);
    let r = app.post_json_as(user.id, &format!("/api/design/{project}/comments/{id}/replies"), &json!({ "body": "first" })).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    let after = saves().lock().unwrap().get(&id).copied().unwrap_or(0);
    assert_eq!(after, before, "the first reply re-saved the whole comment row");
    let t = app.get_as(user.id, &format!("/api/design/{project}/comments/{id}/thread")).await.json();
    assert_eq!(t["root"]["thread_id"], format!("c{id}"));
}
