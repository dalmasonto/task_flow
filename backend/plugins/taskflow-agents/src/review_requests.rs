//! #1098 (#886 §3.9): review requests — "please review this, here is the diff,
//! look at X".
//!
//! A request names ONE reviewer (a project member or an agent of the project).
//! It is `open` until that reviewer's review on the task answers it
//! ([`answer_open_requests`], called from `apply_review`), or the requester
//! cancels it. The reviewer hears about it at once: an agent through a notice
//! in its pane, a person through the inbox (and the realtime row).
//!
//! **One open request per (task, reviewer) is enforced by the database**, a
//! partial unique index on `(task, reviewer_key) WHERE status = 'open'` (see
//! [`install_review_request_guard`]); asking again answers `409
//! already_requested` with the open one.

use chrono::Utc;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use umbral::db::DbPool;
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use taskflow_tasks::models::{TaskflowActorKind, TaskflowTask};

use crate::agent_auth::RequireAgent;
use crate::answers::{ApiError, Reply, bad, err, internal};
use crate::models::{
    TaskflowAgent, TaskflowAgentStatus, TaskflowChannelMemberKind, TaskflowReviewRequest,
    TaskflowReviewRequestStatus, taskflow_agent, taskflow_review_request,
};
use crate::views::{emit_task_activity, load_task, load_task_in_project};

pub const MAX_LINK_CHARS: usize = 500;
pub const MAX_FOCUS_CHARS: usize = 4000;
const MAX_LISTED: usize = 100;

const ONE_OPEN_INDEX: &str = "taskflow_review_request_one_open";
const ONE_OPEN_INDEX_SQL: &str = "CREATE UNIQUE INDEX IF NOT EXISTS taskflow_review_request_one_open \
     ON taskflow_review_request (task, reviewer_key) WHERE status = 'open'";

/// Install "one open request per (task, reviewer)". Same deferral as the claim
/// guard: a missing table (before `migrate`) is not an error.
pub async fn install_review_request_guard(pool: &DbPool) -> Result<(), sqlx::Error> {
    let result = match pool {
        DbPool::Sqlite(pool) => sqlx::query(ONE_OPEN_INDEX_SQL).execute(pool).await.map(|_| ()),
        DbPool::Postgres(pool) => sqlx::query(ONE_OPEN_INDEX_SQL).execute(pool).await.map(|_| ()),
    };
    match result {
        Err(sqlx::Error::Database(db))
            if (db.message().contains("no such table") && db.message().contains("taskflow_review_request"))
                || db.message().contains("relation \"taskflow_review_request\" does not exist") =>
        {
            tracing::debug!("review request guard deferred until schema exists");
            Ok(())
        }
        Err(e) => Err(e),
        Ok(()) => {
            tracing::info!(index = ONE_OPEN_INDEX, "review request guard installed");
            Ok(())
        }
    }
}

fn status_err(status: StatusCode) -> ApiError {
    let code = match status {
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::FORBIDDEN => "forbidden",
        _ => "error",
    };
    err(status, code)
}

/// Who is acting: derived from the auth gate, never a body field.
#[derive(Debug, Clone)]
struct Actor {
    kind: TaskflowChannelMemberKind,
    id: i64,
    label: String,
}

impl Actor {
    fn key(&self) -> String {
        reviewer_key(self.kind, self.id)
    }
}

