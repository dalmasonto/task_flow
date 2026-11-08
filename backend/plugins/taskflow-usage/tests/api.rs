//! #1115: usage and cost.
//!
//! The rules that matter: a report carries COUNTS ONLY (any other field is a
//! 400 — no transcript content can ride in), the server prices it from a cited
//! table and leaves it UNPRICED rather than guess, a retried turn is a no-op,
//! the task is derived server-side, and the alerts each fire once.

mod support;

use serde_json::{Value, json};
use support::{TestApp, seed_agent_key, seed_member, seed_project};

use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelKind, taskflow_agent_message,
};
use taskflow_decisions::models::{TaskflowDecision, taskflow_decision};
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};
use taskflow_usage::models::{TaskflowUsageReport, taskflow_usage_report};
use umbral::orm::ForeignKey;

const R: &str = "/api/taskflow/agents/usage";

fn report(turn: &str, model: &str, input: i64, output: i64, cache_read: i64, cache_write: i64) -> Value {
    json!({ "turn_id": turn, "model": model, "input_tokens": input, "output_tokens": output,
            "cache_read_tokens": cache_read, "cache_write_tokens": cache_write })
}

async fn boot() -> (TestApp, i64, i64, String, i64) {
    let app = TestApp::new().await;
    taskflow_usage::service::seed_prices().await;
    let (owner, project) = seed_project(&app).await;
    seed_member(project, owner.id, "owner").await;
    let (key, agent) = seed_agent_key(project, &[]).await;
    (app, owner.id, project, key, agent)
}

async fn task_for(project: i64, agent: i64, status: TaskflowTaskStatus) -> i64 {
    TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0, project: ForeignKey::new(project), title: "work".into(), description_markdown: None,
            notes_markdown: None, status, priority: TaskflowTaskPriority::Normal, sort_order: 0, created_by: None,
            assigned_user: None, assigned_agent_id: Some(agent), review_gate: None, estimate_minutes: None,
            operator_user: None, operator_agent_id: None, created_by_agent_id: None, assignee_label: None,
            due_at: None, closed_at: None, github_issue_number: None, github_issue_url: None, github_repo: None,
            created_at: None, updated_at: None,
        })
        .await
        .unwrap()
        .id
}

async fn room(project: i64) -> i64 {
    TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0, project: ForeignKey::new(project), title: "alerts".into(), topic: None,
            kind: TaskflowChannelKind::Project, task: None, created_by_user: None, created_by_agent: None,
            archived: false, is_public: false, is_design: false, created_at: None,
        })
        .await
        .unwrap()
        .id
}

