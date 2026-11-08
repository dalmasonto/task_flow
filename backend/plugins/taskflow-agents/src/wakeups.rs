//! #1113: wake-up rules — "wake this agent when X" (#886 §3.2), phase A.
//!
//! Agents stop polling: a rule waits for an event or a time, then puts a note
//! in front of the agent. Triggers: a time, a task becoming unblocked, a reply
//! to a message, a message in a room. (CI/PR need a GitHub webhook — phase B.)
//!
//! **Delivery is always a chat message**, never a raw terminal input (lead
//! review #MSG5699): a terminal input types and presses Enter into whatever the
//! pane shows, so it could answer a permission prompt. A message rides the
//! MCP's pane queue and prompt gate. `pane` = a notice in the agent's private
//! "Wake-ups" DM; `room` = a message in the chosen channel; `both` = both.
//!
//! The notice's sender is `kind = user` with NO user and the label
//! [`SENDER_LABEL`]: the MCP never delivers an agent's own messages to it, so a
//! rule an agent set for itself must not be "from" that agent. The same label
//! keeps wake-up notices from firing other agents' room rules (no chains).
//!
//! **Firing is a compare-and-set** from `armed`, so a rule fires exactly once
//! however many events race. If the agent has no live session it becomes
//! `missed` and is delivered — batched, in one notice — when its next session
//! starts (#MSG5699 point 3), or immediately by a human's "Deliver now".
//!
//! **Who may aim a rule at an agent** (#MSG5699 point 2): the agent itself, or a
//! human who passes the #180 terminal-input check (an active project member).
//! Any other agent may only create `room` rules for someone else.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Once, OnceLock};

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_tasks::models::{TaskflowTask, TaskflowTaskStatus, taskflow_task};

use crate::agent_auth::{AgentIdentity, RequireAgent};
use crate::answers::{ApiError, Reply, bad, err, internal, user_label};
use crate::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelKind,
    TaskflowChannelMemberKind, TaskflowMessagePriority, TaskflowWakeDeliver, TaskflowWakeRule,
    TaskflowWakeStatus, TaskflowWakeTrigger, taskflow_agent, taskflow_agent_channel,
    taskflow_agent_message, taskflow_wake_rule,
};

pub const SENDER_LABEL: &str = "TaskFlow wake-up";
pub const MAX_ARMED_PER_AGENT: i64 = 20;
const MAX_NOTE_CHARS: usize = 1000;
const MAX_MINUTES: i64 = 7 * 24 * 60;
const SWEEP_SECONDS: u64 = 15;

// ---------------------------------------------------------------------------
// "Is this task still blocked by a decision?" — registered by the decisions
// plugin (which depends on this crate, so it cannot be called the other way).
// ---------------------------------------------------------------------------

type BoolFuture = Pin<Box<dyn Future<Output = bool> + Send>>;
type BlockedCheck = Box<dyn Fn(i64) -> BoolFuture + Send + Sync>;
static DECISION_BLOCKED: OnceLock<BlockedCheck> = OnceLock::new();

/// The decisions plugin registers how to ask "does task N have an open
/// decision?". Without it (decisions not installed) the answer is "no".
pub fn register_decision_blocked_check(check: BlockedCheck) {
    let _ = DECISION_BLOCKED.set(check);
}

async fn decision_blocked(task: i64) -> bool {
    match DECISION_BLOCKED.get() {
        Some(check) => check(task).await,
        None => false,
    }
}

async fn task_is_blocked(task: &TaskflowTask) -> bool {
    task.status == TaskflowTaskStatus::Blocked || decision_blocked(task.id).await
}

// ---------------------------------------------------------------------------
// Reads / JSON
// ---------------------------------------------------------------------------

