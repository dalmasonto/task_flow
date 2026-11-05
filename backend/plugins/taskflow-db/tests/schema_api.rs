//! #885 acceptance: agents write models, a person edits them, and neither side
//! silently overwrites the other.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

fn agent_model(unique_name: bool) -> serde_json::Value {
    json!({
        "name": "Agent",
        "group": "agents",
        "fields": [
            { "name": "id", "type": "i64", "primary_key": true },
            { "name": "display_name", "type": "String", "unique": unique_name },
            { "name": "provider", "type": "enum", "values": ["claude-code", "codex", "other"], "default": "other" }
        ]
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn agents_write_models_people_edit_them_and_locks_hold() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (agent_id, key) = seed_agent(project, "Builder").await;

    // Nothing is seeded: a project starts with an empty schema at version 0.
    let read = app.get_as_agent(&key, &format!("/api/taskflow/agents/db/schema?project={project}")).await;
    assert_eq!(read.status(), 200, "{}", read.text());
    assert_eq!(read.json()["version"], 0);
    assert_eq!(read.json()["doc"]["models"], json!([]));

    // The agent writes a model.
    let w = app
        .put_as_agent(&key, "/api/taskflow/agents/db/model", json!({ "project": project, "base_version": 0, "model": agent_model(false) }))
        .await;
    assert_eq!(w.status(), 200, "{}", w.text());
    assert_eq!(w.json()["version"], 1);
    let f = &w.json()["doc"]["models"][0]["fields"][1];
    assert_eq!(f["written_by"]["kind"], "agent");
    assert_eq!(f["written_by"]["id"], agent_id);
    assert_eq!(f["locked_by_user"], false);

    // The person makes display_name unique: that field becomes theirs and locked.
    let mut doc = w.json()["doc"].clone();
    doc["models"][0]["fields"][1]["unique"] = json!(true);
    let h = app.put_json_as(user.id, &format!("/api/db/{project}/schema"), &json!({ "base_version": 1, "doc": doc })).await;
    assert_eq!(h.status(), 200, "{}", h.text());
    assert_eq!(h.json()["version"], 2);
    let fields = &h.json()["doc"]["models"][0]["fields"];
    assert_eq!(fields[1]["locked_by_user"], true);
    assert_eq!(fields[1]["written_by"]["kind"], "user");
    assert_eq!(fields[2]["locked_by_user"], false, "untouched fields stay the agent's");

    // A stale agent write is refused, not merged.
    let stale = app
        .put_as_agent(&key, "/api/taskflow/agents/db/model", json!({ "project": project, "base_version": 1, "model": agent_model(false) }))
        .await;
    assert_eq!(stale.status(), 409);
    assert_eq!(stale.json()["error"], "version_conflict");
    assert_eq!(stale.json()["current_version"], 2);

    // Undoing the person's change is refused, naming the field.
    let locked = app
        .put_as_agent(&key, "/api/taskflow/agents/db/model", json!({ "project": project, "base_version": 2, "model": agent_model(false) }))
        .await;
    assert_eq!(locked.status(), 409, "{}", locked.text());
    assert_eq!(locked.json()["error"], "locked_by_user");
    assert_eq!(locked.json()["fields"], json!(["display_name"]));

    // With override it goes in, and the person is told in the database room.
    let forced = app
        .put_as_agent(
            &key,
            "/api/taskflow/agents/db/model",
            json!({ "project": project, "base_version": 2, "model": agent_model(false), "override": true }),
        )
        .await;
    assert_eq!(forced.status(), 200, "{}", forced.text());
    let room = app.get_as(user.id, &format!("/api/db/{project}/room")).await;
    assert_eq!(room.status(), 200, "{}", room.text());
    let channel = room.json()["channel_id"].as_i64().unwrap();
    use taskflow_agents::models::{TaskflowAgentMessage, taskflow_agent_message};
    let notes = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::CHANNEL.eq(channel))
        .fetch()
        .await
        .unwrap();
    assert!(notes.iter().any(|m| m.body_markdown.contains("overrode your lock on `Agent`")));
    // The room is stable: asking again gives the same channel.
    let again = app.get_as(user.id, &format!("/api/db/{project}/room")).await;
    assert_eq!(again.json()["channel_id"].as_i64(), Some(channel));

    // History: one row per save, newest first; restore brings v2 back as v4.
    let versions = app.get_as(user.id, &format!("/api/db/{project}/versions")).await;
    let list = versions.json()["versions"].as_array().cloned().unwrap();
    assert_eq!(list.iter().map(|v| v["version"].as_i64().unwrap()).collect::<Vec<_>>(), vec![3, 2, 1]);
    assert!(list[0]["note"].as_str().unwrap().contains("overrode"));
    let restored = app.post_json_as(user.id, &format!("/api/db/{project}/restore"), &json!({ "version": 2, "base_version": 3 })).await;
    assert_eq!(restored.status(), 200, "{}", restored.text());
    assert_eq!(restored.json()["version"], 4);
    assert_eq!(restored.json()["doc"]["models"][0]["fields"][1]["unique"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_writes_name_the_problem_and_references_block_a_delete() {
    let app = TestApp::new().await;
    let (_user, project) = app.create_member_with_project().await;
    let (_agent, key) = seed_agent(project, "Builder").await;

    let bad = app
        .put_as_agent(
            &key,
            "/api/taskflow/agents/db/model",
            json!({ "project": project, "base_version": 0, "model": {
                "name": "Task", "fields": [{ "name": "owner", "type": "fk", "fk": { "model": "User" } }]
            } }),
        )
        .await;
    assert_eq!(bad.status(), 400, "{}", bad.text());
    assert!(bad.json()["errors"][0].as_str().unwrap().contains("Task.owner"));

    // Project, then Task pointing at it.
    let p = app
        .put_as_agent(&key, "/api/taskflow/agents/db/model", json!({ "project": project, "base_version": 0, "model": {
            "name": "Project", "fields": [{ "name": "id", "type": "i64", "primary_key": true }]
        } }))
        .await;
    assert_eq!(p.status(), 200, "{}", p.text());
    let t = app
        .put_as_agent(&key, "/api/taskflow/agents/db/model", json!({ "project": project, "base_version": 1, "model": {
            "name": "Task", "fields": [{ "name": "project", "type": "fk", "fk": { "model": "Project" } }]
        } }))
        .await;
    assert_eq!(t.status(), 200, "{}", t.text());

    let del = app
        .delete_json_as_agent(&key, &format!("/api/taskflow/agents/db/model?project={project}&name=Project&base_version=2"), &json!({}))
        .await;
    assert_eq!(del.status(), 400, "{}", del.text());
    assert!(del.json()["errors"][0].as_str().unwrap().contains("Task.project"));

    // Reading one model shows what points at it.
    let one = app.get_as_agent(&key, &format!("/api/taskflow/agents/db/schema?project={project}&model=Project")).await;
    assert_eq!(one.json()["referenced_by"], json!([{ "model": "Task", "field": "project" }]));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_touch_another_projects_schema() {
    let app = TestApp::new().await;
    let (_u1, p1) = app.create_member_with_project().await;
    let (_u2, p2) = app.create_member_with_project().await;
    let (_agent, key) = seed_agent(p1, "Builder").await;
    let r = app.get_as_agent(&key, &format!("/api/taskflow/agents/db/schema?project={p2}")).await;
    assert_eq!(r.status(), 403);
}
