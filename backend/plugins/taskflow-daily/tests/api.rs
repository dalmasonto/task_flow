//! #1118: the daily update. What must hold: nothing posts without an owner or
//! admin pressing Post (and it posts once, as them); edits are version-guarded;
//! only the configured drafting agent writes, and never over a person's edit;
//! the sweep drafts once per day; the server's draft lists real facts.

mod support;

use chrono::Utc;
use serde_json::json;
use support::{TestApp, seed_agent_key, seed_member, seed_project, seed_task};
use taskflow_agents::models::{TaskflowAgentMessage, taskflow_agent_message};
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskStatus, taskflow_task};

fn today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_owner_edits_and_posts_once_and_others_only_read() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let dev = app.create_user().await;
    seed_member(project, dev, "developer").await;
    let base = format!("/api/taskflow/projects/{project}");
    let day = today();

    // Settings are validated.
    for bad in [
        json!({ "enabled": true, "local_time": "25:00", "timezone": "UTC" }),
        json!({ "enabled": true, "local_time": "18:00", "timezone": "Mars/Olympus" }),
        json!({ "enabled": true, "local_time": "18:00", "timezone": "UTC", "drafting_agent": 999_999 }),
        json!({ "enabled": true, "local_time": "18:00", "timezone": "UTC", "post_channel": 999_999 }),
    ] {
        assert_eq!(app.put_json_as(owner.id, &format!("{base}/daily-update-settings"), bad.clone()).await.status(), 400, "{bad}");
    }
    let ok = json!({ "enabled": true, "local_time": "18:00", "timezone": "Africa/Nairobi" });
    assert_eq!(app.put_json_as(dev, &format!("{base}/daily-update-settings"), ok.clone()).await.status(), 403);
    assert_eq!(app.put_json_as(owner.id, &format!("{base}/daily-update-settings"), ok).await.status(), 200);

    // Draft now: the server's draft, once.
    let d = app.post_json_as(owner.id, &format!("{base}/daily-updates/{day}/draft"), json!({})).await;
    assert_eq!(d.status(), 201, "{}", d.text());
    let d = d.json().await;
    assert!(d["body_markdown"].as_str().unwrap().contains("## Shipped"), "{d}");
    assert_eq!(d["server_drafted"], true);
    let again = app.post_json_as(owner.id, &format!("{base}/daily-updates/{day}/draft"), json!({})).await;
    assert_eq!(again.status(), 200);
    assert_eq!(again.json().await["id"], d["id"]);

    // A developer reads but does not write.
    assert_eq!(app.get_as(dev, &format!("{base}/daily-updates/{day}")).await.status(), 200);
    let path = format!("{base}/daily-updates/{day}");
    assert_eq!(app.patch_json_as(dev, &path, json!({ "body_markdown": "x", "base_version": 1 })).await.status(), 403);
    assert_eq!(app.post_json_as(dev, &format!("{path}/post"), json!({})).await.status(), 403);

    // Version-guarded edit.
    let e = app.patch_json_as(owner.id, &path, json!({ "body_markdown": "## Shipped\n- the thing", "base_version": 1 })).await;
    assert_eq!(e.status(), 200, "{}", e.text());
    assert_eq!(e.json().await["version"], 2);
    assert_eq!(app.patch_json_as(owner.id, &path, json!({ "body_markdown": "stale", "base_version": 1 })).await.status(), 409);

    // Post: as the owner, once, into the public room.
    let p = app.post_json_as(owner.id, &format!("{path}/post"), json!({})).await;
    assert_eq!(p.status(), 200, "{}", p.text());
    let p = p.json().await;
    assert_eq!(p["status"], "posted");
    let msg = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(p["posted_message"].as_i64().unwrap()))
        .first()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(msg.sender_user.map(|u| u.id()), Some(owner.id));
    assert!(msg.body_markdown.contains("the thing"));
    assert_eq!(app.post_json_as(owner.id, &format!("{path}/post"), json!({})).await.status(), 409, "posts once");
    assert_eq!(app.patch_json_as(owner.id, &path, json!({ "body_markdown": "late", "base_version": 2 })).await.status(), 409);

    let list = app.get_as(dev, &format!("{base}/daily-updates")).await.json().await;
    let row = &list["updates"][0];
    assert_eq!(row["status"], "posted");
    assert!(row["excerpt"].as_str().unwrap().contains("the thing"));
    assert!(row.get("body_markdown").is_none(), "the list carries an excerpt, not the body");

    let outsider = app.create_user().await;
    assert_eq!(app.get_as(outsider, &format!("{base}/daily-updates")).await.status(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_drafting_agent_writes_and_never_over_a_persons_edit() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (drafter, drafter_id) = seed_agent_key(project, &[]).await;
    let (other, _) = seed_agent_key(project, &[]).await;
    let base = format!("/api/taskflow/projects/{project}");
    let day = today();
    let set = json!({ "enabled": false, "local_time": "18:00", "timezone": "UTC", "drafting_agent": drafter_id });
    assert_eq!(app.put_json_as(owner.id, &format!("{base}/daily-update-settings"), set).await.status(), 200);

    assert_eq!(app.get_as_agent(&other, &format!("/api/taskflow/agents/daily-update/sources?date={day}")).await.status(), 403);
    let src = app.get_as_agent(&drafter, &format!("/api/taskflow/agents/daily-update/sources?date={day}")).await;
    assert_eq!(src.status(), 200, "{}", src.text());
    assert!(src.json().await["spend"]["self_reported"].as_bool().unwrap());

    let w = format!("/api/taskflow/agents/daily-update/{day}");
    assert_eq!(app.put_json_as_agent(&other, &w, json!({ "body_markdown": "mine" })).await.status(), 403);
    let ok = app.put_json_as_agent(&drafter, &w, json!({ "body_markdown": "## Shipped\n- agent words" })).await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
    let ok = ok.json().await;
    assert_eq!(ok["server_drafted"], false);
    let v = ok["version"].as_i64().unwrap();

    // A person edits; the agent can no longer overwrite.
    let path = format!("{base}/daily-updates/{day}");
    assert_eq!(app.patch_json_as(owner.id, &path, json!({ "body_markdown": "person words", "base_version": v })).await.status(), 200);
    let refused = app.put_json_as_agent(&drafter, &w, json!({ "body_markdown": "agent again" })).await;
    assert_eq!(refused.status(), 409);
    assert_eq!(app.get_as(owner.id, &path).await.json().await["body_markdown"], "person words");

    // Skipped is final: neither agent nor post can touch it.
    assert_eq!(app.post_json_as(owner.id, &format!("{path}/skip"), json!({})).await.status(), 200);
    assert_eq!(app.post_json_as(owner.id, &format!("{path}/post"), json!({})).await.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sweep_drafts_once_a_day_with_the_days_real_facts() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (_, quiet) = seed_project(&app).await; // disabled: never drafted
    let task = seed_task(project, "ship the sweep").await;
    let mut t = TaskflowTask::objects().filter(taskflow_task::ID.eq(task)).first().await.unwrap().unwrap();
    t.status = TaskflowTaskStatus::Done;
    t.closed_at = Some(Utc::now());
    TaskflowTask::objects().save(t).await.unwrap();
    let set = json!({ "enabled": true, "local_time": "00:00", "timezone": "UTC" });
    assert_eq!(app.put_json_as(owner.id, &format!("/api/taskflow/projects/{project}/daily-update-settings"), set).await.status(), 200);

    let now = Utc::now() + chrono::Duration::seconds(1);
    assert!(taskflow_daily::service::sweep_once(now).await >= 1);
    assert_eq!(taskflow_daily::service::find(project, &today()).await.unwrap().is_some(), true);
    assert!(taskflow_daily::service::find(quiet, &today()).await.unwrap().is_none());
    let before = taskflow_daily::service::find(project, &today()).await.unwrap().unwrap();
    taskflow_daily::service::sweep_once(now).await;
    let after = taskflow_daily::service::find(project, &today()).await.unwrap().unwrap();
    assert_eq!(before.id, after.id, "one draft per day");
    assert!(after.body_markdown.contains(&format!("#TSK{task} ship the sweep")), "{}", after.body_markdown);
    assert_eq!(serde_json::to_value(after.status).unwrap(), "draft", "the sweep never posts");
}
