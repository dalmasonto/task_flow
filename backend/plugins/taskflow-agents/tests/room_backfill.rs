//! The boot backfill — layer 2 of "every project has its two rooms".
//!
//! This lives in its OWN test binary, and that is deliberate rather than tidy:
//! the backfill is a GLOBAL sweep over every project, so run inside a binary that
//! also arranges project-scoped fixtures it repairs those fixtures' projects
//! while they are being arranged — a project's rooms appearing mid-arrange is
//! exactly what several of the `design_room.rs` tests assert cannot have happened
//! yet. Test binaries are separate processes with separate databases, so the
//! sweep cannot reach another file's projects from here, whatever order the
//! runner uses.

mod support;

use serde_json::json;
use support::{TestApp, seed_project_via_transaction, seed_room};
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentStatus,
    TaskflowChannelKind, taskflow_agent_channel, taskflow_agent_channel_member,
};
use taskflow_agents::signals::backfill_project_rooms;
use taskflow_agents::views::ensure_project_rooms;
use umbral::orm::ForeignKey;

/// The project's rooms carrying `marker`, asserting at most one — a second
/// marked room is the duplicate the "one per project" rule forbids (the marker
/// guard makes it a constraint violation, and this catches it if that guard ever
/// stops being installed).
async fn marked(project: i64, marker: fn(&TaskflowAgentChannel) -> bool) -> Vec<TaskflowAgentChannel> {
    let rooms: Vec<TaskflowAgentChannel> = TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(project))
        .fetch()
        .await
        .expect("load channels")
        .into_iter()
        .filter(marker)
        .collect();
    assert!(
        rooms.len() <= 1,
        "at most ONE room per marker per project, found {}",
        rooms.len()
    );
    rooms
}

async fn channel_count(project: i64) -> usize {
    TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(project))
        .fetch()
        .await
        .expect("load channels")
        .len()
}

async fn room_by_id(id: i64) -> TaskflowAgentChannel {
    TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(id))
        .first()
        .await
        .expect("load channel")
        .expect("channel exists")
}

// The boot sweep: a project that has NO rooms gets both, and a project whose only
// room predates the markers gets THAT room marked rather than a duplicate created
// beside it.
#[tokio::test]
async fn the_backfill_gives_rooms_to_projects_that_lack_them() {
    // The boot is the point: it registers the write signals and marks the plugin
    // ready. The sweep below is the backfill itself, called directly.
    let _app = TestApp::new().await;

    // Created the way the API creates one: an explicit transaction whose ORM
    // terminal emits no signal at all, so nothing has given it rooms.
    let bare = seed_project_via_transaction().await;
    let legacy_project = seed_project_via_transaction().await;
    let legacy = seed_room(
        legacy_project,
        TaskflowChannelKind::Project,
        "Channel 7",
        false,
        false,
    )
    .await;

    assert!(
        marked(bare, |c| c.is_public).await.is_empty()
            && marked(bare, |c| c.is_design).await.is_empty(),
        "PRECONDITION: a project created through the API's transaction path has no rooms yet. \
         If this fired, the creation path changed (see `signals.rs` — the ORM's transaction \
         terminal emits no signal) and this test's arrange needs reworking, not the backfill \
         deleting."
    );

    let repaired = backfill_project_rooms().await;
    assert!(repaired >= 2, "both projects are reported as repaired");

    assert!(
        !marked(bare, |c| c.is_public).await.is_empty(),
        "bare project: public room"
    );
    assert!(
        !marked(bare, |c| c.is_design).await.is_empty(),
        "bare project: design room"
    );
    assert_eq!(channel_count(bare).await, 2);

    let adopted = marked(legacy_project, |c| c.is_public).await;
    assert_eq!(
        adopted.first().map(|c| c.id),
        Some(legacy),
        "the legacy room was adopted by the sweep, not duplicated"
    );
    assert!(
        room_by_id(legacy).await.is_public,
        "and it is the same row, marked in place"
    );
    assert_eq!(
        room_by_id(legacy).await.title,
        "Channel 7",
        "adoption renames nothing"
    );
    assert_eq!(
        room_by_id(legacy).await.kind,
        TaskflowChannelKind::Project,
        "the marker selects it; the kind still says project-wide"
    );
    assert_eq!(
        json!(room_by_id(legacy).await.is_design),
        json!(false),
        "and it is not the design room"
    );

    // A second sweep has nothing left to do for THESE projects. The assertion is
    // deliberately about them and not about the sweep's global repair count: this
    // binary's other tests create projects while this one runs, and a count
    // assertion would fail whenever one appeared between the two sweeps.
    backfill_project_rooms().await;
    assert_eq!(
        marked(legacy_project, |c| c.is_public).await.first().map(|c| c.id),
        Some(legacy),
        "the second sweep re-marked nothing: the same row is still the public room"
    );
    assert!(
        !marked(legacy_project, |c| c.is_design).await.is_empty(),
        "and the design room is still there"
    );
    assert_eq!(channel_count(bare).await, 2, "the bare project still has exactly its pair");
    assert_eq!(channel_count(legacy_project).await, 2);
}

