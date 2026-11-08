//! Org routes (#1133). Every handler checks the caller's ORG role; none of
//! them grants or reads project access. Not-a-member is a 404, so an org's
//! existence doesn't leak.
//!
//! | Route | Who |
//! |---|---|
//! | `GET  /api/taskflow/orgs` | me: the orgs I'm in, with my role |
//! | `GET  /api/taskflow/orgs/{o}` | any member (billing too): the org, my role, seats used, and the org's projects that I can access |
//! | `PATCH /api/taskflow/orgs/{o}` | owner, admin: `{name}` |
//! | `GET  /api/taskflow/orgs/{o}/members` | owner, admin |
//! | `PATCH /api/taskflow/orgs/{o}/members/{user}` | owner, admin: `{role}`. Only an owner grants or takes away `owner`; the last owner can't be demoted |
//! | `DELETE /api/taskflow/orgs/{o}/members/{user}` | owner, admin, or the member themselves (leaving). An admin can't remove an owner; the last owner can't go |
//! | `GET  /api/taskflow/orgs/{o}/invites` | owner, admin: pending ones (never a token) |
//! | `POST /api/taskflow/orgs/{o}/invites` | owner, admin: `{email, role}`. Returns the token ONCE. Only an owner invites an owner |
//! | `POST /api/taskflow/orgs/{o}/invites/{id}/resend` | owner, admin: a new token and expiry, ONCE; at most once a minute |
//! | `DELETE /api/taskflow/orgs/{o}/invites/{id}` | owner, admin: revoke |
//! | `POST /api/taskflow/org-invites/accept` | any signed-in user: `{token}` |
//! | `POST /api/taskflow/org-invites/peek` | any signed-in user: `{token}` → org, invited email, role, open, matches_me |
//!
//! **Accept** needs the token AND an account whose email equals the invite's
//! (case-insensitive), and, when `TASKFLOW_ORG_INVITE_REQUIRE_VERIFIED=1`, a
//! verified email. It grants the org role only, never project access.

use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Response, StatusCode};
use umbral_auth::{AuthUser, RequireAuth, auth_user};

use taskflow_projects::models::{TaskflowProject, taskflow_project};

use crate::models::{
    TaskflowOrg, TaskflowOrgInvite, TaskflowOrgInviteStatus, TaskflowOrgMember, TaskflowOrgProject, TaskflowOrgRole,
    taskflow_org, taskflow_org_invite, taskflow_org_member, taskflow_org_project,
};
use crate::service::{self, values};

pub const INVITE_TTL_DAYS: i64 = 7;
pub const MAX_INVITES_PER_HOUR: usize = 20;
pub const MAX_PENDING_INVITES: usize = 100;
pub const RESEND_EVERY_SECS: i64 = 60;

type ApiError = (StatusCode, Json<Value>);
type Reply = Result<Response, ApiError>;

fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

