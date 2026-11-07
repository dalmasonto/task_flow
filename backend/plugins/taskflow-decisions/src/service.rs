//! The decision rules, written once and called by both the human and the agent
//! handlers (`views.rs`). A handler only resolves WHO is calling; everything
//! about what that caller may do lives here.
//!
//! Three rules carry the security of the feature:
//!
//! 1. **Only humans rule or supersede.** There is no agent route for either —
//!    an agent key can leak or be prompt-injected, and a ruling unblocks work.
//!    When `ruler_user` is named, only that user may rule.
//! 2. **A ruling is permanent.** `rule` is a compare-and-set from `open`, so two
//!    concurrent rulers cannot both win, and a ruled decision changes only by
//!    being superseded (which keeps the old ruling on record).
//! 3. **The ruled option must belong to the decision** — checked here, not left
//!    to the foreign key, since `ruled_option_id` is a bare id.
//!
//! **Realtime.** `umbral-realtime` publishes on `post_save` / `post_delete`
//! only. A queryset `update_values` emits `bulk_post_save` (ids, no row) and a
//! write inside `umbral::transaction` emits NOTHING. So every conditional or
//! transactional write below is followed by a plain `save` of the re-read row,
//! which is what puts the full row on the wire for the v3 board.

use chrono::Utc;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use umbral::orm::ForeignKey;
use umbral::web::{Json, StatusCode};

use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage,
    TaskflowChannelKind, TaskflowChannelMemberKind, TaskflowMessagePriority,
    taskflow_agent_channel, taskflow_agent_channel_member,
};
use taskflow_tasks::models::{
    TaskflowActorKind, TaskflowTask, TaskflowTaskActivity, taskflow_task,
};

use crate::models::{
    TaskflowDecision, TaskflowDecisionComment, TaskflowDecisionOption, TaskflowDecisionStatus,
    TaskflowDecisionTask, taskflow_decision, taskflow_decision_comment, taskflow_decision_option,
    taskflow_decision_task,
};

pub type ApiError = (StatusCode, Json<Value>);

pub fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

/// A field-level 400 that names the field (#886 §2.6: never `400 {}`).
pub fn bad(field: &str, reason: &str) -> ApiError {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "invalid", "field": field, "reason": reason })),
    )
}

fn internal<E>(_: E) -> ApiError {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

pub const MAX_OPTIONS: usize = 10;
pub const MAX_LINKED_TASKS: usize = 50;

/// Who is acting. Agents and users share every rule except ruling.
#[derive(Debug, Clone)]
pub enum Actor {
    User { id: i64, label: String },
    Agent { id: i64, label: String },
}

impl Actor {
    pub fn label(&self) -> &str {
        match self {
            Actor::User { label, .. } | Actor::Agent { label, .. } => label,
        }
    }
    fn user_id(&self) -> Option<i64> {
        match self {
            Actor::User { id, .. } => Some(*id),
            Actor::Agent { .. } => None,
        }
    }
    fn agent_id(&self) -> Option<i64> {
        match self {
            Actor::Agent { id, .. } => Some(*id),
            Actor::User { .. } => None,
        }
    }
}

/// A key is the slug agents ask about: lowercase letters, digits and dashes,
/// 3–60 chars, starting with a letter.
pub fn valid_key(key: &str) -> bool {
    (3..=60).contains(&key.len())
        && key.starts_with(|c: char| c.is_ascii_lowercase())
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !key.ends_with('-')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

pub async fn find(project: i64, key: &str) -> Result<TaskflowDecision, ApiError> {
    TaskflowDecision::objects()
        .filter(taskflow_decision::PROJECT.eq(project) & taskflow_decision::KEY.eq(key))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "decision"))
}

async fn options_of(decision: i64) -> Result<Vec<TaskflowDecisionOption>, ApiError> {
    TaskflowDecisionOption::objects()
        .filter(taskflow_decision_option::DECISION.eq(decision))
        .order_by(taskflow_decision_option::SORT_ORDER.asc())
        .fetch()
        .await
        .map_err(internal)
}

