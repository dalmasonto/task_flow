//! #660: a conversation's files — the endpoint behind the Files tab.
//!
//! What matters here is not the listing (that is a query) but the two rules
//! around it: a caller sees ONLY the channels they may see (the same rule the
//! chat tables follow — a project member who is not on a private room's roster
//! gets nothing, and learns nothing), and the keyset cursor neither skips nor
//! repeats rows as they arrive.

mod support;
use support::{
    MultipartPart, TestApp, add_channel_roster_row, design_room_of, encode_multipart,
    make_active_project_member, public_room_of, seed_channel_of_kind, seed_project,
};
use serde_json::Value;
use taskflow_agents::models::TaskflowChannelKind;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 9, 9, 9];

fn field(name: &str, value: &str) -> MultipartPart {
    MultipartPart { field_name: name.to_string(), filename: None, content_type: None, bytes: value.as_bytes().to_vec() }
}

fn file(filename: &str, bytes: &[u8]) -> MultipartPart {
    MultipartPart {
        field_name: "files".to_string(),
        filename: Some(filename.to_string()),
        content_type: Some("image/png".to_string()),
        bytes: bytes.to_vec(),
    }
}

async fn post_with_file(app: &TestApp, user: i64, channel: i64, body: &str, filename: &str) {
    let (content_type, payload) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", body),
        file(filename, PNG),
    ]);
    let response = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &content_type, payload)
        .await;
    assert_eq!(response.status(), 200, "{}", response.json().await);
}

async fn files(app: &TestApp, user: i64, channel: i64, query: &str) -> Value {
    let response = app
        .get_as(user, &format!("/api/taskflow/channels/{channel}/attachments{query}"))
        .await;
    assert_eq!(response.status(), 200, "{}", response.text());
    response.json().await
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_a_conversations_files_newest_first_with_their_senders() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    post_with_file(&app, user, channel, "first", "one.png").await;
    post_with_file(&app, user, channel, "second", "two.png").await;

    // Another channel's file must not appear.
    let other = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    post_with_file(&app, user, other, "elsewhere", "other.png").await;

    let body = files(&app, user, channel, "").await;
    let items = body["attachments"].as_array().expect("attachments");
    assert_eq!(items.len(), 2, "only THIS conversation's files: {body}");
    assert_eq!(items[0]["name"], "two.png", "newest first");
    assert_eq!(items[1]["name"], "one.png");
    assert_eq!(items[0]["content_type"], "image/png");
    assert_eq!(items[0]["size_bytes"], PNG.len());
    assert!(items[0]["url"].as_str().unwrap().contains("/media/"), "{body}");
    assert!(items[0]["message_id"].is_number(), "the message to jump to: {body}");
    assert_eq!(items[0]["sender"]["kind"], "user");
    assert_eq!(items[0]["sender"]["id"], user);
    assert_eq!(items[0]["channel"], channel);
    assert!(items[0]["created_at"].is_string(), "{body}");
    assert!(body["next_cursor"].is_null(), "one page holds everything: {body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_cursor_pages_without_skipping_or_repeating() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    for i in 1..=3 {
        post_with_file(&app, user, channel, &format!("message {i}"), &format!("f{i}.png")).await;
    }

    let first = files(&app, user, channel, "?limit=2").await;
    let names: Vec<String> = first["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["f3.png", "f2.png"]);
    let cursor = first["next_cursor"].as_i64().expect("a cursor");

    let second = files(&app, user, channel, &format!("?limit=2&cursor={cursor}")).await;
    let names: Vec<String> = second["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, ["f1.png"], "the tail, and nothing repeated");
    assert!(second["next_cursor"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_design_room_answers_with_its_own_files_only() {
    // The spec asks for a "design-room filter". There is deliberately no
    // `is_design` clause on the endpoint: the CHANNEL is the filter, exactly as
    // in the thread, so the design room answers with its own files and nothing
    // from the project room beside it — even though both are shared rooms of
    // the same project.
    let app = TestApp::new().await;
    let project = seed_project().await;
    let design = design_room_of(project).await;
    let room = public_room_of(project).await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    post_with_file(&app, user, design, "the frame", "frame.png").await;
    post_with_file(&app, user, room, "the spec", "spec.txt").await;

    let design_files = files(&app, user, design, "").await;
    let names: Vec<&str> = design_files["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["frame.png"], "only the design room's own file: {design_files}");

    let room_files = files(&app, user, room, "").await;
    let names: Vec<&str> = room_files["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["spec.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_caller_who_cannot_see_the_channel_gets_nothing_and_learns_nothing() {
    let app = TestApp::new().await;
    let project = seed_project().await;

    // A private group room the outsider is not on the roster of.
    let group = seed_channel_of_kind(project, TaskflowChannelKind::Group).await;
    let insider = app.create_user().await;
    make_active_project_member(project, insider).await;
    add_channel_roster_row(project, group, insider).await;
    post_with_file(&app, insider, group, "ours", "private.png").await;

    // A project member who is NOT on the group's roster.
    let peer = app.create_user().await;
    make_active_project_member(project, peer).await;
    assert_eq!(
        app.get_as(peer, &format!("/api/taskflow/channels/{group}/attachments")).await.status(),
        404,
        "an off-roster member must not see a private room's files"
    );

    // A caller with no access to the project at all.
    let stranger = app.create_user().await;
    assert_eq!(
        app.get_as(stranger, &format!("/api/taskflow/channels/{group}/attachments")).await.status(),
        404
    );

    // The insider sees them — the refusal above is about the caller, not the route.
    assert_eq!(files(&app, insider, group, "").await["attachments"].as_array().unwrap().len(), 1);

    // And a channel that does not exist answers the same 404.
    assert_eq!(app.get_as(insider, "/api/taskflow/channels/999999/attachments").await.status(), 404);
}
