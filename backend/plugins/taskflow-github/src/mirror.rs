//! Post a task comment to the linked GitHub issue, as the acting user.
//!
//! One gated implementation shared by every caller — the human comment endpoint
//! (`views::comment_on_issue`) and the agent activity ingest (in
//! `taskflow-agents`). The safety rule from #25 lives here: post under the
//! acting person's own key, and only when they're connected AND opted in
//! (`post_as_me`); otherwise `NeedsConnect`, never a fallback to another key.

use taskflow_projects::models::{TaskflowProject, taskflow_project};
use taskflow_tasks::models::{TaskflowTask, taskflow_task};

use crate::api::GithubApi;
use crate::models::{TaskflowGithubPref, taskflow_github_pref};
use crate::tokens::{GithubTokenSource, TokenOutcome, resolve_actor_token};

/// What happened when we tried to mirror a comment to GitHub.
#[derive(Debug, PartialEq, Eq)]
pub enum MirrorOutcome {
    /// Comment posted to the issue.
    Posted,
    /// The project has no linked repo.
    NotLinked,
    /// The task has no GitHub issue yet.
    NotPublished,
    /// The acting user isn't connected or hasn't opted in — no post made.
    NeedsConnect,
}

#[derive(Debug)]
pub enum MirrorError {
    Db,
    Github(String),
}

/// Post `body` to the task's GitHub issue on behalf of `actor_user_id`.
pub async fn mirror_comment(
    api: &dyn GithubApi,
    tokens: &dyn GithubTokenSource,
    project_id: i64,
    task_id: i64,
    actor_user_id: i64,
    body: &str,
) -> Result<MirrorOutcome, MirrorError> {
    let project = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project_id))
        .first()
        .await
        .map_err(|_| MirrorError::Db)?
        .ok_or(MirrorError::Db)?;
    let Some(repo) = project.github_repo.clone() else {
        return Ok(MirrorOutcome::NotLinked);
    };

    let task = TaskflowTask::objects()
        .filter(taskflow_task::ID.eq(task_id) & taskflow_task::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|_| MirrorError::Db)?
        .ok_or(MirrorError::Db)?;
    let Some(issue_number) = task.github_issue_number else {
        return Ok(MirrorOutcome::NotPublished);
    };

    // Opt-in: default false when no pref row exists for this (user, project).
    let post_as_me = TaskflowGithubPref::objects()
        .filter(
            taskflow_github_pref::USER.eq(actor_user_id)
                & taskflow_github_pref::PROJECT.eq(project_id),
        )
        .first()
        .await
        .map_err(|_| MirrorError::Db)?
        .map(|pref| pref.post_as_me)
        .unwrap_or(false);

    let token = match resolve_actor_token(tokens, actor_user_id, post_as_me).await {
        TokenOutcome::Ready(token) => token,
        TokenOutcome::NeedsConnect => return Ok(MirrorOutcome::NeedsConnect),
    };

    api.add_comment(&token, &repo, issue_number, body)
        .await
        .map_err(|error| MirrorError::Github(format!("{error:?}")))?;
    Ok(MirrorOutcome::Posted)
}
