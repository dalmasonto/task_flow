//! #1136: change a project member's role, or remove them.
//!
//! | Route | Who |
//! |---|---|
//! | `PATCH /api/taskflow/projects/{project}/members/{user}` `{role}` | an active owner or admin. The new role can't rank above the caller's, an admin can't change an owner, and only an owner makes an owner |
//! | `DELETE /api/taskflow/projects/{project}/members/{user}` | an owner or admin (an admin can't remove an owner), or the member themselves (leaving) |
//!
//! The last active owner can be neither demoted nor removed (409 `last_owner`),
//! checked before the write and re-checked after it, so two owners demoting
//! each other at once can't leave the project with none. Removal sets the
//! membership `left`; the read scope only honours `active`, so access ends at
//! once. Not a member at all: 404, so a project's existence doesn't leak.
//!
//! **Removal stops the keys of agents the member linked** (`linked_by` = them):
//! the raw keys sit in their `.taskflow.json`, so leaving must not leave them
//! working. The agents and their history stay; an owner or admin can rotate a
//! key to bring one back. The response names them:
//! `{revoked_agent_keys, agents: [{id, display_name}]}`. Role changes and
//! removals each write one activity row (`member_role_changed`,
//! `member_removed`).

use serde::Deserialize;
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::RequireAuth;

use chrono::Utc;
use umbral::orm::ForeignKey;

use taskflow_projects::models::{TaskflowProjectMember, TaskflowProjectRole, taskflow_project_member};
use taskflow_tasks::models::{TaskflowActorKind, TaskflowTaskActivity};

use crate::models::{TaskflowAgent, TaskflowAgentCredential, taskflow_agent, taskflow_agent_credential};

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "project member route failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

pub(crate) fn rank(role: TaskflowProjectRole) -> u8 {
    match role {
        TaskflowProjectRole::Owner => 4,
        TaskflowProjectRole::Admin => 3,
        TaskflowProjectRole::Developer => 2,
        TaskflowProjectRole::Reviewer => 1,
        TaskflowProjectRole::Viewer => 0,
    }
}

fn role_str(role: TaskflowProjectRole) -> String {
    serde_json::to_value(role).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
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

async fn active_owners(project: i64) -> Result<usize, ApiError> {
    Ok(TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project)
                & taskflow_project_member::STATUS.eq("active")
                & taskflow_project_member::ROLE.eq("owner"),
        )
        .fetch()
        .await
        .map_err(internal)?
        .len())
}

async fn emit_member(id: i64) {
    if let Ok(Some(row)) = TaskflowProjectMember::objects().filter(taskflow_project_member::ID.eq(id)).first().await {
        crate::emit::emit_post_save(&row).await;
    }
}

fn label(m: &TaskflowProjectMember) -> String {
    if m.display_name.trim().is_empty() { format!("user {}", m.user.as_ref().map(|u| u.id()).unwrap_or_default()) } else { m.display_name.clone() }
}

async fn audit(project: i64, actor: &TaskflowProjectMember, action: &str, body: String, meta: Value) {
    let row = TaskflowTaskActivity {
        id: 0,
        project: ForeignKey::new(project),
        task: None,
        actor_kind: TaskflowActorKind::User,
        actor_user: actor.user.clone(),
        actor_agent_id: None,
        actor_label: label(actor),
        action: action.to_string(),
        body_markdown: Some(body),
        metadata_json: Some(meta.to_string()),
        created_at: None,
    };
    if let Err(e) = TaskflowTaskActivity::objects().create(row).await {
        tracing::error!(project, error = %e, action, "member change applied but its activity row failed");
    }
}