fn bad(field: &str, reason: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid", "field": field, "reason": reason })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "org route failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

fn not_found() -> ApiError {
    err(StatusCode::NOT_FOUND, "not_found")
}

/// The caller's role, or 404 when they aren't in the org (or it doesn't exist).
async fn my_role(user: i64, org: i64) -> Result<TaskflowOrgRole, ApiError> {
    service::role_of(user, org).await.map_err(internal)?.ok_or_else(not_found)
}

async fn manager(user: i64, org: i64) -> Result<TaskflowOrgRole, ApiError> {
    let role = my_role(user, org).await?;
    if !role.manages() {
        return Err(err(StatusCode::FORBIDDEN, "not_an_org_admin"));
    }
    Ok(role)
}

async fn load_org(org: i64) -> Result<TaskflowOrg, ApiError> {
    TaskflowOrg::objects().filter(taskflow_org::ID.eq(org)).first().await.map_err(internal)?.ok_or_else(not_found)
}

fn org_json(o: &TaskflowOrg) -> Value {
    json!({ "id": o.id, "name": o.name, "slug": o.slug, "personal": o.personal_of.is_some(), "created_at": o.created_at })
}

fn invite_json(i: &TaskflowOrgInvite) -> Value {
    json!({
        "id": i.id, "org": i.org.id(), "email": i.email, "role": i.role.as_str(),
        "status": serde_json::to_value(i.status).unwrap_or(Value::Null),
        "invited_by": i.invited_by.as_ref().map(|u| u.id()), "expires_at": i.expires_at,
        "sent_at": i.sent_at, "created_at": i.created_at,
    })
}

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

/// `GET /api/taskflow/orgs`
pub async fn my_orgs(RequireAuth(user): RequireAuth<i64>) -> Reply {
    let memberships = TaskflowOrgMember::objects()
        .filter(taskflow_org_member::USER.eq(user))
        .fetch()
        .await
        .map_err(internal)?;
    let ids: Vec<i64> = memberships.iter().map(|m| m.org.id()).collect();
    let orgs = if ids.is_empty() {
        Vec::new()
    } else {
        TaskflowOrg::objects().filter(taskflow_org::ID.in_(&ids)).order_by(taskflow_org::ID.asc()).fetch().await.map_err(internal)?
    };
    let results: Vec<Value> = orgs
        .iter()
        .map(|o| {
            let mut v = org_json(o);
            let role = memberships.iter().find(|m| m.org.id() == o.id).map(|m| m.role.as_str());
            v["my_role"] = json!(role);
            v
        })
        .collect();
    Ok(Json(json!({ "results": results })).into_response())
}

/// `GET /api/taskflow/orgs/{o}`
pub async fn get_org(RequireAuth(user): RequireAuth<i64>, Path(org): Path<i64>) -> Reply {
    let role = my_role(user, org).await?;
    let o = load_org(org).await?;
    // The org's projects, filtered to those the caller can open by PROJECT
    // membership. A billing member sees none unless they are also a member
    // of a project: the org role never opens one.
    let links = TaskflowOrgProject::objects()
        .filter(taskflow_org_project::ORG.eq(org))
        .fetch()
        .await
        .map_err(internal)?;
    let mut projects = Vec::new();
    for l in &links {
        let pid = l.project.id();
        if taskflow_projects::scope::can_access_project(user, pid).await {
            if let Some(p) = TaskflowProject::objects().filter(taskflow_project::ID.eq(pid)).first().await.map_err(internal)? {
                projects.push(json!({ "id": p.id, "name": p.name, "slug": p.slug }));
            }
        }
    }
    let mut v = org_json(&o);
    v["my_role"] = json!(role.as_str());
    v["seats_used"] = json!(service::seats_used(org).await.map_err(internal)?);
    v["project_count"] = json!(links.len());
    v["projects"] = json!(projects);
    Ok(Json(v).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrgPatch {
    pub name: String,
}

/// `PATCH /api/taskflow/orgs/{o}`
pub async fn patch_org(RequireAuth(user): RequireAuth<i64>, Path(org): Path<i64>, Json(input): Json<OrgPatch>) -> Reply {
    manager(user, org).await?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(bad("name", "1 to 120 characters"));
    }
    TaskflowOrg::objects()
        .filter(taskflow_org::ID.eq(org))
        .update_values(values(&[("name", json!(name))]))
        .await
        .map_err(internal)?;
    Ok(Json(org_json(&load_org(org).await?)).into_response())
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/// `GET /api/taskflow/orgs/{o}/members`
pub async fn list_members(RequireAuth(user): RequireAuth<i64>, Path(org): Path<i64>) -> Reply {
    manager(user, org).await?;
    let members = TaskflowOrgMember::objects()
        .filter(taskflow_org_member::ORG.eq(org))
        .order_by(taskflow_org_member::ID.asc())
        .fetch()
        .await
        .map_err(internal)?;
    let ids: Vec<i64> = members.iter().map(|m| m.user.id()).collect();
    let users = if ids.is_empty() {
        Vec::new()
    } else {
        AuthUser::objects().filter(auth_user::ID.in_(&ids)).fetch().await.map_err(internal)?
    };
    let results: Vec<Value> = members
        .iter()
        .map(|m| {
            let u = users.iter().find(|u| u.id == m.user.id());
            json!({
                "user": m.user.id(), "username": u.map(|u| u.username.clone()), "email": u.map(|u| u.email.clone()),
                "role": m.role.as_str(), "joined_at": m.joined_at,
                "last_login": u.and_then(|u| u.last_login),
            })
        })
        .collect();
    Ok(Json(json!({ "results": results, "seats_used": results.len() })).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RolePatch {
    pub role: TaskflowOrgRole,
}

async fn member_row(org: i64, target: i64) -> Result<TaskflowOrgMember, ApiError> {
    TaskflowOrgMember::objects()
        .filter(taskflow_org_member::ORG.eq(org) & taskflow_org_member::USER.eq(target))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)
}

/// `PATCH /api/taskflow/orgs/{o}/members/{user}`
pub async fn set_role(
    RequireAuth(user): RequireAuth<i64>,
    Path((org, target)): Path<(i64, i64)>,
    Json(input): Json<RolePatch>,
) -> Reply {
    let mine = manager(user, org).await?;
    let current = member_row(org, target).await?;
    let touches_owner = current.role == TaskflowOrgRole::Owner || input.role == TaskflowOrgRole::Owner;
    if touches_owner && mine != TaskflowOrgRole::Owner {
        return Err(err(StatusCode::FORBIDDEN, "owner_only"));
    }
    if current.role == TaskflowOrgRole::Owner
        && input.role != TaskflowOrgRole::Owner
        && service::owner_count(org).await.map_err(internal)? <= 1
    {
        return Err(err(StatusCode::CONFLICT, "last_owner"));
    }
    // Column update guarded on the role we checked: a concurrent change
    // between the read and here is a 409, not overwritten.
    let n = TaskflowOrgMember::objects()
        .filter(taskflow_org_member::ID.eq(current.id) & taskflow_org_member::ROLE.eq(current.role.as_str()))
        .update_values(values(&[("role", service::role_json(input.role))]))
        .await
        .map_err(internal)?;
    if n == 0 {
        return Err(err(StatusCode::CONFLICT, "changed"));
    }
    // Re-check after the write: two owners demoting each other at once could
    // both pass the count above. If that left no owner, undo ours.
    if current.role == TaskflowOrgRole::Owner && service::owner_count(org).await.map_err(internal)? == 0 {
        TaskflowOrgMember::objects()
            .filter(taskflow_org_member::ID.eq(current.id))
            .update_values(values(&[("role", service::role_json(TaskflowOrgRole::Owner))]))
            .await
            .map_err(internal)?;
        return Err(err(StatusCode::CONFLICT, "last_owner"));
    }
    Ok(Json(json!({ "user": target, "role": input.role.as_str() })).into_response())
}

/// `DELETE /api/taskflow/orgs/{o}/members/{user}`
pub async fn remove_member(RequireAuth(user): RequireAuth<i64>, Path((org, target)): Path<(i64, i64)>) -> Reply {
    let mine = my_role(user, org).await?;
    let leaving = user == target;
    if !leaving && !mine.manages() {
        return Err(err(StatusCode::FORBIDDEN, "not_an_org_admin"));
    }
    let current = member_row(org, target).await?;
    if current.role == TaskflowOrgRole::Owner {
        if !leaving && mine != TaskflowOrgRole::Owner {
            return Err(err(StatusCode::FORBIDDEN, "owner_only"));
        }
        if service::owner_count(org).await.map_err(internal)? <= 1 {
            return Err(err(StatusCode::CONFLICT, "last_owner"));
        }
    }
    TaskflowOrgMember::objects()
        .filter(taskflow_org_member::ID.eq(current.id))
        .delete()
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/// `GET /api/taskflow/orgs/{o}/invites`
pub async fn list_invites(RequireAuth(user): RequireAuth<i64>, Path(org): Path<i64>) -> Reply {
    manager(user, org).await?;
    let rows = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::ORG.eq(org) & taskflow_org_invite::STATUS.eq("pending"))
        .order_by(taskflow_org_invite::ID.desc())
        .fetch()
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "results": rows.iter().map(invite_json).collect::<Vec<_>>() })).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InviteInput {
    pub email: String,
    #[serde(default = "default_role")]
    pub role: TaskflowOrgRole,
}

fn default_role() -> TaskflowOrgRole {
    TaskflowOrgRole::Member
}

fn plausible_email(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else { return false };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !e.contains(char::is_whitespace) && e.len() <= 240
}

/// `POST /api/taskflow/orgs/{o}/invites`
pub async fn create_invite(RequireAuth(user): RequireAuth<i64>, Path(org): Path<i64>, Json(input): Json<InviteInput>) -> Reply {
    let mine = manager(user, org).await?;
    let email = input.email.trim().to_lowercase();
    if !plausible_email(&email) {
        return Err(bad("email", "not an email address"));
    }
    if input.role == TaskflowOrgRole::Owner && mine != TaskflowOrgRole::Owner {
        return Err(err(StatusCode::FORBIDDEN, "owner_only"));
    }
    // Already in the org?
    // `icontains` escapes LIKE wildcards (an `_` in an address is literal);
    // the exact, case-insensitive match is then made here.
    let existing = AuthUser::objects().filter(auth_user::EMAIL.icontains(email.as_str())).fetch().await.map_err(internal)?;
    for u in existing.iter().filter(|u| u.email.trim().eq_ignore_ascii_case(&email)) {
        if service::role_of(u.id, org).await.map_err(internal)?.is_some() {
            return Err(err(StatusCode::CONFLICT, "already_a_member"));
        }
    }
    // Throttles: a burst cap per hour, and a cap on what's outstanding.
    let now = Utc::now();
    let recent = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::ORG.eq(org) & taskflow_org_invite::CREATED_AT.gt(now - Duration::hours(1)))
        .fetch()
        .await
        .map_err(internal)?
        .len();
    if recent >= MAX_INVITES_PER_HOUR {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "too_many_invites"));
    }
    let pending = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::ORG.eq(org) & taskflow_org_invite::STATUS.eq("pending"))
        .fetch()
        .await
        .map_err(internal)?;
    if pending.len() >= MAX_PENDING_INVITES {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "too_many_pending"));
    }
    if pending.iter().any(|i| i.email == email) {
        return Err(err(StatusCode::CONFLICT, "already_invited"));
    }
    let (token, token_hash) = service::new_token();
    let invite = TaskflowOrgInvite::objects()
        .create(TaskflowOrgInvite {
            id: 0,
            org: ForeignKey::new(org),
            email,
            role: input.role,
            status: TaskflowOrgInviteStatus::Pending,
            token_hash,
            invited_by: Some(ForeignKey::new(user)),
            expires_at: now + Duration::days(INVITE_TTL_DAYS),
            sent_at: now,
            accepted_at: None,
            accepted_by: None,
            created_at: None,
        })
        .await
        .map_err(internal)?;
    let mut v = invite_json(&invite);
    v["token"] = json!(token); // the ONLY time the plaintext leaves the server
    Ok((StatusCode::CREATED, Json(v)).into_response())
}

