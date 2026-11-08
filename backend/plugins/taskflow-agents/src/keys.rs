//! #1136: an agent's keys after it's linked: rotate, and revoke one.
//!
//! | Route | |
//! |---|---|
//! | `POST /api/taskflow/agents/{agent}/rotate-key` | revoke every active key and mint ONE new one in a single transaction; the raw key comes back once. The new key keeps the newest active key's scopes and denials |
//! | `POST /api/taskflow/agents/{agent}/credentials/{credential}/revoke` | stop one key without deleting the agent |
//!
//! Who: the same rule as driving the agent (#1127): an active owner or admin
//! of its project, its linked human (still an active member), or a superuser.
//! Anyone else in the project gets 403; outside it, 404. A revoked key is a 401
//! on its next request (`RequireAgent` only accepts active keys). Each change
//! writes one activity row and emits `post_save` for the credentials.

use chrono::Utc;
use serde_json::json;
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;
use uuid::Uuid;

use taskflow_projects::models::{TaskflowProjectMember, taskflow_project_member};
use taskflow_tasks::models::{TaskflowActorKind, TaskflowTaskActivity};

use crate::agent_auth::hash_key;
use crate::models::{
    TaskflowAgent, TaskflowAgentCredential, TaskflowCredentialStatus, taskflow_agent, taskflow_agent_credential,
};

/// Fresh key material: a non-secret unique prefix, the raw key (shown once),
/// and its sha256 (all that is stored). Shared with `link`.
pub fn new_key() -> (String, String, String) {
    let prefix12: String = Uuid::new_v4().simple().to_string().chars().take(12).collect();
    let secret = Uuid::new_v4().simple().to_string();
    let key_prefix = format!("tfk_{prefix12}");
    let raw_key = format!("tfk_{prefix12}_{secret}");
    let key_hash = hash_key(&raw_key);
    (key_prefix, raw_key, key_hash)
}

pub(crate) const ROTATION_BUSY: &str = "taskflow:rotation_busy";

type TxError = Box<dyn std::error::Error + Send + Sync>;

/// The agent's newest credential of ANY status: its policy is what a new key
/// inherits. Active-only would let the linked human revoke every key, rotate,
/// and come back with an owner's denials gone (#1136 review).
pub(crate) async fn newest_credential_on(tx: &mut umbral::db::Transaction, agent: i64) -> Result<Option<TaskflowAgentCredential>, TxError> {
    Ok(TaskflowAgentCredential::objects()
        .filter(taskflow_agent_credential::AGENT.eq(agent))
        .order_by(taskflow_agent_credential::ID.desc())
        .on_tx(tx)
        .first()
        .await?)
}

/// Revoke every active key of `agent`; returns how many.
pub(crate) async fn revoke_active_on(tx: &mut umbral::db::Transaction, agent: i64) -> Result<u64, TxError> {
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!("revoked"));
    v.insert("revoked_at".into(), json!(Utc::now()));
    Ok(TaskflowAgentCredential::objects()
        .filter(taskflow_agent_credential::AGENT.eq(agent) & taskflow_agent_credential::STATUS.eq("active"))
        .on_tx(tx)
        .update_values(v)
        .await? as u64)
}

fn refuse(status: StatusCode, code: &str, detail: &str) -> Response {
    (status, Json(json!({ "error": code, "detail": detail }))).into_response()
}

