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
    TestApp, TestResponse, seed_active_member, seed_activity, seed_closed_task, seed_project,
    seed_session, seed_task,
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

/// `activity_by_tool` caps at the top 12 actions by count, folding everything
/// past that into a single `{"tool":"Other","count":<sum of the tail>}` entry
/// (see `views.rs`'s `if tools.len() > 12` branch). No other test in this
/// file exceeds 2 distinct actions, so this is the only regression pin for
/// the fold itself. Self-contained project/member so it can't perturb the
/// shared `build_scenario` sums used by the tests above.
#[tokio::test]
async fn activity_by_tool_folds_the_tail_past_top_12_into_other() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let member = app.create_user().await;
    seed_active_member(project, member).await;
    let task = seed_task(project).await;

    // 14 distinct actions, each with a distinct count so desc ordering is
    // deterministic: tool01=14 events ... tool14=1 event.
    for i in 1..=14i64 {
        let action = format!("tool{i:02}");
        let count = 15 - i; // tool01 -> 14, tool02 -> 13, ..., tool14 -> 1
        for _ in 0..count {
            seed_activity(
                project,
                task,
                TaskflowActorKind::User,
                Some(member),
                None,
                "Member",
                &action,
            )
            .await;
        }
    }

    let resp = s_get_stats_all(&app, member, project).await;
    assert_eq!(resp.status(), 200);
    let body = resp.json().await;

    let by_tool = body["activity_by_tool"].as_array().expect("array");
    assert_eq!(by_tool.len(), 13, "top 12 + one folded 'Other' entry");

    // First 12 entries are the 12 highest-count actions (tool01..tool12,
    // counts 14 down to 3), strictly descending.
    for i in 1..=12i64 {
        let action = format!("tool{i:02}");
        let expected_count = 15 - i;
        assert_eq!(
            tool_count(by_tool, &action),
            Some(expected_count),
            "entry for {action} present with its own count in the top 12"
        );
    }
    for i in 0..11 {
        assert!(
            by_tool[i]["count"].as_i64().unwrap() >= by_tool[i + 1]["count"].as_i64().unwrap(),
            "activity_by_tool must be desc by count"
        );
    }

    // 13th entry: "Other", summing the two smallest tails (tool13=2, tool14=1).
    assert_eq!(by_tool[12]["tool"], "Other");
    assert_eq!(
        by_tool[12]["count"].as_i64(),
        Some(2 + 1),
        "'Other' sums the counts of the folded tail (tool13 + tool14)"
    );
    assert_eq!(tool_count(by_tool, "tool13"), None, "tool13 folded into Other, not listed on its own");
    assert_eq!(tool_count(by_tool, "tool14"), None, "tool14 folded into Other, not listed on its own");
}

/// `active_members` counts a still-running session (`duration_seconds: None`,
/// `ended_at: None`) — it is NOT gated on a completed duration the way
/// `worked_per_member` is (see `views.rs`: `active` is built in its own pass
/// over `sessions`, keyed only on `in_range(s.started_at)`, while `worked`
/// additionally requires `s.duration_seconds` to be `Some`). This pins that
/// split against a regression back to `active_members = worked.len()`.
#[tokio::test]
async fn active_members_counts_a_still_running_session_worked_per_member_does_not() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let member_a = app.create_user().await;
    seed_active_member(project, member_a).await;
    let task = seed_task(project).await;

    let now = Utc::now();

    // A's ONE session is still running: no duration, no ended_at.
    seed_session(
        project,
        task,
        TaskflowActorKind::User,
        Some(member_a),
        None,
        "Member A",
        now - Duration::hours(1),
        None,
    )
    .await;

    let resp = s_get_stats_all(&app, member_a, project).await;
    assert_eq!(resp.status(), 200);
    let body = resp.json().await;

    assert!(
        body["totals"]["active_members"].as_i64().unwrap_or(0) >= 1,
        "a still-running session's actor counts toward active_members"
    );

    let worked = body["worked_per_member"].as_array().expect("array");
    assert_eq!(
        find_member(worked, "user", member_a),
        None,
        "a still-running (duration-less) session contributes nothing to worked_per_member"
    );

    // Belt-and-suspenders: add a second, completed session for the SAME
    // member and confirm active_members counts them once (distinct actor),
    // not twice across the two sessions.
    seed_session(
        project,
        task,
        TaskflowActorKind::User,
        Some(member_a),
        None,
        "Member A",
        now - Duration::hours(2),
        Some(120),
    )
    .await;

    let resp2 = s_get_stats_all(&app, member_a, project).await;
    assert_eq!(resp2.status(), 200);
    let body2 = resp2.json().await;
    assert_eq!(
        body2["totals"]["active_members"].as_i64(),
        Some(1),
        "one distinct member across a running + a completed session counts once"
    );
    let worked2 = body2["worked_per_member"].as_array().expect("array");
    assert_eq!(
        find_member(worked2, "user", member_a).and_then(|e| e["seconds"].as_i64()),
        Some(120),
        "worked_per_member only sums the completed session's duration"
    );
}

/// Shared helper for the two self-contained tests above: GET stats with
/// `range=all` (irrelevant to what they assert, but keeps every seeded
/// session/activity — regardless of timestamp — in scope).
async fn s_get_stats_all(app: &TestApp, user: i64, project: i64) -> TestResponse {
    app.get_as(user, &format!("/api/taskflow/projects/{project}/stats?range=all"))
        .await
}