async fn pending_invite(org: i64, id: i64) -> Result<TaskflowOrgInvite, ApiError> {
    TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::ORG.eq(org) & taskflow_org_invite::ID.eq(id) & taskflow_org_invite::STATUS.eq("pending"))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)
}

/// `POST /api/taskflow/orgs/{o}/invites/{id}/resend`: a NEW token (the old
/// link stops working) and a fresh expiry.
pub async fn resend_invite(RequireAuth(user): RequireAuth<i64>, Path((org, id)): Path<(i64, i64)>) -> Reply {
    manager(user, org).await?;
    let invite = pending_invite(org, id).await?;
    let now = Utc::now();
    if now - invite.sent_at < Duration::seconds(RESEND_EVERY_SECS) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "resent_too_soon"));
    }
    let (token, token_hash) = service::new_token();
    // Guarded on the sent_at we read: two racing resends can't both mint.
    let n = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::ID.eq(id) & taskflow_org_invite::STATUS.eq("pending") & taskflow_org_invite::SENT_AT.eq(invite.sent_at))
        .update_values(values(&[
            ("token_hash", json!(token_hash)),
            ("sent_at", json!(now)),
            ("expires_at", json!(now + Duration::days(INVITE_TTL_DAYS))),
        ]))
        .await
        .map_err(internal)?;
    if n == 0 {
        return Err(err(StatusCode::CONFLICT, "changed"));
    }
    let mut v = invite_json(&pending_invite(org, id).await?);
    v["token"] = json!(token);
    Ok(Json(v).into_response())
}

