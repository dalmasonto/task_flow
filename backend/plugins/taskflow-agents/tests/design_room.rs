//! The two rooms a project owns — the public room and the design room — are
//! marked by PROPERTY (`is_public` / `is_design`) and found by property alone.
//!
//! Before this, design messages lived in the project room and were told apart by
//! a client-declared `is_design` flag, and "the project room" meant "the earliest
//! Project-kind channel, else any non-DM channel". Both are ambiguous the moment
//! a project holds anything else — a design room, a user's #42 Group, a task
//! room — which is exactly what users are free to create. These tests pin the
//! replacement:
//!
//!   * both rooms exist (created by the project-write signal, by the boot
//!     backfill, by `link_agent`, or by a human's channel request) and are
//!     created together;
//!   * `ensure_project_rooms` is idempotent and adopts — never duplicates — a
//!     project room that predates the marker column;
//!   * neither finder answers with the OTHER room, or with a user's room;
//!   * a project's existing design history is adopted when the design room is
//!     created — only that project's, and only from rooms the whole project can
//!     read;
//!   * `is_design` on a message is derived from the destination room, whatever
//!     the client sent.

mod support;

use serde_json::json;
use support::{
    TestApp, make_active_project_member, seed_project, seed_project_via_transaction, seed_room,
};
use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind,
    TaskflowChannelMemberKind, TaskflowMessageAttachment, TaskflowMessagePriority,
    taskflow_agent_channel, taskflow_agent_channel_member, taskflow_agent_message,
    taskflow_message_attachment,
};
use taskflow_agents::views::ensure_project_rooms;
use taskflow_projects::models::{TaskflowProject, taskflow_project};
use umbral::orm::{FileField, ForeignKey};

/// The titles the plan fixes. Nothing SELECTS a room by title — the tests that
/// matter seed differently-titled rooms on purpose — so these are asserted only
/// where the room is first created.
const PUBLIC_ROOM_TITLE: &str = "Project room";
const DESIGN_ROOM_TITLE: &str = "Design room";

/// Every channel in `project`, earliest first.
async fn channels(project: i64) -> Vec<TaskflowAgentChannel> {
    TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::PROJECT.eq(project))
        .order_by(taskflow_agent_channel::ID.asc())
        .fetch()
        .await
        .expect("load channels")
}

/// The project's rooms carrying `marker`, asserting there is at most ONE — a
/// second marked room is the duplicate the "one per project" rule forbids, and
/// quietly taking the first would hide it.
async fn marked(project: i64, marker: fn(&TaskflowAgentChannel) -> bool) -> Vec<TaskflowAgentChannel> {
    let rooms: Vec<TaskflowAgentChannel> = channels(project)
        .await
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

async fn public_room(project: i64) -> Option<TaskflowAgentChannel> {
    marked(project, |c| c.is_public).await.into_iter().next()
}

async fn design_room(project: i64) -> Option<TaskflowAgentChannel> {
    marked(project, |c| c.is_design).await.into_iter().next()
}

async fn room_by_id(id: i64) -> TaskflowAgentChannel {
    TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(id))
        .first()
        .await
        .expect("load channel")
        .expect("channel exists")
}

/// Load a message row, so assertions read what was STORED rather than what the
/// endpoint echoed back.
async fn message_row(id: i64) -> TaskflowAgentMessage {
    TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::ID.eq(id))
        .first()
        .await
        .expect("load message")
        .expect("message exists")
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

/// Mint an agent as `user`, returning `(key, agent_id)`. This is the LINK path —
/// the same one `create_channel.rs` and `tasks_review.rs` use.
async fn mint_agent(
    app: &TestApp,
    user: i64,
    project: i64,
    display_name: &str,
    profile: &str,
) -> (String, i64) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": display_name, "profile": profile }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    let body = resp.json().await;
    (
        body["key"].as_str().expect("key").to_string(),
        body["agent_id"].as_i64().expect("agent_id"),
    )
}

