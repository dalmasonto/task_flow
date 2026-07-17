//! The send endpoint accepts `multipart/form-data` with file parts and records
//! each file as a `TaskflowMessageAttachment`, returning them (with resolved
//! URLs) in the response. These drive a real multipart request through the
//! handler's own `parse_multipart` path.

mod support;
use support::{MultipartPart, TestApp, encode_multipart, seed_channel_with_member};

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