async fn links_of(decision: i64) -> Result<Vec<TaskflowDecisionTask>, ApiError> {
    TaskflowDecisionTask::objects()
        .filter(taskflow_decision_task::DECISION.eq(decision))
        .fetch()
        .await
        .map_err(internal)
}

fn option_json(o: &TaskflowDecisionOption) -> Value {
    json!({
        "id": o.id,
        "label": o.label,
        "detail": o.detail,
        "sort_order": o.sort_order,
        "recommended": o.recommended_by_label.is_some(),
        "recommended_by_label": o.recommended_by_label,
        "recommended_by_user": o.recommended_by_user.as_ref().map(|f| f.id()),
        "recommended_by_agent": o.recommended_by_agent.as_ref().map(|f| f.id()),
    })
}

/// The full record. `with_comments` is off for listings.
pub async fn decision_json(d: &TaskflowDecision, with_comments: bool) -> Result<Value, ApiError> {
    let options = options_of(d.id).await?;
    let task_ids: Vec<i64> = links_of(d.id).await?.iter().map(|l| l.task.id()).collect();
    let ruled_option = d
        .ruled_option_id
        .and_then(|id| options.iter().find(|o| o.id == id))
        .map(option_json);
    let mut value = json!({
        "id": d.id,
        "project": d.project.id(),
        "key": d.key,
        "question": d.question,
        "context_markdown": d.context_markdown,
        "status": d.status,
        "is_ruled": d.status == TaskflowDecisionStatus::Ruled,
        "asked_by_label": d.asked_by_label,
        "asked_by_user": d.asked_by_user.as_ref().map(|f| f.id()),
        "asked_by_agent": d.asked_by_agent.as_ref().map(|f| f.id()),
        "ruler_user": d.ruler_user.as_ref().map(|f| f.id()),
        "channel": d.channel.as_ref().map(|f| f.id()),
        "options": options.iter().map(option_json).collect::<Vec<_>>(),
        "ruled_option": ruled_option,
        "ruling_note": d.ruling_note,
        "ruled_by_label": d.ruled_by_label,
        "ruled_by_user": d.ruled_by_user.as_ref().map(|f| f.id()),
        "ruled_at": d.ruled_at,
        "superseded_by_id": d.superseded_by_id,
        "task_ids": task_ids,
        "created_at": d.created_at,
        "updated_at": d.updated_at,
    });
    if with_comments {
        let comments = TaskflowDecisionComment::objects()
            .filter(taskflow_decision_comment::DECISION.eq(d.id))
            .order_by(taskflow_decision_comment::ID.asc())
            .fetch()
            .await
            .map_err(internal)?;
        value["comments"] = Value::Array(
            comments
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "author_label": c.author_label,
                        "author_user": c.author_user.as_ref().map(|f| f.id()),
                        "author_agent": c.author_agent.as_ref().map(|f| f.id()),
                        "body_markdown": c.body_markdown,
                        "created_at": c.created_at,
                    })
                })
                .collect(),
        );
    }
    Ok(value)
}

#[derive(Debug, Default, Deserialize)]
pub struct ListFilter {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub task: Option<i64>,
    /// "me" = decisions this user is the named ruler of, or any open one with
    /// no named ruler (human surface only).
    #[serde(default)]
    pub waiting_on: Option<String>,
}