/// Seed a message directly in `channel` with an explicit `is_design` flag.
/// `support::seed_message` pins the flag false, and the flag is the entire point
/// here, so these tests seed their own rows.
async fn seed_flagged_message(project: i64, channel: i64, is_design: bool) -> i64 {
    TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(channel),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: None,
            sender_agent: None,
            target_agent: None,
            targets: None,
            sender_label: "Seeder".to_string(),
            body_markdown: format!("seeded design={is_design}"),
            priority: TaskflowMessagePriority::Normal,
            is_design,
            client_nonce: None,
            edited_at: None,
            created_at: None,
        })
        .await
        .expect("create message")
        .id
}

/// Seed an attachment row for `message`, denormalizing `channel` exactly as the
/// send endpoint does (that column is what the REST scope filters on).
async fn seed_attachment(project: i64, message: i64, channel: i64) -> i64 {
    TaskflowMessageAttachment::objects()
        .create(TaskflowMessageAttachment {
            id: 0,
            message: ForeignKey::new(message),
            project: ForeignKey::new(project),
            channel: Some(ForeignKey::new(channel)),
            file: FileField::from(format!("seed-key-{message}")),
            name: "sketch.png".to_string(),
            content_type: "image/png".to_string(),
            size_bytes: 12,
            created_at: None,
        })
        .await
        .expect("create attachment")
        .id
}

async fn attachment_row(id: i64) -> TaskflowMessageAttachment {
    TaskflowMessageAttachment::objects()
        .filter(taskflow_message_attachment::ID.eq(id))
        .first()
        .await
        .expect("load attachment")
        .expect("attachment exists")
}

// ---------------------------------------------------------------------------
// Both rooms, created together, found by property
// ---------------------------------------------------------------------------

// `ensure_project_rooms` creates BOTH rooms, marked, and is idempotent: a second
// call creates nothing and answers with the same two rooms.
#[tokio::test]
async fn ensure_project_rooms_creates_both_rooms_and_is_idempotent() {
    // The boot is the point: it registers the project-write signals and runs the
    // plugin's `on_ready`. No request is made here.
    let _app = TestApp::new().await;
    // The transaction path: the project starts with no rooms, so the two below
    // are this call's work and not the write signal's.
    let project = seed_project_via_transaction().await;

    let (public, design) = ensure_project_rooms(project).await.expect("ensure rooms");

    assert_ne!(public.id, design.id, "two rooms, not one");
    assert!(public.is_public && !public.is_design, "the public room's markers");
    assert!(design.is_design && !design.is_public, "the design room's markers");
    // Both keep kind = Project: that is what makes the existing visibility gates
    // (project-wide for every non-Direct/non-Group kind) treat them as shared
    // rooms. The markers select them, never the kind.
    assert_eq!(public.kind, TaskflowChannelKind::Project);
    assert_eq!(design.kind, TaskflowChannelKind::Project);
    assert_eq!(public.title, PUBLIC_ROOM_TITLE);
    assert_eq!(design.title, DESIGN_ROOM_TITLE);

    // Idempotent: the same two rooms, and nothing new in the project.
    let (public_again, design_again) = ensure_project_rooms(project).await.expect("ensure again");
    assert_eq!(public_again.id, public.id, "the public room is reused");
    assert_eq!(design_again.id, design.id, "the design room is reused");
    assert_eq!(
        channels(project).await.len(),
        2,
        "exactly the two rooms — a third would be a duplicate"
    );

    // The cross-task contract: the frontend selects these rooms by reading
    // THESE field names off the channel JSON.
    let value = serde_json::to_value(&public).expect("serialize channel");
    assert_eq!(value["is_public"], json!(true));
    assert_eq!(value["is_design"], json!(false));
}