/// Stop every active key of the agents `user` linked in `project`. Returns the
/// agents whose keys were stopped.
async fn revoke_linked_keys(project: i64, user: i64) -> Result<(u64, Vec<Value>), ApiError> {
    let agents = TaskflowAgent::objects()
        .filter(taskflow_agent::PROJECT.eq(project) & taskflow_agent::LINKED_BY.eq(user))
        .fetch()
        .await
        .map_err(internal)?;
    let mut total = 0u64;
    let mut named = Vec::new();
    for a in &agents {
        let mut v = serde_json::Map::new();
        v.insert("status".into(), json!("revoked"));
        v.insert("revoked_at".into(), json!(Utc::now()));
        let n = TaskflowAgentCredential::objects()
            .filter(taskflow_agent_credential::AGENT.eq(a.id) & taskflow_agent_credential::STATUS.eq("active"))
            .update_values(v)
            .await
            .map_err(internal)? as u64;
        if n > 0 {
            total += n;
            named.push(json!({ "id": a.id, "display_name": a.display_name }));
            if let Ok(rows) = TaskflowAgentCredential::objects().filter(taskflow_agent_credential::AGENT.eq(a.id)).fetch().await {
                for c in &rows {
                    crate::emit::emit_post_save(c).await;
                }
            }
        }
    }
    Ok((total, named))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleInput {
    pub role: TaskflowProjectRole,
}

/// `PATCH /api/taskflow/projects/{project}/members/{user}`
pub async fn set_role(
    RequireAuth(caller): RequireAuth<i64>,
    Path((project, target)): Path<(i64, i64)>,
    Json(input): Json<RoleInput>,
) -> Result<Response, ApiError> {
    let me = active_member(project, caller).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "No such project."))?;
    if !matches!(me.role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin) {
        return Err(err(StatusCode::FORBIDDEN, "owner_or_admin_only", "Only owners and admins can change roles."));
    }
    let them = active_member(project, target).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "not_a_member", "That person isn't an active member."))?;
    let owner_involved = them.role == TaskflowProjectRole::Owner || input.role == TaskflowProjectRole::Owner;
    if owner_involved && me.role != TaskflowProjectRole::Owner {
        return Err(err(StatusCode::FORBIDDEN, "owner_only", "Only an owner can make, or change, an owner."));
    }
    // With today's roles `owner_only` above already covers this (only an
    // admin could outrank itself, by giving `owner`); it holds the line for
    // any role added between the current ones.
    if rank(input.role) > rank(me.role) {
        return Err(err(StatusCode::FORBIDDEN, "above_your_role", "You can't give a role above your own."));
    }
    if them.role == input.role {
        return Ok(Json(json!({ "user": target, "role": role_str(input.role) })).into_response());
    }
    if them.role == TaskflowProjectRole::Owner && active_owners(project).await? <= 1 {
        return Err(err(StatusCode::CONFLICT, "last_owner", "A project needs an owner: make someone else owner first."));
    }
    // Guarded on the role we checked: a change in between is a 409.
    let mut v = serde_json::Map::new();
    v.insert("role".into(), json!(role_str(input.role)));
    let n = TaskflowProjectMember::objects()
        .filter(taskflow_project_member::ID.eq(them.id) & taskflow_project_member::ROLE.eq(role_str(them.role)))
        .update_values(v)
        .await
        .map_err(internal)?;
    if n == 0 {
        return Err(err(StatusCode::CONFLICT, "changed", "Their role changed meanwhile; reload."));
    }
    if them.role == TaskflowProjectRole::Owner && active_owners(project).await? == 0 {
        let mut back = serde_json::Map::new();
        back.insert("role".into(), json!("owner"));
        TaskflowProjectMember::objects()
            .filter(taskflow_project_member::ID.eq(them.id))
            .update_values(back)
            .await
            .map_err(internal)?;
        return Err(err(StatusCode::CONFLICT, "last_owner", "A project needs an owner: make someone else owner first."));
    }
    emit_member(them.id).await;
    audit(
        project,
        &me,
        "member_role_changed",
        format!("{}: {} → {}", label(&them), role_str(them.role), role_str(input.role)),
        json!({ "user": target, "from": role_str(them.role), "to": role_str(input.role) }),
    )
    .await;
    Ok(Json(json!({ "user": target, "role": role_str(input.role) })).into_response())
}

/// `DELETE /api/taskflow/projects/{project}/members/{user}`
pub async fn remove(RequireAuth(caller): RequireAuth<i64>, Path((project, target)): Path<(i64, i64)>) -> Result<Response, ApiError> {
    let me = active_member(project, caller).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found", "No such project."))?;
    let leaving = caller == target;
    let them = if leaving {
        me.clone()
    } else {
        if !matches!(me.role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin) {
            return Err(err(StatusCode::FORBIDDEN, "owner_or_admin_only", "Only owners and admins can remove people."));
        }
        active_member(project, target).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "not_a_member", "That person isn't an active member."))?
    };
    if them.role == TaskflowProjectRole::Owner {
        if !leaving && me.role != TaskflowProjectRole::Owner {
            return Err(err(StatusCode::FORBIDDEN, "owner_only", "Only an owner can remove an owner."));
        }
        if active_owners(project).await? <= 1 {
            return Err(err(StatusCode::CONFLICT, "last_owner", "A project needs an owner: make someone else owner first."));
        }
    }
    let mut v = serde_json::Map::new();
    v.insert("status".into(), json!("left"));
    let n = TaskflowProjectMember::objects()
        .filter(taskflow_project_member::ID.eq(them.id) & taskflow_project_member::STATUS.eq("active"))
        .update_values(v)
        .await
        .map_err(internal)?;
    if n > 0 && them.role == TaskflowProjectRole::Owner && active_owners(project).await? == 0 {
        let mut back = serde_json::Map::new();
        back.insert("status".into(), json!("active"));
        TaskflowProjectMember::objects()
            .filter(taskflow_project_member::ID.eq(them.id))
            .update_values(back)
            .await
            .map_err(internal)?;
        return Err(err(StatusCode::CONFLICT, "last_owner", "A project needs an owner: make someone else owner first."));
    }
    emit_member(them.id).await;
    if n == 0 {
        // Already gone (a concurrent removal): nothing more to do.
        return Ok(Json(json!({ "revoked_agent_keys": 0, "agents": [] })).into_response());
    }
    let (keys, agents) = revoke_linked_keys(project, target).await?;
    let body = if leaving {
        format!("{} left the project", label(&them))
    } else {
        format!("{} removed {}", label(&me), label(&them))
    };
    let body = if keys > 0 { format!("{body}; {keys} agent key(s) they set up were stopped") } else { body };
    audit(project, &me, "member_removed", body, json!({ "user": target, "left": leaving, "revoked_agent_keys": keys, "agents": agents })).await;
    Ok(Json(json!({ "revoked_agent_keys": keys, "agents": agents })).into_response())
}
