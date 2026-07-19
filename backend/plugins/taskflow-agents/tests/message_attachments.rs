//! The send endpoint accepts `multipart/form-data` with file parts and records
//! each file as a `TaskflowMessageAttachment`, returning them (with resolved
//! URLs) in the response. These drive a real multipart request through the
//! handler's own `parse_multipart` path.

mod support;
use support::{
    MultipartPart, TestApp, encode_multipart, make_active_project_member, seed_channel_of_kind,
    seed_channel_with_member, seed_project,
};
use taskflow_agents::models::TaskflowChannelKind;

/// A few bytes standing in for an uploaded image. The endpoint does not sniff
/// content — it trusts the declared part `Content-Type` — so any bytes work.
const IMAGE_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];

fn field(name: &str, value: &str) -> MultipartPart {
    MultipartPart {
        field_name: name.to_string(),
        filename: None,
        content_type: None,
        bytes: value.as_bytes().to_vec(),
    }
}

fn file(name: &str, filename: &str, content_type: &str, bytes: &[u8]) -> MultipartPart {
    MultipartPart {
        field_name: name.to_string(),
        filename: Some(filename.to_string()),
        content_type: Some(content_type.to_string()),
        bytes: bytes.to_vec(),
    }
}

#[tokio::test]
async fn multipart_send_with_one_image_creates_attachment_and_returns_url() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "here is a screenshot"),
        file("files", "shot.png", "image/png", IMAGE_BYTES),
    ]);

    let response = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &content_type, body)
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;

    // The message fields are still present (JSON-path shape preserved).
    assert_eq!(row["sender_user"], serde_json::json!(user));
    assert_eq!(row["body_markdown"], serde_json::json!("here is a screenshot"));

    // Exactly one attachment, fully populated, with a resolved /media url.
    let attachments = row["attachments"].as_array().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    let att = &attachments[0];
    assert_eq!(att["name"], serde_json::json!("shot.png"));
    assert_eq!(att["content_type"], serde_json::json!("image/png"));
    assert_eq!(att["size_bytes"], serde_json::json!(IMAGE_BYTES.len()));
    assert_eq!(att["message"], row["id"]);
    assert_eq!(att["project"], row["project"]);
    let url = att["url"].as_str().expect("url string");
    assert!(url.starts_with("/media/"), "unexpected url: {url}");

    // And the row was persisted with the right message FK.
    let message_id = row["id"].as_i64().expect("message id");
    assert_eq!(app.count_attachments(message_id).await, 1);
}

#[tokio::test]
async fn file_only_message_with_empty_body_succeeds() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", ""),
        file("files", "notes.pdf", "application/pdf", b"%PDF-1.4 stub"),
    ]);

    let response = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &content_type, body)
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;
    let attachments = row["attachments"].as_array().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["content_type"], serde_json::json!("application/pdf"));
}

#[tokio::test]
async fn empty_body_and_no_files_is_rejected_400() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "   "),
    ]);

    let response = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &content_type, body)
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn same_nonce_with_a_file_stores_once_and_returns_the_same_message() {
    let app = TestApp::new().await;
    let (channel, user) = seed_channel_with_member(&app).await;

    let make_body = || {
        encode_multipart(&[
            field("channel", &channel.to_string()),
            field("body_markdown", "attach once"),
            field("client_nonce", "attach-nonce-1"),
            file("files", "shot.png", "image/png", IMAGE_BYTES),
        ])
    };

    let (ct1, b1) = make_body();
    let first = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &ct1, b1)
        .await;
    let (ct2, b2) = make_body();
    let second = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &ct2, b2)
        .await;

    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);

    let first_row = first.json().await;
    let second_row = second.json().await;

    // Same message, and the file was NOT stored a second time.
    let message_id = first_row["id"].as_i64().expect("message id");
    assert_eq!(second_row["id"], first_row["id"]);
    assert_eq!(app.count_messages(channel).await, 1);
    assert_eq!(app.count_attachments(message_id).await, 1);

    // The idempotent replay still returns the existing attachment.
    let attachments = second_row["attachments"].as_array().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["name"], serde_json::json!("shot.png"));
}

// ---------------------------------------------------------------------------
// The AGENT send route (`/api/taskflow/agents/agent/messages`). It accepts the
// same two transports as the human route above; these are the agent-authed
// counterparts of those cases, plus the membership and idempotency gates that
// are specific to the agent path.
// ---------------------------------------------------------------------------

const AGENT_SEND: &str = "/api/taskflow/agents/agent/messages";