fn rule_json(r: &TaskflowWakeRule) -> Value {
    json!({
        "id": r.id,
        "project": r.project.id(),
        "agent": r.agent.id(),
        "created_by_user": r.created_by_user.as_ref().map(|u| u.id()),
        "created_by_agent": r.created_by_agent.as_ref().map(|a| a.id()),
        "created_by_label": r.created_by_label,
        "trigger": r.trigger_kind,
        "target_task": r.target_task,
        "target_message": r.target_message,
        "watch_channel": r.watch_channel.as_ref().map(|c| c.id()),
        "mentions_only": r.mentions_only,
        "fire_at": r.fire_at,
        "note": r.note,
        "deliver": r.deliver,
        "deliver_channel": r.deliver_channel.as_ref().map(|c| c.id()),
        "status": r.status,
        "fired_at": r.fired_at,
        "delivered_at": r.delivered_at,
        "source_ref": r.source_ref,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    })
}

async fn load_rule(project: i64, id: i64) -> Result<TaskflowWakeRule, ApiError> {
    TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::ID.eq(id) & taskflow_wake_rule::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))
}

async fn load_agent(project: i64, id: i64) -> Result<TaskflowAgent, ApiError> {
    TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(id) & taskflow_agent::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| bad("agent", "not an agent in this project"))
}

#[derive(Debug, Default, Deserialize)]
pub struct ListFilter {
    #[serde(default)]
    pub agent: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
}

async fn list(project: i64, filter: &ListFilter) -> Result<Value, ApiError> {
    let mut rows = TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::PROJECT.eq(project))
        .order_by(taskflow_wake_rule::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    if let Some(agent) = filter.agent {
        rows.retain(|r| r.agent.id() == agent);
    }
    if let Some(status) = filter.status.as_deref() {
        let wanted = parse_status(status).ok_or_else(|| bad("status", "armed, fired, missed, paused or cancelled"))?;
        rows.retain(|r| r.status == wanted);
    }
    Ok(json!({ "results": rows.iter().map(rule_json).collect::<Vec<_>>(), "count": rows.len() }))
}

