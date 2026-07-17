//! REST resource wiring — every project-scoped table restricted to the rows of
//! the caller's active projects.
//!
//! The bug this closes: each resource was a bare `ResourceConfig::new("…")`
//! under `default_permission(IsAuthenticated)` with no row scope, so any
//! logged-in user could list *every* project's data by id. Model-level
//! permission gates *whether* you may call the endpoint, never *which rows* you
//! get back — that is what [`ResourceConfig::scope_async`] is for.
//!
//! One factory, [`project_scope`], produces the per-request decision for all of
//! them so the superuser / anonymous / empty-membership branching lives in
//! exactly one place:
//!
//! - **superuser** → [`ScopeDecision::All`] (the `/admin` + seeded-superuser
//!   bypass), decided *before* any DB lookup;
//! - **anonymous** → [`ScopeDecision::None`];
//! - **authenticated** → `RestrictIn(col, my_active_project_ids)` — and an empty
//!   id list means `col IN ()` → zero rows, so "you joined nothing" fails closed
//!   to "you see nothing", never "you see everything".

use std::future::Future;
use std::pin::Pin;

use umbral_rest::{Identity, ResourceConfig, ScopeDecision};

/// Every project-scoped table, keyed by its `project` FK. `taskflow_project`
/// itself is scoped separately (by its own `id`) via [`project_resource`].
const PROJECT_SCOPED_TABLES: &[&str] = &[
    "taskflow_project_member",
    "taskflow_project_invite",
    "taskflow_project_api_endpoint",
    "taskflow_task",
    "taskflow_task_relation",
    "taskflow_task_activity",
    "taskflow_task_session",
    "taskflow_agent",
    "taskflow_agent_credential",
    "taskflow_agent_session",
    "taskflow_agent_channel",
    "taskflow_agent_channel_member",
    "taskflow_agent_message",
    "taskflow_agent_terminal_frame",
];

/// The boxed-future type a `scope_async` closure returns. Naming it keeps the
/// factory's signature readable.
type ScopeFuture = Pin<Box<dyn Future<Output = ScopeDecision> + Send>>;

/// Build the per-request row-scope closure that restricts `column` to the
/// caller's active project ids. `column` is `"id"` for `taskflow_project` and
/// `"project"` for every table that hangs off a project FK.
///
/// Factored out so the superuser / anonymous / membership branching is written
/// once, not copy-pasted across fifteen resources.
pub fn project_scope(column: &'static str) -> impl Fn(Option<Identity>) -> ScopeFuture + Clone {
    move |identity| {
        Box::pin(async move {
            match identity {
                // Superuser bypass — decided before touching the DB. "All
                // projects" is not expressible as a finite id list anyway.
                Some(id) if id.is_superuser => ScopeDecision::All,
                // Authenticated: the rows of the projects they actively belong
                // to. An empty list → `IN ()` → no rows (fail closed).
                Some(id) => ScopeDecision::RestrictIn(
                    column.to_string(),
                    taskflow_projects::scope::active_project_ids_for(&id).await,
                ),
                // Anonymous: nothing.
                None => ScopeDecision::None,
            }
        })
    }
}

/// The `taskflow_project` resource, scoped by its own primary key to the
/// caller's active projects.
pub fn project_resource() -> ResourceConfig {
    ResourceConfig::new("taskflow_project").scope_async(project_scope("id"))
}

/// Every project-scoped resource (all tables carrying a `project` FK), each
/// restricted to the caller's active projects.
pub fn project_scoped_resources() -> Vec<ResourceConfig> {
    PROJECT_SCOPED_TABLES
        .iter()
        .map(|table| ResourceConfig::new(*table).scope_async(project_scope("project")))
        .collect()
}