pub fn reviewer_key(kind: TaskflowChannelMemberKind, id: i64) -> String {
    match kind {
        TaskflowChannelMemberKind::User => format!("user:{id}"),
        TaskflowChannelMemberKind::Agent => format!("agent:{id}"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerKind {
    User,
    Agent,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reviewer {
    pub kind: ReviewerKind,
    pub id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestInput {
    pub reviewer: Reviewer,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub focus_markdown: Option<String>,
}

fn trimmed(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

async fn active_member(project: i64, user: i64) -> Result<Option<TaskflowProjectMember>, ApiError> {
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project)
                & taskflow_project_member::USER.eq(user)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(internal)
}

/// The named reviewer, checked against the TASK's project: a person must be an
/// active member, an agent must belong to the project and not be revoked.
async fn resolve_reviewer(project: i64, r: &Reviewer) -> Result<Actor, ApiError> {
    match r.kind {
        ReviewerKind::User => {
            let m = active_member(project, r.id)
                .await?
                .ok_or_else(|| bad("reviewer", "not an active member of this project"))?;
            Ok(Actor { kind: TaskflowChannelMemberKind::User, id: r.id, label: m.display_name })
        }
        ReviewerKind::Agent => {
            let a = TaskflowAgent::objects()
                .filter(taskflow_agent::ID.eq(r.id) & taskflow_agent::PROJECT.eq(project))
                .first()
                .await
                .map_err(internal)?
                .filter(|a| a.status != TaskflowAgentStatus::Revoked)
                .ok_or_else(|| bad("reviewer", "not an agent of this project"))?;
            Ok(Actor { kind: TaskflowChannelMemberKind::Agent, id: a.id, label: a.display_name })
        }
    }
}

fn actor_fks(a: &Actor) -> (Option<ForeignKey<umbral_auth::AuthUser>>, Option<ForeignKey<TaskflowAgent>>) {
    match a.kind {
        TaskflowChannelMemberKind::User => (Some(ForeignKey::new(a.id)), None),
        TaskflowChannelMemberKind::Agent => (None, Some(ForeignKey::new(a.id))),
    }
}

fn actor_kind(k: TaskflowChannelMemberKind) -> TaskflowActorKind {
    match k {
        TaskflowChannelMemberKind::User => TaskflowActorKind::User,
        TaskflowChannelMemberKind::Agent => TaskflowActorKind::Agent,
    }
}

pub fn request_json(r: &TaskflowReviewRequest) -> Value {
    json!({
        "id": r.id, "project": r.project.id(), "task": r.task.id(),
        "requester_kind": r.requester_kind, "requester_user": r.requester_user.as_ref().map(|u| u.id()),
        "requester_agent": r.requester_agent.as_ref().map(|a| a.id()), "requester_label": r.requester_label,
        "reviewer_kind": r.reviewer_kind, "reviewer_user": r.reviewer_user.as_ref().map(|u| u.id()),
        "reviewer_agent": r.reviewer_agent.as_ref().map(|a| a.id()), "reviewer_label": r.reviewer_label,
        "link": r.link, "focus_markdown": r.focus_markdown, "status": r.status,
        "review": r.review.as_ref().map(|v| v.id()), "closed_at": r.closed_at, "created_at": r.created_at,
    })
}

async fn open_for(task: i64, key: &str) -> Result<Vec<TaskflowReviewRequest>, ApiError> {
    TaskflowReviewRequest::objects()
        .filter(
            taskflow_review_request::TASK.eq(task)
                & taskflow_review_request::REVIEWER_KEY.eq(key)
                & taskflow_review_request::STATUS.eq("open"),
        )
        .fetch()
        .await
        .map_err(internal)
}

/// Best-effort agent notice: the request stands even if the pane is gone.
async fn tell_agent(agent: i64, body: String) {
    if let Err((status, _)) = crate::wakeups::notify_agent(agent, body).await {
        tracing::warn!(agent, %status, "review request notice not delivered");
    }
}

async fn create(task: TaskflowTask, requester: Actor, input: RequestInput) -> Reply {
    let link = trimmed(&input.link);
    if let Some(l) = &link {
        if l.chars().count() > MAX_LINK_CHARS {
            return Err(bad("link", &format!("at most {MAX_LINK_CHARS} characters")));
        }
        if !(l.starts_with("https://") || l.starts_with("http://")) || l.chars().any(char::is_whitespace) {
            return Err(bad("link", "an http(s) URL"));
        }
    }
    let focus = trimmed(&input.focus_markdown);
    if focus.as_ref().is_some_and(|f| f.chars().count() > MAX_FOCUS_CHARS) {
        return Err(bad("focus_markdown", &format!("at most {MAX_FOCUS_CHARS} characters")));
    }
    let project = task.project.id();
    let reviewer = resolve_reviewer(project, &input.reviewer).await?;
    if reviewer.key() == requester.key() {
        return Err(bad("reviewer", "you cannot review your own request"));
    }

    let (requester_user, requester_agent) = actor_fks(&requester);
    let (reviewer_user, reviewer_agent) = actor_fks(&reviewer);
    let created = TaskflowReviewRequest::objects()
        .create(TaskflowReviewRequest {
            id: 0,
            project: task.project.clone(),
            task: ForeignKey::new(task.id),
            requester_kind: requester.kind,
            requester_user,
            requester_agent,
            requester_label: requester.label.clone(),
            reviewer_kind: reviewer.kind,
            reviewer_user,
            reviewer_agent,
            reviewer_label: reviewer.label.clone(),
            reviewer_key: reviewer.key(),
            link: link.clone(),
            focus_markdown: focus.clone(),
            status: TaskflowReviewRequestStatus::Open,
            review: None,
            closed_at: None,
            created_at: None,
        })
        .await;
    let request = match created {
        Ok(r) => r,
        // The partial unique index is the arbiter of "already open".
        Err(_) => {
            return match open_for(task.id, &reviewer.key()).await?.into_iter().next() {
                Some(open) => Err((
                    StatusCode::CONFLICT,
                    Json(json!({ "error": "already_requested", "request": request_json(&open) })),
                )),
                None => Err(err(StatusCode::INTERNAL_SERVER_ERROR, "internal")),
            };
        }
    };

    if reviewer.kind == TaskflowChannelMemberKind::Agent {
        let mut body = format!(
            "Review requested by {} on #TSK{} \"{}\".",
            requester.label, task.id, task.title
        );
        if let Some(f) = &focus {
            body.push_str(&format!(" Focus: {f}"));
        }
        if let Some(l) = &link {
            body.push_str(&format!(" Link: {l}"));
        }
        body.push_str(" Answer with report_review on the task.");
        tell_agent(reviewer.id, body).await;
    }
    let (au, aa) = match requester.kind {
        TaskflowChannelMemberKind::User => (Some(requester.id), None),
        TaskflowChannelMemberKind::Agent => (None, Some(requester.id)),
    };
    if let Err(status) = emit_task_activity(
        project,
        task.id,
        actor_kind(requester.kind),
        au,
        aa,
        requester.label.clone(),
        "review_requested",
        Some(format!("asked {} to review", reviewer.label)),
    )
    .await
    {
        tracing::warn!(task = task.id, %status, "review_requested activity not logged");
    }
    Ok((StatusCode::CREATED, Json(request_json(&request))).into_response())
}

/// `POST /api/taskflow/tasks/{task}/review-requests` — a project member asks.
pub async fn request_review(
    RequireAuth(user): RequireAuth<i64>,
    Path(task): Path<i64>,
    Json(input): Json<RequestInput>,
) -> Reply {
    let task = load_task(task).await.map_err(status_err)?;
    let member = active_member(task.project.id(), user)
        .await?
        .ok_or_else(|| err(StatusCode::FORBIDDEN, "forbidden"))?;
    let me = Actor { kind: TaskflowChannelMemberKind::User, id: user, label: member.display_name };
    create(task, me, input).await
}

/// `POST /api/taskflow/tasks/{task}/agent/review-requests` — an agent asks.
pub async fn agent_request_review(
    RequireAgent(agent): RequireAgent,
    Path(task): Path<i64>,
    Json(input): Json<RequestInput>,
) -> Reply {
    agent
        .require(crate::scopes::TASKS_WRITE)
        .map_err(crate::scopes::CapabilityError::into_status_json)?;
    let task = load_task_in_project(task, agent.project_id).await.map_err(status_err)?;
    let me = Actor { kind: TaskflowChannelMemberKind::Agent, id: agent.agent_id, label: agent.display_name.clone() };
    create(task, me, input).await
}

/// Close one open request, compare-and-set from `open` so a racing answer and
/// cancel cannot both win. Re-saved afterwards: `update_values` emits only the
/// id-only bulk signal, and realtime listens to `post_save`.
async fn close(id: i64, status: &str, review: Option<i64>) -> Result<Option<TaskflowReviewRequest>, ApiError> {
    let mut values = Map::new();
    values.insert("status".into(), json!(status));
    values.insert("closed_at".into(), json!(Utc::now()));
    if let Some(r) = review {
        values.insert("review".into(), json!(r));
    }
    let flipped = TaskflowReviewRequest::objects()
        .filter(taskflow_review_request::ID.eq(id) & taskflow_review_request::STATUS.eq("open"))
        .update_values(values)
        .await
        .map_err(internal)?;
    if flipped == 0 {
        return Ok(None);
    }
    let row = TaskflowReviewRequest::objects()
        .filter(taskflow_review_request::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    Ok(Some(TaskflowReviewRequest::objects().save(row).await.map_err(internal)?))
}

/// Called by `apply_review` once the review row exists: every open request on
/// the task naming THIS reviewer is answered by it. A review by someone else
/// leaves the request open. Agent requesters other than `skip_agent` (the
/// task's responsible agent, who already gets the review report-back) are told.
pub async fn answer_open_requests(
    task: &TaskflowTask,
    reviewer_kind: TaskflowChannelMemberKind,
    reviewer_id: i64,
    review_id: i64,
    verdict: &str,
    skip_agent: Option<i64>,
) -> Result<Vec<TaskflowReviewRequest>, ApiError> {
    let key = reviewer_key(reviewer_kind, reviewer_id);
    let mut answered = Vec::new();
    for open in open_for(task.id, &key).await? {
        if let Some(r) = close(open.id, "answered", Some(review_id)).await? {
            answered.push(r);
        }
    }
    for r in &answered {
        if let Some(agent) = r.requester_agent.as_ref().map(|a| a.id()) {
            if Some(agent) != skip_agent {
                tell_agent(
                    agent,
                    format!("{} answered your review request on #TSK{} \"{}\": {verdict}.", r.reviewer_label, task.id, task.title),
                )
                .await;
            }
        }
    }
    Ok(answered)
}

async fn cancel(id: i64, me: Actor, project: Option<i64>) -> Reply {
    let req = TaskflowReviewRequest::objects()
        .filter(taskflow_review_request::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .filter(|r| project.is_none_or(|p| r.project.id() == p))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let requester = match me.kind {
        TaskflowChannelMemberKind::User => req.requester_user.as_ref().map(|u| u.id()),
        TaskflowChannelMemberKind::Agent => req.requester_agent.as_ref().map(|a| a.id()),
    };
    if req.requester_kind != me.kind || requester != Some(me.id) {
        return Err(err(StatusCode::FORBIDDEN, "not_requester"));
    }
    let Some(closed) = close(req.id, "cancelled", None).await? else {
        return Err(err(StatusCode::CONFLICT, "not_open"));
    };
    if let Some(agent) = closed.reviewer_agent.as_ref().map(|a| a.id()) {
        tell_agent(
            agent,
            format!("{} cancelled the review request on #TSK{}; no review needed.", me.label, closed.task.id()),
        )
        .await;
    }
    Ok(Json(request_json(&closed)).into_response())
}

/// `POST /api/taskflow/review-requests/{id}/cancel` — the requesting person.
pub async fn cancel_request(RequireAuth(user): RequireAuth<i64>, Path(id): Path<i64>) -> Reply {
    let label = crate::answers::user_label(user).await;
    cancel(id, Actor { kind: TaskflowChannelMemberKind::User, id: user, label }, None).await
}

/// `POST /api/taskflow/agents/review-requests/{id}/cancel` — the requesting agent.
pub async fn agent_cancel_request(RequireAgent(agent): RequireAgent, Path(id): Path<i64>) -> Reply {
    agent
        .require(crate::scopes::TASKS_WRITE)
        .map_err(crate::scopes::CapabilityError::into_status_json)?;
    let me = Actor { kind: TaskflowChannelMemberKind::Agent, id: agent.agent_id, label: agent.display_name.clone() };
    cancel(id, me, Some(agent.project_id)).await
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    /// "open" (default), "answered", "cancelled" or "all".
    #[serde(default)]
    pub status: Option<String>,
}

/// `GET /api/taskflow/agents/review-requests` — the agent's own requests, both
/// ways: `for_me` (it is the named reviewer) and `mine` (it asked).
pub async fn agent_list(RequireAgent(agent): RequireAgent, Query(q): Query<ListQuery>) -> Reply {
    let status = q.status.as_deref().unwrap_or("open");
    if !["open", "answered", "cancelled", "all"].contains(&status) {
        return Err(bad("status", "open, answered, cancelled or all"));
    }
    let mut filter = taskflow_review_request::PROJECT.eq(agent.project_id);
    if status != "all" {
        filter = filter & taskflow_review_request::STATUS.eq(status);
    }
    let rows = TaskflowReviewRequest::objects()
        .filter(filter)
        .order_by(taskflow_review_request::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    let is = |fk: &Option<ForeignKey<TaskflowAgent>>| fk.as_ref().is_some_and(|a| a.id() == agent.agent_id);
    let pick = |f: &dyn Fn(&TaskflowReviewRequest) -> bool| -> Vec<Value> {
        rows.iter().filter(|r| f(r)).take(MAX_LISTED).map(request_json).collect()
    };
    let for_me = pick(&|r| is(&r.reviewer_agent));
    let mine = pick(&|r| is(&r.requester_agent));
    Ok(Json(json!({ "for_me": for_me, "mine": mine })).into_response())
}