fn parse_status(s: &str) -> Option<TaskflowWakeStatus> {
    Some(match s {
        "armed" => TaskflowWakeStatus::Armed,
        "fired" => TaskflowWakeStatus::Fired,
        "missed" => TaskflowWakeStatus::Missed,
        "paused" => TaskflowWakeStatus::Paused,
        "cancelled" => TaskflowWakeStatus::Cancelled,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Creator {
    User { id: i64, label: String },
    Agent { id: i64, label: String },
}

#[derive(Debug, Deserialize)]
pub struct CreateInput {
    /// The agent to wake. Agents may omit it (= themselves).
    #[serde(default)]
    pub agent: Option<i64>,
    pub trigger: TaskflowWakeTrigger,
    #[serde(default)]
    pub task: Option<i64>,
    #[serde(default)]
    pub message: Option<i64>,
    #[serde(default)]
    pub channel: Option<i64>,
    #[serde(default)]
    pub mentions_only: bool,
    /// `after_time`: an absolute time, or…
    #[serde(default)]
    pub fire_at: Option<DateTime<Utc>>,
    /// …minutes from now (1 to 7 days).
    #[serde(default)]
    pub in_minutes: Option<i64>,
    pub note: String,
    #[serde(default = "default_deliver")]
    pub deliver: TaskflowWakeDeliver,
    #[serde(default)]
    pub deliver_channel: Option<i64>,
}

fn default_deliver() -> TaskflowWakeDeliver {
    TaskflowWakeDeliver::Pane
}

async fn channel_in_project(project: i64, id: i64, field: &str) -> Result<TaskflowAgentChannel, ApiError> {
    TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(id) & taskflow_agent_channel::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| bad(field, "not a channel in this project"))
}

/// The woken agent must be able to see a channel the rule watches or posts in.
async fn agent_sees(channel: &TaskflowAgentChannel, agent: i64, project: i64, field: &str) -> Result<(), ApiError> {
    let ok = crate::views::agent_can_see_channel(channel, agent, project)
        .await
        .map_err(internal)?;
    if ok { Ok(()) } else { Err(bad(field, "the agent cannot see that channel")) }
}

/// A human creator must be able to see it too.
async fn user_sees(channel: &TaskflowAgentChannel, user: i64, field: &str) -> Result<(), ApiError> {
    crate::views::ensure_channel_visible(user, channel.id)
        .await
        .map(|_| ())
        .map_err(|_| bad(field, "not a channel in this project"))
}

async fn create(project: i64, creator: Creator, input: CreateInput) -> Result<Value, ApiError> {
    let agent_id = match (&creator, input.agent) {
        (_, Some(a)) => a,
        (Creator::Agent { id, .. }, None) => *id,
        (Creator::User { .. }, None) => return Err(bad("agent", "which agent to wake")),
    };
    let agent = load_agent(project, agent_id).await?;

    // Who may aim a PANE notice at this agent: itself, or a human who may type
    // into its terminal (#180: an active project member — the handler checked).
    // Another agent may only create room rules for it.
    let other_agent = matches!(&creator, Creator::Agent { id, .. } if *id != agent.id);
    if other_agent && input.deliver != TaskflowWakeDeliver::Room {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "pane_not_allowed", "field": "deliver", "reason": "only the agent itself or a person may wake an agent's pane; use deliver: room" })),
        ));
    }

    let note = input.note.trim().to_string();
    if note.is_empty() || note.chars().count() > MAX_NOTE_CHARS {
        return Err(bad("note", &format!("1-{MAX_NOTE_CHARS} characters")));
    }

    let armed = TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::AGENT.eq(agent.id) & taskflow_wake_rule::STATUS.eq("armed"))
        .count()
        .await
        .map_err(internal)?;
    if armed >= MAX_ARMED_PER_AGENT {
        return Err(bad("agent", &format!("an agent can have at most {MAX_ARMED_PER_AGENT} armed rules")));
    }

    let (mut target_task, mut target_message, mut watch, mut fire_at) = (None, None, None, None);
    match input.trigger {
        TaskflowWakeTrigger::AfterTime => {
            let at = match (input.fire_at, input.in_minutes) {
                (Some(at), None) => at,
                (None, Some(m)) if (1..=MAX_MINUTES).contains(&m) => Utc::now() + Duration::minutes(m),
                (None, Some(_)) => return Err(bad("in_minutes", "1 minute to 7 days")),
                _ => return Err(bad("fire_at", "give fire_at or in_minutes")),
            };
            if at <= Utc::now() || at > Utc::now() + Duration::minutes(MAX_MINUTES) {
                return Err(bad("fire_at", "in the future, within 7 days"));
            }
            fire_at = Some(at);
        }
        TaskflowWakeTrigger::TaskUnblocked => {
            let id = input.task.ok_or_else(|| bad("task", "which task"))?;
            let task = TaskflowTask::objects()
                .filter(taskflow_task::ID.eq(id) & taskflow_task::PROJECT.eq(project))
                .first()
                .await
                .map_err(internal)?
                .ok_or_else(|| bad("task", "not a task in this project"))?;
            if !task_is_blocked(&task).await {
                return Err(bad("task", "that task is not blocked"));
            }
            target_task = Some(task.id);
        }
        TaskflowWakeTrigger::ReplyToMessage => {
            let id = input.message.ok_or_else(|| bad("message", "which message"))?;
            let message = TaskflowAgentMessage::objects()
                .filter(taskflow_agent_message::ID.eq(id) & taskflow_agent_message::PROJECT.eq(project))
                .first()
                .await
                .map_err(internal)?
                .ok_or_else(|| bad("message", "not a message in this project"))?;
            let channel = channel_in_project(project, message.channel.id(), "message").await?;
            agent_sees(&channel, agent.id, project, "message").await?;
            if let Creator::User { id, .. } = &creator {
                user_sees(&channel, *id, "message").await?;
            }
            target_message = Some(message.id);
        }
        TaskflowWakeTrigger::MessageInRoom => {
            let id = input.channel.ok_or_else(|| bad("channel", "which room to watch"))?;
            let channel = channel_in_project(project, id, "channel").await?;
            agent_sees(&channel, agent.id, project, "channel").await?;
            if let Creator::User { id, .. } = &creator {
                user_sees(&channel, *id, "channel").await?;
            }
            watch = Some(channel.id);
        }
    }

    let deliver_channel = match input.deliver {
        TaskflowWakeDeliver::Pane => None,
        TaskflowWakeDeliver::Room | TaskflowWakeDeliver::Both => {
            let id = input.deliver_channel.ok_or_else(|| bad("deliver_channel", "which room to post in"))?;
            let channel = channel_in_project(project, id, "deliver_channel").await?;
            agent_sees(&channel, agent.id, project, "deliver_channel").await?;
            match &creator {
                Creator::User { id, .. } => user_sees(&channel, *id, "deliver_channel").await?,
                Creator::Agent { id, .. } => agent_sees(&channel, *id, project, "deliver_channel").await?,
            }
            Some(channel.id)
        }
    };

    let (cu, ca, label) = match &creator {
        Creator::User { id, label } => (Some(ForeignKey::new(*id)), None, label.clone()),
        Creator::Agent { id, label } => (None, Some(ForeignKey::new(*id)), label.clone()),
    };
    let rule = TaskflowWakeRule::objects()
        .create(TaskflowWakeRule {
            id: 0,
            project: ForeignKey::new(project),
            agent: ForeignKey::new(agent.id),
            created_by_user: cu,
            created_by_agent: ca,
            created_by_label: label,
            trigger_kind: input.trigger,
            target_task,
            target_message,
            watch_channel: watch.map(ForeignKey::new),
            mentions_only: input.mentions_only && input.trigger == TaskflowWakeTrigger::MessageInRoom,
            fire_at,
            note,
            deliver: input.deliver,
            deliver_channel: deliver_channel.map(ForeignKey::new),
            pane_channel: None,
            status: TaskflowWakeStatus::Armed,
            fired_at: None,
            delivered_at: None,
            source_ref: None,
            created_at: None,
            updated_at: Some(Utc::now()),
        })
        .await
        .map_err(internal)?;
    Ok(rule_json(&rule))
}

