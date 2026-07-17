//! HTTP handlers for the `taskflow-projects` plugin.
//!
//! The invite accept/decline flow and the per-user settings inbox are custom
//! authed endpoints — they derive the caller's identity from the authenticated
//! token (`RequireAuth`), never from the request body, and every write is
//! gated on the invite's `email` matching the caller's own account email. This
//! is the same "trust the identity, not the payload" shape as the agents
//! `send_message` endpoint.

use chrono::{Duration, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

use umbral::orm::ForeignKey;
use umbral::web::{Json, Path, StatusCode};
use umbral_auth::{AuthUser, CurrentIdentity, RequireAuth, auth_user};

use crate::models::{
    TaskflowInviteStatus, TaskflowMembershipStatus, TaskflowProject, TaskflowProjectInvite,
    TaskflowProjectMember, TaskflowProjectRole, TaskflowTheme, TaskflowUserSettings,
    taskflow_project, taskflow_project_invite, taskflow_project_member, taskflow_user_settings,
};

pub async fn health() -> &'static str {
    "taskflow-projects:ok"
}

/// The stored (snake_case) value of `TaskflowInviteStatus::Pending`. The status
/// column is TEXT at the DB layer, so filters compare against the literal.
const PENDING: &str = "pending";

/// Load the authenticated caller's `AuthUser` row. A valid token whose user row
/// has vanished is treated as unauthenticated rather than a 500.
async fn load_caller(user_id: i64) -> Result<AuthUser, StatusCode> {
    AuthUser::objects()
        .filter(auth_user::ID.eq(user_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)
}

/// Load an invite by its opaque token, 404 if there is no such token.
async fn load_invite(token: &str) -> Result<TaskflowProjectInvite, StatusCode> {
    TaskflowProjectInvite::objects()
        .filter(taskflow_project_invite::INVITE_TOKEN.eq(token))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)
}

/// The security boundary shared by accept and decline: the invite may only be
/// acted on by the account whose email it was addressed to. Compared
/// case-insensitively — a caller must not be able to act on an invite addressed
/// to someone else even if they somehow hold the token.
fn caller_owns_invite(invite: &TaskflowProjectInvite, caller: &AuthUser) -> bool {
    invite.email.eq_ignore_ascii_case(&caller.email)
}

