//! #525: posting a message from inside another tool — the helpers the design
//! tools' `deliver` goes through.
//!
//! The render path itself needs a renderer (not configured in tests, so the
//! tools answer 503 before delivery ever runs). What is testable here is the
//! part that could silently break in production: the membership rule — a
//! render must land nowhere a sentence could not — and that the message and
//! its attachments are recorded exactly once, with the bytes that were handed
//! in.

mod support;

use support::{TestApp, make_active_project_member, seed_channel_of_kind, seed_project};
use umbral::orm::Model as _;

use taskflow_agents::agent_auth::resolve_agent;
use taskflow_agents::models::{
    TaskflowAgentMessage, TaskflowChannelKind, TaskflowMessageAttachment, taskflow_agent_message,
    taskflow_message_attachment,
};
use taskflow_agents::posting::{OutgoingFile, PostError, post_agent_message, postable_channel};

/// Mint a project-scoped agent key through the real endpoint (the same helper
/// the message tests use): the identity `postable_channel` checks is the one a
/// deployed agent would have.
async fn mint_agent_key(app: &TestApp, project: i64, label: &str) -> String {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(
            human,
            "/api/taskflow/agents/link",
            serde_json::json!({ "project": project, "display_name": label, "profile": label }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await["key"].as_str().expect("minted key").to_string()
}

fn file(name: &str, bytes: &[u8]) -> OutgoingFile {
    OutgoingFile {
        filename: name.to_string(),
        content_type: "image/png".to_string(),
        bytes: bytes.to_vec(),
    }
}

#[tokio::test]
async fn posting_from_another_tool_records_the_message_and_its_files() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let key = mint_agent_key(&app, project, "Deliverer").await;
    let agent = resolve_agent(&key).await.expect("the minted key resolves");

    let channel = postable_channel(&agent, room).await.expect("its own project's room");
    let (message, attachments) = post_agent_message(
        &agent,
        &channel,
        "two renders",
        None,
        vec![file("home.png", &[1, 2, 3]), file("settings.png", &[4, 5])],
    )
    .await
    .expect("the post lands");

    assert_eq!(message.channel.id(), room);
    assert_eq!(message.body_markdown, "two renders");
    assert_eq!(message.client_nonce, None, "a programmatic post has no nonce to replay");
    assert_eq!(
        message.is_design, channel.is_design,
        "the DESTINATION decides, as on every other path"
    );
    assert_eq!(attachments.len(), 2);
    assert_eq!(attachments[0].name, "home.png");
    assert_eq!(attachments[0].content_type, "image/png");
    assert_eq!(attachments[0].size_bytes, 3, "the bytes handed in are the bytes recorded");
    assert_eq!(attachments[0].message.id(), message.id);
    assert_eq!(attachments[1].size_bytes, 2);
    assert!(
        attachments[0].file.url().starts_with("http") || attachments[0].file.url().starts_with('/'),
        "a resolvable url: {}",
        attachments[0].file.url()
    );

    // The rows are really there, not just returned.
    let count = TaskflowMessageAttachment::objects()
        .filter(taskflow_message_attachment::MESSAGE.eq(message.id))
        .count()
        .await
        .unwrap_or(0);
    assert_eq!(count, 2);
    let messages = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::CHANNEL.eq(room))
        .count()
        .await
        .unwrap_or(0);
    assert_eq!(messages, 1);
}

#[tokio::test]
async fn posting_refuses_a_foreign_room_and_a_dm_off_the_roster() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let other_project = seed_project().await;
    let key = mint_agent_key(&app, project, "Deliverer").await;
    let agent = resolve_agent(&key).await.expect("the minted key resolves");

    // Another project's room: a shared room is postable only in the agent's OWN
    // project.
    let foreign = seed_channel_of_kind(other_project, TaskflowChannelKind::Project).await;
    assert!(matches!(
        postable_channel(&agent, foreign).await,
        Err(PostError::NotAllowed)
    ));

    // A DM in its own project it is not on the roster of: private, so refused.
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    assert!(matches!(postable_channel(&agent, dm).await, Err(PostError::NotAllowed)));

    // And a channel that does not exist at all.
    assert!(matches!(
        postable_channel(&agent, 999_999).await,
        Err(PostError::ChannelNotFound)
    ));

    // Nothing was written by any of the refusals — counted in the channels
    // themselves: the project's room may already carry its own marker message,
    // which is not this path's doing.
    for channel in [foreign, dm] {
        let messages = TaskflowAgentMessage::objects()
            .filter(taskflow_agent_message::CHANNEL.eq(channel))
            .count()
            .await
            .unwrap_or(0);
        assert_eq!(messages, 0, "a refused delivery must leave no message in channel {channel}");
    }
}

#[tokio::test]
async fn an_oversized_file_is_refused_before_the_message_exists() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let key = mint_agent_key(&app, project, "Deliverer").await;
    let agent = resolve_agent(&key).await.expect("the minted key resolves");
    let channel = postable_channel(&agent, room).await.expect("its own project's room");

    let too_big = vec![0u8; 26 * 1024 * 1024];
    let outcome = post_agent_message(&agent, &channel, "huge", None, vec![file("huge.png", &too_big)]).await;
    match outcome {
        Err(PostError::TooLarge { name, max_mb }) => {
            assert_eq!(name, "huge.png");
            assert_eq!(max_mb, 25);
        }
        other => panic!("expected TooLarge, got {:?}", other.map(|(m, _)| m.id)),
    }

    let messages = TaskflowAgentMessage::objects()
        .filter(taskflow_agent_message::BODY_MARKDOWN.eq("huge"))
        .count()
        .await
        .unwrap_or(0);
    assert_eq!(
        messages, 0,
        "an oversized render fails the WHOLE message rather than persisting one whose attachment cannot store"
    );
}
