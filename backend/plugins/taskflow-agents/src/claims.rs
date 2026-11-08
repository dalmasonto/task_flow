//! #1095: claiming a message — "I'm answering this".
//!
//! A message aimed at several agents used to get two answers seconds apart
//! (#886 §2.3). An agent (or person) now claims it first; everyone else sees
//! who holds it and stands down.
//!
//! **Active is derived, never stored:** a claim is active while it is not
//! released, not expired, and its claimer has not yet replied to the message.
//! Replying clears it with no write. The message row is never touched (an
//! update re-types it into every agent pane as an edit).
//!
//! **One open claim per message is enforced by the database**, not by a
//! check-then-insert: a partial unique index on `(message) WHERE released_at IS
//! NULL` (see [`install_claim_guard`]). Claiming first RELEASES any stale open
//! claim (expired, or its claimer replied), then inserts; a racing second
//! claimer hits the index and gets `409 already_claimed`. `SELECT … FOR UPDATE`
//! could not do this: with no claim row yet there is nothing to lock.

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use umbral::db::DbPool;
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, StatusCode};
use umbral_auth::RequireAuth;

use crate::agent_auth::RequireAgent;
use crate::answers::{ApiError, Reply, bad, err, internal, message_for_agent, message_for_user, user_label};
use crate::models::{
    TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelMemberKind, TaskflowMessageClaim,
    taskflow_agent_message, taskflow_message_claim,
};

pub const DEFAULT_MINUTES: i64 = 10;
pub const MAX_MINUTES: i64 = 30;
const MAX_MESSAGES_PER_READ: usize = 100;

const ONE_OPEN_CLAIM_INDEX: &str = "taskflow_message_claim_one_open";
const ONE_OPEN_CLAIM_INDEX_SQL: &str = "CREATE UNIQUE INDEX IF NOT EXISTS taskflow_message_claim_one_open \
     ON taskflow_message_claim (message) WHERE released_at IS NULL";