pub async fn list(project: i64, filter: &ListFilter, me: Option<i64>) -> Result<Value, ApiError> {
    let mut rows = TaskflowDecision::objects()
        .filter(taskflow_decision::PROJECT.eq(project))
        .order_by(taskflow_decision::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    if let Some(status) = filter.status.as_deref() {
        let wanted = match status {
            "open" => TaskflowDecisionStatus::Open,
            "ruled" => TaskflowDecisionStatus::Ruled,
            "superseded" => TaskflowDecisionStatus::Superseded,
            _ => return Err(bad("status", "one of open, ruled, superseded")),
        };
        rows.retain(|d| d.status == wanted);
    }
    if let Some(task) = filter.task {
        let linked: Vec<i64> = TaskflowDecisionTask::objects()
            .filter(taskflow_decision_task::TASK.eq(task))
            .fetch()
            .await
            .map_err(internal)?
            .iter()
            .map(|l| l.decision.id())
            .collect();
        rows.retain(|d| linked.contains(&d.id));
    }
    if filter.waiting_on.as_deref() == Some("me") {
        let me = me.ok_or_else(|| bad("waiting_on", "only people can be waited on"))?;
        rows.retain(|d| {
            d.status == TaskflowDecisionStatus::Open
                && d.ruler_user.as_ref().map(|f| f.id()).is_none_or(|r| r == me)
        });
    }
    let mut out = Vec::with_capacity(rows.len());
    for d in &rows {
        out.push(decision_json(d, false).await?);
    }
    Ok(json!({ "results": out, "count": out.len() }))
}

/// The open decisions blocking each task in a project — what the board needs
/// for its "Blocked on decision" line and "Open decision" filter, in one call.
pub async fn blocking(project: i64) -> Result<Value, ApiError> {
    let open: Vec<TaskflowDecision> = TaskflowDecision::objects()
        .filter(taskflow_decision::PROJECT.eq(project) & taskflow_decision::STATUS.eq("open"))
        .fetch()
        .await
        .map_err(internal)?;
    let ids: Vec<i64> = open.iter().map(|d| d.id).collect();
    let links = if ids.is_empty() {
        Vec::new()
    } else {
        TaskflowDecisionTask::objects()
            .filter(taskflow_decision_task::DECISION.in_(&ids))
            .fetch()
            .await
            .map_err(internal)?
    };
    let mut by_task: Map<String, Value> = Map::new();
    for link in &links {
        let Some(d) = open.iter().find(|d| d.id == link.decision.id()) else { continue };
        let entry = by_task
            .entry(link.task.id().to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(list) = entry {
            list.push(json!({ "id": d.id, "key": d.key, "question": d.question }));
        }
    }
    Ok(json!({ "tasks": by_task }))
}

// ---------------------------------------------------------------------------
// Writes shared by humans and agents
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct OptionInput {
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// Mark this option as the asker's recommendation.
    #[serde(default)]
    pub recommended: bool,
}

#[derive(Debug, Deserialize)]
pub struct AskInput {
    pub key: String,
    pub question: String,
    #[serde(default)]
    pub context_markdown: Option<String>,
    #[serde(default)]
    pub options: Vec<OptionInput>,
    #[serde(default)]
    pub ruler_user: Option<i64>,
    #[serde(default)]
    pub task_ids: Vec<i64>,
    #[serde(default)]
    pub channel: Option<i64>,
}

fn check_option(o: &OptionInput, field: &str) -> Result<(), ApiError> {
    let label = o.label.trim();
    if label.is_empty() || label.chars().count() > 200 {
        return Err(bad(field, "label must be 1–200 characters"));
    }
    if o.detail.as_deref().is_some_and(|d| d.chars().count() > 2000) {
        return Err(bad(field, "detail must be at most 2000 characters"));
    }
    Ok(())
}

async fn task_in_project(project: i64, task: i64) -> Result<TaskflowTask, ApiError> {
    TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task) & taskflow_task::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)?
        // A task in another project is reported exactly like a missing one.
        .ok_or_else(|| bad("task_ids", &format!("task {task} is not in this project")))
}

