//! DM confidentiality on the REALTIME path.
//!
//! `rest_scope.rs` proves a project member cannot READ another member's DM over
//! REST — `channel_scope` restricts the chat tables to `visible_channel_ids`.
//! That gate lives entirely in `backend::rest` and nothing in `backend::realtime`
//! consults it.
//!
//! Realtime routes chat events with `group_for`, which reads only the row's
//! `project` FK, so every message in a project — DMs included — lands in the one
//! `project:{id}:messages` room. `may_join` admits any active member of that
//! project. A member who is not on a DM's roster therefore joins the room that
//! carries the DM and receives whatever the projection puts on the wire.
//!
//! This test subscribes as that member through the real [`Registry`] — the same
//! path the SSE transport uses — and asserts the delivered payload carries no
//! message body. It exercises the actual dispatch, not the field constant, so it
//! stays honest if the routing or the projection changes.

use std::collections::HashSet;
use std::time::Duration;

use umbral::orm::ForeignKey;
use umbral_auth::{AuthPlugin, AuthUser};
use umbral_realtime::Realtime;
use umbral_testing::boot;

use taskflow_agents::TaskflowAgentsPlugin;
use taskflow_agents::models::{
    TaskflowAgentChannel, TaskflowAgentChannelMember, TaskflowAgentMessage, TaskflowChannelKind,
    TaskflowChannelMemberKind, TaskflowMessagePriority,
};
use taskflow_projects::TaskflowProjectsPlugin;
use taskflow_projects::models::{
    TaskflowMembershipStatus, TaskflowProject, TaskflowProjectMember, TaskflowProjectRole,
    TaskflowProjectStatus,
};

/// The body Alice sends Carol. Distinctive so the assertion cannot pass by
/// accident on some other field's contents.
const SECRET: &str = "sealed-envelope-do-not-broadcast";

async fn make_user(username: &str) -> i64 {
    AuthUser::objects()
        .create(AuthUser {
            id: 0,
            username: username.to_string(),
            email: format!("{username}@example.test"),
            password_hash: "x".to_string(),
            is_active: true,
            is_staff: false,
            is_superuser: false,
            date_joined: chrono::Utc::now(),
            last_login: None,
            email_verified_at: None,
        })
        .await
        .expect("create AuthUser")
        .id
}

async fn make_project(slug: &str) -> i64 {
    TaskflowProject::objects()
        .create(TaskflowProject {
            id: 0,
            name: slug.to_string(),
            slug: slug.to_string(),
            description_markdown: String::new(),
            repository_url: None,
            default_api_base_url: None,
            status: TaskflowProjectStatus::Active,
            owner: None,
            github_repo: None,
            github_linked_by: None,
            github_default_branch: None,
            created_at: None,
            updated_at: None,
        })
        .await
        .expect("create project")
        .id
}

async fn make_member(project: i64, user: i64) {
    TaskflowProjectMember::objects()
        .create(TaskflowProjectMember {
            id: 0,
            project: ForeignKey::new(project),
            member_key: format!("user:{user}"),
            user: Some(ForeignKey::new(user)),
            display_name: format!("User {user}"),
            email: None,
            role: TaskflowProjectRole::Developer,
            status: TaskflowMembershipStatus::Active,
            invited_by: None,
            created_at: None,
            joined_at: None,
        })
        .await
        .expect("create member");
}

/// A `direct` channel rostered to exactly `members`.
async fn make_dm(project: i64, members: &[i64]) -> i64 {
    let channel = TaskflowAgentChannel::objects()
        .create(TaskflowAgentChannel {
            id: 0,
            project: ForeignKey::new(project),
            title: "alice + carol".to_string(),
            topic: None,
            kind: TaskflowChannelKind::Direct,
            task: None,
            created_by_user: None,
            created_by_agent: None,
            archived: false,
            created_at: None,
        })
        .await
        .expect("create channel")
        .id;
    for user in members {
        TaskflowAgentChannelMember::objects()
            .create(TaskflowAgentChannelMember {
                id: 0,
                project: ForeignKey::new(project),
                channel: ForeignKey::new(channel),
                member_kind: TaskflowChannelMemberKind::User,
                user: Some(ForeignKey::new(*user)),
                agent: None,
                display_name: format!("User {user}"),
                role: String::new(),
                joined_at: None,
            })
            .await
            .expect("create roster row");
    }
    channel
}