/// Install the durable "one open claim per message" invariant. The ORM cannot
/// express a partial unique index; both backends accept this syntax. Called
/// from the plugin's `on_ready`; a missing table (before `migrate`) defers it.
pub async fn install_claim_guard(pool: &DbPool) -> Result<(), sqlx::Error> {
    let result = match pool {
        DbPool::Sqlite(pool) => sqlx::query(ONE_OPEN_CLAIM_INDEX_SQL).execute(pool).await.map(|_| ()),
        DbPool::Postgres(pool) => sqlx::query(ONE_OPEN_CLAIM_INDEX_SQL).execute(pool).await.map(|_| ()),
    };
    match result {
        Err(sqlx::Error::Database(db))
            // SQLite reports a CREATE INDEX on a missing table as
            // "no such table: main.<table>", so match both halves.
            if (db.message().contains("no such table") && db.message().contains("taskflow_message_claim"))
                || db.message().contains("relation \"taskflow_message_claim\" does not exist") =>
        {
            tracing::debug!("message claim guard deferred until schema exists");
            Ok(())
        }
        Err(e) => Err(e),
        Ok(()) => {
            tracing::info!(index = ONE_OPEN_CLAIM_INDEX, "message claim guard installed");
            Ok(())
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Claimer {
    User { id: i64, label: String },
    Agent { id: i64, label: String },
}

impl Claimer {
    fn label(&self) -> &str {
        match self {
            Claimer::User { label, .. } | Claimer::Agent { label, .. } => label,
        }
    }
    fn holds(&self, c: &TaskflowMessageClaim) -> bool {
        match self {
            Claimer::User { id, .. } => c.claimer_user.as_ref().map(|u| u.id()) == Some(*id),
            Claimer::Agent { id, .. } => c.claimer_agent.as_ref().map(|a| a.id()) == Some(*id),
        }
    }
}

/// Has the claimer replied to the message since claiming it?
async fn claimer_replied(c: &TaskflowMessageClaim) -> Result<bool, ApiError> {
    let replies = TaskflowAgentMessage::objects()
        .filter(
            taskflow_agent_message::CHANNEL.eq(c.channel.id())
                & taskflow_agent_message::REPLY_TO.eq(c.message.id()),
        )
        .fetch()
        .await
        .map_err(internal)?;
    Ok(replies.iter().any(|m| {
        let after = m.created_at.is_some_and(|t| t >= c.claimed_at);
        let same = match c.claimer_kind {
            TaskflowChannelMemberKind::Agent => {
                m.sender_kind == TaskflowChannelMemberKind::Agent
                    && m.sender_agent.as_ref().map(|a| a.id()) == c.claimer_agent.as_ref().map(|a| a.id())
            }
            TaskflowChannelMemberKind::User => {
                m.sender_kind == TaskflowChannelMemberKind::User
                    && m.sender_user.as_ref().map(|u| u.id()) == c.claimer_user.as_ref().map(|u| u.id())
            }
        };
        after && same
    }))
}

async fn is_active(c: &TaskflowMessageClaim, now: DateTime<Utc>) -> Result<bool, ApiError> {
    if c.released_at.is_some() || c.expires_at <= now {
        return Ok(false);
    }
    Ok(!claimer_replied(c).await?)
}

async fn open_claims(message: i64) -> Result<Vec<TaskflowMessageClaim>, ApiError> {
    TaskflowMessageClaim::objects()
        .filter(taskflow_message_claim::MESSAGE.eq(message) & taskflow_message_claim::RELEASED_AT.is_null())
        .fetch()
        .await
        .map_err(internal)
}

/// The message's ACTIVE claim, if any.
async fn active_claim(message: i64, now: DateTime<Utc>) -> Result<Option<TaskflowMessageClaim>, ApiError> {
    for c in open_claims(message).await? {
        if is_active(&c, now).await? {
            return Ok(Some(c));
        }
    }
    Ok(None)
}

fn claim_json(c: &TaskflowMessageClaim) -> Value {
    json!({
        "id": c.id,
        "message": c.message.id(),
        "claimer_kind": c.claimer_kind,
        "claimer_user": c.claimer_user.as_ref().map(|u| u.id()),
        "claimer_agent": c.claimer_agent.as_ref().map(|a| a.id()),
        "claimer_label": c.claimer_label,
        "claimed_at": c.claimed_at,
        "expires_at": c.expires_at,
    })
}

fn conflict(holder: &TaskflowMessageClaim) -> ApiError {
    (StatusCode::CONFLICT, Json(json!({ "error": "already_claimed", "claim": claim_json(holder) })))
}

#[derive(Debug, Default, Deserialize)]
pub struct ClaimInput {
    /// How long the claim lasts, 1–30 minutes (default 10).
    #[serde(default)]
    pub minutes: Option<i64>,
}

async fn claim(message: TaskflowAgentMessage, channel: TaskflowAgentChannel, who: Claimer, input: ClaimInput) -> Reply {
    let minutes = input.minutes.unwrap_or(DEFAULT_MINUTES);
    if !(1..=MAX_MINUTES).contains(&minutes) {
        return Err(bad("minutes", &format!("1 to {MAX_MINUTES}")));
    }
    let now = Utc::now();
    let expires = now + Duration::minutes(minutes);

    // 1. Release stale open claims (expired, or the claimer already replied),
    //    so the unique index only ever sees live ones. Re-saved, so realtime
    //    carries the release.
    for mut c in open_claims(message.id).await? {
        if is_active(&c, now).await? {
            if who.holds(&c) {
                // Claiming again extends your own claim.
                c.expires_at = expires;
                let c = TaskflowMessageClaim::objects().save(c).await.map_err(internal)?;
                return Ok(Json(claim_json(&c)).into_response());
            }
            return Err(conflict(&c));
        }
        c.released_at = Some(now);
        TaskflowMessageClaim::objects().save(c).await.map_err(internal)?;
    }

    // 2. Insert. The partial unique index is the arbiter: a racing claimer that
    //    got here first makes this insert fail, and we answer with its claim.
    let (kind, user, agent) = match &who {
        Claimer::User { id, .. } => (TaskflowChannelMemberKind::User, Some(ForeignKey::new(*id)), None),
        Claimer::Agent { id, .. } => (TaskflowChannelMemberKind::Agent, None, Some(ForeignKey::new(*id))),
    };
    let created = TaskflowMessageClaim::objects()
        .create(TaskflowMessageClaim {
            id: 0,
            project: message.project.clone(),
            channel: ForeignKey::new(channel.id),
            message: ForeignKey::new(message.id),
            claimer_kind: kind,
            claimer_user: user,
            claimer_agent: agent,
            claimer_label: who.label().to_string(),
            claimed_at: now,
            expires_at: expires,
            released_at: None,
        })
        .await;
    match created {
        Ok(c) => Ok((StatusCode::CREATED, Json(claim_json(&c))).into_response()),
        Err(_) => match open_claims(message.id).await?.into_iter().next() {
            Some(holder) => Err(conflict(&holder)),
            None => Err(err(StatusCode::INTERNAL_SERVER_ERROR, "internal")),
        },
    }
}

async fn release(message: TaskflowAgentMessage, who: Claimer) -> Reply {
    let now = Utc::now();
    let mine = open_claims(message.id).await?.into_iter().find(|c| who.holds(c));
    let Some(mut c) = mine else {
        return Err(err(StatusCode::NOT_FOUND, "no_claim"));
    };
    c.released_at = Some(now);
    let c = TaskflowMessageClaim::objects().save(c).await.map_err(internal)?;
    Ok(Json(json!({ "released": true, "claim": claim_json(&c) })).into_response())
}

async fn read_one(message: &TaskflowAgentMessage) -> Reply {
    let active = active_claim(message.id, Utc::now()).await?;
    Ok(Json(json!({ "message": message.id, "claim": active.as_ref().map(claim_json) })).into_response())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/taskflow/agents/messages/{message}/claim`
pub async fn claim_as_agent(
    RequireAgent(agent): RequireAgent,
    Path(id): Path<i64>,
    body: Option<Json<ClaimInput>>,
) -> Reply {
    agent
        .require(crate::scopes::CHAT_SEND)
        .map_err(crate::scopes::CapabilityError::into_status_json)?;
    let (message, channel) = message_for_agent(&agent, id).await?;
    let who = Claimer::Agent { id: agent.agent_id, label: agent.display_name.clone() };
    claim(message, channel, who, body.map(|Json(b)| b).unwrap_or_default()).await
}

/// `DELETE /api/taskflow/agents/messages/{message}/claim`
pub async fn release_as_agent(RequireAgent(agent): RequireAgent, Path(id): Path<i64>) -> Reply {
    let (message, _) = message_for_agent(&agent, id).await?;
    release(message, Claimer::Agent { id: agent.agent_id, label: agent.display_name.clone() }).await
}

/// `GET /api/taskflow/agents/messages/{message}/claim`
pub async fn get_as_agent(RequireAgent(agent): RequireAgent, Path(id): Path<i64>) -> Reply {
    let (message, _) = message_for_agent(&agent, id).await?;
    read_one(&message).await
}

/// `POST /api/taskflow/messages/{message}/claim`
pub async fn claim_as_user(
    RequireAuth(user): RequireAuth<i64>,
    Path(id): Path<i64>,
    body: Option<Json<ClaimInput>>,
) -> Reply {
    let (message, channel) = message_for_user(user, id).await?;
    let who = Claimer::User { id: user, label: user_label(user).await };
    claim(message, channel, who, body.map(|Json(b)| b).unwrap_or_default()).await
}

/// `DELETE /api/taskflow/messages/{message}/claim`
pub async fn release_as_user(RequireAuth(user): RequireAuth<i64>, Path(id): Path<i64>) -> Reply {
    let (message, _) = message_for_user(user, id).await?;
    release(message, Claimer::User { id: user, label: String::new() }).await
}

/// `GET /api/taskflow/messages/{message}/claim`
pub async fn get_as_user(RequireAuth(user): RequireAuth<i64>, Path(id): Path<i64>) -> Reply {
    let (message, _) = message_for_user(user, id).await?;
    read_one(&message).await
}

#[derive(Debug, Deserialize)]
pub struct ChannelClaimsQuery {
    pub messages: String,
}

/// `GET /api/taskflow/channels/{channel}/claims?messages=1,2,3` — active claims
/// for one chat page. Ids outside the channel are ignored.
pub async fn channel_claims(
    RequireAuth(user): RequireAuth<i64>,
    Path(channel): Path<i64>,
    Query(query): Query<ChannelClaimsQuery>,
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
    let now = Utc::now();
    let mut results = Vec::new();
    if !ids.is_empty() {
        let open = TaskflowMessageClaim::objects()
            .filter(
                taskflow_message_claim::MESSAGE.in_(&ids)
                    & taskflow_message_claim::CHANNEL.eq(channel.id)
                    & taskflow_message_claim::RELEASED_AT.is_null(),
            )
            .fetch()
            .await
            .map_err(internal)?;
        for c in &open {
            if is_active(c, now).await? {
                results.push(claim_json(c));
            }
        }
    }
    Ok(Json(json!({ "results": results })).into_response())
}
