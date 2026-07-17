//! The add-channel-member endpoint is the only authorized way to put a person
//! on a channel roster. It derives the caller and channel server-side and
//! refuses anyone who isn't an active project member — plus, for DMs, anyone who
//! isn't already in the DM.

use serde_json::json;

mod support;
use support::{
    TestApp, add_channel_roster_row, make_active_project_member, new_project_and_channel,
    try_insert_channel_roster_row,
};
use taskflow_agents::models::TaskflowChannelKind;

const PATH: &str = "/api/taskflow/channels";

fn members_url(channel: i64) -> String {
    format!("{PATH}/{channel}/members")
}

// An active project member adds another active project member to a shared
// (Project) channel: the roster row is minted and copies the target's
// project-member display_name.
#[tokio::test]
async fn active_member_adds_another_to_project_channel() {
    let app = TestApp::new().await;
    let (project, channel) = new_project_and_channel(TaskflowChannelKind::Project).await;

    let caller = app.create_user().await;
    make_active_project_member(project, caller).await;

    let target = app.create_user().await;
    let target_display = make_active_project_member(project, target).await;

    let response = app
        .post_as(caller, &members_url(channel), json!({ "user": target }))
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let row = response.json().await;
    assert_eq!(row["channel"], json!(channel));
    assert_eq!(row["user"], json!(target));
    assert_eq!(row["member_kind"], json!("user"));
    assert_eq!(row["display_name"], json!(target_display));
    assert_eq!(app.count_channel_members(channel).await, 1);
}

// Idempotent: adding the same user twice yields exactly one roster row, and both
// calls hand back that same row.
#[tokio::test]
async fn adding_same_user_twice_is_idempotent() {
    let app = TestApp::new().await;
    let (project, channel) = new_project_and_channel(TaskflowChannelKind::Project).await;

    let caller = app.create_user().await;
    make_active_project_member(project, caller).await;

    let target = app.create_user().await;
    make_active_project_member(project, target).await;

    let first = app
        .post_as(caller, &members_url(channel), json!({ "user": target }))
        .await;
    let second = app
        .post_as(caller, &members_url(channel), json!({ "user": target }))
        .await;

    assert_eq!(first.status(), 201, "body: {:?}", first.json().await);
    // The second add finds the existing row and returns it as a 200, not a new
    // 201 and not a 500 from the unique index firing.
    assert_eq!(second.status(), 200, "body: {:?}", second.json().await);
    assert_eq!(first.json().await["id"], second.json().await["id"]);
    assert_eq!(app.count_channel_members(channel).await, 1);
}

// The target must be a project member: adding an outsider is rejected with the
// field-error body and creates no row.
#[tokio::test]
async fn adding_a_non_project_member_is_rejected() {
    let app = TestApp::new().await;
    let (project, channel) = new_project_and_channel(TaskflowChannelKind::Project).await;

    let caller = app.create_user().await;
    make_active_project_member(project, caller).await;

    // A real, logged-in user who simply isn't in this project.
    let outsider = app.create_user().await;

    let response = app
        .post_as(caller, &members_url(channel), json!({ "user": outsider }))
        .await;

    assert_eq!(response.status(), 400);
    let body = response.json().await;
    assert_eq!(body["code"], json!("not_a_project_member"));
    assert!(body["user"].is_array(), "expected field error on `user`: {body:?}");
    assert_eq!(app.count_channel_members(channel).await, 0);
}

// The caller must be a project member: a non-member cannot add anyone.
#[tokio::test]
async fn non_member_caller_is_forbidden() {
    let app = TestApp::new().await;
    let (project, channel) = new_project_and_channel(TaskflowChannelKind::Project).await;

    // Caller is authenticated but not a member of this project.
    let caller = app.create_user().await;

    // A valid target who IS a project member — so the only thing failing the
    // request is the CALLER's missing membership.
    let target = app.create_user().await;
    make_active_project_member(project, target).await;

    let response = app
        .post_as(caller, &members_url(channel), json!({ "user": target }))
        .await;

    assert_eq!(response.status(), 403);
    assert_eq!(app.count_channel_members(channel).await, 0);
}

// DM carve-out: a project member who is NOT on the DM's roster cannot add anyone
// to it, even though active project membership would suffice for a shared room.
#[tokio::test]
async fn direct_channel_requires_caller_on_roster() {
    let app = TestApp::new().await;
    let (project, channel) = new_project_and_channel(TaskflowChannelKind::Direct).await;

    let caller = app.create_user().await;
    make_active_project_member(project, caller).await;

    let target = app.create_user().await;
    make_active_project_member(project, target).await;

    let response = app
        .post_as(caller, &members_url(channel), json!({ "user": target }))
        .await;

    assert_eq!(response.status(), 403);
    assert_eq!(app.count_channel_members(channel).await, 0);
}

// DM: a caller who IS already on the DM's roster may add a fellow project member.
#[tokio::test]
async fn direct_channel_roster_member_can_add() {
    let app = TestApp::new().await;
    let (project, channel) = new_project_and_channel(TaskflowChannelKind::Direct).await;

    let caller = app.create_user().await;
    make_active_project_member(project, caller).await;
    // The caller is already in the DM.
    add_channel_roster_row(project, channel, caller).await;

    let target = app.create_user().await;
    let target_display = make_active_project_member(project, target).await;

    let response = app
        .post_as(caller, &members_url(channel), json!({ "user": target }))
        .await;

    assert_eq!(response.status(), 201, "body: {:?}", response.json().await);
    let row = response.json().await;
    assert_eq!(row["user"], json!(target));
    assert_eq!(row["display_name"], json!(target_display));
    // The caller's own roster row plus the newly added target.
    assert_eq!(app.count_channel_members(channel).await, 2);
}

// The unique index on (channel, user) is the real guarantee behind idempotency:
// a direct second insert of the same (channel, user) must be rejected by the DB.
#[tokio::test]
async fn unique_index_blocks_duplicate_roster_row() {
    let app = TestApp::new().await;
    let (project, channel) = new_project_and_channel(TaskflowChannelKind::Project).await;

    let user = app.create_user().await;

    // First insert lands.
    let first_ok = try_insert_channel_roster_row(project, channel, user).await;
    assert!(first_ok, "the first roster insert should succeed");

    // Second insert of the same (channel, user) must be refused by the unique
    // index — proving the constraint, not just the endpoint's dedupe, holds.
    let second_ok = try_insert_channel_roster_row(project, channel, user).await;
    assert!(!second_ok, "the unique index must reject a duplicate (channel, user)");

    assert_eq!(app.count_channel_members(channel).await, 1);
}
