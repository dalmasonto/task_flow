//! `GET /api/taskflow/projects/{project}/stats` — the dashboard's single
//! aggregation endpoint over a project's sessions, tasks, and activity.
//!
//! Drives the real HTTP route (via `support::TestApp`) rather than calling
//! the handler function directly, so auth (`RequireAuth`), project scoping
//! (`can_access_project` -> 404 for a non-member), and query parsing all get
//! exercised the way a real request would.

mod support;

use chrono::{Datelike, Duration, TimeZone, Utc};
use serde_json::Value;

use support::{
    TestApp, seed_active_member, seed_activity, seed_closed_task, seed_project, seed_session,
    seed_task,
};
use taskflow_tasks::models::TaskflowActorKind;

/// Find the entry in a `worked_per_member`/`activity_by_member`-shaped array
/// whose `kind`/`id` match, and return its numeric field (`seconds` or
/// `count`). Panics (with the array printed) if the field is not a number —
/// the array is small, so this doubles as a decent failure message.
fn find_member<'a>(arr: &'a [Value], kind: &str, id: i64) -> Option<&'a Value> {
    arr.iter()
        .find(|e| e["kind"] == kind && e["id"].as_i64() == Some(id))
}

fn tool_count(arr: &[Value], tool: &str) -> Option<i64> {
    arr.iter()
        .find(|e| e["tool"] == tool)
        .and_then(|e| e["count"].as_i64())
}

fn day_count(arr: &[Value], day: &str) -> Option<i64> {
    arr.iter()
        .find(|e| e["day"] == day)
        .and_then(|e| e["count"].as_i64())
}

/// Everything the test scenario needs, seeded once and reused across the
/// range=30d (default), range=7d, range=all, 400, and 404 assertions —
/// seeding it per-case would multiply the already-long fixture for no
/// benefit, since none of the assertions mutate state.
struct Scenario {
    app: TestApp,
    project: i64,
    member: i64,
    outsider: i64,
    agent_id: i64,
    today: String,
    yesterday: String,
    old_day: String,
}

