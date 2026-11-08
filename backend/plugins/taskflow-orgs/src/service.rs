//! Org rules that are not HTTP: personal orgs, the project backfill, role
//! lookups and invite tokens.
//!
//! **Backfill rule (#1133, written down so it is deterministic).** A project
//! with no org link belongs to its owner's personal org. The project's owner
//! is its ACTIVE `owner`-role member with the lowest member id; if it has none,
//! the project's `owner` column. A project with neither is left unlinked and
//! logged. One personal org per user (`TaskflowOrg.personal_of` is unique),
//! and a project already linked is skipped, so the backfill is idempotent: it
//! runs at every boot and after every project create.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use umbral::orm::ForeignKey;
use umbral_auth::{AuthUser, auth_user};

use taskflow_projects::models::{TaskflowProject, TaskflowProjectMember, taskflow_project, taskflow_project_member};

use crate::models::{
    TaskflowOrg, TaskflowOrgMember, TaskflowOrgProject, TaskflowOrgRole, taskflow_org, taskflow_org_member,
    taskflow_org_project,
};

pub type DbError = Box<dyn std::error::Error + Send + Sync>;

/// The caller's role in an org, or None if they are not in it.
pub async fn role_of(user: i64, org: i64) -> Result<Option<TaskflowOrgRole>, DbError> {
    Ok(TaskflowOrgMember::objects()
        .filter(taskflow_org_member::ORG.eq(org) & taskflow_org_member::USER.eq(user))
        .first()
        .await?
        .map(|m| m.role))
}

/// How many owners an org has. The last one can be neither demoted nor removed.
pub async fn owner_count(org: i64) -> Result<usize, DbError> {
    Ok(TaskflowOrgMember::objects()
        .filter(taskflow_org_member::ORG.eq(org) & taskflow_org_member::ROLE.eq(TaskflowOrgRole::Owner.as_str()))
        .fetch()
        .await?
        .len())
}

/// Seats used: every person in the org (agents are never org members).
pub async fn seats_used(org: i64) -> Result<usize, DbError> {
    Ok(TaskflowOrgMember::objects().filter(taskflow_org_member::ORG.eq(org)).fetch().await?.len())
}

/// A lowercase slug from a name: letters and digits, single dashes.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').chars().take(60).collect::<String>();
    if out.is_empty() { "org".into() } else { out }
}

async fn find_personal(user: i64) -> Result<Option<TaskflowOrg>, DbError> {
    Ok(TaskflowOrg::objects().filter(taskflow_org::PERSONAL_OF.eq(user)).first().await?)
}

/// The user's personal org, created (with them as its owner) on first need.
/// A concurrent create loses on the unique `personal_of` and re-reads.
pub async fn personal_org(user: i64) -> Result<TaskflowOrg, DbError> {
    if let Some(org) = find_personal(user).await? {
        return Ok(org);
    }
    let username = AuthUser::objects()
        .filter(auth_user::ID.eq(user))
        .first()
        .await?
        .map(|u| u.username)
        .unwrap_or_else(|| format!("user-{user}"));
    let created = TaskflowOrg::objects()
        .create(TaskflowOrg {
            id: 0,
            name: username.chars().take(120).collect(),
            // The user id keeps it unique without a lookup loop.
            slug: format!("{}-{user}", slugify(&username)),
            personal_of: Some(ForeignKey::new(user)),
            created_by: Some(ForeignKey::new(user)),
            created_at: None,
        })
        .await;
    let org = match created {
        Ok(org) => org,
        Err(e) => match find_personal(user).await? {
            Some(org) => org, // lost the race: the winner's row is the org
            None => return Err(e.into()),
        },
    };
    ensure_member(org.id, user, TaskflowOrgRole::Owner, None).await?;
    Ok(org)
}

