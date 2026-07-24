//! HTTP handlers for the `taskflow-tasks` plugin.

use taskflow_projects::scope::can_access_project;
use umbral::web::{Json, Path, StatusCode};
use umbral_auth::RequireAuth;

use crate::models::{TaskflowTaskActivity, taskflow_task_activity};

pub async fn health() -> &'static str {
    "taskflow-tasks:ok"
}

/// `GET /api/taskflow/projects/{project}/activity/actions`
///
/// #56: the distinct `action` values in a project's activity feed.
///
/// The activity page's tool filter is applied SERVER-side, which means the rows
/// it gets back depend on the filter — so a dropdown derived from those rows
/// narrows to its own selection and its contents shift as you page. A filter's
/// options have to come from a source the filter does not affect, and the REST
/// layer offers no distinct-values query, so this is the endpoint that provides
/// one. Fetched once per project.
///
/// Scoped like every other project route: a caller without active membership
/// gets 404 rather than 403, so the endpoint cannot be used to probe which
/// project ids exist.
#[derive(serde::Serialize)]
pub struct ActivityActions {
    pub actions: Vec<String>,
}

pub async fn activity_actions(
    RequireAuth(user_id): RequireAuth<i64>,
    Path(project_id): Path<i64>,
) -> Result<Json<ActivityActions>, StatusCode> {
    if !can_access_project(user_id, project_id).await {
        return Err(StatusCode::NOT_FOUND);
    }

    // Read the column and reduce in memory rather than SELECT DISTINCT: the ORM
    // has no distinct projection, and `action` is a short string — the whole
    // column for a busy project is a few hundred KB at worst, on a request that
    // runs once per project rather than per page.
    let rows = TaskflowTaskActivity::objects()
        .filter(taskflow_task_activity::PROJECT.eq(project_id))
        .fetch()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut actions: Vec<String> = rows.into_iter().map(|row| row.action).collect();
    actions.sort();
    actions.dedup();

    Ok(Json(ActivityActions { actions }))
}
