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

use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowChannelKind,
    taskflow_agent_channel_member,
};
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
    // Attachments are minted only by the trusted send endpoint (which stores
    // the file and denormalizes `project` from the channel); a client REST
    // create would insert a row pointing at a file it never uploaded. Read-only
    // so the frontend can still `.list()` them, scoped by project.
    "taskflow_message_attachment",
    // Read cursors are written ONLY through the trusted read endpoints
    // (`POST /api/taskflow/channels/{channel}/read` and its agent variant),
    // which derive the member identity server-side and advance forward only. A
    // client REST create/update could forge another member's cursor or move one
    // backwards. Read-only so clients can still `.list()` them to compute unread
    // counts, scoped by project.
    "taskflow_channel_read_cursor",
    // Task reviews are minted only by the trusted review endpoints
    // (`POST /api/taskflow/tasks/{task}/review` and its agent variant), which
    // derive the reviewer identity server-side and transition the task. A client
    // REST create could forge a reviewer or a decision. Read-only so the frontend
    // can still `.list()` them, scoped by project.
    "taskflow_task_review",
    // Prompts are written ONLY by the trusted agent endpoints (the hook reports
    // one, the agent clears it) and answered through
    // `POST /api/taskflow/prompts/{prompt}/answer`, which records who answered.
    // A client REST write could forge a question or an answer — and an answer is
    // keystrokes in someone's live terminal. Read-only so the frontend can still
    // `.list()` them.
    //
    // Being absent from this list entirely (as it was) did NOT hide the table:
    // auto-REST exposes every model, so it was served UNSCOPED — readable across
    // projects by any authenticated user.
    "taskflow_agent_prompt",
];

