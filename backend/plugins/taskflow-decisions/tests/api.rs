//! #1094: the decisions HTTP surface, as tests.
//!
//! The rules that matter most are negative: an agent can never rule, a named
//! ruler is the only one who may rule, a ruling is permanent (409 the second
//! time), the ruled option must belong to the decision, and a non-member sees
//! nothing. Around them: the ruling unblocks linked tasks (activity + chat
//! notice to the asking agent), and supersede moves task links onto the
//! replacement so nothing silently unblocks.

mod support;
use serde_json::{Value, json};
use support::{TestApp, seed_agent_key, seed_member, seed_project, seed_task};

use taskflow_agents::models::{TaskflowAgentMessage, taskflow_agent_message};
use taskflow_tasks::models::{TaskflowTaskActivity, taskflow_task_activity};

fn base(project: i64) -> String {
    format!("/api/taskflow/decisions/{project}")
}

fn options() -> Value {
    json!([
        { "label": "1 hour", "detail": "Simple and safe." },
        { "label": "6 hours", "detail": "Covers nightly builds.", "recommended": true },
        { "label": "7 days" },
    ])
}

fn option_id(decision: &Value, label: &str) -> i64 {
    decision["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["label"] == label)
        .unwrap_or_else(|| panic!("no option {label}: {decision}"))["id"]
        .as_i64()
        .unwrap()
}

async fn activity_actions(task: i64) -> Vec<(String, String)> {
    TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::TASK.eq(task))
        .fetch()
        .await
        .unwrap()
        .into_iter()
        .map(|a| (a.action, a.body_markdown.unwrap_or_default()))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_asks_a_human_rules_and_the_task_unblocks() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (key, agent_id) = seed_agent_key(project, &[]).await;
    let task = seed_task(project, "Wire trigger delay").await;

    let asked = app
        .post_json_as_agent(
            &key,
            "/api/taskflow/agents/decisions",
            json!({ "key": "trigger-max-delay", "question": "Max delay per agent trigger?",
                    "options": options(), "task_ids": [task] }),
        )
        .await;
    assert_eq!(asked.status(), 201, "{}", asked.text());
    let asked = asked.json().await;
    assert_eq!(asked["status"], "open");
    assert_eq!(asked["is_ruled"], false);
    assert_eq!(asked["task_ids"], json!([task]));
    assert_eq!(asked["asked_by_agent"], agent_id);
    // The recommendation is attributed to the asker.
    let six = asked["options"].as_array().unwrap().iter().find(|o| o["label"] == "6 hours").unwrap();
    assert_eq!(six["recommended"], true);

    // The board's view: the task is blocked on this decision.
    let blocking = app.get_as(owner.id, &format!("{}/blocking", base(project))).await.json().await;
    assert_eq!(blocking["tasks"][task.to_string()][0]["key"], "trigger-max-delay");

    // is_ruled, from the agent's side, before.
    let before = app.get_as_agent(&key, "/api/taskflow/agents/decisions/trigger-max-delay").await;
    assert_eq!(before.status(), 200);
    assert_eq!(before.json().await["is_ruled"], false);

    // A human rules.
    let six_id = option_id(&asked, "6 hours");
    let ruled = app
        .post_json_as(
            owner.id,
            &format!("{}/d/trigger-max-delay/rule", base(project)),
            json!({ "option_id": six_id, "note": "Leaves room for the 2h migration." }),
        )
        .await;
    assert_eq!(ruled.status(), 200, "{}", ruled.text());
    let ruled = ruled.json().await;
    assert_eq!(ruled["status"], "ruled");
    assert_eq!(ruled["ruled_option"]["label"], "6 hours");
    assert_eq!(ruled["ruled_by_user"], owner.id);
    assert!(ruled["ruled_at"].is_string());

    // is_ruled, after.
    let after = app.get_as_agent(&key, "/api/taskflow/agents/decisions/trigger-max-delay").await.json().await;
    assert_eq!(after["is_ruled"], true);
    assert_eq!(after["ruled_option"]["label"], "6 hours");
    assert_eq!(after["ruling_note"], "Leaves room for the 2h migration.");

    // The task is no longer blocked, and its history says so.
    let blocking = app.get_as(owner.id, &format!("{}/blocking", base(project))).await.json().await;
    assert!(blocking["tasks"].get(task.to_string()).is_none(), "{blocking}");
    let actions = activity_actions(task).await;
    assert!(actions.iter().any(|(a, _)| a == "decision_blocked"), "{actions:?}");
    assert!(
        actions.iter().any(|(a, b)| a == "decision_ruled" && b.contains("Unblocked")),
        "{actions:?}"
    );

    // The asking agent is told, through chat (its pane path), as the ruler.
    let notice = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::PROJECT.eq(project))
        .fetch()
        .await
        .unwrap()
        .into_iter()
        .find(|m| m.body_markdown.contains("trigger-max-delay"))
        .expect("a ruling notice");
    assert_eq!(notice.target_agent.as_ref().map(|a| a.id()), Some(agent_id));
    assert_eq!(notice.sender_user.as_ref().map(|u| u.id()), Some(owner.id));
    assert!(notice.body_markdown.contains(&format!("#TSK{task}")), "{}", notice.body_markdown);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_has_no_way_to_rule_or_supersede() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (key, _) = seed_agent_key(project, &[]).await;
    let asked = app
        .post_json_as_agent(&key, "/api/taskflow/agents/decisions", json!({ "key": "palette", "question": "Which palette?", "options": options() }))
        .await
        .json()
        .await;
    let one = option_id(&asked, "1 hour");

    for path in ["/api/taskflow/agents/decisions/palette/rule", "/api/taskflow/agents/decisions/palette/supersede"] {
        let res = app.post_json_as_agent(&key, path, json!({ "option_id": one, "by": "x" })).await;
        assert!(matches!(res.status(), 404 | 405), "{path} answered {}", res.status());
    }
    // An agent key on the HUMAN route is not a user: rejected.
    let res = app
        .post_json_as_agent(&key, &format!("{}/d/palette/rule", base(project)), json!({ "option_id": one }))
        .await;
    assert_eq!(res.status(), 401, "{}", res.text());

    let still = app.get_as_agent(&key, "/api/taskflow/agents/decisions/palette").await.json().await;
    assert_eq!(still["status"], "open");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_named_ruler_is_the_only_one_who_may_rule() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let other = app.create_user().await;
    seed_member(project, other, "developer").await;

    let asked = app
        .post_json_as(owner.id, &base(project), json!({ "key": "who-rules", "question": "Q?", "options": options(), "ruler_user": owner.id }))
        .await;
    assert_eq!(asked.status(), 201, "{}", asked.text());
    let one = option_id(&asked.json().await, "1 hour");

    let denied = app.post_json_as(other, &format!("{}/d/who-rules/rule", base(project)), json!({ "option_id": one })).await;
    assert_eq!(denied.status(), 403, "{}", denied.text());
    let allowed = app.post_json_as(owner.id, &format!("{}/d/who-rules/rule", base(project)), json!({ "option_id": one })).await;
    assert_eq!(allowed.status(), 200, "{}", allowed.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_ruling_is_permanent_and_must_use_its_own_option() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let a = app.post_json_as(owner.id, &base(project), json!({ "key": "first", "question": "A?", "options": options() })).await.json().await;
    let b = app.post_json_as(owner.id, &base(project), json!({ "key": "second", "question": "B?", "options": options() })).await.json().await;

    // An option of ANOTHER decision is refused, naming the field.
    let foreign = app
        .post_json_as(owner.id, &format!("{}/d/first/rule", base(project)), json!({ "option_id": option_id(&b, "1 hour") }))
        .await;
    assert_eq!(foreign.status(), 400);
    assert_eq!(foreign.json().await["field"], "option_id");

    let ok = app.post_json_as(owner.id, &format!("{}/d/first/rule", base(project)), json!({ "option_id": option_id(&a, "1 hour") })).await;
    assert_eq!(ok.status(), 200);
    let again = app.post_json_as(owner.id, &format!("{}/d/first/rule", base(project)), json!({ "option_id": option_id(&a, "7 days") })).await;
    assert_eq!(again.status(), 409);
    let read = app.get_as(owner.id, &format!("{}/d/first", base(project))).await.json().await;
    assert_eq!(read["ruled_option"]["label"], "1 hour");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_member_sees_nothing() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    app.post_json_as(owner.id, &base(project), json!({ "key": "secret", "question": "Q?" })).await;
    let stranger = app.create_user().await;

    assert_eq!(app.get_as(stranger, &base(project)).await.status(), 404);
    assert_eq!(app.get_as(stranger, &format!("{}/d/secret", base(project))).await.status(), 404);
    assert_eq!(app.post_json_as(stranger, &base(project), json!({ "key": "mine", "question": "Q?" })).await.status(), 404);

    // An agent of ANOTHER project does not see it either: its credential pins its own.
    let (_, other_project) = seed_project(&app).await;
    let (key, _) = seed_agent_key(other_project, &[]).await;
    assert_eq!(app.get_as_agent(&key, "/api/taskflow/agents/decisions/secret").await.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_input_names_the_field() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (_, other_project) = seed_project(&app).await;
    let foreign_task = seed_task(other_project, "Not yours").await;

    let cases = [
        (json!({ "key": "Bad Key", "question": "Q?" }), "key"),
        (json!({ "key": "ok-key", "question": "" }), "question"),
        (json!({ "key": "ok-key", "question": "Q?", "task_ids": [foreign_task] }), "task_ids"),
        (json!({ "key": "ok-key", "question": "Q?", "options": [{ "label": "" }] }), "options[0]"),
        (json!({ "key": "ok-key", "question": "Q?", "ruler_user": 999999 }), "ruler_user"),
    ];
    for (body, field) in cases {
        let res = app.post_json_as(owner.id, &base(project), body.clone()).await;
        assert_eq!(res.status(), 400, "{body}");
        assert_eq!(res.json().await["field"], field, "{body}");
    }

    assert_eq!(app.post_json_as(owner.id, &base(project), json!({ "key": "dup", "question": "Q?" })).await.status(), 201);
    let dup = app.post_json_as(owner.id, &base(project), json!({ "key": "dup", "question": "Again?" })).await;
    assert_eq!(dup.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_denied_tasks_write_capability_blocks_agent_writes_not_reads() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    app.post_json_as(owner.id, &base(project), json!({ "key": "readable", "question": "Q?" })).await;
    let (key, _) = seed_agent_key(project, &["tasks:write"]).await;

    let ask = app.post_json_as_agent(&key, "/api/taskflow/agents/decisions", json!({ "key": "nope", "question": "Q?" })).await;
    assert_eq!(ask.status(), 403, "{}", ask.text());
    let comment = app.post_json_as_agent(&key, "/api/taskflow/agents/decisions/readable/comments", json!({ "body_markdown": "hi" })).await;
    assert_eq!(comment.status(), 403);
    assert_eq!(app.get_as_agent(&key, "/api/taskflow/agents/decisions/readable").await.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn superseding_moves_the_tasks_and_keeps_them_blocked() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let t1 = seed_task(project, "One").await;
    let t2 = seed_task(project, "Two").await;

    // A is RULED (so t1 was unblocked); B is open and already blocks t2.
    let a = app.post_json_as(owner.id, &base(project), json!({ "key": "old-call", "question": "Old?", "options": options(), "task_ids": [t1, t2] })).await.json().await;
    app.post_json_as(owner.id, &format!("{}/d/old-call/rule", base(project)), json!({ "option_id": option_id(&a, "1 hour") })).await;
    app.post_json_as(owner.id, &base(project), json!({ "key": "new-call", "question": "New?", "options": options(), "task_ids": [t2] })).await;

    // The replacement must be open; a decision cannot replace itself.
    assert_eq!(app.post_json_as(owner.id, &format!("{}/d/old-call/supersede", base(project)), json!({ "by": "old-call" })).await.status(), 400);

    let res = app.post_json_as(owner.id, &format!("{}/d/old-call/supersede", base(project)), json!({ "by": "new-call" })).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let new = res.json().await;
    let mut tasks: Vec<i64> = new["task_ids"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    tasks.sort_unstable();
    assert_eq!(tasks, vec![t1, t2], "both tasks now hang off the replacement, no duplicate");

    let old = app.get_as(owner.id, &format!("{}/d/old-call", base(project))).await.json().await;
    assert_eq!(old["status"], "superseded");
    assert_eq!(old["superseded_by_id"], new["id"]);
    assert_eq!(old["task_ids"], json!([]));
    // The old ruling stays on record.
    assert_eq!(old["ruled_option"]["label"], "1 hour");

    // t1 was unblocked by the old ruling and is blocked again: nothing silently unblocks.
    let blocking = app.get_as(owner.id, &format!("{}/blocking", base(project))).await.json().await;
    assert_eq!(blocking["tasks"][t1.to_string()][0]["key"], "new-call");
    assert_eq!(blocking["tasks"][t2.to_string()][0]["key"], "new-call");
    assert!(activity_actions(t1).await.iter().any(|(a, _)| a == "decision_superseded"));

    // Superseded is final.
    let twice = app.post_json_as(owner.id, &format!("{}/d/old-call/supersede", base(project)), json!({ "by": "new-call" })).await;
    assert_eq!(twice.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn ruling_one_of_two_blockers_reports_the_task_still_blocked() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let t = seed_task(project, "Doubly blocked").await;
    let a = app.post_json_as(owner.id, &base(project), json!({ "key": "first-gate", "question": "A?", "options": options(), "task_ids": [t] })).await.json().await;
    app.post_json_as(owner.id, &base(project), json!({ "key": "second-gate", "question": "B?", "options": options(), "task_ids": [t] })).await;

    app.post_json_as(owner.id, &format!("{}/d/first-gate/rule", base(project)), json!({ "option_id": option_id(&a, "7 days") })).await;
    let actions = activity_actions(t).await;
    assert!(
        actions.iter().any(|(a, b)| a == "decision_ruled" && b.contains("Still blocked on `second-gate`")),
        "{actions:?}"
    );
    let blocking = app.get_as(owner.id, &format!("{}/blocking", base(project))).await.json().await;
    assert_eq!(blocking["tasks"][t.to_string()][0]["key"], "second-gate");
}

#[tokio::test(flavor = "multi_thread")]
async fn discussion_recommendation_and_links_work_for_agents() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (key, agent_id) = seed_agent_key(project, &[]).await;
    let t = seed_task(project, "Later").await;
    app.post_json_as(owner.id, &base(project), json!({ "key": "talk", "question": "Q?", "options": options() })).await;

    let c = app.post_json_as_agent(&key, "/api/taskflow/agents/decisions/talk/comments", json!({ "body_markdown": "Agree, if missed triggers are marked." })).await;
    assert_eq!(c.status(), 201);
    let d = c.json().await;
    assert_eq!(d["comments"][0]["author_agent"], agent_id);

    // The recommendation MOVES: one option at a time carries it.
    let seven = option_id(&d, "7 days");
    let r = app.post_json_as_agent(&key, "/api/taskflow/agents/decisions/talk/recommend", json!({ "option_id": seven })).await.json().await;
    let recommended: Vec<&str> = r["options"].as_array().unwrap().iter().filter(|o| o["recommended"] == true).map(|o| o["label"].as_str().unwrap()).collect();
    assert_eq!(recommended, vec!["7 days"]);

    let linked = app.post_json_as_agent(&key, "/api/taskflow/agents/decisions/talk/tasks", json!({ "task_id": t })).await.json().await;
    assert_eq!(linked["task_ids"], json!([t]));
    let unlinked = app.post_json_as_agent(&key, "/api/taskflow/agents/decisions/talk/tasks", json!({ "task_id": t, "link": false })).await.json().await;
    assert_eq!(unlinked["task_ids"], json!([]));

    let open = app.get_as_agent(&key, "/api/taskflow/agents/decisions?status=open").await.json().await;
    assert_eq!(open["count"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_named_ruler_cannot_be_routed_around_by_superseding() {
    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let member = app.create_user().await;
    seed_member(project, member, "developer").await;
    let other_ruler = app.create_user().await;
    seed_member(project, other_ruler, "developer").await;
    let t = seed_task(project, "Gated").await;

    app.post_json_as(owner.id, &base(project), json!({ "key": "owners-call", "question": "Q?", "options": options(), "ruler_user": owner.id, "task_ids": [t] })).await;
    // The member opens an un-ruled copy...
    app.post_json_as(member, &base(project), json!({ "key": "my-copy", "question": "Q?", "options": options() })).await;
    // ...and may NOT use it to replace the ruler's decision.
    let denied = app.post_json_as(member, &format!("{}/d/owners-call/supersede", base(project)), json!({ "by": "my-copy" })).await;
    assert_eq!(denied.status(), 403, "{}", denied.text());
    let still = app.get_as(owner.id, &format!("{}/d/owners-call", base(project))).await.json().await;
    assert_eq!(still["status"], "open");
    assert_eq!(still["task_ids"], json!([t]), "a refused supersede moves nothing");

    // A replacement answering to a DIFFERENT ruler is refused, naming the field.
    app.post_json_as(owner.id, &base(project), json!({ "key": "other-ruler", "question": "Q?", "options": options(), "ruler_user": other_ruler })).await;
    let mismatch = app.post_json_as(owner.id, &format!("{}/d/owners-call/supersede", base(project)), json!({ "by": "other-ruler" })).await;
    assert_eq!(mismatch.status(), 400);
    assert_eq!(mismatch.json().await["field"], "by");

    // The ruler may supersede with an unnamed copy, which INHERITS the ruler —
    // so the member still cannot rule the replacement.
    let ok = app.post_json_as(owner.id, &format!("{}/d/owners-call/supersede", base(project)), json!({ "by": "my-copy" })).await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
    let copy = ok.json().await;
    assert_eq!(copy["ruler_user"], owner.id);
    assert_eq!(copy["task_ids"], json!([t]));
    let member_rules = app
        .post_json_as(member, &format!("{}/d/my-copy/rule", base(project)), json!({ "option_id": option_id(&copy, "1 hour") }))
        .await;
    assert_eq!(member_rules.status(), 403, "{}", member_rules.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn ruling_a_decision_fires_a_task_unblocked_wake_up() {
    use taskflow_agents::models::{TaskflowWakeDeliver, TaskflowWakeRule, TaskflowWakeStatus, TaskflowWakeTrigger, taskflow_wake_rule};
    use umbral::orm::ForeignKey;

    let app = TestApp::new().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (_, agent) = seed_agent_key(project, &[]).await;
    let t = seed_task(project, "Waits on a ruling").await;
    let d = app.post_json_as(owner.id, &base(project), json!({ "key": "wake-gate", "question": "Go?", "options": options(), "task_ids": [t] })).await.json().await;

    // The agent waits for the task (decision-blocked, so the rule is valid).
    let rule = TaskflowWakeRule::objects()
        .create(TaskflowWakeRule {
            id: 0, project: ForeignKey::new(project), agent: ForeignKey::new(agent), created_by_user: None,
            created_by_agent: Some(ForeignKey::new(agent)), created_by_label: "agent".into(),
            trigger_kind: TaskflowWakeTrigger::TaskUnblocked, target_task: Some(t), target_message: None,
            watch_channel: None, mentions_only: false, fire_at: None, note: "the gate is ruled".into(),
            deliver: TaskflowWakeDeliver::Pane, deliver_channel: None, pane_channel: None,
            status: TaskflowWakeStatus::Armed, fired_at: None, delivered_at: None, source_ref: None,
            created_at: None, updated_at: None,
        })
        .await
        .unwrap();
    // While the decision is open, a task write must NOT fire it.
    taskflow_agents::wakeups::task_maybe_unblocked(t).await;
    let still = TaskflowWakeRule::objects().filter(taskflow_wake_rule::ID.eq(rule.id)).first().await.unwrap().unwrap();
    assert_eq!(still.status, TaskflowWakeStatus::Armed, "still blocked by the open decision");

    app.post_json_as(owner.id, &format!("{}/d/wake-gate/rule", base(project)), json!({ "option_id": option_id(&d, "1 hour") })).await;
    let fired = TaskflowWakeRule::objects().filter(taskflow_wake_rule::ID.eq(rule.id)).first().await.unwrap().unwrap();
    // The agent has no live session here, so it is fired-then-missed: either way, not armed.
    assert_ne!(fired.status, TaskflowWakeStatus::Armed, "the ruling woke it");
    assert_eq!(fired.source_ref.as_deref(), Some(format!("task:{t}").as_str()));
}