// The misroute the property lookup closes, in one arrange: a project whose only
// rooms are a USER's room (titled "Project room", so a title-based selector takes
// it) and the MARKED design room. `find_public_room` must answer with neither, so
// `ensure_project_rooms` creates a real public room and leaves the user's room
// exactly as it found it.
//
// This is the test the reverted predicates die on: selecting the public room by
// `kind == Project` answers with the DESIGN room (also Project-kind), and the
// old "else any non-Direct channel" fallback answers with the user's GROUP room.
#[tokio::test]
async fn the_public_room_is_never_the_design_room_or_a_users_room() {
    // The boot is the point: it registers the project-write signals and runs the
    // plugin's `on_ready`. No request is made here.
    let _app = TestApp::new().await;
    // The transaction path, so the project starts with NO rooms: a `seed_project`
    // would already have been given both by the project-write signal, and this
    // test is about which room the finders choose.
    let project = seed_project_via_transaction().await;

    // Seeded FIRST, so a fallback that takes "the first non-Direct channel"
    // reaches it before anything else.
    let users_room = seed_room(project, TaskflowChannelKind::Group, PUBLIC_ROOM_TITLE, false, false).await;
    let design = seed_room(project, TaskflowChannelKind::Project, DESIGN_ROOM_TITLE, false, true).await;

    let public = ensure_project_rooms(project)
        .await
        .expect("ensure rooms")
        .0;

    assert_ne!(public.id, users_room, "the public room is NOT the user's room");
    assert_ne!(public.id, design, "the public room is NOT the design room");
    assert!(public.is_public, "and it is the one carrying the marker");
    assert_eq!(public.kind, TaskflowChannelKind::Project);

    // The user's room is untouched: neither marker, same kind, same title, still
    // one room — the "users may create other rooms, harmlessly" rule.
    let users_room = room_by_id(users_room).await;
    assert!(
        !users_room.is_public && !users_room.is_design,
        "a user's room carries neither project marker"
    );
    assert_eq!(users_room.kind, TaskflowChannelKind::Group);
    assert_eq!(users_room.title, PUBLIC_ROOM_TITLE);
    assert_eq!(channels(project).await.len(), 3, "user room + design + public");

    // The design room is still the design room — and there is still exactly one.
    assert_eq!(design_room(project).await.expect("design room").id, design);
}

// The design room is found by its MARKER, not by its name: a user is free to
// create a room called "Design room" (titles are cosmetic — see ruling 4), and
// the design conversation must still be the room that IS the design room.
//
// This is the test a title-based selector dies on: it answers with the user's
// room, so `ensure_project_rooms` reports a "design room" that is not the marked
// one, and the marked room is left beside it.
#[tokio::test]
async fn the_design_room_is_not_whatever_is_titled_design_room() {
    let _app = TestApp::new().await;
    let project = seed_project_via_transaction().await;

    // A user's room, named exactly what the design room is usually named.
    let users_room = seed_room(
        project,
        TaskflowChannelKind::Group,
        DESIGN_ROOM_TITLE,
        false,
        false,
    )
    .await;
    // The real design room, deliberately titled something else.
    let design = seed_room(project, TaskflowChannelKind::Project, "Channel 7", false, true).await;

    let (_public, found) = ensure_project_rooms(project).await.expect("ensure rooms");

    assert_eq!(found.id, design, "the marked room is THE design room");
    assert!(found.is_design);
    assert_eq!(found.title, "Channel 7", "and its title is irrelevant");

    let rooms = marked(project, |c| c.is_design).await;
    assert_eq!(rooms.len(), 1, "no second design room was created beside it");

    let users_room = room_by_id(users_room).await;
    assert!(
        !users_room.is_public && !users_room.is_design,
        "the user's room kept both markers false, exactly as it was seeded"
    );
    assert_eq!(users_room.title, DESIGN_ROOM_TITLE, "and its name");
}

// A project room that predates the `is_public` column carries BOTH markers false
// — indistinguishable from a user's room, which is the ambiguity the markers
// remove. It must be MARKED, in place: a duplicate would leave the project with
// two rooms claiming to be the public one, and the old one orphaned from design
// and review traffic.
#[tokio::test]
async fn a_project_room_that_predates_the_markers_is_marked_not_duplicated() {
    // The boot is the point: it registers the project-write signals and runs the
    // plugin's `on_ready`. No request is made here.
    let _app = TestApp::new().await;
    // The transaction path: with `seed_project` the signal would have given the
    // project a MARKED public room already, and there would be no legacy room to
    // adopt.
    let project = seed_project_via_transaction().await;

    // The pre-marker shape: a Project-kind room, no markers, an ordinary title.
    let legacy = seed_room(project, TaskflowChannelKind::Project, "Channel 7", false, false).await;

    let (public, design) = ensure_project_rooms(project).await.expect("ensure rooms");

    assert_eq!(
        public.id, legacy,
        "the room that already existed IS the public room now"
    );
    assert!(
        room_by_id(legacy).await.is_public,
        "and it was marked, not replaced"
    );
    assert_eq!(
        room_by_id(legacy).await.title,
        "Channel 7",
        "adoption renames nothing — the title was never load-bearing"
    );
    assert_eq!(design.kind, TaskflowChannelKind::Project);
    assert!(design.is_design);
    assert_eq!(
        channels(project).await.len(),
        2,
        "the legacy room plus the design room — no third room was minted"
    );

    // Still idempotent after the adoption: nothing is re-marked or re-created.
    let (public_again, design_again) = ensure_project_rooms(project).await.expect("ensure again");
    assert_eq!(public_again.id, legacy);
    assert_eq!(design_again.id, design.id);
}

