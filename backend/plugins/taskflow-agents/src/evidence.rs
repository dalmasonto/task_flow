//! #1117 (v3 group 6): evidence for review — the task page's "Evidence for
//! review" list (tests, CI runs, PRs, attachments, notes).
//!
//! Self-reported: the server records WHO said it (derived from the auth gate)
//! and checks shape, never truth, and every response says so
//! (`self_reported: true`). An attachment must be on the same task. Authors
//! can withdraw their own evidence; nobody can edit it.

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use taskflow_tasks::models::{TaskflowTask, TaskflowTaskAttachment, taskflow_task_attachment};

use crate::agent_auth::RequireAgent;
use crate::answers::{ApiError, Reply, bad, err, internal};
use crate::models::{
    TaskflowChannelMemberKind, TaskflowEvidenceKind, TaskflowTaskEvidence, taskflow_task_evidence,
};
use crate::views::{load_task, load_task_in_project};

pub const MAX_LABEL_CHARS: usize = 200;
pub const MAX_URL_CHARS: usize = 500;
/// A task's evidence list is a review aid, not a log: cap it.
pub const MAX_PER_TASK: usize = 100;
/// How many labels a status-change activity quotes.
const SUMMARY_LABELS: usize = 3;

fn status_err(status: StatusCode) -> ApiError {
    let code = match status {
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::FORBIDDEN => "forbidden",
        _ => "error",
    };
    err(status, code)
}

