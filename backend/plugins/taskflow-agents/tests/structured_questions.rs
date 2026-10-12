//! #644: structured questions attached to a message.
//!
//! The field is a JSON STRING on the row — the same shape `targets` uses — so
//! nothing new is needed to store or transport it, and the UI parses it. What
//! is not free is the schema: the UI renders what the promises are, so a
//! question set is validated on the send path and a malformed one is refused
//! BEFORE it is stored. A message that renders as a broken form is worse than
//! a refused send an agent can read and fix.

mod support;

use serde_json::{Value, json};
use support::{MultipartPart, TestApp, encode_multipart, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::TaskflowChannelKind;

/// Mint a project-scoped agent key through the real endpoint.
async fn mint_agent_key(app: &TestApp, project: i64, label: &str) -> String {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(
            human,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": label, "profile": label }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await["key"].as_str().expect("minted key").to_string()
}

/// The question set the owner described: mostly radio and select with an
/// optional "other", a text input, a date.
fn question_set() -> Value {
    json!({
        "title": "Which direction should the pricing page take?",
        "questions": [
            {
                "key": "scope",
                "label": "What should change?",
                "type": "radio",
                "required": true,
                "allow_other": true,
                "options": [
                    { "value": "buttons", "label": "Buttons only" },
                    { "value": "hero", "label": "Hero + buttons", "description": "A bigger change to the layout" },
                ],
            },
            { "key": "notes", "label": "Anything else?", "type": "text", "multiline": true, "placeholder": "Optional" },
            {
                "key": "palette",
                "label": "Palette",
                "type": "select",
                "options": [{ "value": "lime", "label": "Lime" }, { "value": "forest", "label": "Forest" }],
            },
            { "key": "due", "label": "By when?", "type": "date" },
        ],
        "submit_label": "Send answers",
        "cancel_label": "Not now",
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_can_post_a_question_set_and_it_round_trips() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let key = mint_agent_key(&app, project, "Asker").await;

    let posted = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({
                "channel": room,
                "body_markdown": "Before I restyle, three quick decisions.",
                "questions": question_set(),
            }),
        )
        .await;
    assert_eq!(posted.status(), 200, "{}", posted.text());
    let body = posted.json().await;

    // The response carries the questions as JSON TEXT (the row's own shape),
    // so a client parses exactly what the UI will parse later.
    let raw = body["questions"].as_str().expect("questions as a JSON string");
    let parsed: Value = serde_json::from_str(raw).expect("valid JSON");
    assert_eq!(parsed["title"], question_set()["title"]);
    assert_eq!(parsed["questions"][0]["type"], "radio");
    assert_eq!(parsed["questions"][0]["allow_other"], true);
    assert_eq!(parsed["questions"][3]["type"], "date");

    // And it is really on the row, not just in the response: the REST read
    // every other surface uses returns it too.
    let listed = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={room}"))
        .await;
    let rows = listed.json().await;
    let row = rows["messages"]
        .as_array()
        .expect("results")
        .iter()
        .find(|row| row["id"] == body["id"])
        .expect("the posted message");
    assert_eq!(row["questions"].as_str(), Some(raw));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_human_sends_a_question_set_through_the_same_validator() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    // Multipart is the human path: `questions` rides as a JSON string field,
    // exactly like the other structured fields.
    let (content_type, payload) = encode_multipart(&[
        MultipartPart { field_name: "channel".into(), filename: None, content_type: None, bytes: room.to_string().into_bytes() },
        MultipartPart { field_name: "body_markdown".into(), filename: None, content_type: None, bytes: b"two options".to_vec() },
        MultipartPart {
            field_name: "questions".into(),
            filename: None,
            content_type: None,
            bytes: serde_json::to_vec(&question_set()).unwrap(),
        },
    ]);
    let posted = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &content_type, payload)
        .await;
    assert_eq!(posted.status(), 200, "{}", posted.text());
    assert!(posted.json().await["questions"].is_string());

    // Malformed JSON is refused like any other bad structured field.
    let (content_type, payload) = encode_multipart(&[
        MultipartPart { field_name: "channel".into(), filename: None, content_type: None, bytes: room.to_string().into_bytes() },
        MultipartPart { field_name: "body_markdown".into(), filename: None, content_type: None, bytes: b"broken".to_vec() },
        MultipartPart { field_name: "questions".into(), filename: None, content_type: None, bytes: b"{ not json".to_vec() },
    ]);
    let bad = app
        .post_multipart_as(user, "/api/taskflow/agents/messages", &content_type, payload)
        .await;
    assert_eq!(bad.status(), 400, "{}", bad.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_question_set_is_refused_before_it_is_stored() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let key = mint_agent_key(&app, project, "Asker").await;

    let post = |questions: Value| {
        let app = &app;
        let key = key.clone();
        async move {
            app.post_as_agent(
                &key,
                "/api/taskflow/agents/agent/messages",
                json!({ "channel": room, "body_markdown": "ask", "questions": questions }),
            )
            .await
        }
    };
    let with_question = |question: Value| json!({ "questions": [question] });

    // An option type nobody can render.
    let unknown_type = post(with_question(json!({ "key": "a", "label": "Pick", "type": "checkbox" }))).await;
    assert_eq!(unknown_type.status(), 400, "{}", unknown_type.text());

    // A radio with nothing to pick.
    let no_options = post(with_question(json!({ "key": "a", "label": "Pick", "type": "radio", "options": [] }))).await;
    assert_eq!(no_options.status(), 400, "{}", no_options.text());

    // "Other" on a text question makes no sense.
    let other_on_text = post(with_question(json!({ "key": "a", "label": "Say", "type": "text", "allow_other": true }))).await;
    assert_eq!(other_on_text.status(), 400, "{}", other_on_text.text());

    // Two questions with the same key: the answers could not be told apart.
    let duplicate_keys = post(json!({ "questions": [
        { "key": "a", "label": "One", "type": "text" },
        { "key": "a", "label": "Two", "type": "text" },
    ] }))
    .await;
    assert_eq!(duplicate_keys.status(), 400, "{}", duplicate_keys.text());

    // More questions than a person will answer in one dialog.
    let too_many = post(json!({ "questions": (0..9).map(|n| json!({ "key": format!("q{n}"), "label": "Q", "type": "text" })).collect::<Vec<_>>() })).await;
    assert_eq!(too_many.status(), 400, "{}", too_many.text());

    // An empty set is not a question.
    let empty = post(json!({ "questions": [] })).await;
    assert_eq!(empty.status(), 400, "{}", empty.text());

    // None of the refusals stored anything.
    let listed = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/messages?channel={room}"))
        .await;
    let carriers = listed
        .json()
        .await["messages"]
        .as_array()
        .map(|rows| rows.iter().filter(|row| !row["questions"].is_null()).count())
        .unwrap_or(0);
    assert_eq!(carriers, 0, "a refused question set must leave no message behind");
}

#[tokio::test(flavor = "multi_thread")]
async fn questions_are_optional_everywhere_else() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let key = mint_agent_key(&app, project, "Chatty").await;

    let plain = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": room, "body_markdown": "just a message" }),
        )
        .await;
    assert_eq!(plain.status(), 200, "{}", plain.text());
    assert!(plain.json().await["questions"].is_null(), "absent means null");
}