/// `POST /api/taskflow/projects/invites/{token}/accept`
///
/// Turns a pending invite addressed to the caller into an active membership,
/// atomically. Idempotent: a second accept by the same user returns the
/// existing membership (200).
pub async fn accept_invite(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(token): Path<String>,
) -> Result<Json<TaskflowProjectMember>, StatusCode> {
    let invite = load_invite(&token).await?;
    let caller = load_caller(user_id).await?;

    // Security: the invite is bound to an email, not a token-bearer. Only the
    // account it names may accept it.
    if !caller_owns_invite(&invite, &caller) {
        return Err(StatusCode::FORBIDDEN);
    }

    let project_id = invite.project.id();
    let member_key = format!("user:{user_id}");
    let now = Utc::now();

    match invite.status {
        // Idempotent: already accepted by this (email-matched) user → hand back
        // the membership that accept created, without a second write.
        TaskflowInviteStatus::Accepted => {
            let member = TaskflowProjectMember::objects()
                .filter(
                    taskflow_project_member::PROJECT.eq(project_id)
                        & taskflow_project_member::MEMBER_KEY.eq(member_key.as_str()),
                )
                .first()
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .ok_or(StatusCode::CONFLICT)?;
            return Ok(Json(member));
        }
        TaskflowInviteStatus::Pending => {}
        // Declined / Revoked / Expired are terminal for accept.
        _ => return Err(StatusCode::CONFLICT),
    }

    // Expiry: a pending-but-expired invite is Gone. Best-effort flip to
    // `expired` so it stops showing up as actionable.
    if let Some(expires_at) = invite.expires_at {
        if expires_at < now {
            let _ = TaskflowProjectInvite::objects()
                .filter(taskflow_project_invite::ID.eq(invite.id))
                .update_values(
                    json!({ "status": "expired" })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                )
                .await;
            return Err(StatusCode::GONE);
        }
    }

    // MEDIUM: suspension is terminal until an admin clears it. A suspended
    // member must NOT be able to self-reactivate by accepting a fresh invite —
    // only prior `invited` / `left` (or the idempotent already-`active`) states
    // are reactivatable below. Checked before the transaction so a suspended
    // caller never consumes the invite either.
    if let Some(existing) = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::MEMBER_KEY.eq(member_key.as_str()),
        )
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        if existing.status == TaskflowMembershipStatus::Suspended {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    let display_name = caller.username.clone();
    let email = caller.email.clone();
    let role = invite.role;
    let invited_by = invite.invited_by.clone();
    let invite_id = invite.id;
    let role_value = serde_json::to_value(role).unwrap_or(json!("developer"));

    // Atomic: flip the invite to accepted AND create-or-activate the membership.
    // If either write fails, neither lands — no accepted invite without a
    // membership, and no membership without the invite consumed.
    let member = umbral::transaction(move |tx| {
        Box::pin(async move {
            // Re-assert `pending` inside the transaction: the status was read
            // before the tx opened, so a concurrent decline/revoke between then
            // and now must not be steam-rolled into an acceptance. If the
            // conditional update touches no row, the invite is no longer
            // pending — abort, rolling the whole transaction back.
            let flipped = TaskflowProjectInvite::objects()
                .filter(
                    taskflow_project_invite::ID.eq(invite_id)
                        & taskflow_project_invite::STATUS.eq(PENDING),
                )
                .on_tx(tx)
                .update_values(
                    json!({ "status": "accepted", "accepted_at": now })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                )
                .await?;
            if flipped == 0 {
                return Err("invite is no longer pending".into());
            }

            // Respect the unique_together on (project, member_key): if a row
            // already exists (e.g. a prior `invited` placeholder), activate it
            // rather than inserting a duplicate.
            let existing = TaskflowProjectMember::objects()
                .filter(
                    taskflow_project_member::PROJECT.eq(project_id)
                        & taskflow_project_member::MEMBER_KEY.eq(member_key.as_str()),
                )
                .on_tx(tx)
                .first()
                .await?;

            let member = if let Some(existing) = existing {
                TaskflowProjectMember::objects()
                    .filter(taskflow_project_member::ID.eq(existing.id))
                    .on_tx(tx)
                    .update_values(
                        json!({
                            "status": "active",
                            "role": role_value,
                            "joined_at": now,
                        })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    )
                    .await?;
                TaskflowProjectMember::objects()
                    .filter(taskflow_project_member::ID.eq(existing.id))
                    .on_tx(tx)
                    .first()
                    .await?
                    .ok_or("membership vanished mid-transaction")?
            } else {
                TaskflowProjectMember::objects()
                    .on_tx(tx)
                    .create(TaskflowProjectMember {
                        id: 0,
                        project: ForeignKey::new(project_id),
                        member_key: member_key.clone(),
                        user: Some(ForeignKey::new(user_id)),
                        display_name: display_name.clone(),
                        email: Some(email.clone()),
                        role,
                        status: TaskflowMembershipStatus::Active,
                        invited_by: invited_by.clone(),
                        created_at: None,
                        joined_at: Some(now),
                    })
                    .await?
            };

            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(member)
        })
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(member))
}

/// The privilege rank of a role, high to low: owner > admin > developer >
/// reviewer > viewer. Used to cap the role a caller may hand out at their own
/// level, so an admin can never mint an `owner`.
fn role_rank(role: TaskflowProjectRole) -> u8 {
    match role {
        TaskflowProjectRole::Owner => 4,
        TaskflowProjectRole::Admin => 3,
        TaskflowProjectRole::Developer => 2,
        TaskflowProjectRole::Reviewer => 1,
        TaskflowProjectRole::Viewer => 0,
    }
}

/// How long a freshly minted invite stays valid.
const INVITE_TTL_DAYS: i64 = 14;

/// What a client may say when creating an invite: who to invite, at what role,
/// and an optional display name. Everything security-relevant — `project`
/// (path), `invited_by`/`status`/`invite_token` (server) — is deliberately
/// ABSENT so there is no field to forge, exactly like the agents `send_message`
/// endpoint.
#[derive(Debug, Deserialize)]
pub struct CreateInviteInput {
    pub email: String,
    pub role: TaskflowProjectRole,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// `POST /api/taskflow/projects/{project}/invites`
///
/// Create an invite into `{project}` (id from the PATH, never the body). This is
/// the ONLY authorized way to mint an invite — the `taskflow_project_invite`
/// table is read-only over auto-REST precisely so a caller cannot self-author
/// one and then accept it into an ownership takeover.
///
/// Authorization: the caller must be an ACTIVE member of the project whose role
/// is `owner` or `admin`, verified server-side against `TaskflowProjectMember`
/// — a non-member, or a viewer/reviewer/developer, gets 403. A SUPERUSER
/// bypasses the membership check entirely (consistent with the SP-A project
/// visibility scope, which already lets a superuser see every project) — they
/// may create an invite for any project without holding a membership row in it.
///
/// Role cap: the invited role may not out-rank the caller's own role
/// (owner > admin > developer > reviewer > viewer). So an admin can invite up to
/// `admin` but never `owner`; only an owner (or a superuser) can mint an owner
/// invite.
///
/// The `invite_token` is generated server-side (unguessable UUIDv4) and never
/// accepted from the body; `status` is forced to `pending`, `invited_by` to the
/// caller, and `expires_at` to now + 14 days.
pub async fn create_invite(
    CurrentIdentity(identity): CurrentIdentity,
    Path(project_id): Path<i64>,
    Json(input): Json<CreateInviteInput>,
) -> Result<Json<TaskflowProjectInvite>, StatusCode> {
    let email = input.email.trim();
    if email.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let user_id: i64 = identity.pk().map_err(|_| StatusCode::BAD_REQUEST)?;

    // Authorization is membership, not identity — EXCEPT for a superuser, who
    // is granted the top rank outright rather than being read from the
    // membership table (there may be no row for them in this project at all).
    // Everyone else must be an ACTIVE member OF THIS PROJECT, read from the
    // table and never trusted from the request. Absent → 403 (a non-member,
    // non-superuser cannot invite).
    let caller_rank = if identity.is_superuser {
        role_rank(TaskflowProjectRole::Owner)
    } else {
        let caller_member = TaskflowProjectMember::objects()
            .filter(
                taskflow_project_member::PROJECT.eq(project_id)
                    & taskflow_project_member::USER.eq(user_id)
                    & taskflow_project_member::STATUS.eq("active"),
            )
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::FORBIDDEN)?;

        let rank = role_rank(caller_member.role);
        // Only owners and admins may invite at all.
        if rank < role_rank(TaskflowProjectRole::Admin) {
            return Err(StatusCode::FORBIDDEN);
        }
        rank
    };

    // Cap the invited role at the caller's own level: an admin cannot mint an
    // owner (owner-rank 4 > admin-rank 3 → 403). A superuser is capped at
    // `Owner` too, but `Owner` is the top rank so that's no real limit.
    if role_rank(input.role) > caller_rank {
        return Err(StatusCode::FORBIDDEN);
    }

    let now = Utc::now();
    // Server-minted, unguessable token — never read from the body.
    let token = format!("inv_{}", Uuid::new_v4().simple());

    let invite = TaskflowProjectInvite::objects()
        .create(TaskflowProjectInvite {
            id: 0,
            project: ForeignKey::new(project_id),
            email: email.to_string(),
            display_name: input.display_name.clone(),
            role: input.role,
            status: TaskflowInviteStatus::Pending,
            invite_token: token,
            invited_by: Some(ForeignKey::new(user_id)),
            expires_at: Some(now + Duration::days(INVITE_TTL_DAYS)),
            accepted_at: None,
            created_at: None,
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(invite))
}

/// `POST /api/taskflow/projects/invites/{token}/decline`
///
/// Marks an invite addressed to the caller as declined. Creates no membership.
/// Idempotent: declining an already-declined invite returns 200.
pub async fn decline_invite(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(token): Path<String>,
) -> Result<Json<TaskflowProjectInvite>, StatusCode> {
    let invite = load_invite(&token).await?;
    let caller = load_caller(user_id).await?;

    if !caller_owns_invite(&invite, &caller) {
        return Err(StatusCode::FORBIDDEN);
    }

    match invite.status {
        // Idempotent no-op.
        TaskflowInviteStatus::Declined => Ok(Json(invite)),
        TaskflowInviteStatus::Pending => {
            // No membership is created on decline — only the invite changes.
            let mut updated = invite;
            updated.status = TaskflowInviteStatus::Declined;
            let saved = TaskflowProjectInvite::objects()
                .save(updated)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(Json(saved))
        }
        // Accepted / Revoked / Expired can't be declined.
        _ => Err(StatusCode::CONFLICT),
    }
}

/// An invite plus the human-readable project name, so the inbox can show which
/// project the caller was invited to without a second round trip.
#[derive(Debug, Serialize)]
pub struct InviteInboxEntry {
    #[serde(flatten)]
    pub invite: TaskflowProjectInvite,
    pub project_name: Option<String>,
}

/// `GET /api/taskflow/projects/invites/mine`
///
/// The caller's invite inbox: pending, non-expired invites addressed to their
/// account email (case-insensitive), regardless of project membership. The
/// SP-A project scope hides invites for projects the caller isn't in yet — this
/// endpoint is how an invitee sees the invite that would let them join.
pub async fn my_invites(
    RequireAuth(user_id): RequireAuth<i64>,
) -> Result<Json<Vec<InviteInboxEntry>>, StatusCode> {
    let caller = load_caller(user_id).await?;
    let now = Utc::now();

    // Pending invites system-wide, then narrowed in-process to the caller's
    // email (case-insensitive) and un-expired. The email filter is what makes
    // this safe: a caller only ever sees invites addressed to their own account.
    let pending = TaskflowProjectInvite::objects()
        .filter(taskflow_project_invite::STATUS.eq(PENDING))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mine: Vec<TaskflowProjectInvite> = pending
        .into_iter()
        .filter(|inv| inv.email.eq_ignore_ascii_case(&caller.email))
        .filter(|inv| inv.expires_at.map(|exp| exp > now).unwrap_or(true))
        .collect();

    // Resolve project names in one query.
    let project_ids: Vec<i64> = mine.iter().map(|inv| inv.project.id()).collect();
    let names: HashMap<i64, String> = if project_ids.is_empty() {
        HashMap::new()
    } else {
        TaskflowProject::objects()
            .filter(taskflow_project::ID.in_(&project_ids))
            .fetch()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .into_iter()
            .map(|p| (p.id, p.name))
            .collect()
    };

    let entries = mine
        .into_iter()
        .map(|invite| {
            let project_name = names.get(&invite.project.id()).cloned();
            InviteInboxEntry {
                invite,
                project_name,
            }
        })
        .collect();

    Ok(Json(entries))
}

/// The caller's settings row, created with defaults if it doesn't exist yet.
/// Keyed purely on the authenticated user id — no caller can name another user's
/// row. The `unique` constraint on `user` makes the first-read create race-safe:
/// a losing concurrent create hits the constraint and we recover by re-reading.
async fn load_or_create_settings(user_id: i64) -> Result<TaskflowUserSettings, StatusCode> {
    if let Some(existing) = TaskflowUserSettings::objects()
        .filter(taskflow_user_settings::USER.eq(user_id))
        .first()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Ok(existing);
    }

    match TaskflowUserSettings::objects()
        .create(TaskflowUserSettings {
            id: 0,
            user: ForeignKey::new(user_id),
            theme: TaskflowTheme::System,
            email_notifications: true,
            default_project: None,
            created_at: None,
            updated_at: None,
        })
        .await
    {
        Ok(created) => Ok(created),
        Err(_) => TaskflowUserSettings::objects()
            .filter(taskflow_user_settings::USER.eq(user_id))
            .first()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// `GET /api/taskflow/user/settings`
///
/// The caller's own settings, created with defaults on first read. Keyed purely
/// on the authenticated identity — there is no path or body parameter to point
/// at another user's row, so a caller can only ever read/create their own.
pub async fn get_user_settings(
    RequireAuth(user_id): RequireAuth<i64>,
) -> Result<Json<TaskflowUserSettings>, StatusCode> {
    load_or_create_settings(user_id).await.map(Json)
}

/// Distinguish "field absent" (leave unchanged) from "field present and null"
/// (clear it) for the nullable `default_project`. Absent → `None`; explicit
/// `null` → `Some(None)`; a value → `Some(Some(v))`.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

/// The mutable slice of a user's settings. `user`, `id`, and timestamps are
/// deliberately ABSENT — there is no field here for a client to reassign
/// ownership through. Every field is optional so a partial update touches only
/// what it names.
#[derive(Debug, Default, Deserialize)]
pub struct UpdateSettingsInput {
    #[serde(default)]
    pub theme: Option<TaskflowTheme>,
    #[serde(default)]
    pub email_notifications: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub default_project: Option<Option<i64>>,
}

/// `POST /api/taskflow/user/settings`
///
/// Update the caller's own settings. Get-or-creates the row first (so an update
/// before any read still works), then applies only the fields the body names.
/// The caller is the authenticated identity; the body carries preferences only,
/// never a `user` — so this can only ever write the caller's own row.
pub async fn update_user_settings(
    RequireAuth(user_id): RequireAuth<i64>,
    Json(input): Json<UpdateSettingsInput>,
) -> Result<Json<TaskflowUserSettings>, StatusCode> {
    let mut settings = load_or_create_settings(user_id).await?;

    if let Some(theme) = input.theme {
        settings.theme = theme;
    }
    if let Some(email_notifications) = input.email_notifications {
        settings.email_notifications = email_notifications;
    }
    if let Some(default_project) = input.default_project {
        settings.default_project = default_project.map(ForeignKey::new);
    }
    settings.updated_at = Some(Utc::now());

    let saved = TaskflowUserSettings::objects()
        .save(settings)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(saved))
}
