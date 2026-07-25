//! HTTP handlers for the `taskflow-tasks` plugin.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use taskflow_projects::scope::can_access_project;
use umbral::web::{Json, Path, Query, StatusCode};
use umbral_auth::RequireAuth;

use crate::models::{
    TaskflowActorKind, TaskflowTask, TaskflowTaskActivity, TaskflowTaskSession,
    TaskflowTaskStatus, taskflow_task, taskflow_task_activity, taskflow_task_session,
};

pub async fn health() -> &'static str {
    "taskflow-tasks:ok"
}

/// `GET /api/taskflow/projects/{project}/activity/actions`
///
/// #56: the distinct `action` values in a project's activity feed.
///
/// The activity page's tool filter is applied SERVER-side, which means the rows
/// it gets back depend on the filter — so a dropdown derived from those rows
/// narrows to its own selection and its contents shift as you page. A filter's
/// options have to come from a source the filter does not affect, and the REST
/// layer offers no distinct-values query, so this is the endpoint that provides
/// one. Fetched once per project.
///
/// Scoped like every other project route: a caller without active membership
/// gets 404 rather than 403, so the endpoint cannot be used to probe which
/// project ids exist.
#[derive(serde::Serialize)]
pub struct ActivityActions {
    pub actions: Vec<String>,
}