/// A channel the actor may post into in this project: a shared room, or a DM
/// the actor is on the roster of.
async fn usable_channel(project: i64, channel: i64, actor: &Actor) -> Result<i64, ApiError> {
    let row = TaskflowAgentChannel::objects()
        .filter(
            taskflow_agent_channel::ID.eq(channel) & taskflow_agent_channel::PROJECT.eq(project),
        )
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| bad("channel", "not a channel in this project"))?;
    if row.kind == TaskflowChannelKind::Direct {
        let roster = TaskflowAgentChannelMember::objects().filter(taskflow_agent_channel_member::CHANNEL.eq(row.id));
        let on_roster = match actor {
            Actor::User { id, .. } => roster.filter(taskflow_agent_channel_member::USER.eq(*id)),
            Actor::Agent { id, .. } => roster.filter(taskflow_agent_channel_member::AGENT.eq(*id)),
        }
        .exists()
        .await
        .map_err(internal)?;
        if !on_roster {
            return Err(bad("channel", "not a channel in this project"));
        }
    }
    Ok(row.id)
}

async fn activity(project: i64, task: i64, actor: &Actor, action: &str, body: String) {
    let (kind, user, agent) = match actor {
        Actor::User { id, .. } => (TaskflowActorKind::User, Some(ForeignKey::new(*id)), None),
        Actor::Agent { id, .. } => (TaskflowActorKind::Agent, None, Some(*id)),
    };
    // Best-effort: an activity line must never undo a ruling that landed.
    let _ = TaskflowTaskActivity::objects()
        .create(TaskflowTaskActivity {
            id: 0,
            project: ForeignKey::new(project),
            task: Some(ForeignKey::new(task)),
            actor_kind: kind,
            actor_user: user,
            actor_agent_id: agent,
            actor_label: actor.label().to_string(),
            action: action.to_string(),
            body_markdown: Some(body),
            metadata_json: None,
            created_at: None,
        })
        .await;
}

pub async fn ask(project: i64, actor: &Actor, input: AskInput) -> Result<Value, ApiError> {
    let key = input.key.trim().to_string();
    if !valid_key(&key) {
        return Err(bad(
            "key",
            "3–60 lowercase letters, digits and dashes, starting with a letter",
        ));
    }
    let question = input.question.trim().to_string();
    if question.is_empty() || question.chars().count() > 300 {
        return Err(bad("question", "must be 1–300 characters"));
    }
    if input.context_markdown.as_deref().is_some_and(|c| c.chars().count() > 12000) {
        return Err(bad("context_markdown", "must be at most 12000 characters"));
    }
    if input.options.len() > MAX_OPTIONS {
        return Err(bad("options", &format!("at most {MAX_OPTIONS} options")));
    }
    for (i, o) in input.options.iter().enumerate() {
        check_option(o, &format!("options[{i}]"))?;
    }
    if input.options.iter().filter(|o| o.recommended).count() > 1 {
        return Err(bad("options", "at most one option can be recommended"));
    }
    if let Some(ruler) = input.ruler_user {
        if !taskflow_projects::scope::can_access_project(ruler, project).await {
            return Err(bad("ruler_user", "must be an active member of this project"));
        }
    }
    let mut task_ids = input.task_ids.clone();
    task_ids.sort_unstable();
    task_ids.dedup();
    if task_ids.len() > MAX_LINKED_TASKS {
        return Err(bad("task_ids", &format!("at most {MAX_LINKED_TASKS} tasks")));
    }
    for task in &task_ids {
        task_in_project(project, *task).await?;
    }
    let channel = match input.channel {
        Some(c) => Some(usable_channel(project, c, actor).await?),
        None => None,
    };
    if TaskflowDecision::objects()
        .filter(taskflow_decision::PROJECT.eq(project) & taskflow_decision::KEY.eq(key.as_str()))
        .exists()
        .await
        .map_err(internal)?
    {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({ "error": "key_taken", "field": "key" })),
        ));
    }

    let decision = TaskflowDecision::objects()
        .create(TaskflowDecision {
            id: 0,
            project: ForeignKey::new(project),
            key: key.clone(),
            question,
            context_markdown: input.context_markdown.filter(|c| !c.trim().is_empty()),
            status: TaskflowDecisionStatus::Open,
            asked_by_user: actor.user_id().map(ForeignKey::new),
            asked_by_agent: actor.agent_id().map(ForeignKey::new),
            asked_by_label: actor.label().to_string(),
            ruler_user: input.ruler_user.map(ForeignKey::new),
            channel: channel.map(ForeignKey::new),
            ruled_option_id: None,
            ruling_note: None,
            ruled_by_user: None,
            ruled_by_label: None,
            ruled_at: None,
            superseded_by_id: None,
            created_at: None,
            updated_at: Some(Utc::now()),
        })
        .await
        // The unique (project, key) index is the real guard against a race
        // between the exists-check above and this insert.
        .map_err(|_| (StatusCode::CONFLICT, Json(json!({ "error": "key_taken", "field": "key" }))))?;

    for (i, o) in input.options.iter().enumerate() {
        create_option(&decision, actor, o, i as i64).await?;
    }
    for task in &task_ids {
        create_link(&decision, *task).await?;
        activity(
            project,
            *task,
            actor,
            "decision_blocked",
            format!("Blocked on decision `{}`: {}", decision.key, decision.question),
        )
        .await;
    }
    decision_json(&decision, true).await
}

