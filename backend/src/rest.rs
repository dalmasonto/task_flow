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

use umbral_rest::{Action, Identity, ResourceConfig, ScopeDecision};

/// Every project-scoped table, keyed by its `project` FK. `taskflow_project`
/// itself is scoped separately (by its own `id`) via [`project_resource`].
///
/// These are the tables the app legitimately *writes* from the client (create a
/// task, post a message, invite a teammate, …), so they keep the full CRUD
/// surface — restricted to the caller's active-project rows by [`project_scope`].
/// The server-managed / access-granting tables are NOT here — they are locked
/// read-only via [`READ_ONLY_PROJECT_SCOPED_TABLES`].
const PROJECT_SCOPED_TABLES: &[&str] = &[
    "taskflow_project_api_endpoint",
    "taskflow_task",
    "taskflow_task_relation",
    "taskflow_task_activity",
    "taskflow_task_session",
    "taskflow_agent",
    "taskflow_agent_channel",
    "taskflow_agent_channel_member",
    "taskflow_agent_message",
    "taskflow_agent_terminal_frame",
];

/// Project-scoped tables the client may only ever READ, never create/update/
/// delete through auto-REST. Each is server-managed and access-granting, so a
/// direct client write is both unnecessary and a privilege-escalation vector:
///
/// - **`taskflow_project_member`** — the escalation vector. `scope_async` only
///   governs reads (list/retrieve/update/delete), NOT create, and `status` is a
///   client-writable column. Left writable, any authenticated non-member could
///   `POST {project:P, user:<self>, status:"active", …}` to grant themselves an
///   ACTIVE membership, which the read-scope then honours — opening project P's
///   tasks, messages, `agent_credential.key_hash`, and every `project:P:*`
///   realtime room. Membership must come from the seed and the (SP-B)
///   invite-accept endpoint, never from client REST.
/// - **`taskflow_agent_credential`** — holds `key_hash`; only ever minted
///   server-side.
/// - **`taskflow_agent_session`** — managed by the agent runtime.
/// - **`taskflow_project_invite`** — the invite is the thing project membership
///   is minted from (SP-B's accept endpoint only checks that the invite's
///   `email` matches the caller). Left writable, any authenticated user could
///   `POST {project:<any>, email:<self>, role:"owner", status:"pending",
///   invite_token:"x"}` (create is unscoped → 201) and then accept it (email
///   matches their own account) to become an active OWNER of a project they
///   were never part of — a full takeover that defeats the read-scope. Invites
///   are now minted only by the authorized `POST
///   /api/taskflow/projects/{project}/invites` endpoint (owner/admin-gated,
///   server-generated token); an invitee reads their own invites through the
///   separate `/api/taskflow/projects/invites/mine` endpoint, so read-only here
///   costs the app nothing.
///
/// The frontend only ever `.list()`s these tables (see `v2_fe/src/lib/
/// taskflow-api.ts`), so read-only is a no-op for the app and closes the hole.
const READ_ONLY_PROJECT_SCOPED_TABLES: &[&str] = &[
    "taskflow_project_member",
    "taskflow_agent_credential",
    "taskflow_agent_session",
    "taskflow_project_invite",
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

/// Per-user settings — READ-ONLY over REST, owner-scoped.
///
/// `owned_by("user")` restricts list/retrieve to the caller's own row (another
/// user's settings 404, never leak), and `.views([List, Retrieve])` strips the
/// write actions entirely. Writes are deliberately NOT exposed through auto-REST:
/// `owner_field` only guards the *create* path, so a client could otherwise
/// `PATCH /taskflow_user_settings/{id}` with a body-supplied `user` and reassign
/// its own row to another account (a write-side IDOR that `owned_by` alone does
/// not close — the scope governs *which* row, not the *new* `user` value).
///
/// Reads use the plugin's get-or-create `GET /api/taskflow/user/settings`; writes
/// use `POST /api/taskflow/user/settings`, both keyed purely on the authenticated
/// identity — there is no `user` field for a client to lie in.
pub fn user_settings_resource() -> ResourceConfig {
    ResourceConfig::new("taskflow_user_settings")
        .owned_by("user")
        .views([Action::List, Action::Retrieve])
}

/// Every project-scoped resource (all tables carrying a `project` FK), each
/// restricted to the caller's active projects.
///
/// The server-managed / access-granting tables in
/// [`READ_ONLY_PROJECT_SCOPED_TABLES`] additionally have their write actions
/// (create/update/delete) stripped via `.views([List, Retrieve])`, so a caller
/// cannot `POST` a row into them at all — closing the self-service membership
/// escalation that `scope_async` alone leaves open (it governs reads, not
/// creates).
pub fn project_scoped_resources() -> Vec<ResourceConfig> {
    let writable = PROJECT_SCOPED_TABLES
        .iter()
        .map(|table| ResourceConfig::new(*table).scope_async(project_scope("project")));

    let read_only = READ_ONLY_PROJECT_SCOPED_TABLES.iter().map(|table| {
        ResourceConfig::new(*table)
            .scope_async(project_scope("project"))
            .views([Action::List, Action::Retrieve])
    });

    writable.chain(read_only).collect()
}