async fn build_scenario() -> Scenario {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let member = app.create_user().await;
    let outsider = app.create_user().await;
    seed_active_member(project, member).await;
    let agent_id = 9001i64;

    // A task to hang the sessions/activity off of — deliberately NOT one of
    // the closed/open tasks below, so it can't be confused with them, but it
    // still counts toward `totals.open_now` like any other non-terminal task
    // (accounted for in the open_now assertion below).
    let work_task = seed_task(project).await;

    // --- Sessions: worked_per_member + active_members -----------------
    // Anchored on a single `now` read once, so every offset is internally
    // consistent even if the test happens to straddle a clock tick.
    let now = Utc::now();

    // Recent (within 7d): both the user and the agent get two/one sessions.
    seed_session(
        project,
        work_task,
        TaskflowActorKind::User,
        Some(member),
        None,
        "Member",
        now - Duration::hours(1),
        Some(600),
    )
    .await;
    seed_session(
        project,
        work_task,
        TaskflowActorKind::User,
        Some(member),
        None,
        "Member",
        now - Duration::hours(2),
        Some(300),
    )
    .await;
    seed_session(
        project,
        work_task,
        TaskflowActorKind::Agent,
        None,
        Some(agent_id),
        "Agent",
        now - Duration::hours(1),
        Some(500),
    )
    .await;

    // A `system` session: must NEVER appear in worked_per_member or count
    // toward active_members, at any range.
    seed_session(
        project,
        work_task,
        TaskflowActorKind::System,
        None,
        None,
        "System",
        now - Duration::hours(1),
        Some(9_999),
    )
    .await;

    // Mid-range (10 days ago): outside a 7d cutoff, inside 30d/90d/all.
    seed_session(
        project,
        work_task,
        TaskflowActorKind::User,
        Some(member),
        None,
        "Member",
        now - Duration::days(10),
        Some(1_000),
    )
    .await;

    // Very old (100 days ago): outside every fixed cutoff, only visible under
    // range=all.
    seed_session(
        project,
        work_task,
        TaskflowActorKind::Agent,
        None,
        Some(agent_id),
        "Agent",
        now - Duration::days(100),
        Some(50_000),
    )
    .await;

    // --- Tasks: tasks_closed_by_day + closed_in_range + open_now -------
    // Anchored on the CALENDAR DAY of `now` at a fixed mid-day hour, so the
    // "today"/"yesterday" bucketing can't flake around a midnight-UTC test
    // run the way `now - 1h` / `now - 25h` could.
    let today_noon = Utc
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 12, 0, 0)
        .single()
        .expect("valid today-noon timestamp");
    let yesterday_noon = today_noon - Duration::days(1);
    let old_noon = today_noon - Duration::days(40);

    seed_closed_task(project, today_noon).await;
    seed_closed_task(project, today_noon + Duration::hours(1)).await; // same day as above
    seed_closed_task(project, yesterday_noon).await;
    seed_closed_task(project, old_noon).await; // outside the 30d default, inside "all"

    // Open tasks: never terminal, so they must count toward open_now at
    // EVERY range (it's a snapshot, not range-filtered) and never appear in
    // tasks_closed_by_day/closed_in_range.
    seed_task(project).await;
    seed_task(project).await;

    // --- Activity: activity_by_tool + activity_by_member ----------------
    // Two actions, all three actor kinds. `edit_description` x2 user + x1
    // agent = 3; `add_comment` x1 user + x1 agent = 2; `status_change` x1
    // system (counts in activity_by_tool, excluded from activity_by_member).
    seed_activity(
        project,
        work_task,
        TaskflowActorKind::User,
        Some(member),
        None,
        "Member",
        "edit_description",
    )
    .await;
    seed_activity(
        project,
        work_task,
        TaskflowActorKind::User,
        Some(member),
        None,
        "Member",
        "edit_description",
    )
    .await;
    seed_activity(
        project,
        work_task,
        TaskflowActorKind::Agent,
        None,
        Some(agent_id),
        "Agent",
        "edit_description",
    )
    .await;
    seed_activity(
        project,
        work_task,
        TaskflowActorKind::User,
        Some(member),
        None,
        "Member",
        "add_comment",
    )
    .await;
    seed_activity(
        project,
        work_task,
        TaskflowActorKind::Agent,
        None,
        Some(agent_id),
        "Agent",
        "add_comment",
    )
    .await;
    seed_activity(
        project,
        work_task,
        TaskflowActorKind::System,
        None,
        None,
        "System",
        "status_change",
    )
    .await;

    Scenario {
        app,
        project,
        member,
        outsider,
        agent_id,
        today: today_noon.format("%Y-%m-%d").to_string(),
        yesterday: yesterday_noon.format("%Y-%m-%d").to_string(),
        old_day: old_noon.format("%Y-%m-%d").to_string(),
    }
}