#[derive(Debug, Clone)]
struct Author {
    kind: TaskflowChannelMemberKind,
    id: i64,
    label: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stats {
    pub passed: Option<i64>,
    pub failed: Option<i64>,
    pub duration_ms: Option<i64>,
    pub files: Option<i64>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceInput {
    pub kind: TaskflowEvidenceKind,
    pub label: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub passed: Option<bool>,
    #[serde(default)]
    pub stats: Option<Stats>,
    #[serde(default)]
    pub attachment: Option<i64>,
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

async fn attachment_of(task: i64, id: i64) -> Result<Option<TaskflowTaskAttachment>, ApiError> {
    TaskflowTaskAttachment::objects()
        .filter(taskflow_task_attachment::ID.eq(id) & taskflow_task_attachment::TASK.eq(task))
        .first()
        .await
        .map_err(internal)
}

fn attachment_json(a: &TaskflowTaskAttachment) -> Value {
    json!({ "id": a.id, "filename": a.name, "content_type": a.content_type, "size": a.size_bytes })
}

async fn evidence_json(e: &TaskflowTaskEvidence) -> Result<Value, ApiError> {
    let attachment = match &e.attachment {
        Some(a) => attachment_of(e.task.id(), a.id()).await?.map(|a| attachment_json(&a)),
        None => None,
    };
    let stats = json!({
        "passed": e.tests_passed, "failed": e.tests_failed, "duration_ms": e.duration_ms,
        "files": e.files_changed, "additions": e.additions, "deletions": e.deletions,
    });
    Ok(json!({
        "id": e.id, "project": e.project.id(), "task": e.task.id(), "kind": e.kind, "label": e.label,
        "url": e.url, "passed": e.passed, "stats": stats, "attachment": attachment,
        "author_kind": e.author_kind, "author_user": e.author_user.as_ref().map(|u| u.id()),
        "author_agent": e.author_agent.as_ref().map(|a| a.id()), "author_label": e.author_label,
        "self_reported": true, "created_at": e.created_at,
    }))
}

fn non_negative(field: &str, v: Option<i64>) -> Result<Option<i64>, ApiError> {
    match v {
        Some(n) if n < 0 => Err(bad(field, "zero or more")),
        other => Ok(other),
    }
}

async fn task_evidence(task: i64) -> Result<Vec<TaskflowTaskEvidence>, ApiError> {
    TaskflowTaskEvidence::objects()
        .filter(taskflow_task_evidence::TASK.eq(task))
        .order_by(taskflow_task_evidence::ID.desc())
        .limit(MAX_PER_TASK as u64)
        .fetch()
        .await
        .map_err(internal)
}

async fn add(task: TaskflowTask, author: Author, input: EvidenceInput) -> Reply {
    let label = input.label.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
        return Err(bad("label", &format!("1 to {MAX_LABEL_CHARS} characters")));
    }
    let url = input.url.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(u) = &url {
        if u.chars().count() > MAX_URL_CHARS
            || !(u.starts_with("https://") || u.starts_with("http://"))
            || u.chars().any(char::is_whitespace)
        {
            return Err(bad("url", &format!("an http(s) URL of at most {MAX_URL_CHARS} characters")));
        }
    }
    let attachment = match input.attachment {
        Some(id) => Some(attachment_of(task.id, id).await?.ok_or_else(|| bad("attachment", "not an attachment on this task"))?),
        None => None,
    };
    if input.kind == TaskflowEvidenceKind::Attachment && attachment.is_none() {
        return Err(bad("attachment", "required for attachment evidence"));
    }
    let stats = input.stats.unwrap_or_default();
    let count = TaskflowTaskEvidence::objects()
        .filter(taskflow_task_evidence::TASK.eq(task.id))
        .count()
        .await
        .map_err(internal)?;
    if count as usize >= MAX_PER_TASK {
        return Err(err(StatusCode::CONFLICT, "evidence_full"));
    }
    let (user, agent) = match author.kind {
        TaskflowChannelMemberKind::User => (Some(ForeignKey::new(author.id)), None),
        TaskflowChannelMemberKind::Agent => (None, Some(ForeignKey::new(author.id))),
    };
    let row = TaskflowTaskEvidence::objects()
        .create(TaskflowTaskEvidence {
            id: 0,
            project: task.project.clone(),
            task: ForeignKey::new(task.id),
            kind: input.kind,
            label,
            url,
            passed: input.passed,
            tests_passed: non_negative("stats.passed", stats.passed)?,
            tests_failed: non_negative("stats.failed", stats.failed)?,
            duration_ms: non_negative("stats.duration_ms", stats.duration_ms)?,
            files_changed: non_negative("stats.files", stats.files)?,
            additions: non_negative("stats.additions", stats.additions)?,
            deletions: non_negative("stats.deletions", stats.deletions)?,
            attachment: attachment.as_ref().map(|a| ForeignKey::new(a.id)),
            author_kind: author.kind,
            author_user: user,
            author_agent: agent,
            author_label: author.label,
            created_at: None,
        })
        .await
        .map_err(internal)?;
    Ok((StatusCode::CREATED, Json(evidence_json(&row).await?)).into_response())
}

async fn list(task: i64) -> Reply {
    let mut out = Vec::new();
    for e in task_evidence(task).await? {
        out.push(evidence_json(&e).await?);
    }
    Ok(Json(json!({ "task": task, "evidence": out, "self_reported": true })).into_response())
}

/// The labels a status-change activity quotes ("evidence: 218 tests pass,
/// migration plan"), newest first. None when there is no evidence.
pub async fn summary(task: i64) -> Option<String> {
    let rows = TaskflowTaskEvidence::objects()
        .filter(taskflow_task_evidence::TASK.eq(task))
        .order_by(taskflow_task_evidence::ID.desc())
        .limit(SUMMARY_LABELS as u64 + 1)
        .fetch()
        .await
        .ok()?;
    if rows.is_empty() {
        return None;
    }
    let mut labels: Vec<String> = rows.iter().take(SUMMARY_LABELS).map(|e| e.label.clone()).collect();
    if rows.len() > SUMMARY_LABELS {
        labels.push("more".into());
    }
    Some(format!("evidence: {}", labels.join(", ")))
}

async fn member_author(user: i64, project: i64) -> Result<Author, ApiError> {
    let m = active_member(project, user).await?.ok_or_else(|| err(StatusCode::FORBIDDEN, "forbidden"))?;
    Ok(Author { kind: TaskflowChannelMemberKind::User, id: user, label: m.display_name })
}

/// `POST /api/taskflow/tasks/{task}/evidence` — an active project member.
pub async fn add_evidence(RequireAuth(user): RequireAuth<i64>, Path(task): Path<i64>, Json(input): Json<EvidenceInput>) -> Reply {
    let task = load_task(task).await.map_err(status_err)?;
    let author = member_author(user, task.project.id()).await?;
    add(task, author, input).await
}

/// `POST /api/taskflow/tasks/{task}/agent/evidence` — an agent (tasks:write).
pub async fn agent_add_evidence(RequireAgent(agent): RequireAgent, Path(task): Path<i64>, Json(input): Json<EvidenceInput>) -> Reply {
    agent
        .require(crate::scopes::TASKS_WRITE)
        .map_err(crate::scopes::CapabilityError::into_status_json)?;
    let task = load_task_in_project(task, agent.project_id).await.map_err(status_err)?;
    let author = Author { kind: TaskflowChannelMemberKind::Agent, id: agent.agent_id, label: agent.display_name.clone() };
    add(task, author, input).await
}

/// `GET /api/taskflow/tasks/{task}/evidence` — an active project member.
pub async fn list_evidence(RequireAuth(user): RequireAuth<i64>, Path(task): Path<i64>) -> Reply {
    let task = load_task(task).await.map_err(status_err)?;
    member_author(user, task.project.id()).await?;
    list(task.id).await
}

/// `GET /api/taskflow/tasks/{task}/agent/evidence` — an agent of the project.
pub async fn agent_list_evidence(RequireAgent(agent): RequireAgent, Path(task): Path<i64>) -> Reply {
    let task = load_task_in_project(task, agent.project_id).await.map_err(status_err)?;
    list(task.id).await
}

async fn withdraw(id: i64, author: Author, project: Option<i64>) -> Reply {
    let e = TaskflowTaskEvidence::objects()
        .filter(taskflow_task_evidence::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .filter(|e| project.is_none_or(|p| e.project.id() == p))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let owner = match author.kind {
        TaskflowChannelMemberKind::User => e.author_user.as_ref().map(|u| u.id()),
        TaskflowChannelMemberKind::Agent => e.author_agent.as_ref().map(|a| a.id()),
    };
    if e.author_kind != author.kind || owner != Some(author.id) {
        return Err(err(StatusCode::FORBIDDEN, "not_author"));
    }
    if author.kind == TaskflowChannelMemberKind::User && active_member(e.project.id(), author.id).await?.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "forbidden"));
    }
    // delete_instance fires per-row post_delete, which realtime listens to.
    TaskflowTaskEvidence::objects().delete_instance(&e).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `DELETE /api/taskflow/evidence/{id}` — its author (a person).
pub async fn delete_evidence(RequireAuth(user): RequireAuth<i64>, Path(id): Path<i64>) -> Reply {
    withdraw(id, Author { kind: TaskflowChannelMemberKind::User, id: user, label: String::new() }, None).await
}

/// `DELETE /api/taskflow/agents/evidence/{id}` — its author (an agent).
pub async fn agent_delete_evidence(RequireAgent(agent): RequireAgent, Path(id): Path<i64>) -> Reply {
    agent
        .require(crate::scopes::TASKS_WRITE)
        .map_err(crate::scopes::CapabilityError::into_status_json)?;
    let me = Author { kind: TaskflowChannelMemberKind::Agent, id: agent.agent_id, label: String::new() };
    withdraw(id, me, Some(agent.project_id)).await
}