/// Tables whose rows belong to a CHANNEL and must follow its visibility rather
/// than the project's. Every one of these carries a `project` FK too, which is
/// exactly why project scope silently leaked DMs between members.
const CHANNEL_SCOPED_TABLES: &[&str] = &[
    "taskflow_agent_channel",
    "taskflow_agent_channel_member",
    "taskflow_agent_message",
    "taskflow_channel_read_cursor",
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


/// The channels a caller may SEE: every shared room in their active projects,
/// plus only the direct channels they are actually on the roster of.
///
/// Project scope alone is not enough for chat. `project_scope` restricts rows to
/// the caller's projects, which is right for tasks and agents — those are shared
/// workspace state. A DM is not: two people in the same project were being
/// served each other's private conversations, including message bodies, because
/// every row carried the same `project` FK.
///
/// Fails closed: any lookup error yields an empty list, which becomes `IN ()`.
async fn visible_channel_ids(identity: &Identity) -> Vec<String> {
    let Ok(user_id) = identity.pk::<i64>() else {
        return Vec::new();
    };
    let project_ids = taskflow_projects::scope::active_project_ids_for(identity).await;
    if project_ids.is_empty() {
        return Vec::new();
    }
    let projects: Vec<i64> = project_ids.iter().filter_map(|id| id.parse().ok()).collect();

    let channels = TaskflowAgentChannel::objects()
        .fetch()
        .await
        .unwrap_or_default();

    // The direct channels this user is rostered into. One query, then an
    // in-memory membership test — the roster is small.
    let my_channel_ids: std::collections::HashSet<i64> = TaskflowAgentChannelMember::objects()
        .filter(taskflow_agent_channel_member::USER.eq(user_id))
        .fetch()
        .await
        .unwrap_or_default()
        .iter()
        .map(|member| member.channel.id())
        .collect();

    channels
        .into_iter()
        .filter(|channel| projects.contains(&channel.project.id()))
        .filter(|channel| {
            // Shared rooms follow project membership; a DM follows its roster.
            channel.kind != TaskflowChannelKind::Direct || my_channel_ids.contains(&channel.id)
        })
        .map(|channel| channel.id.to_string())
        .collect()
}

/// Row scope for the chat tables: restrict `column` to [`visible_channel_ids`].
///
/// `column` is `"id"` for the channel table itself and `"channel"` for anything
/// hanging off one (messages, roster rows, read cursors).
pub fn channel_scope(column: &'static str) -> impl Fn(Option<Identity>) -> ScopeFuture + Clone {
    move |identity| {
        Box::pin(async move {
            match identity {
                Some(id) if id.is_superuser => ScopeDecision::All,
                Some(id) => {
                    ScopeDecision::RestrictIn(column.to_string(), visible_channel_ids(&id).await)
                }
                None => ScopeDecision::None,
            }
        })
    }
}

/// The `taskflow_project` resource, scoped by its own primary key to the
/// caller's active projects.
///
/// `create` is deliberately STRIPPED (`.views([List, Retrieve, Update, Delete])`):
/// an auto-REST create inserts a `taskflow_project` row but NO
/// `TaskflowProjectMember` row, and the SP-A scope above hides any project the
/// caller isn't an active member of — so an auto-REST-created project was an
/// orphan invisible to its own creator. Projects are now created only through the
/// authorized `POST /api/taskflow/projects` endpoint, which atomically creates
/// the project and an active owner membership. Update/Delete stay — the frontend
/// edits projects via PATCH, still governed by the `scope_async` row scope.
pub fn project_resource() -> ResourceConfig {
    ResourceConfig::new("taskflow_project")
        .scope_async(project_scope("id"))
        .views([
            Action::List,
            Action::Retrieve,
            Action::Update,
            Action::Delete,
        ])
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
        // The chat tables are scoped by CHANNEL VISIBILITY, not by project: a DM
        // must reach its two participants and nobody else, even though everyone
        // in the project shares its `project` FK.
        .filter(|table| !CHANNEL_SCOPED_TABLES.contains(*table))
        .map(|table| ResourceConfig::new(*table).scope_async(project_scope("project")));

    let chat = CHANNEL_SCOPED_TABLES.iter().map(|table| {
        let column = if *table == "taskflow_agent_channel" { "id" } else { "channel" };
        let config = ResourceConfig::new(*table).scope_async(channel_scope(column));
        match *table {
            // Channels are created, renamed, and archived ONLY through the
            // trusted POST /api/taskflow/channels endpoints — never through
            // auto-REST. An auto-REST create makes a channel with no roster —
            // invisible to its own creator, and impossible to join, because
            // add_channel_member needs a roster row that was never written.
            // Update/Delete are just as dangerous even though channel_scope
            // already limits a caller to channels they can see: every active
            // project member can see the shared project room, so PATCHing
            // `kind` to "direct" would hide it from every human (Direct
            // visibility requires a roster row that ensure_project_room never
            // writes for humans), and DELETE cascades every message in it
            // (`taskflow_agent_message.channel` is `on_delete = "cascade"`).
            // Nothing in the frontend or MCP layer ever calls either verb on
            // this table — auto-REST exposes reads only.
            "taskflow_agent_channel" => config.views([Action::List, Action::Retrieve]),
            // Roster rows are ACCESS-GRANTING: `visible_channel_ids` reads this
            // table to decide who may see a DM. Left writable, any project member
            // could POST themselves a row and the read scope would honour it —
            // the same escalation `taskflow_project_member` is read-only to
            // prevent. Rows come from channel creation or the trusted
            // POST /api/taskflow/channels/{channel}/members.
            "taskflow_agent_channel_member" => config.views([Action::List, Action::Retrieve]),
            // Messages are written ONLY by POST /api/taskflow/agents/messages,
            // which derives the sender from the caller's identity and checks they
            // are on the channel's roster. Left writable, auto-REST create takes
            // `sender_label`/`sender_user` verbatim from the body AND never
            // consults channel visibility — so any project member could forge a
            // message as someone else and inject it into a DM they cannot even
            // list, with the SSE fan-out delivering it to the real participants.
            // Read-only: the frontend lists messages constantly.
            "taskflow_agent_message" => config.views([Action::List, Action::Retrieve]),
            _ => config,
        }
    });

    let read_only = READ_ONLY_PROJECT_SCOPED_TABLES.iter().map(|table| {
        ResourceConfig::new(*table)
            .scope_async(project_scope("project"))
            .views([Action::List, Action::Retrieve])
    });

    writable.chain(chat).chain(read_only).collect()
}