// ---------------------------------------------------------------------------
// Firing and delivery
// ---------------------------------------------------------------------------

async fn agent_is_live(agent: i64) -> bool {
    crate::views::live_session_count(agent, Utc::now()).await.map(|n| n > 0).unwrap_or(false)
}

fn summary(r: &TaskflowWakeRule) -> String {
    match r.trigger_kind {
        TaskflowWakeTrigger::AfterTime => "time is up".to_string(),
        TaskflowWakeTrigger::TaskUnblocked => format!("#TSK{} is unblocked", r.target_task.unwrap_or_default()),
        TaskflowWakeTrigger::ReplyToMessage => format!("a reply to #MSG{} arrived", r.target_message.unwrap_or_default()),
        TaskflowWakeTrigger::MessageInRoom => match r.source_ref.as_deref().and_then(|s| s.strip_prefix("message:")) {
            Some(id) => format!("new message #MSG{id}"),
            None => "a new message in the room".to_string(),
        },
    }
}

/// One line, always: a note (or label) with a line break could otherwise forge
/// a second `[taskflow wake-up …]` line, or a fake entry in the batched list.
fn flat(text: &str) -> String {
    text.split(['\n', '\r']).map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Who set it, in the notice itself (lead review #MSG5703): the note is free
/// text by whoever made the rule, and must not read as a TaskFlow instruction.
fn header(r: &TaskflowWakeRule) -> String {
    format!("[taskflow wake-up #{}, set by {}]", r.id, flat(&r.created_by_label))
}

/// The agent's private "Wake-ups" DM: reuse one an earlier rule made, else
/// create it, rostered to the agent and the human who linked it.
async fn pane_channel_for(agent: &TaskflowAgent) -> Result<i64, ApiError> {
    let existing = TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::AGENT.eq(agent.id) & taskflow_wake_rule::PANE_CHANNEL.is_not_null())
        .first()
        .await
        .map_err(internal)?
        .and_then(|r| r.pane_channel.map(|c| c.id()));
    if let Some(id) = existing {
        if TaskflowAgentChannel::objects().filter(taskflow_agent_channel::ID.eq(id)).exists().await.map_err(internal)? {
            return Ok(id);
        }
    }
    let project = agent.project.id();
    let channel = TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: agent.project.clone(),
            title: format!("Wake-ups · {}", agent.display_name),
            topic: Some("Wake-up notices for this agent".to_string()),
            kind: TaskflowChannelKind::Direct,
            task: None,
            created_by_user: None,
            created_by_agent: None,
            archived: false,
            is_public: false,
            is_design: false,
            created_at: None,
        })
        .await
        .map_err(internal)?;
    crate::views::ensure_agent_channel_row(project, channel.id, agent.id, &agent.display_name)
        .await
        .map_err(internal)?;
    if let Some(user) = agent.linked_by.as_ref() {
        let label = user_label(user.id()).await;
        crate::views::ensure_user_channel_row(project, channel.id, user.id(), &label)
            .await
            .map_err(internal)?;
    }
    Ok(channel.id)
}