/// `DELETE /api/taskflow/orgs/{o}/invites/{id}`
pub async fn revoke_invite(RequireAuth(user): RequireAuth<i64>, Path((org, id)): Path<(i64, i64)>) -> Reply {
    manager(user, org).await?;
    let n = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::ORG.eq(org) & taskflow_org_invite::ID.eq(id) & taskflow_org_invite::STATUS.eq("pending"))
        .update_values(values(&[("status", json!("revoked"))]))
        .await
        .map_err(internal)?;
    if n == 0 {
        return Err(not_found());
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptInput {
    pub token: String,
}

fn require_verified() -> bool {
    std::env::var("TASKFLOW_ORG_INVITE_REQUIRE_VERIFIED").is_ok_and(|v| v.trim() == "1" || v.trim().eq_ignore_ascii_case("true"))
}

/// `POST /api/taskflow/org-invites/accept`
pub async fn accept_invite(RequireAuth(user): RequireAuth<i64>, Json(input): Json<AcceptInput>) -> Reply {
    let hash = service::hash_token(&input.token);
    // One answer for "no such token" and "not yours", so a token can't be
    // probed for which org it belongs to.
    let invite = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::TOKEN_HASH.eq(hash.as_str()))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    let me = AuthUser::objects()
        .filter(auth_user::ID.eq(user))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    if !me.email.trim().eq_ignore_ascii_case(&invite.email) {
        return Err(not_found());
    }
    if require_verified() && me.email_verified_at.is_none() {
        return Err(err(StatusCode::FORBIDDEN, "email_not_verified"));
    }
    let org = invite.org.id();
    match invite.status {
        TaskflowOrgInviteStatus::Pending => {}
        TaskflowOrgInviteStatus::Accepted if invite.accepted_by.as_ref().map(|u| u.id()) == Some(user) => {
            let role = service::role_of(user, org).await.map_err(internal)?;
            return Ok(Json(json!({ "org": org, "role": role.map(|r| r.as_str()) })).into_response());
        }
        _ => return Err(err(StatusCode::GONE, "invite_closed")),
    }
    let now = Utc::now();
    if invite.expires_at < now {
        return Err(err(StatusCode::GONE, "invite_expired"));
    }
    // Single use: only the request that flips pending → accepted proceeds.
    let n = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::ID.eq(invite.id) & taskflow_org_invite::STATUS.eq("pending"))
        .update_values(values(&[("status", json!("accepted")), ("accepted_at", json!(now)), ("accepted_by", json!(user))]))
        .await
        .map_err(internal)?;
    if n == 0 {
        return Err(err(StatusCode::GONE, "invite_closed"));
    }
    let member = match service::ensure_member(org, user, invite.role, invite.invited_by.as_ref().map(|u| u.id())).await {
        Ok(m) => m,
        Err(e) => {
            // Don't leave a consumed invite with no membership behind it.
            let _ = TaskflowOrgInvite::objects()
                .filter(taskflow_org_invite::ID.eq(invite.id) & taskflow_org_invite::STATUS.eq("accepted"))
                .update_values(values(&[("status", json!("pending")), ("accepted_at", Value::Null), ("accepted_by", Value::Null)]))
                .await;
            return Err(internal(e));
        }
    };
    Ok(Json(json!({ "org": org, "role": member.role.as_str() })).into_response())
}

