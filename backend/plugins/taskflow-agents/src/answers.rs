//! #1099: answering a message's questions in place.
//!
//! A message's question set (#644, `questions.rs`) used to be answered by
//! sending a SEPARATE prose reply, so nothing on the question itself said which
//! questions were answered. Now each answer is a row in
//! [`TaskflowMessageAnswer`] — the chat renders answered/open state inline —
//! and every submission posts ONE auto-reply so the answer still reaches the
//! asking agent's pane through the ordinary chat path (no MCP change).
//!
//! **The question message is never written.** Updating a message row makes
//! every agent's MCP re-type it as an EDIT (#107). Answers live in their own
//! append-only table; changing an answer appends a newer row.
//!
//! Who may answer (lead review, #MSG5660):
//! - the caller must be able to SEE the channel;
//! - the message's own sender may not answer its own questions;
//! - a human may answer unless the message targets specific users and they are
//!   not one of them;
//! - an agent may answer only when the message explicitly targets it.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::RequireAuth;

use crate::agent_auth::{AgentIdentity, RequireAgent};
use crate::models::{
    MessageTarget, TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelMemberKind,
    TaskflowMessageAnswer, TaskflowMessagePriority, taskflow_agent_channel, taskflow_agent_message,
    taskflow_message_answer,
};
use crate::questions::{self, Question, QuestionSet};

type ApiError = (StatusCode, Json<Value>);
type Reply = Result<Response, ApiError>;

fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

fn bad(field: &str, reason: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid", "field": field, "reason": reason })))
}

fn internal<E>(_: E) -> ApiError {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

fn from_status(status: StatusCode) -> ApiError {
    let code = if status == StatusCode::NOT_FOUND { "not_found" } else { "error" };
    err(status, code)
}

/// The most messages one by-channel read may ask about — one chat page.
pub const MAX_MESSAGES_PER_READ: usize = 100;

#[derive(Debug, Clone)]
enum Answerer {
    User { id: i64, label: String },
    Agent { id: i64, label: String },
}

impl Answerer {
    fn label(&self) -> &str {
        match self {
            Answerer::User { label, .. } | Answerer::Agent { label, .. } => label,
        }
    }
}

async fn load_message(id: i64) -> Result<TaskflowAgentMessage, ApiError> {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))
}

async fn load_channel(id: i64) -> Result<TaskflowAgentChannel, ApiError> {
    TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))
}