/// Bob is an active member of the project but NOT on the DM's roster. He must
/// not receive the DM's body over realtime — the same guarantee REST already
/// gives him.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_member_off_the_roster_never_receives_a_dm_body() {
    boot(|b| {
        b.plugin(AuthPlugin::<AuthUser>::default())
            // `TaskflowMessageAttachment` declares a FileField, so the app will
            // not build without a storage backend.
            .plugin(umbral_storage::StoragePlugin::new().media("/media", "./media"))
            .plugin(TaskflowProjectsPlugin)
            .plugin(taskflow_tasks::TaskflowTasksPlugin)
            .plugin(TaskflowAgentsPlugin)
            .plugin(backend::realtime::plugin())
    })
    .await;

    let alice = make_user("dm-alice").await;
    let carol = make_user("dm-carol").await;
    let bob = make_user("dm-bob").await;

    let project = make_project("dm-project").await;
    for u in [alice, carol, bob] {
        make_member(project, u).await;
    }

    // Alice and Carol only. Bob is deliberately left off.
    let dm = make_dm(project, &[alice, carol]).await;

    // Bob connects exactly as the SSE transport would: the group policy decides
    // admission, then the registry holds the connection.
    let group = format!("project:{project}:messages");
    assert!(
        backend::realtime::may_join(Some(&bob.to_string()), &group),
        "precondition: bob is an active project member, so he joins {group} — \
         this is expected and is not itself the bug",
    );
    let (_conn, mut rx) = Realtime::registry()
        .register(Some(bob.to_string()), HashSet::from([group.clone()]), 32)
        .await
        .expect("register bob's connection");

    // Alice DMs Carol.
    TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            id: 0,
            project: ForeignKey::new(project),
            channel: ForeignKey::new(dm),
            task: None,
            client_nonce: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: Some(ForeignKey::new(alice)),
            sender_agent: None,
            target_agent: None,
            sender_label: "dm-alice".to_string(),
            body_markdown: SECRET.to_string(),
            priority: TaskflowMessagePriority::Normal,
            created_at: None,
        })
        .await
        .expect("alice sends the DM");

    // The ORM signal fans out asynchronously; give dispatch a moment to land.
    let received = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;

    // Bob DOES still get an event — routing is per-project and that is fine, it
    // is the payload that must be bare. Asserting delivery keeps this test from
    // passing vacuously: if dispatch ever stopped reaching him, a silent "no
    // event" would otherwise look identical to a successful redaction.
    let event = received
        .expect("realtime dispatch timed out; the test cannot prove anything about a stream that never delivered")
        .expect("bob's connection closed before the event arrived");

    let wire = serde_json::to_string(&event.data).expect("serialize payload");
    assert!(
        !wire.contains(SECRET),
        "bob is not on this DM's roster but realtime delivered its body.\n\
         group: {group}\n\
         payload: {wire}",
    );
    assert!(
        event.data.get("body_markdown").is_none(),
        "the wire must not carry `body_markdown` for a channel the subscriber \
         cannot read.\npayload: {wire}",
    );
    // Id-only, and the id is what the client needs to drive its REST refetch.
    assert!(
        event.data.get("id").is_some(),
        "the event must still carry the row id so the client can refetch it \
         through the channel-scoped REST path.\npayload: {wire}",
    );
    // The whole leak was extra columns, so pin the shape rather than spot-check
    // one field: a future `.fields(...)` would fail here even if it omitted
    // `body_markdown`. `sender_label` alone still reveals who is DMing whom.
    assert_eq!(
        event.data.as_object().map(|o| o.len()),
        Some(1),
        "the payload must be id-only; any additional column is broadcast to \
         the entire project.\npayload: {wire}",
    );
}
