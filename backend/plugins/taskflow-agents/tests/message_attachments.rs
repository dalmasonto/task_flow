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
use serde_json::Value;

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

// 7. The membership gate must run before the idempotency lookup on the AGENT
//    path too, exactly as it does on the human path (see
//    `non_member_replaying_a_nonce_gets_403_not_the_stored_row` in
//    send_message.rs). The nonce is scoped to (channel, nonce) only — it
//    carries no sender — so an agent that is not on a DM's roster must not
//    be able to replay a nonce a member posted and read the stored message
//    body back. If a refactor moves the idempotency lookup above the
//    membership gate, this test must fail.
#[tokio::test]
async fn agent_non_member_replaying_a_nonce_gets_403_not_the_stored_row() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;

    // The member: minted, then explicitly added to the DM's roster.
    let member_human = app.create_user().await;
    make_active_project_member(project, member_human).await;
    let minted = app
        .post_as(
            member_human,
            "/api/taskflow/agents/link",
            serde_json::json!({
                "project": project,
                "display_name": "Member Agent",
                "profile": "member",
            }),
        )
        .await;
    assert_eq!(minted.status(), 200, "mint failed: {:?}", minted.json().await);
    let minted = minted.json().await;
    let member_key = minted["key"].as_str().expect("minted key").to_string();
    let member_agent_id = minted["agent_id"].as_i64().expect("agent_id present");
    app.add_agent_to_channel_roster(project, dm, member_agent_id)
        .await;

    // The outsider: a different agent in the same project, never added to
    // this DM's roster.
    let outsider_key = mint_agent_key(&app, project, "Outsider Agent").await;

    let first = app
        .post_as_agent(
            &member_key,
            AGENT_SEND,
            serde_json::json!({
                "channel": dm,
                "body_markdown": "secret plans",
                "client_nonce": "n-1",
            }),
        )
        .await;
    assert_eq!(first.status(), 200, "body: {:?}", first.json().await);

    let replay = app
        .post_as_agent(
            &outsider_key,
            AGENT_SEND,
            serde_json::json!({
                "channel": dm,
                "body_markdown": "gimme",
                "client_nonce": "n-1",
            }),
        )
        .await;

    assert_eq!(replay.status(), 403, "leaked: {:?}", replay.json().await);
}

// 8. The agent READ path returns attachments, not just message text. This is
//    the gap that made received files invisible to agents.
#[tokio::test]
async fn agent_read_returns_attachments_for_a_message() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "diagram attached"),
        file("files", "diagram.png", "image/png", b"PNGDATA"),
    ]);
    let sent = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;
    assert_eq!(sent.status(), 200, "body: {:?}", sent.json().await);
    let sent_row = sent.json().await;
    let message_id = sent_row["id"].as_i64().expect("message id");

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    assert_eq!(read.status(), 200, "body: {:?}", read.json().await);
    let page = read.json().await;

    let message = page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|m| m["id"].as_i64() == Some(message_id))
        .expect("the sent message is in the page");

    let attachments = message["attachments"]
        .as_array()
        .expect("attachments array on the READ path");
    assert_eq!(attachments.len(), 1);
    let att = &attachments[0];
    assert_eq!(att["name"], serde_json::json!("diagram.png"));
    assert_eq!(att["content_type"], serde_json::json!("image/png"));
    assert_eq!(att["size_bytes"], serde_json::json!("PNGDATA".len()));
    assert_eq!(att["message"], serde_json::json!(message_id));
    assert!(
        att["url"]
            .as_str()
            .expect("url")
            .starts_with("/media/"),
        "url should resolve to /media/<key>, got {:?}",
        att["url"]
    );
}