async fn create_option(
    d: &TaskflowDecision,
    actor: &Actor,
    o: &OptionInput,
    sort_order: i64,
) -> Result<TaskflowDecisionOption, ApiError> {
    TaskflowDecisionOption::objects()
        .create(TaskflowDecisionOption {
            id: 0,
            project: d.project.clone(),
            decision: ForeignKey::new(d.id),
            label: o.label.trim().to_string(),
            detail: o.detail.clone().filter(|s| !s.trim().is_empty()),
            sort_order,
            recommended_by_user: if o.recommended { actor.user_id().map(ForeignKey::new) } else { None },
            recommended_by_agent: if o.recommended { actor.agent_id().map(ForeignKey::new) } else { None },
            recommended_by_label: o.recommended.then(|| actor.label().to_string()),
            created_at: None,
        })
        .await
        .map_err(internal)
}

async fn create_link(d: &TaskflowDecision, task: i64) -> Result<(), ApiError> {
    TaskflowDecisionTask::objects()
        .create(TaskflowDecisionTask {
            id: 0,
            project: d.project.clone(),
            decision: ForeignKey::new(d.id),
            task: ForeignKey::new(task),
            created_at: None,
        })
        .await
        .map(|_| ())
        .map_err(internal)
}

fn require_open(d: &TaskflowDecision) -> Result<(), ApiError> {
    if d.status == TaskflowDecisionStatus::Open {
        Ok(())
    } else {
        Err((
            StatusCode::CONFLICT,
            Json(json!({ "error": "not_open", "status": d.status })),
        ))
    }
}

/// Re-save a row so `post_save` carries it to realtime (see the module doc).
async fn touch(mut d: TaskflowDecision) -> Result<TaskflowDecision, ApiError> {
    d.updated_at = Some(Utc::now());
    TaskflowDecision::objects().save(d).await.map_err(internal)
}

pub async fn add_option(d: TaskflowDecision, actor: &Actor, o: OptionInput) -> Result<Value, ApiError> {
    require_open(&d)?;
    check_option(&o, "label")?;
    let existing = options_of(d.id).await?;
    if existing.len() >= MAX_OPTIONS {
        return Err(bad("label", &format!("at most {MAX_OPTIONS} options")));
    }
    let next = existing.iter().map(|o| o.sort_order).max().map_or(0, |m| m + 1);
    let created = create_option(&d, actor, &OptionInput { recommended: false, ..o }, next).await?;
    let wants_recommend = o.recommended;
    let d = touch(d).await?;
    if wants_recommend {
        return recommend(d, actor, created.id).await;
    }
    decision_json(&d, true).await
}