/// Mint a fresh agent key in `project` (the human minting it must be an active
/// project member). Returns the raw `tfk_…` key.
async fn mint_agent_key(app: &TestApp, project: i64, label: &str) -> String {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(
            human,
            "/api/taskflow/agents/link",
            serde_json::json!({
                "project": project,
                "display_name": label,
                "profile": label,
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await["key"]
        .as_str()
        .expect("minted key")
        .to_string()
}

/// A shared project room the agent may post in by project scope alone, plus a
/// key for an agent in that project. Returns `(project, channel, key)`.
async fn seed_agent_and_room(app: &TestApp) -> (i64, i64, String) {
    let project = seed_project().await;
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let key = mint_agent_key(app, project, "Attaching Agent").await;
    (project, channel, key)
}

// 1. Multipart with one file → 200 and exactly one fully-populated attachment.
#[tokio::test]
async fn agent_multipart_send_with_one_file_creates_attachment() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "log excerpt attached"),
        file("files", "run.log", "text/plain", b"panic at line 1"),
    ]);

    let response = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;

    // Still stamped as the agent — the transport changes nothing about identity.
    assert_eq!(row["sender_kind"], serde_json::json!("agent"));
    assert_eq!(row["body_markdown"], serde_json::json!("log excerpt attached"));

    let attachments = row["attachments"].as_array().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    let att = &attachments[0];
    assert_eq!(att["name"], serde_json::json!("run.log"));
    assert_eq!(att["content_type"], serde_json::json!("text/plain"));
    assert_eq!(att["size_bytes"], serde_json::json!("panic at line 1".len()));
    assert_eq!(att["message"], row["id"]);
    // `project` is denormalized from the channel, never accepted from the client.
    assert_eq!(att["project"], row["project"]);

    let message_id = row["id"].as_i64().expect("message id");
    assert_eq!(app.count_attachments(message_id).await, 1);
}

// 2. JSON with no files → 200 with `attachments: []`. The pre-existing path
//    must be untouched by the multipart branch.
#[tokio::test]
async fn agent_json_send_still_works_and_returns_no_attachments() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let response = app
        .post_as_agent(
            &key,
            AGENT_SEND,
            serde_json::json!({ "channel": channel, "body_markdown": "plain text send" }),
        )
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;
    assert_eq!(row["sender_kind"], serde_json::json!("agent"));
    assert_eq!(row["body_markdown"], serde_json::json!("plain text send"));
    assert_eq!(
        row["attachments"].as_array().expect("attachments array").len(),
        0
    );
}

// 3. Multipart with an EMPTY body but one file → 200. A file-only message is a
//    legitimate message.
#[tokio::test]
async fn agent_file_only_message_with_empty_body_succeeds() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", ""),
        file("files", "shot.png", "image/png", IMAGE_BYTES),
    ]);

    let response = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;

    assert_eq!(response.status(), 200, "body: {:?}", response.json().await);
    let row = response.json().await;
    assert_eq!(row["body_markdown"], serde_json::json!(""));
    let attachments = row["attachments"].as_array().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["name"], serde_json::json!("shot.png"));
}

// 4. JSON with an empty body and no files → 400. The empty-body allowance is
//    conditional on a file being present, not a blanket relaxation.
#[tokio::test]
async fn agent_json_send_with_empty_body_is_rejected_400() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let response = app
        .post_as_agent(
            &key,
            AGENT_SEND,
            serde_json::json!({ "channel": channel, "body_markdown": "   " }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

// 5. Multipart from a non-member agent into a DM → 403, and NOTHING is written.
//    The membership gate runs before any storage work, so a rejected send must
//    not leave an orphan attachment behind.
#[tokio::test]
async fn agent_multipart_into_a_dm_it_is_not_on_is_forbidden_and_writes_nothing() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let key = mint_agent_key(&app, project, "Outsider Agent").await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &dm.to_string()),
        field("body_markdown", "let me in"),
        file("files", "shot.png", "image/png", IMAGE_BYTES),
    ]);

    let response = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;

    assert_eq!(response.status(), 403);
    assert_eq!(app.count_messages(dm).await, 0);
    assert_eq!(app.count_project_attachments(project).await, 0);
}

// 6. Replaying a nonce returns the ORIGINAL message with its original
//    attachments, and does not store the file twice.
#[tokio::test]
async fn agent_nonce_replay_returns_the_original_message_and_its_attachments() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let make_body = || {
        encode_multipart(&[
            field("channel", &channel.to_string()),
            field("body_markdown", "attach once"),
            field("client_nonce", "agent-attach-nonce-1"),
            file("files", "shot.png", "image/png", IMAGE_BYTES),
        ])
    };

    let (ct1, b1) = make_body();
    let first = app
        .post_multipart_as_agent(&key, AGENT_SEND, &ct1, b1)
        .await;
    let (ct2, b2) = make_body();
    let second = app
        .post_multipart_as_agent(&key, AGENT_SEND, &ct2, b2)
        .await;

    assert_eq!(first.status(), 200, "body: {:?}", first.json().await);
    assert_eq!(second.status(), 200, "body: {:?}", second.json().await);

    let first_row = first.json().await;
    let second_row = second.json().await;
    let message_id = first_row["id"].as_i64().expect("message id");

    assert_eq!(second_row["id"], first_row["id"]);
    assert_eq!(app.count_messages(channel).await, 1);
    assert_eq!(app.count_attachments(message_id).await, 1);

    let attachments = second_row["attachments"].as_array().expect("attachments array");
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["name"], serde_json::json!("shot.png"));
    assert_eq!(attachments[0]["id"], first_row["attachments"][0]["id"]);
}