// 8b. CONTRACT PAIR with `mcp/src/attachment-download.test.ts` (see the test
//     named "downloads a backend-shaped url whose key has a space and a #").
//     THESE TWO MUST MOVE TOGETHER.
//
//     This half pins what the backend actually EMITS. `FileField::url()` does
//     no percent-encoding — it is `format!("{mount}/{key}")` — and the storage
//     filename sanitiser strips only `/`, `\` and control characters. So `#`,
//     `?`, `%`, spaces and unicode all survive verbatim into the url string.
//     The MCP half feeds this exact shape through `downloadAttachment` and
//     asserts it is re-encoded before it becomes a request line.
//
//     Asserting `starts_with("/media/")` is what let the encoding mismatch
//     ship: it passes for a truncated url just as happily. This asserts the
//     WHOLE string.
#[tokio::test]
async fn agent_read_emits_the_url_unencoded_for_a_name_with_a_space_and_a_hash() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    // A space AND a `#`. `#` is the dangerous one: treated as a fragment
    // delimiter by any consumer that does not encode, truncating the request.
    const FILENAME: &str = "Q3 #2 report.pdf";

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "quarterly numbers"),
        file("files", FILENAME, "application/pdf", b"%PDF-1.4 q3"),
    ]);
    let sent = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;
    assert_eq!(sent.status(), 200, "body: {:?}", sent.json().await);
    let message_id = sent.json().await["id"].as_i64().expect("message id");

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    assert_eq!(read.status(), 200, "body: {:?}", read.json().await);
    let page = read.json().await;
    let message = page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|m| m["id"].as_i64() == Some(message_id))
        .expect("the sent message is in the page")
        .clone();

    let att = &message["attachments"][0];
    assert_eq!(att["name"], serde_json::json!(FILENAME));

    let url = att["url"].as_str().expect("url string");

    // The storage key is `<unique>-<filename>`, so the url is fully determined
    // apart from that opaque prefix. Assert every other character of it.
    assert!(url.starts_with("/media/"), "unexpected url: {url}");
    let key_part = url.strip_prefix("/media/").expect("media prefix");
    let (prefix, name_part) = key_part
        .split_once('-')
        .expect("storage key is <unique>-<filename>");
    assert!(
        !prefix.is_empty(),
        "expected a non-empty unique prefix in {url}"
    );
    assert_eq!(
        name_part, FILENAME,
        "the filename must reach the url byte-for-byte, unencoded: {url}"
    );

    // Stated positively, so a future move to an encoding backend fails HERE
    // (loudly, next to this comment) rather than silently in the MCP client.
    assert!(
        url.contains(" ") && url.contains('#'),
        "the url must be UNENCODED — the MCP client encodes it, and would \
         double-encode a url that arrived pre-encoded: {url}"
    );
    assert!(
        !url.contains('%'),
        "no percent-encoding is expected from this layer: {url}"
    );
}

// 9. A text-only message returns an EMPTY ARRAY, never an absent key. An absent
//    key is indistinguishable from "not reported", which is exactly how the
//    original bug hid.
#[tokio::test]
async fn agent_read_returns_empty_array_for_a_message_with_no_files() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let sent = app
        .post_as_agent(
            &key,
            AGENT_SEND,
            serde_json::json!({ "channel": channel, "body_markdown": "no files here" }),
        )
        .await;
    assert_eq!(sent.status(), 200, "body: {:?}", sent.json().await);
    let message_id = sent.json().await["id"].as_i64().expect("message id");

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    let page = read.json().await;
    let message = page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|m| m["id"].as_i64() == Some(message_id))
        .expect("the sent message is in the page");

    // The KEY must exist — not merely be falsy. `get` returning None is the bug.
    let attachments = message
        .get("attachments")
        .expect("attachments key must be present even with no files");
    assert_eq!(attachments, &serde_json::json!([]));
}

// 10. SHAPE PARITY: the send response and the agent read serialize an
//     attachment identically. This is the check that catches the whole CLASS of
//     human-route-vs-agent-route drift, rather than one instance of it.
#[tokio::test]
async fn send_response_and_agent_read_serialize_attachments_identically() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "parity check"),
        file("files", "report.pdf", "application/pdf", b"%PDF-1.4 fake"),
    ]);
    let sent = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;
    assert_eq!(sent.status(), 200, "body: {:?}", sent.json().await);
    let sent_row = sent.json().await;
    let message_id = sent_row["id"].as_i64().expect("message id");
    let from_send = sent_row["attachments"][0].clone();

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    let page = read.json().await;
    let from_read = page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|m| m["id"].as_i64() == Some(message_id))
        .expect("the sent message is in the page")["attachments"][0]
        .clone();

    assert_eq!(
        from_send, from_read,
        "send and read must serialize an attachment identically; \
         a divergence here is the drift this feature exists to stop"
    );
}