/// Make `option` the recommendation, moving it off any other option. Anyone
/// who may discuss may recommend; the recommendation is attributed.
pub async fn recommend(d: TaskflowDecision, actor: &Actor, option: i64) -> Result<Value, ApiError> {
    require_open(&d)?;
    let options = options_of(d.id).await?;
    if !options.iter().any(|o| o.id == option) {
        return Err(bad("option_id", "not an option of this decision"));
    }
    for mut o in options {
        let is_target = o.id == option;
        let has = o.recommended_by_label.is_some();
        if is_target {
            o.recommended_by_user = actor.user_id().map(ForeignKey::new);
            o.recommended_by_agent = actor.agent_id().map(ForeignKey::new);
            o.recommended_by_label = Some(actor.label().to_string());
        } else if has {
            o.recommended_by_user = None;
            o.recommended_by_agent = None;
            o.recommended_by_label = None;
        } else {
            continue;
        }
        TaskflowDecisionOption::objects().save(o).await.map_err(internal)?;
    }
    let d = touch(d).await?;
    decision_json(&d, true).await
}

pub async fn comment(d: TaskflowDecision, actor: &Actor, body: String) -> Result<Value, ApiError> {
    let body = body.trim().to_string();
    if body.is_empty() || body.chars().count() > 8000 {
        return Err(bad("body_markdown", "must be 1–8000 characters"));
    }
    // Discussion stays open after a ruling: people explain, agents ask why.
    TaskflowDecisionComment::objects()
        .create(TaskflowDecisionComment {
            id: 0,
            project: d.project.clone(),
            decision: ForeignKey::new(d.id),
            author_user: actor.user_id().map(ForeignKey::new),
            author_agent: actor.agent_id().map(ForeignKey::new),
            author_label: actor.label().to_string(),
            body_markdown: body,
            created_at: None,
        })
        .await
        .map_err(internal)?;
    decision_json(&d, true).await
}

/// Link (`link = true`) or unlink a task. Only while open: a ruled decision
/// blocks nothing, so linking to it would mean nothing.
pub async fn set_link(d: TaskflowDecision, actor: &Actor, task: i64, link: bool) -> Result<Value, ApiError> {
    require_open(&d)?;
    let project = d.project.id();
    task_in_project(project, task).await.map_err(|_| bad("task_id", "not a task in this project"))?;
    let existing = TaskflowDecisionTask::objects()
        .filter(taskflow_decision_task::DECISION.eq(d.id) & taskflow_decision_task::TASK.eq(task))
        .first()
        .await
        .map_err(internal)?;
    match (link, existing) {
        (true, None) => {
            if links_of(d.id).await?.len() >= MAX_LINKED_TASKS {
                return Err(bad("task_id", &format!("at most {MAX_LINKED_TASKS} tasks")));
            }
            create_link(&d, task).await?;
            activity(project, task, actor, "decision_blocked", format!("Blocked on decision `{}`: {}", d.key, d.question)).await;
        }
        (false, Some(row)) => {
            TaskflowDecisionTask::objects().delete_instance(&row).await.map_err(internal)?;
            activity(project, task, actor, "decision_unlinked", format!("No longer blocked on decision `{}`", d.key)).await;
        }
        // Already in the requested state: idempotent.
        _ => {}
    }
    let d = touch(d).await?;
    decision_json(&d, true).await
}

// ---------------------------------------------------------------------------
// Human-only writes
// ---------------------------------------------------------------------------

/// May `user` rule on `d`? The handler has already checked active membership.
pub fn may_rule(d: &TaskflowDecision, user: i64) -> bool {
    d.ruler_user.as_ref().is_none_or(|r| r.id() == user)
}