// A review on a project that has NO rooms still reports back: `apply_review`
// ENSURES the pair rather than merely looking one up.
//
// Without that, the report-back is silently skipped and the agent never learns
// its task was reviewed — the exact failure the room-ensuring paths exist to
// prevent (`ensure_project_room`'s own doc says so). The project here is created
// the way the API creates one (no signal) and its agent is seeded directly,
// because `link_agent` — the other path that would create the rooms — is what
// this test needs to stay out of the way.
#[tokio::test]
async fn a_review_on_a_roomless_project_still_reports_back() {
    use taskflow_agents::models::{TaskflowAgent, TaskflowAgentStatus};
    use taskflow_tasks::models::{TaskflowTask, TaskflowTaskPriority, TaskflowTaskStatus};

    let app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

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

    let task = TaskflowTask::objects()
        .create(TaskflowTask {
            id: 0,
            project: ForeignKey::new(project),
            title: "Ship the thing".to_string(),
            description_markdown: String::new(),
            notes_markdown: None,
            status: TaskflowTaskStatus::PartialDone,
            priority: TaskflowTaskPriority::Normal,
            sort_order: 0,
            created_by: None,
            created_by_agent_id: None,
            assigned_user: None,
            assigned_agent_id: None,
            operator_user: None,
            operator_agent_id: Some(agent),
            review_gate: None,
            estimate_minutes: None,
            assignee_label: None,
            due_at: None,
            closed_at: None,
            github_issue_number: None,
            github_issue_url: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create task")
        .id;

    assert!(
        public_room(project).await.is_none(),
        "PRECONDITION: the project has no rooms before the review"
    );

    let reviewed = app
        .post_as(
            user,
            &format!("/api/taskflow/tasks/{task}/review"),
            json!({ "decision": "changes_requested" }),
        )
        .await;
    assert_eq!(reviewed.status(), 200, "body: {:?}", reviewed.json().await);

    // The report-back exists AND went to the room the review made.
    let report = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::TASK.eq(task))
        .first()
        .await
        .expect("load report-back")
        .expect("the report-back was not silently dropped");
    let public = public_room(project)
        .await
        .expect("the review created the project's rooms");
    assert_eq!(report.channel.id(), public.id);
}

// ---------------------------------------------------------------------------
// The layers that create the rooms
// ---------------------------------------------------------------------------
//
// Layer 2, the boot backfill, is a GLOBAL sweep and lives in
// `tests/room_backfill.rs`: run inside this binary it would repair the projects
// arranged below while they are being arranged.

// Layer 1, the signal, on its per-row path (`Manager::save` → `post_save`): a
// project write brings the rooms into existence for a project that has none.
#[tokio::test]
async fn a_project_save_creates_both_rooms() {
    // Booted for the signal registration the save below is expected to reach.
    let _app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    assert!(
        public_room(project).await.is_none(),
        "PRECONDITION: no rooms before the write (see signals.rs on why this path emits nothing)"
    );

    let row = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .first()
        .await
        .expect("load project")
        .expect("project exists");
    TaskflowProject::objects()
        .save(row)
        .await
        .expect("save project");

    assert!(public_room(project).await.is_some(), "the save created the public room");
    assert!(design_room(project).await.is_some(), "and the design room");
}

// Layer 1, the BULK path (`update_values` → `bulk_post_save`, the shape
// umbral-rest's dashboard PATCH takes, whose payload carries ids and no
// instance). A subscriber that knew only the per-row signal would miss this
// write — and vice versa, which is why both are registered.
#[tokio::test]
async fn a_project_bulk_update_creates_both_rooms() {
    // Booted for the signal registration the bulk update below is expected to reach.
    let _app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    assert!(public_room(project).await.is_none(), "PRECONDITION: no rooms before the write");

    let affected = TaskflowProject::objects()
        .filter(taskflow_project::ID.eq(project))
        .update_values(
            json!({ "description_markdown": "edited through the bulk path" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )
        .await
        .expect("bulk update");
    assert_eq!(affected, 1, "the update matched the project");

    assert!(public_room(project).await.is_some(), "the bulk update created the public room");
    assert!(design_room(project).await.is_some(), "and the design room");
}

// Layer 3, `link_agent` — the choke point for "agent added to a project": both
// rooms exist afterwards, and the agent is on BOTH rosters, so it can answer a
// design request immediately rather than only once a human opens the design page.
#[tokio::test]
async fn link_agent_creates_both_rooms_and_rosters_the_agent_in_both() {
    let app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let (_, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    let public = public_room(project).await.expect("public room exists");
    let design = design_room(project).await.expect("design room exists");
    assert_ne!(public.id, design.id);
    assert_eq!(design.title, DESIGN_ROOM_TITLE);

    assert!(agent_is_rostered(public.id, agent_id).await, "rostered in the public room");
    assert!(agent_is_rostered(design.id, agent_id).await, "and in the design room");

    // A second agent, linked when the rooms ALREADY exist. Its seat comes from
    // `link_agent` itself: the create path (`ensure_project_rooms` rostering the
    // project's agents) cannot cover it, because this agent did not exist when
    // the rooms were made.
    let (_, later_agent) = mint_agent(&app, user, project, "Reviewer", "reviewer").await;
    assert!(
        agent_is_rostered(public.id, later_agent).await,
        "an agent linked after the rooms exist is rostered in the public room"
    );
    assert!(
        agent_is_rostered(design.id, later_agent).await,
        "and in the design room"
    );
    assert_eq!(channels(project).await.len(), 2, "and linking minted no third room");
}

// The human path: a `kind = project` channel request is get-or-create for the
// MARKED public room, and because the invariant is "both rooms or neither", the
// same request is what gives a project with no agents a design room. A second
// request reuses both (200, not 201).
#[tokio::test]
async fn a_channel_request_gets_the_public_room_and_creates_the_pair() {
    let app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let first = app
        .post_as(
            user,
            "/api/taskflow/channels",
            json!({ "project": project, "kind": "project", "title": PUBLIC_ROOM_TITLE, "members": [] }),
        )
        .await;
    assert_eq!(first.status(), 201, "body: {:?}", first.json().await);
    let body = first.json().await;
    let created_id = body["id"].as_i64().expect("channel id");
    assert_eq!(body["is_public"], json!(true), "the marker is in the response");

    assert_eq!(
        public_room(project).await.expect("public room").id,
        created_id
    );
    assert!(design_room(project).await.is_some(), "the pair was created together");

    // A second request — a different member this time — reuses the one room.
    let other = app.create_user().await;
    make_active_project_member(project, other).await;
    let second = app
        .post_as(
            other,
            "/api/taskflow/channels",
            json!({ "project": project, "kind": "project", "title": PUBLIC_ROOM_TITLE, "members": [] }),
        )
        .await;
    assert_eq!(second.status(), 200, "body: {:?}", second.json().await);
    assert_eq!(second.json().await["id"].as_i64(), Some(created_id));
    assert_eq!(channels(project).await.len(), 2, "still exactly the two rooms");
}

// The review report-back goes to the room MARKED public — never to whatever
// shared room happens to exist. It does not merely read the marker: it ensures
// the pair, because a report-back into a missing room is a review the agent
// never learns about.
#[tokio::test]
async fn the_review_report_back_lands_in_the_public_room_not_the_design_room() {
    let app = TestApp::new().await;
    let project = seed_project_via_transaction().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    // A marked design room, so a loose selector has something to misroute to —
    // and deliberately before any public room exists.
    let design = seed_room(project, TaskflowChannelKind::Project, "A user's room", false, true).await;

    let (key, _) = mint_agent(&app, user, project, "Builder", "main").await;
    let public = public_room(project).await.expect("the link created the public room");
    assert_ne!(public.id, design);

    let task_id = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/tasks",
            json!({ "title": "Ship the thing", "claim": true }),
        )
        .await
        .json()
        .await["id"]
        .as_i64()
        .expect("task id");
    let reviewed = app
        .post_as(
            user,
            &format!("/api/taskflow/tasks/{task_id}/review"),
            json!({ "decision": "approved" }),
        )
        .await;
    assert_eq!(reviewed.status(), 200, "body: {:?}", reviewed.json().await);

    let report = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::TASK.eq(task_id))
        .first()
        .await
        .expect("load report-back")
        .expect("report-back exists");
    assert_eq!(
        report.channel.id(),
        public.id,
        "the report-back went to the public room, not to the room marked design"
    );
    assert!(!report.is_design, "and is not a design message");
}

// ---------------------------------------------------------------------------
// Adoption on first creation (the design history re-point)
// ---------------------------------------------------------------------------

// Creating the design room adopts the project's design history — and ONLY that:
// the project's own messages, and only those in rooms the whole project can read.
//
// The private cases are the load-bearing ones. `is_design` was a client-declared
// flag, so a DM or a #42 Group could carry it; re-pointing one of those would
// publish a private conversation into a project-wide room.
#[tokio::test]
async fn adoption_repoints_only_this_projects_shared_design_messages() {
    // The boot is the point: it registers the project-write signals and runs the
    // plugin's `on_ready`. No request is made here.
    let app = TestApp::new().await;
    // The transaction path, so the project has NO design room yet: the adoption
    // below can only happen when the design room is first created.
    let project = seed_project_via_transaction().await;
    let other_project = seed_project_via_transaction().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let room = seed_room(project, TaskflowChannelKind::Project, "Room", false, false).await;
    let dm = seed_room(project, TaskflowChannelKind::Direct, "DM", false, false).await;
    let elsewhere =
        seed_room(other_project, TaskflowChannelKind::Project, "Other", false, false).await;

    let adopted = seed_flagged_message(project, room, true).await;
    let adopted_with_file = seed_flagged_message(project, room, true).await;
    let attachment = seed_attachment(project, adopted_with_file, room).await;
    let ordinary = seed_flagged_message(project, room, false).await;
    let private = seed_flagged_message(project, dm, true).await;
    let foreign = seed_flagged_message(other_project, elsewhere, true).await;

    // The link creates the design room, which is what triggers the adoption.
    mint_agent(&app, user, project, "Builder", "main").await;
    let design = design_room(project).await.expect("design room").id;

    assert_eq!(
        message_row(adopted).await.channel.id(),
        design,
        "a design message in a shared room is adopted"
    );
    assert_eq!(
        message_row(adopted_with_file).await.channel.id(),
        design,
        "so is one with an attachment"
    );
    assert_eq!(
        attachment_row(attachment).await.channel.as_ref().map(|fk| fk.id()),
        Some(design),
        "and the attachment follows its message, since the REST scope filters on that column"
    );
    assert!(
        message_row(adopted).await.is_design,
        "adoption does not clear the flag it exists to honour"
    );

    assert_eq!(
        message_row(ordinary).await.channel.id(),
        room,
        "an ordinary message stays put"
    );
    assert_eq!(
        message_row(private).await.channel.id(),
        dm,
        "a flagged message in a DM is NOT published into the project-wide design room"
    );
    assert_eq!(
        message_row(foreign).await.channel.id(),
        elsewhere,
        "another project's design history is not touched"
    );
}

// ---------------------------------------------------------------------------
// The message flag is derived from the destination
// ---------------------------------------------------------------------------

// `is_design` is true exactly when the message was posted into the DESIGN room —
// for a human and for an agent, whatever each declared, and whether they
// declared it at all.
#[tokio::test]
async fn is_design_is_derived_from_the_destination_on_both_send_paths() {
    // The boot is the point: it registers the project-write signals and runs the
    // plugin's `on_ready`. No request is made here.
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let (key, _) = mint_agent(&app, user, project, "Builder", "main").await;
    let public = public_room(project).await.expect("public room").id;
    let design = design_room(project).await.expect("design room").id;

    // HUMAN, public room, declaring design → stored false (the declaration loses).
    let posted = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": public, "body_markdown": "in chat", "is_design": true }),
        )
        .await;
    assert_eq!(posted.status(), 200, "body: {:?}", posted.json().await);
    let id = posted.json().await["id"].as_i64().expect("message id");
    assert!(
        !message_row(id).await.is_design,
        "a design flag sent to the public room is overridden"
    );

    // HUMAN, design room, declaring nothing → stored true (the destination wins).
    let posted = app
        .post_as(
            user,
            "/api/taskflow/agents/messages",
            json!({ "channel": design, "body_markdown": "in design" }),
        )
        .await;
    assert_eq!(posted.status(), 200, "body: {:?}", posted.json().await);
    let id = posted.json().await["id"].as_i64().expect("message id");
    assert!(
        message_row(id).await.is_design,
        "the design room makes a human's message a design message"
    );

    // AGENT, public room, declaring design → stored false.
    let posted = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": public, "body_markdown": "agent in chat", "is_design": true }),
        )
        .await;
    assert_eq!(posted.status(), 200, "body: {:?}", posted.json().await);
    let id = posted.json().await["id"].as_i64().expect("message id");
    assert!(
        !message_row(id).await.is_design,
        "the same override holds on the agent path"
    );

    // AGENT, design room, declaring nothing → stored true.
    let posted = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": design, "body_markdown": "agent in design" }),
        )
        .await;
    assert_eq!(posted.status(), 200, "body: {:?}", posted.json().await);
    let id = posted.json().await["id"].as_i64().expect("message id");
    assert!(
        message_row(id).await.is_design,
        "the design room makes an agent's message a design message"
    );
}