// 11. MIXED PAGE: a channel with a text-only message, a one-file message, and
//     a two-file message, all from the same agent, read back in a single
//     page. `list_messages_as_agent` fetches every attachment for the page in
//     one batched query and must assign each to its OWN message, not to
//     every message on the page. If the per-message filter ever compares the
//     wrong id (or is dropped), every attachment on the page would leak onto
//     every message — this is the test that catches that.
#[tokio::test]
async fn agent_read_groups_attachments_by_their_own_message_on_a_mixed_page() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    // A: text only, no files.
    let sent_a = app
        .post_as_agent(
            &key,
            AGENT_SEND,
            serde_json::json!({ "channel": channel, "body_markdown": "message A, no files" }),
        )
        .await;
    assert_eq!(sent_a.status(), 200, "body: {:?}", sent_a.json().await);
    let message_a = sent_a.json().await["id"].as_i64().expect("message id");

    // B: one file.
    let (ct_b, body_b) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "message B, one file"),
        file("files", "b-report.pdf", "application/pdf", b"%PDF-1.4 b stub"),
    ]);
    let sent_b = app
        .post_multipart_as_agent(&key, AGENT_SEND, &ct_b, body_b)
        .await;
    assert_eq!(sent_b.status(), 200, "body: {:?}", sent_b.json().await);
    let message_b = sent_b.json().await["id"].as_i64().expect("message id");

    // C: two files.
    let (ct_c, body_c) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "message C, two files"),
        file("files", "c-one.png", "image/png", b"C-ONE-BYTES"),
        file("files", "c-two.png", "image/png", b"C-TWO-BYTES"),
    ]);
    let sent_c = app
        .post_multipart_as_agent(&key, AGENT_SEND, &ct_c, body_c)
        .await;
    assert_eq!(sent_c.status(), 200, "body: {:?}", sent_c.json().await);
    let message_c = sent_c.json().await["id"].as_i64().expect("message id");

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    assert_eq!(read.status(), 200, "body: {:?}", read.json().await);
    let page = read.json().await;
    let messages = page["messages"].as_array().expect("messages array");

    let find = |id: i64| -> &Value {
        messages
            .iter()
            .find(|m| m["id"].as_i64() == Some(id))
            .expect("sent message present in the page")
    };

    let msg_a = find(message_a);
    let msg_b = find(message_b);
    let msg_c = find(message_c);

    let atts_a = msg_a["attachments"].as_array().expect("attachments array on A");
    assert_eq!(atts_a, &Vec::<Value>::new(), "A has no files, expected []");

    let atts_b = msg_b["attachments"].as_array().expect("attachments array on B");
    assert_eq!(atts_b.len(), 1, "B has exactly one file");
    assert_eq!(atts_b[0]["name"], serde_json::json!("b-report.pdf"));

    let atts_c = msg_c["attachments"].as_array().expect("attachments array on C");
    assert_eq!(atts_c.len(), 2, "C has exactly two files");
    let c_names: std::collections::HashSet<&str> = atts_c
        .iter()
        .map(|a| a["name"].as_str().expect("name"))
        .collect();
    assert_eq!(
        c_names,
        std::collections::HashSet::from(["c-one.png", "c-two.png"])
    );

    // The assertion that kills a `.filter(|_a| true)` mutation: every
    // attachment reported on a message must point back at THAT message's own
    // id, never a sibling's.
    for (label, msg, atts) in [
        ("B", msg_b, atts_b),
        ("C", msg_c, atts_c),
    ] {
        let own_id = msg["id"].clone();
        for att in atts {
            assert_eq!(
                att["message"], own_id,
                "attachment on message {label} points at a different message: {att:?}"
            );
        }
    }
}
