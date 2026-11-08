//! #1131: resolve, dispatch and a person's PATCH write a design comment by
//! column update (compare-and-set for a status change), never by saving a
//! stale copy of the row back whole.
//!
//! What must hold, and how each is pinned deterministically (a request race
//! through TestClient does not reproduce the window, see #1123):
//! - A concurrent write landing INSIDE a dispatch is not reverted. umbral
//!   awaits async signal subscribers inline, so a `post_save` hook on the
//!   first claimed comment dismisses the second one exactly in that window.
//!   The old whole-row save then overwrote "dismissed" with "sent".
//! - No path does a whole-row save: none fires `pre_save:design_comment`
//!   (only `Manager::save` does), yet each still fires `post_save` with the
//!   new status, so realtime re-colours the pin live.
//! - Resolving a comment a person dismissed is a 409; a resolve keeps the
//!   reply's `thread_id`.

mod support;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{Value, json};
use support::{TestApp, seed_agent};
use taskflow_design::models::{DesignComment, design_comment};

/// Per comment id: (pre_save count, statuses seen in post_save).
fn seen() -> &'static Mutex<HashMap<i64, (usize, Vec<String>)>> {
    static S: OnceLock<Mutex<HashMap<i64, (usize, Vec<String>)>>> = OnceLock::new();
    S.get_or_init(|| {
        umbral::signals::subscribe_async("pre_save:design_comment", |p| {
            let id = p["instance"]["id"].as_i64();
            async move {
                if let Some(id) = id {
                    seen().lock().unwrap().entry(id).or_default().0 += 1;
                }
            }
        });
        umbral::signals::subscribe_async("post_save:design_comment", |p| {
            let id = p["instance"]["id"].as_i64();
            let status = p["instance"]["status"].as_str().map(str::to_string);
            async move {
                if let (Some(id), Some(status)) = (id, status) {
                    seen().lock().unwrap().entry(id).or_default().1.push(status);
                }
            }
        });
        Mutex::new(HashMap::new())
    })
}

/// "When comment K is claimed (post_save, status sent), dismiss comment V."
fn interleave() -> &'static Mutex<HashMap<i64, i64>> {
    static I: OnceLock<Mutex<HashMap<i64, i64>>> = OnceLock::new();
    I.get_or_init(|| {
        umbral::signals::subscribe_async("post_save:design_comment", |p| {
            let id = p["instance"]["id"].as_i64();
            let sent = p["instance"]["status"] == "sent";
            async move {
                let victim = id.filter(|_| sent).and_then(|id| interleave().lock().unwrap().remove(&id));
                if let Some(victim) = victim {
                    let mut v = serde_json::Map::new();
                    v.insert("status".into(), json!("dismissed"));
                    DesignComment::objects().filter(design_comment::ID.eq(victim)).update_values(v).await.unwrap();
                }
            }
        });
        Mutex::new(HashMap::new())
    })
}