/// Add `user` to `org` with `role` unless they are already in it (an existing
/// membership keeps its role). Returns the membership.
pub async fn ensure_member(
    org: i64,
    user: i64,
    role: TaskflowOrgRole,
    invited_by: Option<i64>,
) -> Result<TaskflowOrgMember, DbError> {
    let existing = || async {
        TaskflowOrgMember::objects()
            .filter(taskflow_org_member::ORG.eq(org) & taskflow_org_member::USER.eq(user))
            .first()
            .await
    };
    if let Some(m) = existing().await? {
        return Ok(m);
    }
    match TaskflowOrgMember::objects()
        .create(TaskflowOrgMember {
            id: 0,
            org: ForeignKey::new(org),
            user: ForeignKey::new(user),
            role,
            invited_by: invited_by.map(ForeignKey::new),
            joined_at: None,
        })
        .await
    {
        Ok(m) => Ok(m),
        Err(e) => existing().await?.ok_or_else(|| e.into()),
    }
}

/// The project's owner under the backfill rule (module docs).
pub async fn project_owner(project: &TaskflowProject) -> Result<Option<i64>, DbError> {
    let owner_member = TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project.id)
                & taskflow_project_member::STATUS.eq("active")
                & taskflow_project_member::ROLE.eq("owner")
                & taskflow_project_member::USER.is_not_null(),
        )
        .order_by(taskflow_project_member::ID.asc())
        .first()
        .await?;
    Ok(owner_member
        .and_then(|m| m.user.map(|u| u.id()))
        .or_else(|| project.owner.as_ref().map(|o| o.id())))
}

/// The org a project is in, if any.
pub async fn org_of_project(project: i64) -> Result<Option<i64>, DbError> {
    Ok(TaskflowOrgProject::objects()
        .filter(taskflow_org_project::PROJECT.eq(project))
        .first()
        .await?
        .map(|l| l.org.id()))
}

/// Link one unlinked project to its owner's personal org. `Ok(false)` when it
/// was already linked or has no owner to place it with.
pub async fn place_project(project: &TaskflowProject) -> Result<bool, DbError> {
    if org_of_project(project.id).await?.is_some() {
        return Ok(false);
    }
    let Some(owner) = project_owner(project).await? else {
        tracing::warn!(project = project.id, "org backfill: project has no owner; left without an org");
        return Ok(false);
    };
    let org = personal_org(owner).await?;
    let linked = TaskflowOrgProject::objects()
        .create(TaskflowOrgProject {
            id: 0,
            org: ForeignKey::new(org.id),
            project: ForeignKey::new(project.id),
            created_at: None,
        })
        .await;
    match linked {
        Ok(_) => Ok(true),
        // A concurrent placement won the unique `project`: already linked.
        Err(_) if org_of_project(project.id).await?.is_some() => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Place every unlinked project. Returns how many were linked now.
pub async fn backfill_once() -> Result<usize, DbError> {
    let linked: std::collections::HashSet<i64> =
        TaskflowOrgProject::objects().fetch().await?.into_iter().map(|l| l.project.id()).collect();
    let projects = TaskflowProject::objects().order_by(taskflow_project::ID.asc()).fetch().await?;
    let mut n = 0;
    for p in projects.iter().filter(|p| !linked.contains(&p.id)) {
        if place_project(p).await? {
            n += 1;
        }
    }
    if n > 0 {
        tracing::info!(linked = n, "org backfill: projects placed in their owner's personal org");
    }
    Ok(n)
}

/// Place one project by id (the post-create hook).
pub async fn place_project_id(project: i64) {
    let row = TaskflowProject::objects().filter(taskflow_project::ID.eq(project)).first().await;
    match row {
        Ok(Some(p)) => {
            if let Err(e) = place_project(&p).await {
                tracing::error!(project, error = %e, "org: could not place a new project");
            }
        }
        Ok(None) => {}
        Err(e) => tracing::error!(project, error = %e, "org: could not read a new project"),
    }
}

/// A fresh invite token (256 bits of uuid-v4 CSPRNG material) and its hash.
pub fn new_token() -> (String, String) {
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let hash = hash_token(&token);
    (token, hash)
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.trim().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A JSON map from pairs (for `update_values`).
pub fn values(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

pub fn role_json(r: TaskflowOrgRole) -> Value {
    json!(r.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("Supercode Hive!"), "supercode-hive");
        assert_eq!(slugify("  --  "), "org");
        assert_eq!(slugify("Ünïcode name"), "n-code-name");
    }

    #[test]
    fn tokens_hash_and_differ() {
        let (a, ha) = new_token();
        let (b, _) = new_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert_eq!(hash_token(&a), ha);
        assert_eq!(ha.len(), 64);
    }
}