/// `POST /api/taskflow/org-invites/peek` `{token}` (signed in): what an invite
/// link is for, so the accept screen can show the invited address and a
/// person who landed on someone else's invite sees it isn't theirs. A POST so
/// the token stays out of URLs and access logs. Only the token's holder learns
/// anything; an unknown token is a 404.
pub async fn peek_invite(RequireAuth(user): RequireAuth<i64>, Json(input): Json<AcceptInput>) -> Reply {
    let hash = service::hash_token(&input.token);
    let invite = TaskflowOrgInvite::objects()
        .filter(taskflow_org_invite::TOKEN_HASH.eq(hash.as_str()))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(not_found)?;
    let org = load_org(invite.org.id()).await?;
    let me = AuthUser::objects().filter(auth_user::ID.eq(user)).first().await.map_err(internal)?;
    let matches_me = me.is_some_and(|u| u.email.trim().eq_ignore_ascii_case(&invite.email));
    let open = invite.status == TaskflowOrgInviteStatus::Pending && invite.expires_at > Utc::now();
    Ok(Json(json!({
        "org": { "id": org.id, "name": org.name },
        "email": invite.email, "role": invite.role.as_str(),
        "expires_at": invite.expires_at, "open": open, "matches_me": matches_me,
    }))
    .into_response())
}