async fn comment(app: &TestApp, user: i64, project: i64, body: &str) -> i64 {
    let res = app
        .post_json_as(user, &format!("/api/design/{project}/comments"), &json!({
            "page_path": "/settings",
            "element_path": "main > section",
            "viewport": "laptop",
            "rect": {"x": 1, "y": 2, "w": 3, "h": 4},
            "body": body
        }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    res.json()["id"].as_i64().unwrap()
}

async fn row(id: i64) -> DesignComment {
    DesignComment::objects().filter(design_comment::ID.eq(id)).first().await.unwrap().unwrap()
}

fn status(c: &DesignComment) -> Value {
    serde_json::to_value(c.status).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_inside_a_dispatch_is_not_reverted() {
    let app = TestApp::new().await;
    let _ = interleave();
    let (user, project) = app.create_member_with_project().await;
    let (agent, _) = seed_agent(project, "Builder").await;
    let first = comment(&app, user.id, project, "first").await;
    let second = comment(&app, user.id, project, "second").await;
    interleave().lock().unwrap().insert(first, second);

    let res = app
        .post_json_as(user.id, &format!("/api/design/{project}/dispatch"), &json!({ "comment_ids": [first, second], "agent_id": agent }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["sent_comment_ids"], json!([first]), "only what this dispatch won");
    assert_eq!(status(&row(second).await), "dismissed", "the dismissal that landed mid-dispatch was overwritten");
    assert!(row(second).await.sent_to_agent.is_none());
    let first_row = row(first).await;
    assert_eq!(status(&first_row), "sent");
    assert_eq!(first_row.sent_to_agent.map(|a| a.id()), Some(agent));

}

/// "When project P's DM is created mid-dispatch, dismiss comment C." The DM
/// is created after the comments are loaded and before they are claimed.
fn on_dm_created() -> &'static Mutex<HashMap<i64, i64>> {
    static D: OnceLock<Mutex<HashMap<i64, i64>>> = OnceLock::new();
    D.get_or_init(|| {
        umbral::signals::subscribe_async("post_save:taskflow_agent_channel", |p| {
            let project = p["instance"]["project"].as_i64();
            async move {
                let victim = project.and_then(|p| on_dm_created().lock().unwrap().remove(&p));
                if let Some(victim) = victim {
                    let mut v = serde_json::Map::new();
                    v.insert("status".into(), json!("dismissed"));
                    DesignComment::objects().filter(design_comment::ID.eq(victim)).update_values(v).await.unwrap();
                }
            }
        });
        Mutex::new(HashMap::new())
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dispatch_whose_comments_were_all_taken_is_a_conflict_and_posts_nothing() {
    use taskflow_agents::models::{TaskflowAgentMessage, taskflow_agent_message};
    let app = TestApp::new().await;
    let _ = on_dm_created();
    let (user, project) = app.create_member_with_project().await;
    let (agent, _) = seed_agent(project, "Builder").await;
    let id = comment(&app, user.id, project, "only").await;
    on_dm_created().lock().unwrap().insert(project, id);

    let res = app
        .post_json_as(user.id, &format!("/api/design/{project}/dispatch"), &json!({ "comment_ids": [id], "agent_id": agent }))
        .await;
    assert!(on_dm_created().lock().unwrap().get(&project).is_none(), "the hook ran (the DM was created)");
    assert_eq!(res.status(), 409, "{}", res.text());
    assert_eq!(status(&row(id).await), "dismissed");
    let posted = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::PROJECT.eq(project) & taskflow_agent_message::TARGET_AGENT.eq(agent))
        .fetch()
        .await
        .unwrap();
    assert!(posted.iter().all(|m| !m.body_markdown.contains("[design-review]")), "no dispatch message for nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_path_rewrites_the_whole_row_but_realtime_still_hears_each_change() {
    let app = TestApp::new().await;
    let _ = seen();
    let (user, project) = app.create_member_with_project().await;
    let (agent, key) = seed_agent(project, "Builder").await;
    let id = comment(&app, user.id, project, "make it smaller").await;
    let (base, base_events) = seen().lock().unwrap().get(&id).map(|e| (e.0, e.1.len())).unwrap_or((0, 0));

    // A reply sets thread_id (by column update).
    let r = app.post_json_as(user.id, &format!("/api/design/{project}/comments/{id}/replies"), &json!({ "body": "first" })).await;
    assert_eq!(r.status(), 201);

    let res = app
        .post_json_as(user.id, &format!("/api/design/{project}/dispatch"), &json!({ "comment_ids": [id], "agent_id": agent }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let res = app
        .post_json_as_agent(&key, &format!("/api/taskflow/agents/design/comments/{id}/resolve"), &json!({ "project": project, "note": "h-6" }))
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(res.json()["comment"]["status"], "addressed");
    let res = app.patch_json_as(user.id, &format!("/api/design/{project}/comments/{id}"), &json!({ "status": "open" })).await;
    assert_eq!(res.status(), 200, "{}", res.text());

    let (pre, statuses) = seen().lock().unwrap().get(&id).cloned().unwrap_or_default();
    assert_eq!(pre, base, "a whole-row save ran (pre_save fired)");
    assert_eq!(statuses[base_events..], ["sent", "addressed", "open"], "realtime hears each change once");
    let r = row(id).await;
    assert_eq!(r.thread_id.as_deref(), Some(format!("c{id}").as_str()), "the reply's thread_id survived");
    assert_eq!(r.resolution_note.as_deref(), Some("h-6"));
}

#[tokio::test(flavor = "multi_thread")]
async fn resolving_a_dismissed_comment_is_a_conflict() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_, key) = seed_agent(project, "Builder").await;
    let id = comment(&app, user.id, project, "x").await;
    let res = app.patch_json_as(user.id, &format!("/api/design/{project}/comments/{id}"), &json!({ "status": "dismissed" })).await;
    assert_eq!(res.status(), 200, "{}", res.text());

    let resolve = |note: &'static str| {
        let key = key.clone();
        let app = &app;
        async move {
            app.post_json_as_agent(&key, &format!("/api/taskflow/agents/design/comments/{id}/resolve"), &json!({ "project": project, "note": note }))
                .await
                .status()
        }
    };
    assert_eq!(resolve("done").await, 409);
    assert_eq!(status(&row(id).await), "dismissed", "a dismissal is not overwritten");
    assert_eq!(resolve("done").await, 409);

    // Reopened, it resolves; resolving again (a new note) is allowed.
    app.patch_json_as(user.id, &format!("/api/design/{project}/comments/{id}"), &json!({ "status": "open" })).await;
    assert_eq!(resolve("first").await, 200);
    assert_eq!(resolve("better").await, 200);
    assert_eq!(row(id).await.resolution_note.as_deref(), Some("better"));

    // Addressed by a person with no note: the default, but never over a note.
    let other = comment(&app, user.id, project, "y").await;
    app.patch_json_as(user.id, &format!("/api/design/{project}/comments/{other}"), &json!({ "status": "addressed" })).await;
    assert_eq!(row(other).await.resolution_note.as_deref(), Some("Addressed."));
    app.patch_json_as(user.id, &format!("/api/design/{project}/comments/{id}"), &json!({ "status": "addressed" })).await;
    assert_eq!(row(id).await.resolution_note.as_deref(), Some("better"), "an existing note is kept");
    // Unknown comment: 404.
    assert_eq!(app.patch_json_as(user.id, &format!("/api/design/{project}/comments/999999"), &json!({ "status": "open" })).await.status(), 404);
}
