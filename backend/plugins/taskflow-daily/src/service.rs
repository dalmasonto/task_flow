//! #1118: the daily update — sources, the server-written draft, and the sweep.
//!
//! **Nothing posts without a person.** The sweep only ever creates a DRAFT. The
//! server's own draft lists facts from the window and invents nothing; the
//! drafting agent may rewrite it until a person edits it; a person posts it.
//!
//! **Sources never include a DM:** they read tasks, task activity, reviews,
//! evidence, prompts, decisions and usage — no chat messages at all.

use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::web::{Json, StatusCode};

use taskflow_agents::models::{
    TaskflowAgentPrompt, TaskflowEvidenceKind, TaskflowPromptStatus, TaskflowTaskEvidence, TaskflowTaskReview,
    taskflow_agent_prompt, taskflow_task_evidence, taskflow_task_review,
};
use taskflow_decisions::models::{TaskflowDecision, taskflow_decision};
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskActivity, TaskflowTaskStatus, taskflow_task, taskflow_task_activity};
use taskflow_usage::models::{TaskflowUsageReport, taskflow_usage_report};

use crate::models::{
    TaskflowDailyUpdate, TaskflowDailyUpdateSettings, TaskflowDailyUpdateStatus, taskflow_daily_update,
    taskflow_daily_update_settings,
};

pub type ApiError = (StatusCode, Json<Value>);

pub fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

pub fn bad(field: &str, reason: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid", "field": field, "reason": reason })))
}

