//! Access-scoping helpers — the membership set a caller may see.
//!
//! Every project-scoped REST resource and every realtime project room keys off
//! the same question: *which projects is this caller an active member of?* This
//! module answers it once, in one place, so the REST scope closures (in the
//! backend's `rest` module) and the realtime group policy cannot drift.
//!
//! **Fail closed.** A superuser is handled by the CALLER (it maps to
//! `ScopeDecision::All`, which this module cannot express as a project-id list);
//! everyone else gets the ids of their `Active` memberships, and *any* error —
//! an unparseable pk, a failed query — collapses to the empty set, i.e. "sees
//! nothing", never "sees everything". An empty list fed to
//! `ScopeDecision::RestrictIn` means `col IN ()` → zero rows, which is exactly
//! the safe default.

use umbral::auth::Identity;
use umbral_auth::{AuthUser, auth_user};

use crate::models::{TaskflowProjectMember, taskflow_project_member};

/// The stored value of `TaskflowMembershipStatus::Active` (the enum renders
/// snake_case). The status column is a string column at the DB layer, so we
/// compare against this literal.
const ACTIVE: &str = "active";

/// The active project ids for this identity, as strings ready for
/// [`umbral_rest::ScopeDecision::RestrictIn`].
///
/// The caller MUST short-circuit superusers to `All` *before* calling this —
/// "all projects" is not expressible as a finite id list, and this function
/// deliberately returns only the caller's own memberships.
///
/// Fails closed: a pk that will not parse or a query error yields an empty
/// vec, never a wildcard.
pub async fn active_project_ids_for(identity: &Identity) -> Vec<String> {
    let Ok(user_id) = identity.pk::<i64>() else {
        return Vec::new(); // fail closed — never "all"
    };
    active_project_ids_for_user(user_id).await
}

/// The same lookup keyed by a raw user id — the form the realtime group policy
/// needs, where only the pk string (not a full [`Identity`]) is available.
pub async fn active_project_ids_for_user(user_id: i64) -> Vec<String> {
    let members = TaskflowProjectMember::objects()
        .filter(taskflow_project_member::USER.eq(user_id) & taskflow_project_member::STATUS.eq(ACTIVE))
        .fetch()
        .await
        .unwrap_or_default(); // a failed lookup sees nothing, not everything

    members
        .iter()
        .map(|m| m.project.id().to_string())
        .collect()
}

/// Whether `user_id` may access project `project_id`: an active member, or a
/// superuser. Used by the realtime group policy, which — unlike the REST scope
/// closures — only ever has the caller's pk string, so it resolves the
/// superuser flag from the user row here.
///
/// Fails closed on any error.
pub async fn can_access_project(user_id: i64, project_id: i64) -> bool {
    if is_superuser(user_id).await {
        return true;
    }
    let count = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::USER.eq(user_id)
                & taskflow_project_member::PROJECT.eq(project_id)
                & taskflow_project_member::STATUS.eq(ACTIVE),
        )
        .count()
        .await
        .unwrap_or(0); // fail closed
    count > 0
}

/// Resolve the superuser flag for a user id. A missing user or a query error is
/// treated as "not a superuser" — fail closed.
async fn is_superuser(user_id: i64) -> bool {
    AuthUser::objects()
        .filter(auth_user::ID.eq(user_id))
        .first()
        .await
        .ok()
        .flatten()
        .map(|u| u.is_superuser)
        .unwrap_or(false)
}