/// Rule. Human only — there is deliberately no agent route to this.
pub async fn rule(
    d: TaskflowDecision,
    user: i64,
    user_label: &str,
    option: i64,
    note: Option<String>,
) -> Result<Value, ApiError> {
    require_open(&d)?;
    if !may_rule(&d, user) {
        return Err(err(StatusCode::FORBIDDEN, "not_the_ruler"));
    }
    let options = options_of(d.id).await?;
    let Some(chosen) = options.iter().find(|o| o.id == option) else {
        return Err(bad("option_id", "not an option of this decision"));
    };
    let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if note.as_deref().is_some_and(|n| n.chars().count() > 4000) {
        return Err(bad("note", "must be at most 4000 characters"));
    }
    let now = Utc::now();

    // Compare-and-set: only a still-open row flips. A concurrent ruler, or a
    // supersede that landed first, leaves 0 rows and gets a 409.
    let mut values = Map::new();
    values.insert("status".into(), json!("ruled"));
    values.insert("ruled_option_id".into(), json!(chosen.id));
    values.insert("ruling_note".into(), json!(note));
    values.insert("ruled_by_user".into(), json!(user));
    values.insert("ruled_by_label".into(), json!(user_label));
    values.insert("ruled_at".into(), json!(now));
    let flipped = TaskflowDecision::objects()
        .filter(taskflow_decision::ID.eq(d.id) & taskflow_decision::STATUS.eq("open"))
        .update_values(values)
        .await
        .map_err(internal)?;
    if flipped == 0 {
        return Err((StatusCode::CONFLICT, Json(json!({ "error": "not_open" }))));
    }

    let ruled = TaskflowDecision::objects()
        .filter(taskflow_decision::ID.eq(d.id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "decision"))?;
    let ruled = touch(ruled).await?;

    // Side effects. The ruling has landed; these are best-effort and never undo it.
    let actor = Actor::User { id: user, label: user_label.to_string() };
    let project = ruled.project.id();
    let links = links_of(ruled.id).await?;
    let mut unblocked = Vec::new();
    for link in &links {
        let task = link.task.id();
        let still = still_blocked_by(task, ruled.id).await;
        let body = match still.as_slice() {
            [] => {
                unblocked.push(task);
                format!("Decision `{}` ruled: **{}**. Unblocked.", ruled.key, chosen.label)
            }
            keys => format!(
                "Decision `{}` ruled: **{}**. Still blocked on {}.",
                ruled.key,
                chosen.label,
                keys.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ")
            ),
        };
        activity(project, task, &actor, "decision_ruled", body).await;
    }
    notify_ruling(&ruled, &chosen.label, user, user_label, &unblocked).await;
    decision_json(&ruled, true).await
}

/// Keys of OTHER open decisions still blocking `task`.
async fn still_blocked_by(task: i64, except: i64) -> Vec<String> {
    let links = TaskflowDecisionTask::objects()
        .filter(taskflow_decision_task::TASK.eq(task))
        .fetch()
        .await
        .unwrap_or_default();
    let ids: Vec<i64> = links.iter().map(|l| l.decision.id()).filter(|id| *id != except).collect();
    if ids.is_empty() {
        return Vec::new();
    }
    TaskflowDecision::objects()
        .filter(taskflow_decision::ID.in_(&ids) & taskflow_decision::STATUS.eq("open"))
        .fetch()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|d| d.key)
        .collect()
}

/// Post the ruling into the channel it was asked in (else the project room),
/// from the ruler, targeted at the asking agent. A chat message is what the
/// MCP already types into an agent's pane, through its serial pane queue — so
/// the asker hears about the ruling with no MCP change, and the room sees it.
async fn notify_ruling(d: &TaskflowDecision, label: &str, user: i64, user_label: &str, unblocked: &[i64]) {
    let project = d.project.id();
    let channel = match d.channel.as_ref().map(|c| c.id()) {
        Some(c) => c,
        None => match taskflow_agents::views::ensure_project_rooms(project).await {
            Ok((public, _design)) => public.id,
            Err(_) => return,
        },
    };
    let mut body = format!("Ruled decision `{}`: **{}**", d.key, label);
    if let Some(note) = d.ruling_note.as_deref() {
        body.push_str(&format!("\n\n> {note}"));
    }
    if !unblocked.is_empty() {
        body.push_str(&format!(
            "\n\nUnblocked: {}",
            unblocked.iter().map(|t| format!("#TSK{t}")).collect::<Vec<_>>().join(", ")
        ));
    }
    let asker = d.asked_by_agent.as_ref().map(|a| a.id());
    let _ = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: Some(ForeignKey::new(user)),
            sender_agent: None,
            target_agent: asker.map(ForeignKey::new),
            targets: asker.map(|a| json!([{ "kind": "agent", "id": a }]).to_string()),
            sender_label: user_label.to_string(),
            body_markdown: body,
            priority: TaskflowMessagePriority::Normal,
            is_design: false,
            client_nonce: None,
            edited_at: None,
            reply_to: None,
            questions: None,
            created_at: None,
        })
        .await;
}