// A room created for a project that already has agents gives those agents a seat.
// Without this, an agent linked before the design room existed is missing from its
// roster — the user's rule is that an agent added to a project belongs to both
// rooms, and room creation is the moment the second room appears for a project
// that already had agents.
//
// The agent row is seeded directly because `link_agent` creates the rooms itself:
// it cannot produce "an agent in a project that has no design room", which is the
// state a project predating this feature is in.
//
// It drives `ensure_project_rooms` rather than the boot sweep, so this binary has
// exactly ONE caller of the global sweep (the test below): a second one repairs
// this file's other projects mid-arrange.
#[tokio::test]
async fn a_room_created_for_a_project_rosters_its_existing_agents() {
    let _app = TestApp::new().await;
    let project = seed_project_via_transaction().await;

    let agent = TaskflowAgent::objects()
        .create(TaskflowAgent {
            id: 0,
            project: ForeignKey::new(project),
            display_name: "Builder".to_string(),
            identifier: format!("agent:{project}:builder:main"),
            fingerprint: None,
            project_root: None,
            taskflow_file_path: None,
            runtime: None,
            version: None,
            status: TaskflowAgentStatus::Offline,
            linked_by: None,
            linked_user_label: None,
            last_seen_at: None,
            created_at: None,
        })
        .await
        .expect("create agent")
        .id;

    ensure_project_rooms(project).await.expect("ensure rooms");

    let public = marked(project, |c| c.is_public).await;
    let design = marked(project, |c| c.is_design).await;
    for (which, rooms) in [("public", public), ("design", design)] {
        let room = rooms.first().unwrap_or_else(|| panic!("{which} room exists"));
        assert!(
            agent_is_rostered(room.id, agent).await,
            "the {which} room the sweep created has the project's existing agent on its roster"
        );
    }
}

// The marker guard: one room per marker per project is not merely a convention
// the code follows — the database refuses a second one. That is what makes the
// markers unambiguous even if two callers race (the boot sweep against a live
// project write), which a get-or-create alone cannot promise.
#[tokio::test]
async fn a_second_marked_room_is_a_constraint_violation() {
    let _app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    ensure_project_rooms(project).await.expect("ensure rooms");

    let room = |is_public: bool, is_design: bool| {
        let project = project;
        async move {
            TaskflowAgentChannel::objects()
                .create(TaskflowAgentChannel {
                    id: 0,
                    project: ForeignKey::new(project),
                    title: "Another one".to_string(),
                    topic: None,
                    kind: TaskflowChannelKind::Project,
                    task: None,
                    created_by_user: None,
                    created_by_agent: None,
                    archived: false,
                    is_public,
                    is_design,
                    created_at: None,
                })
                .await
        }
    };

    assert!(
        room(true, false).await.is_err(),
        "a second is_public room in one project must be refused by the database"
    );
    assert!(
        room(false, true).await.is_err(),
        "a second is_design room in one project must be refused by the database"
    );
    // An ORDINARY room is still free to be created: the guard constrains the
    // markers, not the number of rooms a project may hold.
    assert!(
        room(false, false).await.is_ok(),
        "users may create as many ordinary rooms as they like"
    );
}

/// Is `agent` on `channel`'s roster?
async fn agent_is_rostered(channel: i64, agent: i64) -> bool {
    TaskflowAgentChannelMember::objects()
        .filter(
            taskflow_agent_channel_member::CHANNEL.eq(channel)
                & taskflow_agent_channel_member::AGENT.eq(agent),
        )
        .first()
        .await
        .expect("load roster row")
        .is_some()
}