#[tokio::test]
async fn default_range_is_30d_and_aggregates_correctly() {
    let s = build_scenario().await;

    let resp = s
        .app
        .get_as(s.member, &format!("/api/taskflow/projects/{}/stats", s.project))
        .await;
    assert_eq!(resp.status(), 200, "member GET must succeed");
    let body = resp.json().await;
    assert_eq!(body["range"], "30d", "missing range param defaults to 30d");

    // worked_per_member: sums duration_seconds within 30d, excludes system,
    // sorted desc. The 100-day-old agent session is excluded; the 10-day-old
    // user session is included.
    let worked = body["worked_per_member"].as_array().expect("array");
    assert_eq!(
        find_member(worked, "user", s.member)
            .and_then(|e| e["seconds"].as_i64()),
        Some(600 + 300 + 1_000),
        "user worked seconds within 30d"
    );
    assert_eq!(
        find_member(worked, "agent", s.agent_id)
            .and_then(|e| e["seconds"].as_i64()),
        Some(500),
        "agent worked seconds within 30d (100d-old session excluded)"
    );
    assert!(
        find_member(worked, "system", 0).is_none(),
        "system actor must never appear in worked_per_member"
    );
    // desc order: user (1900) before agent (500).
    assert_eq!(worked[0]["kind"], "user");

    // tasks_closed_by_day: two tasks today, one yesterday; the 40-day-old
    // task is outside the 30d window. Ascending by day.
    let by_day = body["tasks_closed_by_day"].as_array().expect("array");
    assert_eq!(day_count(by_day, &s.today), Some(2));
    assert_eq!(day_count(by_day, &s.yesterday), Some(1));
    assert_eq!(
        day_count(by_day, &s.old_day),
        None,
        "the 40-day-old close must not appear under the 30d default"
    );
    let yesterday_idx = by_day.iter().position(|e| e["day"] == s.yesterday).unwrap();
    let today_idx = by_day.iter().position(|e| e["day"] == s.today).unwrap();
    assert!(yesterday_idx < today_idx, "tasks_closed_by_day is ascending");

    // activity_by_tool: desc by count.
    let by_tool = body["activity_by_tool"].as_array().expect("array");
    assert_eq!(tool_count(by_tool, "edit_description"), Some(3));
    assert_eq!(tool_count(by_tool, "add_comment"), Some(2));
    assert_eq!(tool_count(by_tool, "status_change"), Some(1));
    assert_eq!(by_tool[0]["tool"], "edit_description", "desc order");

    // activity_by_member: totals per actor across both actions; system excluded.
    let by_member = body["activity_by_member"].as_array().expect("array");
    assert_eq!(
        find_member(by_member, "user", s.member).and_then(|e| e["count"].as_i64()),
        Some(3)
    );
    assert_eq!(
        find_member(by_member, "agent", s.agent_id).and_then(|e| e["count"].as_i64()),
        Some(2)
    );
    assert!(find_member(by_member, "system", 0).is_none());

    // totals.
    assert_eq!(body["totals"]["closed_in_range"], 3, "3 closes within 30d");
    assert_eq!(body["totals"]["open_now"], 3, "3 non-terminal tasks (work_task + 2 open)");
    assert_eq!(body["totals"]["active_members"], 2, "user + agent, system excluded");
}

#[tokio::test]
async fn range_7d_excludes_the_10_day_old_session() {
    let s = build_scenario().await;

    let resp = s
        .app
        .get_as(
            s.member,
            &format!("/api/taskflow/projects/{}/stats?range=7d", s.project),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = resp.json().await;
    assert_eq!(body["range"], "7d");

    let worked = body["worked_per_member"].as_array().expect("array");
    assert_eq!(
        find_member(worked, "user", s.member).and_then(|e| e["seconds"].as_i64()),
        Some(600 + 300),
        "10-day-old session excluded under 7d"
    );
    assert_eq!(
        find_member(worked, "agent", s.agent_id).and_then(|e| e["seconds"].as_i64()),
        Some(500)
    );
}

#[tokio::test]
async fn range_all_ignores_the_cutoff() {
    let s = build_scenario().await;

    let resp = s
        .app
        .get_as(
            s.member,
            &format!("/api/taskflow/projects/{}/stats?range=all", s.project),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = resp.json().await;
    assert_eq!(body["range"], "all");

    let worked = body["worked_per_member"].as_array().expect("array");
    assert_eq!(
        find_member(worked, "user", s.member).and_then(|e| e["seconds"].as_i64()),
        Some(600 + 300 + 1_000),
    );
    assert_eq!(
        find_member(worked, "agent", s.agent_id).and_then(|e| e["seconds"].as_i64()),
        Some(500 + 50_000),
        "the very-old 100-day session is included under range=all"
    );

    let by_day = body["tasks_closed_by_day"].as_array().expect("array");
    assert_eq!(day_count(by_day, &s.old_day), Some(1), "40-day-old close is visible under all");
    assert_eq!(body["totals"]["closed_in_range"], 4);
    // open_now is a snapshot — unaffected by range.
    assert_eq!(body["totals"]["open_now"], 3);
}

#[tokio::test]
async fn unknown_range_is_400() {
    let s = build_scenario().await;

    let resp = s
        .app
        .get_as(
            s.member,
            &format!("/api/taskflow/projects/{}/stats?range=nonsense", s.project),
        )
        .await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn non_member_gets_404() {
    let s = build_scenario().await;

    let resp = s
        .app
        .get_as(s.outsider, &format!("/api/taskflow/projects/{}/stats", s.project))
        .await;
    assert_eq!(resp.status(), 404);
}