/// The agent, if the caller may manage its keys. `Err(response)` otherwise.
async fn managed_agent(user: i64, agent_id: i64) -> Result<TaskflowAgent, Response> {
    let internal = |_| refuse(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error");
    let agent = TaskflowAgent::objects()
        .filter(taskflow_agent::ID.eq(agent_id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| refuse(StatusCode::NOT_FOUND, "not_found", "No such agent."))?;
    // Outside the project: 404, so an agent's existence doesn't leak.
    let in_project = taskflow_projects::scope::can_access_project(user, agent.project.id()).await;
    if !in_project {
        return Err(refuse(StatusCode::NOT_FOUND, "not_found", "No such agent."));
    }
    let ok = crate::views::may_drive_agent(user, &agent).await.map_err(|s| refuse(s, "internal", "internal error"))?;
    if !ok {
        return Err(refuse(
            StatusCode::FORBIDDEN,
            "not_allowed_to_manage_keys",
            "Only project owners and admins, or the person who linked this agent, can change its keys.",
        ));
    }
    Ok(agent)
}

async fn actor_label(user: i64, project: i64) -> String {
    TaskflowProjectMember::objects()
        .filter(taskflow_project_member::PROJECT.eq(project) & taskflow_project_member::USER.eq(user))
        .first()
        .await
        .ok()
        .flatten()
        .map(|m| m.display_name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| format!("user {user}"))
}

async fn audit(agent: &TaskflowAgent, user: i64, action: &str, body: String, meta: serde_json::Value) {
    let row = TaskflowTaskActivity {
        id: 0,
        project: agent.project.clone(),
        task: None,
        actor_kind: TaskflowActorKind::User,
        actor_user: Some(ForeignKey::new(user)),
        actor_agent_id: None,
        actor_label: actor_label(user, agent.project.id()).await,
        action: action.to_string(),
        body_markdown: Some(body),
        metadata_json: Some(meta.to_string()),
        created_at: None,
    };
    if let Err(e) = TaskflowTaskActivity::objects().create(row).await {
        tracing::error!(agent = agent.id, error = %e, action, "key change applied but its audit row failed");
    }
}

fn credential_json(c: &TaskflowAgentCredential) -> serde_json::Value {
    json!({
        "id": c.id, "agent": c.agent.as_ref().map(|a| a.id()), "name": c.name, "key_prefix": c.key_prefix,
        "status": serde_json::to_value(c.status).unwrap_or_default(), "created_at": c.created_at, "revoked_at": c.revoked_at,
    })
}

/// `POST /api/taskflow/agents/{agent}/rotate-key`
pub async fn rotate_key(RequireAuth(user): RequireAuth<i64>, Path(agent_id): Path<i64>) -> Response {
    let agent = match managed_agent(user, agent_id).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let (key_prefix, raw_key, key_hash) = new_key();
    let default_name = format!("{} key", agent.display_name);
    let agent_id = agent.id;
    let project = agent.project.clone();
    let result = umbral::transaction(move |tx| {
        Box::pin(async move {
            // One rotation at a time per agent. Without this, two concurrent
            // rotations each revoke the keys they can see and each mint one,
            // leaving TWO active keys. The second finds the row locked and
            // backs off (Postgres; SQLite's single writer serializes anyway).
            let locked = TaskflowAgent::objects()
                .filter(taskflow_agent::ID.eq(agent_id))
                .for_update_skip_locked()
                .on_tx(tx)
                .first()
                .await?;
            if locked.is_none() {
                return Err::<(u64, TaskflowAgentCredential), Box<dyn std::error::Error + Send + Sync>>(ROTATION_BUSY.into());
            }
            let (scopes, denied, name) = match newest_credential_on(tx, agent_id).await? {
                Some(c) => (c.scopes, c.denied_scopes, c.name),
                None => (None, None, default_name),
            };
            let revoked = revoke_active_on(tx, agent_id).await?;
            let created = TaskflowAgentCredential::objects()
                .on_tx(tx)
                .create(TaskflowAgentCredential {
                    id: 0,
                    project,
                    agent: Some(ForeignKey::new(agent_id)),
                    issued_by: Some(ForeignKey::new(user)),
                    name,
                    key_prefix,
                    key_hash,
                    status: TaskflowCredentialStatus::Active,
                    scopes,
                    denied_scopes: denied,
                    expires_at: None,
                    revoked_at: None,
                    created_at: None,
                })
                .await?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>((revoked, created))
        })
    })
    .await;
    let (revoked, created) = match result {
        Ok(r) => r,
        Err(e) if e.to_string().contains(ROTATION_BUSY) => {
            return refuse(StatusCode::CONFLICT, "rotation_in_progress", "This agent's key is being rotated right now; try again in a moment.");
        }
        Err(e) => {
            tracing::error!(agent = agent.id, error = %e, "key rotation failed");
            return refuse(StatusCode::INTERNAL_SERVER_ERROR, "internal", "The key couldn't be rotated; nothing changed.");
        }
    };
    // Live: every credential of the agent (the revoked ones and the new one).
    if let Ok(rows) = TaskflowAgentCredential::objects().filter(taskflow_agent_credential::AGENT.eq(agent.id)).fetch().await {
        for c in &rows {
            crate::emit::emit_post_save(c).await;
        }
    }
    audit(
        &agent,
        user,
        "agent_key_rotated",
        format!("{}: new key {}…; {revoked} old key(s) stopped", agent.display_name, created.key_prefix),
        json!({ "agent_id": agent.id, "new_credential": created.id, "revoked": revoked }),
    )
    .await;
    (
        StatusCode::CREATED,
        Json(json!({
            "key": raw_key,
            "credential": credential_json(&created),
            "revoked": revoked,
            "detail": "Copy the key now: it is not shown again. The old key stops working immediately.",
        })),
    )
        .into_response()
}

/// `POST /api/taskflow/agents/{agent}/credentials/{credential}/revoke`
pub async fn revoke_key(RequireAuth(user): RequireAuth<i64>, Path((agent_id, credential)): Path<(i64, i64)>) -> Response {
    let agent = match managed_agent(user, agent_id).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!("revoked"));
    v.insert("revoked_at".into(), json!(Utc::now()));
    let n = TaskflowAgentCredential::objects()
        .filter(
            taskflow_agent_credential::ID.eq(credential)
                & taskflow_agent_credential::AGENT.eq(agent.id)
                & taskflow_agent_credential::STATUS.eq("active"),
        )
        .update_values(v)
        .await;
    let row = TaskflowAgentCredential::objects()
        .filter(taskflow_agent_credential::ID.eq(credential) & taskflow_agent_credential::AGENT.eq(agent.id))
        .first()
        .await;
    let (Ok(n), Ok(row)) = (n, row) else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error");
    };
    let Some(row) = row else {
        return refuse(StatusCode::NOT_FOUND, "not_found", "No such key on this agent.");
    };
    if n > 0 {
        crate::emit::emit_post_save(&row).await;
        audit(
            &agent,
            user,
            "agent_key_revoked",
            format!("{}: key {}… stopped", agent.display_name, row.key_prefix),
            json!({ "agent_id": agent.id, "credential": row.id }),
        )
        .await;
    }
    // Already revoked: idempotent, the same answer.
    Json(json!({ "credential": credential_json(&row) })).into_response()
}