// ---------------------------------------------------------------------------
// The migration that carries the markers into production
// ---------------------------------------------------------------------------

// Tests never apply migrations — the test schema comes from the models — so
// nothing else here would notice a missing or malformed file. And this repo has
// been bitten by a same-id migration rewrite being silently skipped, which is
// why the file must be a NEW name whose id matches it, and why its recorded
// snapshot must agree with the model it claims to have produced.
#[test]
fn the_migration_adds_both_markers_without_rewriting_an_older_one() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../migrations/taskflow_agents");
    let path = format!("{dir}/0021_add_taskflow_agent_channel_is_public_and_is_design.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("the migration that carries the two markers must exist at {path}: {e}")
    });
    let file: serde_json::Value = serde_json::from_str(&raw).expect("migration is valid JSON");

    assert_eq!(
        file["id"], "0021_add_taskflow_agent_channel_is_public_and_is_design",
        "the file's id must match its name — migrations are tracked by name"
    );
    assert_eq!(file["plugin"], "taskflow_agents");

    let ops = file["operations"].as_array().expect("operations array");
    assert_eq!(ops.len(), 2, "one AddColumn per marker");
    for (op, name) in ops.iter().zip(["is_public", "is_design"]) {
        assert_eq!(op["kind"], "AddColumn");
        assert_eq!(op["table"], "taskflow_agent_channel");
        assert_eq!(op["column"]["name"], name);
        assert_eq!(op["column"]["ty"], "Boolean");
        assert_eq!(op["column"]["nullable"], false);
        assert_eq!(
            op["column"]["default"], "false",
            "both markers default to false: an existing room is neither until it is marked"
        );
    }

    // The snapshot the migration records must carry BOTH columns on the channel
    // model — a migration whose operations and whose snapshot disagree is the
    // same class of bug as a same-id rewrite, one layer down.
    let channel = file["snapshot_after"]["models"]
        .as_array()
        .expect("snapshot models")
        .iter()
        .find(|m| m["table"] == "taskflow_agent_channel")
        .expect("the channel model is in the snapshot");
    let field = |name: &str| -> bool {
        channel["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .any(|f| f["name"] == name && f["ty"] == "Boolean" && f["default"] == "false")
    };
    assert!(field("is_public"), "snapshot: is_public");
    assert!(field("is_design"), "snapshot: is_design");
}
