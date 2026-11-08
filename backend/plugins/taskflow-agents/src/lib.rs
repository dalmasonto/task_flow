//! TaskflowAgentsPlugin - agent identity, sessions, group chat, and terminal log.
//!
//! A plugin split one file per concern:
//!
//!   src/
//!     lib.rs     — the `Plugin` impl: glues models + routes together (this file)
//!     models.rs  — `#[derive(Model)]` structs (this app's tables)
//!     views.rs   — HTTP handlers
//!     urls.rs    — the URL conf: maps paths to `views::` handlers
//!     signals.rs — the project-write -> "both rooms exist" bridge + backfill
//!
//! Wire this into your App by adding to `src/main.rs`:
//!
//! ```ignore
//! .plugin(taskflow_agents::TaskflowAgentsPlugin::default())
//! ```
//!
//! See `documentation/docs/v0.0.1/plugins/the-plugin-trait.mdx` for
//! what each `Plugin` method does. This layout is a recommended
//! convention — the framework only needs a type that impls `Plugin`.

pub mod agent_auth;
pub mod answers;
pub mod channel_state;
pub mod claims;
// #1125: post_save for a row written by a guarded column update.
pub mod emit;
// #1126: claim leases (release a silent agent's claims).
pub mod leases;
pub mod wakeups;
pub mod models;
// #525: posting from inside another tool (deliver), one membership rule.
pub mod posting;
pub mod evidence;
pub mod questions;
// Chat threads: placement, targets, reads.
pub mod threads;
pub mod review_requests;
// #605: credential scopes — the allowlist and the canonical stored form.
pub mod scopes;
pub mod signals;
pub mod urls;
pub mod views;

use umbral::plugin::{AppContext, Plugin, PluginError, block_on_ready};
use umbral::web::Router;

#[derive(Debug, Default, Clone)]
pub struct TaskflowAgentsPlugin;

impl Plugin for TaskflowAgentsPlugin {
    fn name(&self) -> &'static str {
        "taskflow_agents"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &["auth", "taskflow_projects", "taskflow_tasks"]
    }

    fn models(&self) -> Vec<umbral::migrate::ModelMeta> {
        vec![
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgent>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentCredential>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentSession>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentChannel>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentChannelMember>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentMessage>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowMessageAttachment>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowMessageAnswer>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowMessageClaim>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowWakeRule>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowChannelState>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowChannelReadCursor>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentTerminalFrame>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTaskReview>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowReviewRequest>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTaskEvidence>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowAgentPrompt>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowTerminalInput>(),
            umbral::migrate::ModelMeta::for_::<models::TaskflowRealtimeTicket>(),
        ]
    }

    fn routes(&self) -> Router {
        // Routes live in `urls.rs` (this app's URL conf), one place to
        // see every path the plugin serves.
        urls::router()
    }

    fn on_ready(&self, ctx: &AppContext) -> Result<(), PluginError> {
        // Every project must have its two rooms (the public one and the design
        // one). Three layers deliver that, and no single one of them is trusted:
        //
        //   1. the project write signals (below),
        //   2. this boot-time backfill, and
        //   3. `link_agent`, the choke point for "agent added to a project".
        //
        // All three call the same idempotent `views::ensure_project_rooms`, so
        // the invariant is enforced rather than hoped for — see `signals.rs` for
        // what each layer covers, and for the one write path (`create_project`,
        // through the ORM's transaction terminal) that emits no signal at all.
        //
        // The durable guard goes in FIRST: `ensure_project_rooms` is
        // get-or-create, so two callers racing (this backfill against a live
        // write and vice versa) could otherwise both create a marked room, and a
        // second marked room is exactly the ambiguity the markers exist to
        // remove.
        block_on_ready(signals::install_room_marker_guard(&ctx.pool))?;
        // #1095: at most one open claim per message, enforced by the database.
        block_on_ready(claims::install_claim_guard(&ctx.pool))?;
        // #1098: at most one open review request per (task, reviewer).
        block_on_ready(review_requests::install_review_request_guard(&ctx.pool))?;
        // #1113: wake-up rules — event hooks and the time sweep.
        wakeups::register();
        // #1126: release claims of agents that went silent.
        leases::start();

        signals::subscribe();

        // The backfill runs OFF the boot path: it is a full table walk, and
        // nothing may depend on it having finished before the first request. A
        // project it has not reached yet is repaired by the signal on its next
        // write, by a link, or by a channel create.
        tokio::spawn(async move {
            let repaired = signals::backfill_once().await;
            tracing::debug!(projects = repaired, "taskflow-agents room backfill done");
        });

        Ok(())
    }
}
