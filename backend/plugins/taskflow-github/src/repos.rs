//! #606: which repo a project — and a task — is talking about.
//!
//! One place resolves it, because four callers need the same answer (publish,
//! mirror, the status panel, the agent tools) and they must not each invent a
//! fallback:
//!
//!   the task's own `github_repo`, else the project's default.
//!
//! The list of linked repos is what authorizes a name: publishing into a repo a
//! project has since dropped is refused, so an old row cannot push anywhere the
//! project no longer points at.

use taskflow_projects::models::{TaskflowProject, taskflow_project};

use crate::models::{TaskflowProjectRepo, taskflow_project_repo};

/// `owner/name`, GitHub's own spelling. Refused here rather than at GitHub, so
/// a typo is a 400 with a reason instead of a 502 from the API.
pub fn valid_repo(repo: &str) -> bool {
    let (owner, name) = match repo.split_once('/') {
        Some(parts) => parts,
        None => return false,
    };
    if name.contains('/') {
        return false;
    }
    let ok = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    ok(owner) && ok(name)
}

/// Every repo the project links, default first.
///
/// A project linked before this table existed (or through the legacy `link`
/// endpoint) has its repo only in `TaskflowProject.github_repo`. That link IS
/// its first repo, so it is materialised here — a one-time, idempotent
/// backfill on the first read, which is what keeps `remove` and `set-default`
/// operating on real rows instead of a name that cannot be updated.
pub async fn linked(project_id: i64) -> Vec<TaskflowProjectRepo> {
    let rows = TaskflowProjectRepo::objects()
        .filter(taskflow_project_repo::PROJECT.eq(project_id))
        .fetch()
        .await
        .unwrap_or_default();

    if let Ok(Some(project)) = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
    {
        if let Some(repo) = project.github_repo.as_deref() {
            if !rows.iter().any(|row| row.repo == repo) {
                if let Ok(created) = TaskflowProjectRepo::objects()
                    .create(TaskflowProjectRepo {
                        id: 0,
                        project: umbral::orm::ForeignKey::new(project_id),
                        repo: repo.to_string(),
                        is_default: true,
                        created_at: None,
                    })
                    .await
                {
                    let mut rows = rows;
                    rows.push(created);
                    return sorted(rows);
                }
            }
        }
    }
    sorted(rows)
}

fn sorted(mut rows: Vec<TaskflowProjectRepo>) -> Vec<TaskflowProjectRepo> {
    rows.sort_by_key(|row| (!row.is_default, row.id));
    rows
}

/// Is `repo` one the project still points at? The legacy column counts: a
/// project linked before this table existed has no rows yet, and its default
/// repo must keep working.
pub async fn is_linked(project: &TaskflowProject, repo: &str) -> bool {
    if project.github_repo.as_deref() == Some(repo) {
        return true;
    }
    TaskflowProjectRepo::objects()
        .filter(taskflow_project_repo::PROJECT.eq(project.id) & taskflow_project_repo::REPO.eq(repo))
        .first()
        .await
        .ok()
        .flatten()
        .is_some()
}

/// The repo a task works in: its own when it names one, else the project's
/// default. `None` means the project is not linked at all.
pub fn for_task(task_repo: Option<&str>, project: &TaskflowProject) -> Option<String> {
    task_repo
        .map(str::to_string)
        .or_else(|| project.github_repo.clone())
}