async fn post_notice(project: i64, channel: i64, agent: i64, body: String) -> Result<(), ApiError> {
    post_system_message(project, channel, Some(agent), body).await
}

/// A system notice (sender kind user, no user, label [`SENDER_LABEL`]) in
/// `channel`, optionally targeted at one agent. Shared with the usage plugin
/// (#1115) so every TaskFlow-generated notice uses one shape — and none of them
/// can wake another rule (the chain guard keys on this label).
pub async fn post_system_message(project: i64, channel: i64, agent: Option<i64>, body: String) -> Result<(), ApiError> {
    let is_design = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(channel))
        .first()
        .await
        .map_err(internal)?
        .is_some_and(|c| c.is_design);
    TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: None,
            sender_agent: None,
            target_agent: agent.map(ForeignKey::new),
            targets: agent.map(|a| json!([{ "kind": "agent", "id": a }]).to_string()),
            sender_label: SENDER_LABEL.to_string(),
            body_markdown: body,
            priority: TaskflowMessagePriority::Normal,
            is_design,
            client_nonce: None,
            edited_at: None,
            reply_to: None,
            questions: None,
            created_at: None,
        })
        .await
        .map(|_| ())
        .map_err(internal)
}

/// Deliver one fired rule now: pane notice and/or room post.
async fn deliver(mut rule: TaskflowWakeRule) -> Result<TaskflowWakeRule, ApiError> {
    let agent = TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(rule.agent.id()))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "agent"))?;
    let body = format!("{} {}: {}", header(&rule), summary(&rule), flat(&rule.note));
    let project = rule.project.id();
    if matches!(rule.deliver, TaskflowWakeDeliver::Pane | TaskflowWakeDeliver::Both) {
        let channel = pane_channel_for(&agent).await?;
        rule.pane_channel = Some(ForeignKey::new(channel));
        post_notice(project, channel, agent.id, body.clone()).await?;
    }
    if matches!(rule.deliver, TaskflowWakeDeliver::Room | TaskflowWakeDeliver::Both) {
        if let Some(channel) = rule.deliver_channel.as_ref().map(|c| c.id()) {
            post_notice(project, channel, agent.id, body).await?;
        }
    }
    rule.status = TaskflowWakeStatus::Fired;
    rule.delivered_at = Some(Utc::now());
    rule.updated_at = Some(Utc::now());
    TaskflowWakeRule::objects().save(rule).await.map_err(internal)
}