/// The message, if the AGENT may see its channel. Invisible = 404, like a
/// message that does not exist.
async fn message_for_agent(agent: &AgentIdentity, id: i64) -> Result<(TaskflowAgentMessage, TaskflowAgentChannel), ApiError> {
    let message = load_message(id).await?;
    let channel = load_channel(message.channel.id()).await?;
    let visible = crate::views::agent_can_see_channel(&channel, agent.agent_id, agent.project_id)
        .await
        .map_err(from_status)?;
    if !visible {
        return Err(err(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok((message, channel))
}

async fn message_for_user(user: i64, id: i64) -> Result<(TaskflowAgentMessage, TaskflowAgentChannel), ApiError> {
    let message = load_message(id).await?;
    let channel = crate::views::ensure_channel_visible(user, message.channel.id())
        .await
        .map_err(|_| err(StatusCode::NOT_FOUND, "not_found"))?;
    Ok((message, channel))
}

fn question_set(message: &TaskflowAgentMessage) -> Result<QuestionSet, ApiError> {
    message
        .questions
        .as_deref()
        .and_then(questions::parse_stored)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no_questions"))
}

fn targets_of(message: &TaskflowAgentMessage) -> Vec<MessageTarget> {
    let mut targets: Vec<MessageTarget> = message
        .targets
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    // Rows written before `targets` carry only the single `target_agent`.
    if targets.is_empty() {
        if let Some(agent) = message.target_agent.as_ref() {
            targets.push(MessageTarget { kind: "agent".into(), id: agent.id() });
        }
    }
    targets
}

/// The answering rules (module doc). `Err` is a 403 naming why.
fn may_answer(message: &TaskflowAgentMessage, who: &Answerer) -> Result<(), ApiError> {
    let targets = targets_of(message);
    match who {
        Answerer::User { id, .. } => {
            if message.sender_kind == TaskflowChannelMemberKind::User
                && message.sender_user.as_ref().map(|u| u.id()) == Some(*id)
            {
                return Err(err(StatusCode::FORBIDDEN, "own_question"));
            }
            let user_targets: Vec<i64> = targets.iter().filter(|t| t.kind == "user").map(|t| t.id).collect();
            if !user_targets.is_empty() && !user_targets.contains(id) {
                return Err(err(StatusCode::FORBIDDEN, "not_a_target"));
            }
        }
        Answerer::Agent { id, .. } => {
            if message.sender_kind == TaskflowChannelMemberKind::Agent
                && message.sender_agent.as_ref().map(|a| a.id()) == Some(*id)
            {
                return Err(err(StatusCode::FORBIDDEN, "own_question"));
            }
            if !targets.iter().any(|t| t.kind == "agent" && t.id == *id) {
                return Err(err(StatusCode::FORBIDDEN, "not_a_target"));
            }
        }
    }
    Ok(())
}

async fn rows_for(messages: &[i64]) -> Result<Vec<TaskflowMessageAnswer>, ApiError> {
    if messages.is_empty() {
        return Ok(Vec::new());
    }
    TaskflowMessageAnswer::objects()
        .filter(taskflow_message_answer::MESSAGE.in_(messages))
        .order_by(taskflow_message_answer::ID.asc())
        .fetch()
        .await
        .map_err(internal)
}

fn answer_json(row: &TaskflowMessageAnswer) -> Value {
    json!({
        "id": row.id,
        "key": row.key,
        "value": serde_json::from_str::<Value>(&row.value_json).unwrap_or(Value::Null),
        "answered_by_kind": row.answered_by_kind,
        "answered_by_user": row.answered_by_user.as_ref().map(|u| u.id()),
        "answered_by_agent": row.answered_by_agent.as_ref().map(|a| a.id()),
        "answered_by_label": row.answered_by_label,
        "reply_message_id": row.reply_message_id,
        "created_at": row.created_at,
    })
}

/// One message's answer state: the current answer per key (newest row wins),
/// the full history, and which keys are still open.
fn state_json(message: &TaskflowAgentMessage, set: Option<&QuestionSet>, rows: &[TaskflowMessageAnswer]) -> Value {
    let mine: Vec<&TaskflowMessageAnswer> = rows.iter().filter(|r| r.message.id() == message.id).collect();
    let mut current: BTreeMap<String, Value> = BTreeMap::new();
    for row in &mine {
        current.insert(row.key.clone(), answer_json(row)); // ascending id: last write wins
    }
    let open: Vec<&str> = set
        .map(|s| s.questions.iter().map(|q| q.key.as_str()).filter(|k| !current.contains_key(*k)).collect())
        .unwrap_or_default();
    json!({
        "message": message.id,
        "answers": current,
        "history": mine.iter().map(|r| answer_json(r)).collect::<Vec<_>>(),
        "open": open,
        "open_count": open.len(),
    })
}

#[derive(Debug, Deserialize)]
pub struct AnswerInput {
    /// `{ key: value }` for one or more questions of the set.
    pub answers: Map<String, Value>,
}

/// Validate, store and announce one submission.
async fn submit(
    message: TaskflowAgentMessage,
    channel: TaskflowAgentChannel,
    who: Answerer,
    input: AnswerInput,
) -> Result<Value, ApiError> {
    let set = question_set(&message)?;
    may_answer(&message, &who)?;
    if input.answers.is_empty() {
        return Err(bad("answers", "answer at least one question"));
    }

    // Validate everything before writing anything: a submission lands whole.
    let mut checked: Vec<(&Question, Value)> = Vec::with_capacity(input.answers.len());
    for (key, value) in &input.answers {
        let question = set
            .questions
            .iter()
            .find(|q| &q.key == key)
            .ok_or_else(|| bad(&format!("answers.{key}"), "no question with that key"))?;
        let canonical = questions::check_answer(question, value).map_err(|reason| bad(&format!("answers.{key}"), &reason))?;
        checked.push((question, canonical));
    }
    // Keep the set's own order in the reply, not the client's map order.
    checked.sort_by_key(|(q, _)| set.questions.iter().position(|x| x.key == q.key).unwrap_or(usize::MAX));

    // One auto-reply per submission, from the answerer, quoting the question
    // and targeted at whoever asked — the asking agent gets it in its pane.
    let mut body = format!("Answers to #MSG{}:", message.id);
    for (question, value) in &checked {
        body.push_str(&format!(
            "\n- {} ({}): {}",
            questions::one_line(&question.label),
            question.key,
            questions::display_answer(question, value)
        ));
    }
    let asker_target = match message.sender_kind {
        TaskflowChannelMemberKind::Agent => message.sender_agent.as_ref().map(|a| json!([{ "kind": "agent", "id": a.id() }])),
        TaskflowChannelMemberKind::User => message.sender_user.as_ref().map(|u| json!([{ "kind": "user", "id": u.id() }])),
    };
    let (sender_kind, sender_user, sender_agent) = match &who {
        Answerer::User { id, .. } => (TaskflowChannelMemberKind::User, Some(ForeignKey::new(*id)), None),
        Answerer::Agent { id, .. } => (TaskflowChannelMemberKind::Agent, None, Some(ForeignKey::new(*id))),
    };
    let reply = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: message.project.clone(),
            channel: ForeignKey::new(channel.id),
            task: message.task.clone(),
            sender_kind,
            sender_user,
            sender_agent,
            target_agent: message.sender_agent.clone().filter(|_| message.sender_kind == TaskflowChannelMemberKind::Agent),
            targets: asker_target.map(|t| t.to_string()),
            sender_label: who.label().to_string(),
            body_markdown: body,
            priority: TaskflowMessagePriority::Normal,
            is_design: channel.is_design,
            client_nonce: None,
            edited_at: None,
            reply_to: Some(message.id),
            questions: None,
            created_at: None,
        })
        .await
        .map_err(internal)?;

    for (question, value) in &checked {
        let (kind, user, agent) = match &who {
            Answerer::User { id, .. } => (TaskflowChannelMemberKind::User, Some(ForeignKey::new(*id)), None),
            Answerer::Agent { id, .. } => (TaskflowChannelMemberKind::Agent, None, Some(ForeignKey::new(*id))),
        };
        TaskflowMessageAnswer::objects()
            .create(TaskflowMessageAnswer {
                id: 0,
                project: message.project.clone(),
                channel: ForeignKey::new(channel.id),
                message: ForeignKey::new(message.id),
                key: question.key.clone(),
                value_json: value.to_string(),
                answered_by_kind: kind,
                answered_by_user: user,
                answered_by_agent: agent,
                answered_by_label: who.label().to_string(),
                reply_message_id: Some(reply.id),
                created_at: None,
            })
            .await
            .map_err(internal)?;
    }

    let rows = rows_for(&[message.id]).await?;
    let mut state = state_json(&message, Some(&set), &rows);
    state["reply_message_id"] = json!(reply.id);
    Ok(state)
}

async fn user_label(user_id: i64) -> String {
    use umbral_auth::auth_user;
    umbral_auth::AuthUser::objects()
        .filter(auth_user::ID.eq(user_id))
        .first()
        .await
        .ok()
        .flatten()
        .map(|u| if u.username.trim().is_empty() { u.email } else { u.username })
        .unwrap_or_else(|| format!("user {user_id}"))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/taskflow/messages/{message}/answers` — a human answers.
pub async fn answer(
    RequireAuth(user): RequireAuth<i64>,
    Path(id): Path<i64>,
    Json(input): Json<AnswerInput>,
) -> Reply {
    let (message, channel) = message_for_user(user, id).await?;
    let who = Answerer::User { id: user, label: user_label(user).await };
    Ok((StatusCode::CREATED, Json(submit(message, channel, who, input).await?)).into_response())
}

/// `POST /api/taskflow/agents/messages/{message}/answers` — an agent answers a
/// question that explicitly targets it.
pub async fn answer_as_agent(
    RequireAgent(agent): RequireAgent,
    Path(id): Path<i64>,
    Json(input): Json<AnswerInput>,
) -> Reply {
    agent
        .require(crate::scopes::CHAT_SEND)
        .map_err(crate::scopes::CapabilityError::into_status_json)?;
    let (message, channel) = message_for_agent(&agent, id).await?;
    let who = Answerer::Agent { id: agent.agent_id, label: agent.display_name.clone() };
    Ok((StatusCode::CREATED, Json(submit(message, channel, who, input).await?)).into_response())
}

/// `GET /api/taskflow/messages/{message}/answers`
pub async fn get_answers(RequireAuth(user): RequireAuth<i64>, Path(id): Path<i64>) -> Reply {
    let (message, _) = message_for_user(user, id).await?;
    let set = message.questions.as_deref().and_then(questions::parse_stored);
    let rows = rows_for(&[message.id]).await?;
    Ok(Json(state_json(&message, set.as_ref(), &rows)).into_response())
}

/// `GET /api/taskflow/agents/messages/{message}/answers`
pub async fn get_answers_as_agent(RequireAgent(agent): RequireAgent, Path(id): Path<i64>) -> Reply {
    let (message, _) = message_for_agent(&agent, id).await?;
    let set = message.questions.as_deref().and_then(questions::parse_stored);
    let rows = rows_for(&[message.id]).await?;
    Ok(Json(state_json(&message, set.as_ref(), &rows)).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ChannelAnswersQuery {
    /// Comma-separated message ids: the chat page on screen. Ids outside the
    /// channel are ignored, so the read can never reach another conversation.
    pub messages: String,
}

/// `GET /api/taskflow/channels/{channel}/answers?messages=1,2,3` — answer state
/// for one page of messages, paged WITH the message list (lead review
/// #MSG5667) so a long channel never loads its whole answer history.
pub async fn channel_answers(
    RequireAuth(user): RequireAuth<i64>,
    Path(channel): Path<i64>,
    Query(query): Query<ChannelAnswersQuery>,
) -> Reply {
    let channel = crate::views::ensure_channel_visible(user, channel)
        .await
        .map_err(|_| err(StatusCode::NOT_FOUND, "not_found"))?;
    let mut ids: Vec<i64> = Vec::new();
    for part in query.messages.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let id: i64 = part.parse().map_err(|_| bad("messages", "comma-separated message ids"))?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() > MAX_MESSAGES_PER_READ {
        return Err(bad("messages", &format!("at most {MAX_MESSAGES_PER_READ} ids per read")));
    }
    let messages = if ids.is_empty() {
        Vec::new()
    } else {
        TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::ID.in_(&ids) & taskflow_agent_message::CHANNEL.eq(channel.id))
            .fetch()
            .await
            .map_err(internal)?
    };
    let with_questions: Vec<&TaskflowAgentMessage> = messages.iter().filter(|m| m.questions.is_some()).collect();
    let rows = rows_for(&with_questions.iter().map(|m| m.id).collect::<Vec<_>>()).await?;
    let results: Vec<Value> = with_questions
        .iter()
        .map(|m| {
            let set = m.questions.as_deref().and_then(questions::parse_stored);
            state_json(m, set.as_ref(), &rows)
        })
        .collect();
    Ok(Json(json!({ "results": results })).into_response())
}