pub fn internal<E>(_: E) -> ApiError {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

pub const DEFAULT_TIME: &str = "18:00";
pub const DEFAULT_TZ: &str = "UTC";
pub const MAX_BODY_CHARS: usize = 12_000;
pub const EXCERPT_CHARS: usize = 200;
/// Rows per section in the server's draft and in the sources reply.
const PER_SECTION: usize = 25;
pub const SERVER_LABEL: &str = "TaskFlow";
const SWEEP_SECONDS: u64 = 60;

pub fn parse_time(s: &str) -> Option<NaiveTime> {
    if s.len() != 5 {
        return None;
    }
    NaiveTime::parse_from_str(s, "%H:%M").ok()
}

pub fn parse_tz(s: &str) -> Option<Tz> {
    s.parse::<Tz>().ok()
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    if s.len() != 10 {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// A local wall-clock moment as UTC. A time that does not exist (a DST gap)
/// moves to the next valid instant; an ambiguous one takes the earlier.
fn local_to_utc(tz: Tz, date: NaiveDate, time: NaiveTime) -> DateTime<Utc> {
    let naive = date.and_time(time);
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t.with_timezone(&Utc),
        chrono::LocalResult::None => tz
            .from_local_datetime(&(naive + chrono::Duration::hours(1)))
            .earliest()
            .map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(|| Utc.from_utc_datetime(&naive)),
    }
}

/// The window a day's update covers: local midnight until the draft is made
/// (`now`), capped at the end of that local day. A draft made at 18:00 covers
/// 00:00–18:00; one rebuilt the next morning still covers only its own day.
pub fn window(tz: Tz, date: NaiveDate, now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = local_to_utc(tz, date, NaiveTime::MIN);
    let day_end = date.succ_opt().map(|d| local_to_utc(tz, d, NaiveTime::MIN)).unwrap_or(start);
    (start, now.min(day_end).max(start))
}

pub async fn settings_for(project: i64) -> Result<Option<TaskflowDailyUpdateSettings>, ApiError> {
    TaskflowDailyUpdateSettings::objects()
        .filter(taskflow_daily_update_settings::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)
}

fn fmt_money(micros: i64) -> String {
    format!("${}.{:02}", micros / 1_000_000, (micros % 1_000_000) / 10_000)
}

/// Everything a draft may say, for one project and window. Facts only.
pub async fn sources(project: i64, tz: Tz, start: DateTime<Utc>, end: DateTime<Utc>) -> Result<Value, ApiError> {
    let activity = TaskflowTaskActivity::objects()
        .filter(
            taskflow_task_activity::PROJECT.eq(project)
                & taskflow_task_activity::CREATED_AT.gte(start)
                & taskflow_task_activity::CREATED_AT.lt(end),
        )
        .fetch()
        .await
        .map_err(internal)?;
    let task_changes = activity.iter().filter(|a| a.action == "status_changed").count();

    let closed = TaskflowTask::objects()
        .filter(
            taskflow_task::PROJECT.eq(project)
                & taskflow_task::CLOSED_AT.gte(start)
                & taskflow_task::CLOSED_AT.lt(end),
        )
        .order_by(taskflow_task::ID.asc())
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|t| t.status == TaskflowTaskStatus::Done)
        .collect::<Vec<_>>();
    let in_review = TaskflowTask::objects()
        .filter(taskflow_task::PROJECT.eq(project) & taskflow_task::STATUS.eq("partial_done"))
        .order_by(taskflow_task::ID.asc())
        .limit(PER_SECTION as u64)
        .fetch()
        .await
        .map_err(internal)?;
    let in_progress = TaskflowTask::objects()
        .filter(taskflow_task::PROJECT.eq(project) & taskflow_task::STATUS.eq("in_progress"))
        .order_by(taskflow_task::ID.asc())
        .limit(PER_SECTION as u64)
        .fetch()
        .await
        .map_err(internal)?;
    let blocked = TaskflowTask::objects()
        .filter(taskflow_task::PROJECT.eq(project) & taskflow_task::STATUS.eq("blocked"))
        .order_by(taskflow_task::ID.asc())
        .limit(PER_SECTION as u64)
        .fetch()
        .await
        .map_err(internal)?;

    let reviews = TaskflowTaskReview::objects()
        .filter(
            taskflow_task_review::PROJECT.eq(project)
                & taskflow_task_review::CREATED_AT.gte(start)
                & taskflow_task_review::CREATED_AT.lt(end),
        )
        .fetch()
        .await
        .map_err(internal)?;
    let evidence = TaskflowTaskEvidence::objects()
        .filter(
            taskflow_task_evidence::PROJECT.eq(project)
                & taskflow_task_evidence::CREATED_AT.gte(start)
                & taskflow_task_evidence::CREATED_AT.lt(end),
        )
        .order_by(taskflow_task_evidence::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    let pull_requests = evidence.iter().filter(|e| e.kind == TaskflowEvidenceKind::PullRequest).count();
    let evidence_for = |task: i64| -> Vec<String> {
        evidence.iter().filter(|e| e.task.id() == task).take(3).map(|e| e.label.clone()).collect()
    };

    let prompts = TaskflowAgentPrompt::objects()
        .filter(taskflow_agent_prompt::PROJECT.eq(project))
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|p| p.status == TaskflowPromptStatus::Pending)
        .count();
    let decisions = TaskflowDecision::objects()
        .filter(taskflow_decision::PROJECT.eq(project) & taskflow_decision::STATUS.eq("open"))
        .order_by(taskflow_decision::ID.asc())
        .limit(PER_SECTION as u64)
        .fetch()
        .await
        .map_err(internal)?;

    // Month to date in the PROJECT's timezone (#1118 review): the 1st at local
    // midnight, not the 1st in UTC.
    let local_end = end.with_timezone(&tz).date_naive();
    let month_start = local_end
        .with_day(1)
        .map(|first| local_to_utc(tz, first, NaiveTime::MIN))
        .unwrap_or(start);
    let reports = TaskflowUsageReport::objects()
        .filter(
            taskflow_usage_report::PROJECT.eq(project)
                & taskflow_usage_report::REPORTED_AT.gte(month_start.min(start))
                & taskflow_usage_report::REPORTED_AT.lt(end),
        )
        .fetch()
        .await
        .map_err(internal)?;
    let sum = |from: DateTime<Utc>| -> i64 { reports.iter().filter(|r| r.reported_at >= from).filter_map(|r| r.cost_micros).sum() };
    let unpriced = reports.iter().filter(|r| r.reported_at >= start && r.cost_micros.is_none()).count();
    let today_agents: std::collections::HashSet<i64> =
        reports.iter().filter(|r| r.reported_at >= start).map(|r| r.agent.id()).collect();
    let budget = taskflow_usage::service::settings_for(project).await.ok().and_then(|s| s.budget_micros);

    let task_row = |t: &TaskflowTask| json!({ "id": t.id, "title": t.title, "evidence": evidence_for(t.id) });
    Ok(json!({
        "window_start": start, "window_end": end,
        "counts": { "activity": activity.len(), "task_changes": task_changes, "reviews": reviews.len(), "pull_requests": pull_requests },
        "shipped": closed.iter().take(PER_SECTION).map(task_row).collect::<Vec<_>>(),
        "in_review": in_review.iter().map(task_row).collect::<Vec<_>>(),
        "in_progress": in_progress.iter().map(task_row).collect::<Vec<_>>(),
        "needs_a_person": {
            "pending_prompts": prompts,
            "open_decisions": decisions.iter().map(|d| json!({ "id": d.id, "key": d.key, "question": d.question })).collect::<Vec<_>>(),
            "blocked": blocked.iter().map(task_row).collect::<Vec<_>>(),
        },
        "spend": {
            "today_micros": sum(start), "month_micros": sum(month_start), "budget_micros": budget,
            "agents_today": today_agents.len(), "unpriced_reports_today": unpriced, "self_reported": true,
        },
    }))
}

fn task_line(t: &Value) -> String {
    let mut line = format!("- #TSK{} {}", t["id"], t["title"].as_str().unwrap_or_default());
    let ev: Vec<&str> = t["evidence"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if !ev.is_empty() {
        line.push_str(&format!(". Evidence: {}.", ev.join(", ")));
    }
    line
}

/// The server's own draft: the sources as plain lists. Never empty.
pub fn server_draft(src: &Value) -> String {
    let mut out = String::new();
    let section = |out: &mut String, title: &str, rows: Vec<String>| {
        out.push_str(&format!("## {title}\n"));
        if rows.is_empty() {
            out.push_str("- Nothing today.\n");
        } else {
            for r in rows {
                out.push_str(&r);
                out.push('\n');
            }
        }
        out.push('\n');
    };
    let list = |key: &str| -> Vec<String> { src[key].as_array().map(|a| a.iter().map(task_line).collect()).unwrap_or_default() };
    section(&mut out, "Shipped", list("shipped"));
    let mut progress = list("in_review").into_iter().map(|l| format!("{l} (in review)")).collect::<Vec<_>>();
    progress.extend(list("in_progress"));
    section(&mut out, "In progress", progress);
    let need = &src["needs_a_person"];
    let mut needs = Vec::new();
    if let Some(n) = need["pending_prompts"].as_u64().filter(|n| *n > 0) {
        needs.push(format!("- {n} permission prompt(s) waiting."));
    }
    for d in need["open_decisions"].as_array().into_iter().flatten() {
        needs.push(format!("- Decide: {}", d["question"].as_str().unwrap_or_default()));
    }
    for t in need["blocked"].as_array().into_iter().flatten() {
        needs.push(format!("{} (blocked)", task_line(t)));
    }
    section(&mut out, "Needs a person", needs);
    let s = &src["spend"];
    let today = s["today_micros"].as_i64().unwrap_or(0);
    let month = s["month_micros"].as_i64().unwrap_or(0);
    let mut spend = format!("- {} today across {} agent(s); {} this month", fmt_money(today), s["agents_today"], fmt_money(month));
    if let Some(b) = s["budget_micros"].as_i64() {
        spend.push_str(&format!(" of the {} budget", fmt_money(b)));
    }
    spend.push_str(". Self-reported by the agents.");
    if let Some(n) = s["unpriced_reports_today"].as_u64().filter(|n| *n > 0) {
        spend.push_str(&format!(" {n} report(s) today could not be priced."));
    }
    section(&mut out, "Spend", vec![spend]);
    out.trim_end().to_string()
}

pub fn excerpt(body: &str) -> String {
    let flat: String = body
        .lines()
        .map(|l| l.trim_start_matches('#').trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    if flat.chars().count() <= EXCERPT_CHARS {
        flat
    } else {
        format!("{}…", flat.chars().take(EXCERPT_CHARS - 1).collect::<String>())
    }
}

pub fn update_json(u: &TaskflowDailyUpdate, full: bool) -> Value {
    let mut v = json!({
        "id": u.id, "project": u.project.id(), "date": u.date, "status": u.status, "version": u.version,
        "edit_count": u.edit_count, "posted_at": u.posted_at, "posted_message": u.posted_message,
        "drafted_by_label": u.drafted_by_label, "server_drafted": u.server_drafted, "excerpt": excerpt(&u.body_markdown),
    });
    if full {
        v["body_markdown"] = json!(u.body_markdown);
        v["window_start"] = json!(u.window_start);
        v["window_end"] = json!(u.window_end);
        v["sources"] = json!({ "activity": u.src_activity, "task_changes": u.src_task_changes, "reviews": u.src_reviews, "pull_requests": u.src_pull_requests });
        v["posted_by"] = json!(u.posted_by.as_ref().map(|p| p.id()));
        v["created_at"] = json!(u.created_at);
    }
    v
}

pub async fn find(project: i64, date: &str) -> Result<Option<TaskflowDailyUpdate>, ApiError> {
    TaskflowDailyUpdate::objects()
        .filter(taskflow_daily_update::PROJECT.eq(project) & taskflow_daily_update::DATE.eq(date))
        .first()
        .await
        .map_err(internal)
}

/// How far back and forward a draft may be CREATED (#1118 review): the last
/// week through tomorrow, in the project's timezone. Reads are not bounded.
pub const DRAFT_DAYS_BACK: i64 = 7;
pub const DRAFT_DAYS_AHEAD: i64 = 1;

pub fn draftable(tz: Tz, date: NaiveDate, now: DateTime<Utc>) -> bool {
    let today = now.with_timezone(&tz).date_naive();
    date >= today - chrono::Duration::days(DRAFT_DAYS_BACK) && date <= today + chrono::Duration::days(DRAFT_DAYS_AHEAD)
}

/// The settings' clock, defaulted when no settings row exists yet.
pub fn clock(s: Option<&TaskflowDailyUpdateSettings>) -> (Tz, NaiveTime) {
    let tz = s.and_then(|s| parse_tz(&s.timezone)).unwrap_or(chrono_tz::UTC);
    let at = s.and_then(|s| parse_time(&s.local_time)).unwrap_or(NaiveTime::from_hms_opt(18, 0, 0).unwrap());
    (tz, at)
}

/// Create the day's draft if there is none (the unique (project, date) index is
/// the arbiter between the sweep and a person's "draft now"). Returns the row
/// and whether THIS call created it.
pub async fn ensure_draft(project: i64, date: NaiveDate) -> Result<(TaskflowDailyUpdate, bool), ApiError> {
    let key = date.format("%Y-%m-%d").to_string();
    if let Some(u) = find(project, &key).await? {
        return Ok((u, false));
    }
    let settings = settings_for(project).await?;
    let (tz, _) = clock(settings.as_ref());
    if !draftable(tz, date, Utc::now()) {
        return Err(bad("date", "within the last 7 days or tomorrow"));
    }
    let (start, end) = window(tz, date, Utc::now());
    let src = sources(project, tz, start, end).await?;
    let counts = &src["counts"];
    let created = TaskflowDailyUpdate::objects()
        .create(TaskflowDailyUpdate {
            id: 0,
            project: ForeignKey::new(project),
            date: key.clone(),
            status: TaskflowDailyUpdateStatus::Draft,
            body_markdown: server_draft(&src),
            version: 1,
            window_start: start,
            window_end: end,
            src_activity: counts["activity"].as_i64().unwrap_or(0),
            src_task_changes: counts["task_changes"].as_i64().unwrap_or(0),
            src_reviews: counts["reviews"].as_i64().unwrap_or(0),
            src_pull_requests: counts["pull_requests"].as_i64().unwrap_or(0),
            drafted_by_label: SERVER_LABEL.into(),
            server_drafted: true,
            edit_count: 0,
            posted_message: None,
            posted_by: None,
            posted_at: None,
            created_at: None,
            updated_at: Some(Utc::now()),
        })
        .await;
    match created {
        Ok(u) => Ok((u, true)),
        Err(_) => find(project, &key).await?.map(|u| (u, false)).ok_or_else(|| err(StatusCode::INTERNAL_SERVER_ERROR, "internal")),
    }
}

/// Tell the drafting agent (if set and live) that a draft is waiting.
pub async fn ping_agent(settings: &TaskflowDailyUpdateSettings, date: &str) {
    let Some(agent) = settings.drafting_agent.as_ref().map(|a| a.id()) else { return };
    let live = taskflow_agents::views::live_session_count(agent, Utc::now()).await.map(|n| n > 0).unwrap_or(false);
    if !live {
        return;
    }
    let body = format!(
        "Daily update for {date} is drafted from today's facts. Read GET /api/taskflow/agents/daily-update/sources?date={date}, \
         then improve it with PUT /api/taskflow/agents/daily-update/{date}. A person reviews and posts it; nothing is posted by you."
    );
    if let Err((status, _)) = taskflow_agents::wakeups::notify_agent(agent, body).await {
        tracing::warn!(agent, %status, "daily update notice not delivered");
    }
}

/// One sweep pass: every enabled project whose local draft time has passed
/// today and has no row for today gets its draft. Returns how many were made.
pub async fn sweep_once(now: DateTime<Utc>) -> usize {
    let Ok(all) = TaskflowDailyUpdateSettings::objects()
        .filter(taskflow_daily_update_settings::ENABLED.eq(true))
        .fetch()
        .await
    else {
        return 0;
    };
    let mut made = 0;
    for s in all {
        let (tz, at) = clock(Some(&s));
        let local = now.with_timezone(&tz);
        if local.time() < at {
            continue;
        }
        match ensure_draft(s.project.id(), local.date_naive()).await {
            Ok((u, true)) => {
                made += 1;
                ping_agent(&s, &u.date).await;
            }
            Ok((_, false)) => {}
            Err((status, _)) => tracing::warn!(project = s.project.id(), %status, "daily update draft failed"),
        }
    }
    made
}

pub fn start_sweep() {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    tokio::spawn(async {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(SWEEP_SECONDS));
        loop {
            tick.tick().await;
            sweep_once(Utc::now()).await;
        }
    });
}