/// Fire one rule: compare-and-set from `armed`, so it fires exactly once.
/// Delivered now if the agent is live, else marked `missed`.
async fn fire(rule_id: i64, source: &str) -> Result<(), ApiError> {
    let now = Utc::now();
    let mut values = Map::new();
    values.insert("status".into(), json!("fired"));
    values.insert("fired_at".into(), json!(now));
    values.insert("source_ref".into(), json!(source));
    values.insert("updated_at".into(), json!(now));
    let flipped = TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::ID.eq(rule_id) & taskflow_wake_rule::STATUS.eq("armed"))
        .update_values(values)
        .await
        .map_err(internal)?;
    if flipped == 0 {
        return Ok(()); // someone else fired it, or it was paused/cancelled
    }
    let mut rule = TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::ID.eq(rule_id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "rule"))?;
    if agent_is_live(rule.agent.id()).await {
        deliver(rule).await?;
    } else {
        rule.status = TaskflowWakeStatus::Missed;
        TaskflowWakeRule::objects().save(rule).await.map_err(internal)?;
    }
    Ok(())
}

/// A session started for `agent`: deliver every missed rule in ONE notice,
/// oldest first, capped at the armed-rule limit (#MSG5699 point 3).
pub async fn deliver_missed(agent_id: i64) -> Result<usize, ApiError> {
    let mut missed = TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::AGENT.eq(agent_id) & taskflow_wake_rule::STATUS.eq("missed"))
        .order_by(taskflow_wake_rule::FIRED_AT.asc())
        .fetch()
        .await
        .map_err(internal)?;
    if missed.is_empty() {
        return Ok(0);
    }
    missed.truncate(MAX_ARMED_PER_AGENT as usize);
    let agent = TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(agent_id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "agent"))?;
    let mut body = format!("[taskflow wake-up] {} wake-up(s) fired while you were offline:", missed.len());
    for r in &missed {
        body.push_str(&format!("\n- #{}, set by {}: {}: {}", r.id, flat(&r.created_by_label), summary(r), flat(&r.note)));
    }
    let channel = pane_channel_for(&agent).await?;
    post_notice(agent.project.id(), channel, agent.id, body).await?;
    let n = missed.len();
    let now = Utc::now();
    for mut r in missed {
        r.status = TaskflowWakeStatus::Fired;
        r.delivered_at = Some(now);
        r.pane_channel = Some(ForeignKey::new(channel));
        r.updated_at = Some(now);
        TaskflowWakeRule::objects().save(r).await.map_err(internal)?;
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// Event hooks
// ---------------------------------------------------------------------------

async fn armed(trigger: &str) -> Vec<TaskflowWakeRule> {
    TaskflowWakeRule::objects()
        .filter(taskflow_wake_rule::STATUS.eq("armed") & taskflow_wake_rule::TRIGGER_KIND.eq(trigger))
        .fetch()
        .await
        .unwrap_or_default()
}

/// A task may have just stopped being blocked. Called by the task write
/// signals (both save paths) and by the decisions plugin after a ruling.
pub async fn task_maybe_unblocked(task_id: i64) {
    let rules: Vec<TaskflowWakeRule> = armed("task_unblocked").await.into_iter().filter(|r| r.target_task == Some(task_id)).collect();
    if rules.is_empty() {
        return;
    }
    let Ok(Some(task)) = TaskflowTask::objects().filter(taskflow_task::ID.eq(task_id)).first().await else {
        return;
    };
    if task_is_blocked(&task).await {
        return;
    }
    for r in rules {
        let _ = fire(r.id, &format!("task:{task_id}")).await;
    }
}

fn mentions(message: &TaskflowAgentMessage, agent: i64) -> bool {
    let targeted = message.target_agent.as_ref().map(|a| a.id()) == Some(agent)
        || message
            .targets
            .as_deref()
            .and_then(|t| serde_json::from_str::<Vec<crate::models::MessageTarget>>(t).ok())
            .is_some_and(|ts| ts.iter().any(|t| t.kind == "agent" && t.id == agent));
    targeted || message.body_markdown.contains(&format!("](agent:{agent})"))
}

/// A message was created: reply and room rules.
pub async fn message_created(message_id: i64) {
    let Ok(Some(m)) = TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(message_id)).first().await else {
        return;
    };
    // Wake-up notices never wake anyone (no chains).
    if m.sender_kind == TaskflowChannelMemberKind::User && m.sender_user.is_none() && m.sender_label == SENDER_LABEL {
        return;
    }
    let from_agent = |agent: i64| m.sender_kind == TaskflowChannelMemberKind::Agent && m.sender_agent.as_ref().map(|a| a.id()) == Some(agent);
    if let Some(parent) = m.reply_to {
        for r in armed("reply_to_message").await {
            if r.target_message == Some(parent) && !from_agent(r.agent.id()) {
                let _ = fire(r.id, &format!("message:{}", m.id)).await;
            }
        }
    }
    for r in armed("message_in_room").await {
        if r.watch_channel.as_ref().map(|c| c.id()) == Some(m.channel.id())
            && !from_agent(r.agent.id())
            && (!r.mentions_only || mentions(&m, r.agent.id()))
        {
            let _ = fire(r.id, &format!("message:{}", m.id)).await;
        }
    }
}