#[tokio::test(flavor = "multi_thread")]
async fn a_report_carries_counts_only() {
    let (app, _, _, key, _) = boot().await;
    let mut with_text = report("t1", "claude-opus-5-5", 10, 10, 0, 0);
    with_text["prompt"] = json!("the user's secret plan");
    let res = app.post_json_as_agent(&key, R, with_text).await;
    assert_eq!(res.status(), 400, "{}", res.text());
    assert_eq!(res.json().await["field"], "prompt");

    // A client cannot pick its own task either.
    let mut with_task = report("t2", "claude-opus-5-5", 10, 10, 0, 0);
    with_task["task"] = json!(1);
    assert_eq!(app.post_json_as_agent(&key, R, with_task).await.status(), 400);

    for (bad, field) in [
        (report("t3", "claude-opus-5-5", -1, 0, 0, 0), "input_tokens"),
        (report("t4", "claude-opus-5-5", 0, 60_000_000, 0, 0), "output_tokens"),
        (report("bad turn id!", "claude-opus-5-5", 1, 1, 0, 0), "turn_id"),
    ] {
        let res = app.post_json_as_agent(&key, R, bad.clone()).await;
        assert_eq!(res.status(), 400, "{bad}");
        assert_eq!(res.json().await["field"], field, "{bad}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_server_prices_it_and_never_guesses() {
    let (app, _, _, key, _) = boot().await;
    // Opus 5.5: $4 in, $20 out, $0.20 cache read (cited). 1M in + 100K out + 1M cache read = $6.20.
    let r = app.post_json_as_agent(&key, R, report("p1", "claude-opus-5-5", 1_000_000, 100_000, 1_000_000, 0)).await;
    assert_eq!(r.status(), 201, "{}", r.text());
    assert_eq!(r.json().await["cost_micros"], 6_200_000);

    // The longest prefix wins: a dated variant of 5.5 is not priced as Opus 5.
    let r = app.post_json_as_agent(&key, R, report("p2", "claude-opus-5-5-preview", 1_000_000, 0, 0, 0)).await.json().await;
    assert_eq!(r["cost_micros"], 4_000_000);

    // Cache WRITE has no cited price: the report is counted but unpriced.
    let r = app.post_json_as_agent(&key, R, report("p3", "claude-opus-5-5", 10, 10, 0, 500)).await.json().await;
    assert_eq!(r["cost_micros"], Value::Null);
    assert_eq!(r["priced"], false);
    // An unknown model is unpriced too.
    let r = app.post_json_as_agent(&key, R, report("p4", "gpt-5-codex", 1000, 1000, 0, 0)).await.json().await;
    assert_eq!(r["cost_micros"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_retried_turn_is_a_no_op_and_the_task_is_derived() {
    let (app, _, project, key, agent) = boot().await;
    let task = task_for(project, agent, TaskflowTaskStatus::InProgress).await;
    let first = app.post_json_as_agent(&key, R, report("same", "claude-sonnet-5-5", 100, 100, 0, 0)).await;
    assert_eq!(first.status(), 201);
    let first = first.json().await;
    assert_eq!(first["task"], task, "the agent's in-progress task, decided by the server");
    let again = app.post_json_as_agent(&key, R, report("same", "claude-sonnet-5-5", 999, 999, 0, 0)).await;
    assert_eq!(again.status(), 200);
    assert_eq!(again.json().await["id"], first["id"]);
    let n = TaskflowUsageReport::objects().filter(taskflow_usage_report::AGENT.eq(agent)).count().await.unwrap();
    assert_eq!(n, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_is_grouped_and_labelled_self_reported() {
    let (app, owner, project, key, agent) = boot().await;
    let task = task_for(project, agent, TaskflowTaskStatus::InProgress).await;
    app.post_json_as_agent(&key, R, report("a", "claude-opus-5-5", 1_000_000, 0, 0, 0)).await;
    app.post_json_as_agent(&key, R, report("b", "claude-sonnet-5-5", 1_000_000, 0, 0, 0)).await;
    app.post_json_as_agent(&key, R, report("c", "gpt-5-codex", 5, 5, 0, 0)).await;

    let by_model = app.get_as(owner, &format!("/api/taskflow/usage/{project}?group=model")).await.json().await;
    assert_eq!(by_model["self_reported"], true);
    assert_eq!(by_model["total"]["cost_micros"], 6_000_000);
    assert_eq!(by_model["total"]["unpriced_reports"], 1);
    assert_eq!(by_model["groups"].as_array().unwrap().len(), 3);
    let by_task = app.get_as(owner, &format!("/api/taskflow/usage/{project}?group=task")).await.json().await;
    assert_eq!(by_task["groups"][0]["key"], task.to_string());
    assert_eq!(by_task["month"]["spend_micros"], 6_000_000);

    let stranger = app.create_user().await;
    assert_eq!(app.get_as(stranger, &format!("/api/taskflow/usage/{project}")).await.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_owners_and_admins_edit_prices_and_every_price_cites_a_source() {
    let (app, owner, project, key, _) = boot().await;
    let dev = app.create_user().await;
    seed_member(project, dev, "developer").await;
    let price = json!({ "model_prefix": "gpt-5-codex", "input_micros_per_mtok": 1_250_000, "output_micros_per_mtok": 10_000_000,
                        "source": "OpenAI pricing page", "as_of": "2026-11" });
    assert_eq!(app.post_json_as(dev, &format!("/api/taskflow/usage/{project}/prices"), price.clone()).await.status(), 403);
    let mut no_source = price.clone();
    no_source["source"] = json!(" ");
    let res = app.post_json_as(owner, &format!("/api/taskflow/usage/{project}/prices"), no_source).await;
    assert_eq!(res.status(), 400);
    assert_eq!(res.json().await["field"], "source");
    assert_eq!(app.post_json_as(owner, &format!("/api/taskflow/usage/{project}/prices"), price).await.status(), 200);

    // The project's price is used from now on.
    let r = app.post_json_as_agent(&key, R, report("x", "gpt-5-codex", 1_000_000, 0, 0, 0)).await.json().await;
    assert_eq!(r["cost_micros"], 1_250_000);
    // Every listed price shows where it came from and when.
    let list = app.get_as(dev, &format!("/api/taskflow/usage/{project}/prices")).await.json().await;
    for p in list["results"].as_array().unwrap() {
        assert!(!p["source"].as_str().unwrap().is_empty() && !p["as_of"].as_str().unwrap().is_empty(), "{p}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_budget_alert_fires_once_a_month() {
    let (app, owner, project, key, _) = boot().await;
    let channel = room(project).await;
    let saved = app
        .post_json_as(owner, &format!("/api/taskflow/usage/{project}/settings"),
            json!({ "budget_micros": 10_000_000, "alert_percent": 80, "alert_channel": channel }))
        .await;
    assert_eq!(saved.status(), 200, "{}", saved.text());

    // $4 then $4.40: crosses 80% of $10 on the second.
    app.post_json_as_agent(&key, R, report("b1", "claude-opus-5-5", 1_000_000, 0, 0, 0)).await;
    app.post_json_as_agent(&key, R, report("b2", "claude-opus-5-5", 1_100_000, 0, 0, 0)).await;
    app.post_json_as_agent(&key, R, report("b3", "claude-opus-5-5", 1_000_000, 0, 0, 0)).await;
    let alerts: Vec<TaskflowAgentMessage> = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::CHANNEL.eq(channel))
        .fetch()
        .await
        .unwrap();
    assert_eq!(alerts.len(), 1, "once per month");
    assert!(alerts[0].body_markdown.contains("$8.40 of the $10.00 budget"), "{}", alerts[0].body_markdown);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_over_its_cap_gets_stop_and_ask() {
    let (app, owner, project, key, agent) = boot().await;
    let task = task_for(project, agent, TaskflowTaskStatus::InProgress).await;
    app.post_json_as(owner, &format!("/api/taskflow/usage/{project}/settings"), json!({ "task_cap_micros": 1_000_000 })).await;

    app.post_json_as_agent(&key, R, report("c1", "claude-opus-5-5", 500_000, 0, 0, 0)).await; // $2
    app.post_json_as_agent(&key, R, report("c2", "claude-opus-5-5", 500_000, 0, 0, 0)).await; // still over: no repeat

    // A notice to the agent…
    let notices: Vec<TaskflowAgentMessage> = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::TARGET_AGENT.eq(agent))
        .fetch()
        .await
        .unwrap();
    assert_eq!(notices.len(), 1, "once per task");
    assert!(notices[0].body_markdown.contains("Stop and ask"), "{}", notices[0].body_markdown);
    // …and an open decision that blocks the task.
    let d = TaskflowDecision::objects()
        .filter(taskflow_decision::PROJECT.eq(project) & taskflow_decision::KEY.eq(format!("continue-task-{task}-over-budget").as_str()))
        .first()
        .await
        .unwrap()
        .expect("a blocking decision");
    assert_eq!(serde_json::to_value(d.status).unwrap(), "open");
    assert!(taskflow_decisions::service::has_open_decision(task).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn reporting_needs_activity_write() {
    let app = TestApp::new().await;
    let (_, project) = seed_project(&app).await;
    let (key, _) = seed_agent_key(project, &["activity:write"]).await;
    assert_eq!(app.post_json_as_agent(&key, R, report("z", "claude-opus-5-5", 1, 1, 0, 0)).await.status(), 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_prompt_haiku_turn_is_priced_at_the_upper_tier() {
    let (app, _, _, key, _) = boot().await;
    // Up to 100K prompt tokens: $0.10 / $0.50.
    let low = app.post_json_as_agent(&key, R, report("h1", "claude-haiku-5-5", 100_000, 1_000_000, 0, 0)).await.json().await;
    assert_eq!(low["cost_micros"], 10_000 + 500_000);
    // 150K input: the $0.50 / $2.50 tier — not 5x too cheap.
    let high = app.post_json_as_agent(&key, R, report("h2", "claude-haiku-5-5", 150_000, 1_000_000, 0, 0)).await.json().await;
    assert_eq!(high["cost_micros"], 75_000 + 2_500_000);
    // Cache reads count toward the prompt size; the upper tier has no cited cache
    // price, so that turn is unpriced rather than priced at the low rate.
    let cached = app.post_json_as_agent(&key, R, report("h3", "claude-haiku-5-5", 50_000, 10, 60_000, 0)).await.json().await;
    assert_eq!(cached["cost_micros"], Value::Null);
}