pub async fn activity_actions(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<ActivityActions>, StatusCode> {
    if !can_access_project(user_id, project_id).await {
        return Err(StatusCode::NOT_FOUND);
    }

    // Read the column and reduce in memory rather than SELECT DISTINCT: the ORM
    // has no distinct projection, and `action` is a short string — the whole
    // column for a busy project is a few hundred KB at worst, on a request that
    // runs once per project rather than per page.
    let rows = TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::PROJECT.eq(project_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut actions: Vec<String> = rows.into_iter().map(|row| row.action).collect();
    actions.sort();
    actions.dedup();

    Ok(Json(ActivityActions { actions }))
}

/// `GET /api/taskflow/projects/{project}/stats?range=7d|30d|90d|all`
///
/// #60: the dashboard's single aggregation endpoint. Everything the page
/// needs about a project's sessions/tasks/activity lives behind one call —
/// worked time per member, tasks closed per day, activity per tool and per
/// member, and a handful of headline totals — rather than the frontend
/// stitching several list endpoints together and re-deriving the same
/// numbers client-side.
///
/// Scoped like every other project route (`activity_actions` above is the
/// template): a caller without active membership gets 404, never 403, so the
/// endpoint can't be used to probe which project ids exist.
///
/// Fetch-then-reduce, same shape as `activity_actions`: the ORM has no
/// GROUP BY projection, and a project's session/task/activity tables are
/// small enough (this runs once per dashboard load, not per row rendered)
/// that reducing in memory is simpler than hand-rolling aggregate SQL per
/// backend.
#[derive(serde::Serialize)]
pub struct MemberSeconds {
    pub kind: String,
    pub id: i64,
    pub label: String,
    pub seconds: i64,
}

#[derive(serde::Serialize)]
pub struct MemberCount {
    pub kind: String,
    pub id: i64,
    pub label: String,
    pub count: i64,
}

#[derive(serde::Serialize)]
pub struct DayCount {
    pub day: String,
    pub count: i64,
}

#[derive(serde::Serialize)]
pub struct ToolCount {
    pub tool: String,
    pub count: i64,
}

#[derive(serde::Serialize)]
pub struct Totals {
    pub closed_in_range: i64,
    pub open_now: i64,
    pub active_members: i64,
}

#[derive(serde::Serialize)]
pub struct ProjectStats {
    pub range: String,
    pub generated_at: DateTime<Utc>,
    pub worked_per_member: Vec<MemberSeconds>,
    pub tasks_closed_by_day: Vec<DayCount>,
    pub activity_by_tool: Vec<ToolCount>,
    pub activity_by_member: Vec<MemberCount>,
    pub totals: Totals,
}

#[derive(serde::Deserialize)]
pub struct StatsQuery {
    #[serde(default)]
    pub range: Option<String>,
}

/// `now - N days` for the known ranges; `None` for `all`; `Err` for anything
/// else (the caller maps that to 400).
fn cutoff(range: &str, now: DateTime<Utc>) -> Result<Option<DateTime<Utc>>, ()> {
    match range {
        "7d" => Ok(Some(now - Duration::days(7))),
        "30d" => Ok(Some(now - Duration::days(30))),
        "90d" => Ok(Some(now - Duration::days(90))),
        "all" => Ok(None),
        _ => Err(()),
    }
}

/// A stable `(kind, id)` key for a non-system actor. `None` for `system`
/// (every aggregation that keys off actor identity excludes it) and for a
/// `user`/`agent` row that is somehow missing its id (defensive — the DB
/// shouldn't produce this, but a malformed row should drop out silently
/// rather than panic the whole stats call).
fn actor_key(
    kind: &TaskflowActorKind,
    user: Option<i64>,
    agent: Option<i64>,
) -> Option<(String, i64)> {
    match kind {
        TaskflowActorKind::User => user.map(|id| ("user".to_string(), id)),
        TaskflowActorKind::Agent => agent.map(|id| ("agent".to_string(), id)),
        TaskflowActorKind::System => None,
    }
}

pub async fn project_stats(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
    Query(q): Query<StatsQuery>,
) -> Result<Json<ProjectStats>, StatusCode> {
    if !can_access_project(user_id, project_id).await {
        return Err(StatusCode::NOT_FOUND);
    }

    let range = q.range.unwrap_or_else(|| "30d".to_string());
    let now = Utc::now();
    let cut = cutoff(&range, now).map_err(|_| StatusCode::BAD_REQUEST)?;
    let in_range = |ts: DateTime<Utc>| cut.is_none_or(|c| ts >= c);

    // --- worked_per_member + active_members (sessions) ---
    let sessions = TaskflowTaskSession::objects()
        .filter(taskflow_task_session::PROJECT.eq(project_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut worked: HashMap<(String, i64), (String, i64)> = HashMap::new();
    for s in &sessions {
        let (Some(secs), true) = (s.duration_seconds, in_range(s.started_at)) else {
            continue;
        };
        let Some(key) = actor_key(
            &s.actor_kind,
            s.actor_user.as_ref().map(|f| f.id()),
            s.actor_agent_id,
        ) else {
            continue;
        };
        let e = worked.entry(key).or_insert((s.actor_label.clone(), 0));
        e.1 += secs;
    }
    // active_members: distinct non-system actors with a session in range —
    // NOT gated on duration_seconds (a still-running session has none but the
    // actor is still "active"), unlike worked_per_member above. Computed as
    // its own pass so the two aggregations can't silently drift together.
    let mut active: std::collections::HashSet<(String, i64)> = std::collections::HashSet::new();
    for s in &sessions {
        if !in_range(s.started_at) {
            continue;
        }
        if let Some(key) = actor_key(
            &s.actor_kind,
            s.actor_user.as_ref().map(|f| f.id()),
            s.actor_agent_id,
        ) {
            active.insert(key);
        }
    }
    let active_members = active.len() as i64;
    let mut worked_per_member: Vec<MemberSeconds> = worked
        .into_iter()
        .map(|((kind, id), (label, seconds))| MemberSeconds {
            kind,
            id,
            label,
            seconds,
        })
        .collect();
    worked_per_member.sort_by(|a, b| b.seconds.cmp(&a.seconds));

    // --- tasks: closed-by-day, closed_in_range, open_now (snapshot) ---
    let tasks = TaskflowTask::objects()
        .filter(taskflow_task::PROJECT.eq(project_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut by_day: HashMap<String, i64> = HashMap::new();
    let (mut closed_in_range, mut open_now) = (0i64, 0i64);
    for t in &tasks {
        let terminal = matches!(t.status, TaskflowTaskStatus::Done | TaskflowTaskStatus::Archived);
        if !terminal {
            open_now += 1;
        }
        if let Some(ca) = t.closed_at {
            if in_range(ca) {
                closed_in_range += 1;
                *by_day.entry(ca.format("%Y-%m-%d").to_string()).or_insert(0) += 1;
            }
        }
    }
    let mut tasks_closed_by_day: Vec<DayCount> = by_day
        .into_iter()
        .map(|(day, count)| DayCount { day, count })
        .collect();
    tasks_closed_by_day.sort_by(|a, b| a.day.cmp(&b.day));

    // --- activity: by tool (top 12 + "Other") and by member ---
    let activity = TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::PROJECT.eq(project_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut by_tool: HashMap<String, i64> = HashMap::new();
    let mut by_member: HashMap<(String, i64), (String, i64)> = HashMap::new();
    for a in &activity {
        // `created_at` is `auto_now_add` (always populated on a real row);
        // a null is treated as in-range rather than dropped, so a
        // hypothetically malformed row still gets counted somewhere instead
        // of silently vanishing from the tool tally.
        if let Some(ts) = a.created_at {
            if !in_range(ts) {
                continue;
            }
        }
        *by_tool.entry(a.action.clone()).or_insert(0) += 1;
        if let Some(key) = actor_key(
            &a.actor_kind,
            a.actor_user.as_ref().map(|f| f.id()),
            a.actor_agent_id,
        ) {
            let e = by_member.entry(key).or_insert((a.actor_label.clone(), 0));
            e.1 += 1;
        }
    }
    let mut tools: Vec<ToolCount> = by_tool
        .into_iter()
        .map(|(tool, count)| ToolCount { tool, count })
        .collect();
    tools.sort_by(|a, b| b.count.cmp(&a.count));
    let activity_by_tool = if tools.len() > 12 {
        let other: i64 = tools[12..].iter().map(|t| t.count).sum();
        let mut top: Vec<ToolCount> = tools.into_iter().take(12).collect();
        top.push(ToolCount {
            tool: "Other".to_string(),
            count: other,
        });
        top
    } else {
        tools
    };
    let mut activity_by_member: Vec<MemberCount> = by_member
        .into_iter()
        .map(|((kind, id), (label, count))| MemberCount {
            kind,
            id,
            label,
            count,
        })
        .collect();
    activity_by_member.sort_by(|a, b| b.count.cmp(&a.count));

    Ok(Json(ProjectStats {
        range,
        generated_at: now,
        worked_per_member,
        tasks_closed_by_day,
        activity_by_tool,
        activity_by_member,
        totals: Totals {
            closed_in_range,
            open_now,
            active_members,
        },
    }))
}