/// `old` is replaced by `new`. Human only. `old` may be open or ruled (a
/// ruling changes only this way); `new` must be open, so every moved task is
/// blocked again until `new` is ruled — nothing silently unblocks.
pub async fn supersede(
    old: TaskflowDecision,
    new_key: &str,
    user: i64,
    user_label: &str,
) -> Result<Value, ApiError> {
    if old.status == TaskflowDecisionStatus::Superseded {
        return Err((StatusCode::CONFLICT, Json(json!({ "error": "already_superseded" }))));
    }
    let project = old.project.id();
    let new = find(project, new_key)
        .await
        .map_err(|_| bad("by", "no decision with that key in this project"))?;
    if new.id == old.id {
        return Err(bad("by", "a decision cannot supersede itself"));
    }
    if new.status != TaskflowDecisionStatus::Open {
        return Err(bad("by", "the replacement must be open"));
    }

    // 1. Links that would collide with one `new` already has are redundant
    //    (the task is blocked by `new` either way). Drop them outside the
    //    transaction so their post_delete reaches realtime.
    let new_tasks: Vec<i64> = links_of(new.id).await?.iter().map(|l| l.task.id()).collect();
    let old_links = links_of(old.id).await?;
    let mut moved_tasks = Vec::new();
    for link in &old_links {
        if new_tasks.contains(&link.task.id()) {
            TaskflowDecisionTask::objects().delete_instance(link).await.map_err(internal)?;
        } else {
            moved_tasks.push(link.task.id());
        }
    }

    // 2. One transaction: flip `old` (compare-and-set on its status) and move
    //    its remaining links onto `new`. Either both land or neither.
    let (old_id, new_id, prior) = (old.id, new.id, old.status);
    let prior_str = if prior == TaskflowDecisionStatus::Open { "open" } else { "ruled" };
    let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = umbral::transaction(move |tx| {
        Box::pin(async move {
            let flipped = TaskflowDecision::objects()
                .filter(taskflow_decision::ID.eq(old_id) & taskflow_decision::STATUS.eq(prior_str))
                .on_tx(tx)
                .update_values(
                    json!({ "status": "superseded", "superseded_by_id": new_id })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                )
                .await?;
            if flipped == 0 {
                return Err("decision changed underneath".into());
            }
            TaskflowDecisionTask::objects()
                .filter(taskflow_decision_task::DECISION.eq(old_id))
                .on_tx(tx)
                .update_values(json!({ "decision": new_id }).as_object().cloned().unwrap_or_default())
                .await?;
            Ok(())
        })
    })
    .await;
    if result.is_err() {
        return Err((StatusCode::CONFLICT, Json(json!({ "error": "not_supersedable" }))));
    }

    // 3. Emit: a transaction fires no signals, so re-save what changed.
    let old = TaskflowDecision::objects()
        .filter(taskflow_decision::ID.eq(old_id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "decision"))?;
    let old = touch(old).await?;
    for link in links_of(new_id).await? {
        if moved_tasks.contains(&link.task.id()) {
            TaskflowDecisionTask::objects().save(link).await.map_err(internal)?;
        }
    }
    let new = touch(new).await?;

    let actor = Actor::User { id: user, label: user_label.to_string() };
    for task in moved_tasks.iter().chain(new_tasks.iter().filter(|t| old_links.iter().any(|l| l.task.id() == **t))) {
        activity(
            project,
            *task,
            &actor,
            "decision_superseded",
            format!("Decision `{}` superseded by `{}`. Blocked until `{}` is ruled.", old.key, new.key, new.key),
        )
        .await;
    }
    decision_json(&new, true).await
}