/// Fire every `after_time` rule whose time has come.
pub async fn sweep_due() -> usize {
    let now = Utc::now();
    let due: Vec<i64> = armed("after_time")
        .await
        .into_iter()
        .filter(|r| r.fire_at.is_some_and(|t| t <= now))
        .map(|r| r.id)
        .collect();
    for id in &due {
        let _ = fire(*id, "time").await;
    }
    due.len()
}

static REGISTER: Once = Once::new();

/// Subscribe the event hooks and start the time sweep. Called once from the
/// plugin's `on_ready`. Hook work is spawned, never run inline on the write.
pub fn register() {
    REGISTER.call_once(|| {
        umbral::signals::subscribe_async("post_save:taskflow_agent_message", |payload| {
            let created = payload["created"].as_bool().unwrap_or(false);
            let id = payload["instance"]["id"].as_i64();
            Box::pin(async move {
                if let (true, Some(id)) = (created, id) {
                    tokio::spawn(message_created(id));
                }
            })
        });
        // Task status: BOTH write paths (Manager::save and the REST PATCH).
        umbral::signals::subscribe_async("post_save:taskflow_task", |payload| {
            let id = payload["instance"]["id"].as_i64();
            Box::pin(async move {
                if let Some(id) = id {
                    tokio::spawn(task_maybe_unblocked(id));
                }
            })
        });
        umbral::signals::subscribe_async("bulk_post_save:taskflow_task", |payload| {
            let ids: Vec<i64> = payload["ids"].as_array().map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
            Box::pin(async move {
                for id in ids {
                    tokio::spawn(task_maybe_unblocked(id));
                }
            })
        });
        // A new session: deliver what was missed while the agent was away.
        umbral::signals::subscribe_async("post_save:taskflow_agent_session", |payload| {
            let created = payload["created"].as_bool().unwrap_or(false);
            let agent = payload["instance"]["agent"].as_i64().or_else(|| payload["instance"]["agent"]["id"].as_i64());
            Box::pin(async move {
                if let (true, Some(agent)) = (created, agent) {
                    tokio::spawn(async move {
                        let _ = deliver_missed(agent).await;
                    });
                }
            })
        });
        tokio::spawn(async {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(SWEEP_SECONDS));
            loop {
                tick.tick().await;
                sweep_due().await;
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn member(user: i64, project: i64) -> Result<Creator, ApiError> {
    if !taskflow_projects::scope::can_access_project(user, project).await {
        return Err(err(StatusCode::NOT_FOUND, "project"));
    }
    Ok(Creator::User { id: user, label: user_label(user).await })
}

fn require_write(agent: &AgentIdentity) -> Result<(), ApiError> {
    agent
        .require(crate::scopes::TASKS_WRITE)
        .map_err(crate::scopes::CapabilityError::into_status_json)
}

/// An agent may change a rule it created, or one that wakes it.
fn agent_owns(r: &TaskflowWakeRule, agent: i64) -> bool {
    r.agent.id() == agent || r.created_by_agent.as_ref().map(|a| a.id()) == Some(agent)
}

async fn set_status(mut r: TaskflowWakeRule, action: &str) -> Result<Value, ApiError> {
    let next = match (action, r.status) {
        ("pause", TaskflowWakeStatus::Armed) => TaskflowWakeStatus::Paused,
        ("resume", TaskflowWakeStatus::Paused) => TaskflowWakeStatus::Armed,
        ("cancel", TaskflowWakeStatus::Armed | TaskflowWakeStatus::Paused | TaskflowWakeStatus::Missed) => TaskflowWakeStatus::Cancelled,
        _ => return Err((StatusCode::CONFLICT, Json(json!({ "error": "invalid_transition", "status": r.status })))),
    };
    r.status = next;
    r.updated_at = Some(Utc::now());
    let r = TaskflowWakeRule::objects().save(r).await.map_err(internal)?;
    Ok(rule_json(&r))
}

pub async fn list_as_user(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Query(f): Query<ListFilter>) -> Reply {
    member(user, project).await?;
    Ok(Json(list(project, &f).await?).into_response())
}

pub async fn create_as_user(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Json(input): Json<CreateInput>) -> Reply {
    let creator = member(user, project).await?;
    Ok((StatusCode::CREATED, Json(create(project, creator, input).await?)).into_response())
}

/// `POST /api/taskflow/wakeups/{project}/{rule}/{action}` — pause, resume,
/// cancel, or deliver (a missed rule, now).
pub async fn act_as_user(RequireAuth(user): RequireAuth<i64>, Path((project, id, action)): Path<(i64, i64, String)>) -> Reply {
    member(user, project).await?;
    let r = load_rule(project, id).await?;
    if action == "deliver" {
        if r.status != TaskflowWakeStatus::Missed {
            return Err((StatusCode::CONFLICT, Json(json!({ "error": "not_missed", "status": r.status }))));
        }
        let r = deliver(r).await?;
        return Ok(Json(rule_json(&r)).into_response());
    }
    Ok(Json(set_status(r, &action).await?).into_response())
}

pub async fn list_as_agent(RequireAgent(agent): RequireAgent, Query(f): Query<ListFilter>) -> Reply {
    Ok(Json(list(agent.project_id, &f).await?).into_response())
}

pub async fn create_as_agent(RequireAgent(agent): RequireAgent, Json(input): Json<CreateInput>) -> Reply {
    require_write(&agent)?;
    let creator = Creator::Agent { id: agent.agent_id, label: agent.display_name.clone() };
    Ok((StatusCode::CREATED, Json(create(agent.project_id, creator, input).await?)).into_response())
}

/// `POST /api/taskflow/agents/wakeups/{rule}/{action}` — pause, resume or
/// cancel a rule the agent created or that wakes it. (No "deliver": that is a
/// person's call.)
pub async fn act_as_agent(RequireAgent(agent): RequireAgent, Path((id, action)): Path<(i64, String)>) -> Reply {
    require_write(&agent)?;
    let r = load_rule(agent.project_id, id).await?;
    if !agent_owns(&r, agent.agent_id) {
        return Err(err(StatusCode::FORBIDDEN, "not_your_rule"));
    }
    if action == "deliver" {
        return Err(err(StatusCode::FORBIDDEN, "deliver_is_for_people"));
    }
    Ok(Json(set_status(r, &action).await?).into_response())
}

/// Put a notice in front of an agent: its private "Wake-ups" DM, targeted at
/// it (the MCP pane path, behind the prompt gate). Used by usage alerts.
pub async fn notify_agent(agent_id: i64, body: String) -> Result<(), ApiError> {
    let agent = TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(agent_id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "agent"))?;
    let channel = pane_channel_for(&agent).await?;
    post_notice(agent.project.id(), channel, agent.id, flat(&body)).await
}
