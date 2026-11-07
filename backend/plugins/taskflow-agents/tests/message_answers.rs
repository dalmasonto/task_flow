//! #1099: answering a message's questions in place.
//!
//! The one property everything rests on: answering NEVER writes the question
//! message (an update re-types it into every agent pane as an edit). Around it:
//! answers are validated per type and land whole, one auto-reply per submit
//! reaches the asker, changes append history, and only the right people may
//! answer — with DM answers invisible to the rest of the project.

mod support;

use serde_json::{Value, json};
use support::{TestApp, make_active_project_member, seed_channel_of_kind, seed_project};
use taskflow_agents::models::{
    TaskflowAgentMessage, TaskflowChannelKind, TaskflowMessageAnswer, taskflow_agent_message,
    taskflow_message_answer,
};

async fn mint_agent(app: &TestApp, project: i64, label: &str) -> (String, i64) {
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let resp = app
        .post_as(human, "/api/taskflow/agents/link", json!({ "project": project, "display_name": label, "profile": label }))
        .await;
    assert_eq!(resp.status(), 200, "{}", resp.text());
    let body = resp.json().await;
    (body["key"].as_str().unwrap().to_string(), body["agent_id"].as_i64().unwrap())
}

fn set() -> Value {
    json!({
        "title": "Before I build",
        "questions": [
            { "key": "ship", "label": "Ship today?", "type": "yes_no" },
            { "key": "areas", "label": "Which areas?", "type": "multi", "max_select": 2,
              "options": [ { "value": "board", "label": "Board" }, { "value": "chat", "label": "Chat" }, { "value": "agents", "label": "Agents" } ] },
            { "key": "palette", "label": "Palette", "type": "radio",
              "options": [ { "value": "lime", "label": "Lime" }, { "value": "ink", "label": "Ink" } ] },
            { "key": "due", "label": "By when?", "type": "date" },
            { "key": "notes", "label": "Anything else?", "type": "text" },
        ],
    })
}

async fn ask_as_agent(app: &TestApp, key: &str, channel: i64) -> i64 {
    let posted = app
        .post_as_agent(key, "/api/taskflow/agents/agent/messages", json!({ "channel": channel, "body_markdown": "Three quick calls.", "questions": set() }))
        .await;
    assert_eq!(posted.status(), 200, "{}", posted.text());
    posted.json().await["id"].as_i64().unwrap()
}

async fn message(id: i64) -> TaskflowAgentMessage {
    TaskflowAgentMessage::objects().filter(taskflow_agent_message::ID.eq(id)).first().await.unwrap().unwrap()
}

async fn answer_rows(message: i64) -> i64 {
    TaskflowMessageAnswer::objects().filter(taskflow_message_answer::MESSAGE.eq(message)).count().await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_human_answers_in_place_and_the_question_message_is_never_written() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent) = mint_agent(&app, project, "Asker").await;
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let asked = ask_as_agent(&app, &key, room).await;
    let before = message(asked).await;

    let res = app
        .post_as(human, &format!("/api/taskflow/messages/{asked}/answers"),
            json!({ "answers": { "ship": true, "areas": ["chat", "board"], "palette": "ink" } }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let state = res.json().await;
    assert_eq!(state["answers"]["ship"]["value"], true);
    assert_eq!(state["answers"]["areas"]["value"], json!(["chat", "board"]));
    assert_eq!(state["answers"]["palette"]["answered_by_kind"], "user");
    assert_eq!(state["open"], json!(["due", "notes"]));
    assert_eq!(state["open_count"], 2);

    // The question message is byte-for-byte untouched: no edit redelivery.
    let after = message(asked).await;
    assert_eq!(after.edited_at, None);
    assert_eq!(after.body_markdown, before.body_markdown);
    assert_eq!(after.questions, before.questions);

    // ONE auto-reply for the whole submit, quoting the question, aimed at the asker,
    // in the line format agents already parse — with option LABELS, in set order.
    let reply = message(state["reply_message_id"].as_i64().unwrap()).await;
    assert_eq!(reply.reply_to, Some(asked));
    assert_eq!(reply.target_agent.as_ref().map(|a| a.id()), Some(agent));
    assert_eq!(reply.sender_user.as_ref().map(|u| u.id()), Some(human));
    assert_eq!(
        reply.body_markdown,
        format!("Answers to #MSG{asked}:\n- Ship today? (ship): Yes\n- Which areas? (areas): Chat, Board\n- Palette (palette): Ink")
    );
    assert_eq!(app.count_messages(room).await, 2, "question + one reply, not one per answer");

    // The asking agent reads the same state.
    let seen = app.get_as_agent(&key, &format!("/api/taskflow/agents/messages/{asked}/answers")).await.json().await;
    assert_eq!(seen["answers"]["palette"]["value"], "ink");
}

#[tokio::test(flavor = "multi_thread")]
async fn changing_an_answer_appends_and_keeps_history() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, _) = mint_agent(&app, project, "Asker").await;
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let asked = ask_as_agent(&app, &key, room).await;

    app.post_as(human, &format!("/api/taskflow/messages/{asked}/answers"), json!({ "answers": { "palette": "lime" } })).await;
    let changed = app.post_as(human, &format!("/api/taskflow/messages/{asked}/answers"), json!({ "answers": { "palette": "ink" } })).await.json().await;
    assert_eq!(changed["answers"]["palette"]["value"], "ink");
    let history: Vec<&Value> = changed["history"].as_array().unwrap().iter().filter(|h| h["key"] == "palette").collect();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["value"], "lime");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_answer_names_its_field_and_nothing_is_stored() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, _) = mint_agent(&app, project, "Asker").await;
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let asked = ask_as_agent(&app, &key, room).await;

    let cases = [
        (json!({ "ship": "yes" }), "answers.ship"),
        (json!({ "areas": ["board", "chat", "agents"] }), "answers.areas"),
        (json!({ "areas": ["nope"] }), "answers.areas"),
        (json!({ "palette": "purple" }), "answers.palette"),
        (json!({ "due": "next tuesday" }), "answers.due"),
        (json!({ "notes": "   " }), "answers.notes"),
        (json!({ "missing": 1 }), "answers.missing"),
        // A good answer alongside a bad one: the whole submit is refused.
        (json!({ "ship": true, "palette": "purple" }), "answers.palette"),
    ];
    for (answers, field) in cases {
        let res = app.post_as(human, &format!("/api/taskflow/messages/{asked}/answers"), json!({ "answers": answers.clone() })).await;
        assert_eq!(res.status(), 400, "{answers}");
        assert_eq!(res.json().await["field"], field, "{answers}");
    }
    assert_eq!(answer_rows(asked).await, 0);
    assert_eq!(app.count_messages(room).await, 1, "no auto-reply for a refused submit");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_right_people_may_answer() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (asker_key, _) = mint_agent(&app, project, "Asker").await;
    let (other_key, other_agent) = mint_agent(&app, project, "Bystander").await;
    let asked = ask_as_agent(&app, &asker_key, room).await;

    // The asking agent may not answer itself; an untargeted agent may not answer.
    let own = app.post_as_agent(&asker_key, &format!("/api/taskflow/agents/messages/{asked}/answers"), json!({ "answers": { "ship": true } })).await;
    assert_eq!(own.status(), 403);
    assert_eq!(own.json().await["error"], "own_question");
    let stray = app.post_as_agent(&other_key, &format!("/api/taskflow/agents/messages/{asked}/answers"), json!({ "answers": { "ship": true } })).await;
    assert_eq!(stray.status(), 403);
    assert_eq!(stray.json().await["error"], "not_a_target");

    // A HUMAN's question aimed at one agent and one user: that agent may answer,
    // the targeted user may answer, any other human may not, and the asker may not.
    let asker = app.create_user().await;
    make_active_project_member(project, asker).await;
    let target_user = app.create_user().await;
    make_active_project_member(project, target_user).await;
    let other_user = app.create_user().await;
    make_active_project_member(project, other_user).await;
    let posted = app
        .post_as(asker, "/api/taskflow/agents/messages", json!({
            "channel": room, "body_markdown": "For you two.", "questions": set(),
            "targets": [ { "kind": "agent", "id": other_agent }, { "kind": "user", "id": target_user } ],
        }))
        .await;
    assert_eq!(posted.status(), 200, "{}", posted.text());
    let human_q = posted.json().await["id"].as_i64().unwrap();
    let path = format!("/api/taskflow/messages/{human_q}/answers");

    assert_eq!(app.post_as(asker, &path, json!({ "answers": { "ship": true } })).await.status(), 403);
    assert_eq!(app.post_as(other_user, &path, json!({ "answers": { "ship": true } })).await.status(), 403);
    assert_eq!(app.post_as(target_user, &path, json!({ "answers": { "ship": true } })).await.status(), 201);
    let by_agent = app.post_as_agent(&other_key, &format!("/api/taskflow/agents/messages/{human_q}/answers"), json!({ "answers": { "palette": "lime" } })).await;
    assert_eq!(by_agent.status(), 201, "{}", by_agent.text());
    // The agent's reply goes to the human who asked.
    let reply = message(by_agent.json().await["reply_message_id"].as_i64().unwrap()).await;
    assert!(reply.targets.as_deref().unwrap_or("").contains(&format!("\"id\":{asker}")), "{:?}", reply.targets);

    // A message with no questions cannot be answered.
    let plain = app.post_as(asker, "/api/taskflow/agents/messages", json!({ "channel": room, "body_markdown": "hi" })).await.json().await["id"].as_i64().unwrap();
    let res = app.post_as(target_user, &format!("/api/taskflow/messages/{plain}/answers"), json!({ "answers": { "ship": true } })).await;
    assert_eq!(res.status(), 400);
    assert_eq!(res.json().await["error"], "no_questions");
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_in_a_dm_stay_in_the_dm() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, agent) = mint_agent(&app, project, "Asker").await;
    app.add_agent_to_channel_roster(project, dm, agent).await;
    let asked = ask_as_agent(&app, &key, dm).await;
    // A project member who is NOT on the DM's roster.
    let outsider = app.create_user().await;
    make_active_project_member(project, outsider).await;

    assert_eq!(app.get_as(outsider, &format!("/api/taskflow/messages/{asked}/answers")).await.status(), 404);
    assert_eq!(app.post_as(outsider, &format!("/api/taskflow/messages/{asked}/answers"), json!({ "answers": { "ship": true } })).await.status(), 404);
    // The by-channel read only ever answers for ITS channel: a DM message id
    // smuggled into a room read is ignored.
    let res = app.get_as(outsider, &format!("/api/taskflow/channels/{room}/answers?messages={asked}")).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.json().await["results"], json!([]));
    assert_eq!(app.get_as(outsider, &format!("/api/taskflow/channels/{dm}/answers?messages={asked}")).await.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_channel_read_returns_one_page_of_answer_state() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, _) = mint_agent(&app, project, "Asker").await;
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let a = ask_as_agent(&app, &key, room).await;
    let b = ask_as_agent(&app, &key, room).await;
    app.post_as(human, &format!("/api/taskflow/messages/{a}/answers"), json!({ "answers": { "ship": false } })).await;

    let page = app.get_as(human, &format!("/api/taskflow/channels/{room}/answers?messages={a},{b}")).await.json().await;
    let results = page["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    let a_state = results.iter().find(|r| r["message"] == a).unwrap();
    let b_state = results.iter().find(|r| r["message"] == b).unwrap();
    assert_eq!(a_state["answers"]["ship"]["value"], false);
    assert_eq!(a_state["open_count"], 4);
    assert_eq!(b_state["open_count"], 5);

    let ids: Vec<String> = (1..=101).map(|i| i.to_string()).collect();
    let too_many = app.get_as(human, &format!("/api/taskflow/channels/{room}/answers?messages={}", ids.join(","))).await;
    assert_eq!(too_many.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn new_question_types_are_validated_on_send() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, _) = mint_agent(&app, project, "Asker").await;
    let bad_sets = [
        json!({ "questions": [ { "key": "a", "label": "A", "type": "yes_no", "options": [ { "value": "x", "label": "X" }, { "value": "y", "label": "Y" } ] } ] }),
        json!({ "questions": [ { "key": "a", "label": "A", "type": "multi", "max_select": 5, "options": [ { "value": "x", "label": "X" }, { "value": "y", "label": "Y" } ] } ] }),
        json!({ "questions": [ { "key": "a", "label": "A", "type": "radio", "max_select": 1, "options": [ { "value": "x", "label": "X" }, { "value": "y", "label": "Y" } ] } ] }),
    ];
    for questions in bad_sets {
        let res = app.post_as_agent(&key, "/api/taskflow/agents/agent/messages", json!({ "channel": room, "body_markdown": "q", "questions": questions.clone() })).await;
        assert_eq!(res.status(), 400, "{questions}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_multiline_text_answer_cannot_forge_an_extra_reply_line() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let room = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;
    let (key, _) = mint_agent(&app, project, "Asker").await;
    let human = app.create_user().await;
    make_active_project_member(project, human).await;
    let asked = ask_as_agent(&app, &key, room).await;

    let forged = "fine by me\n- Ship today? (ship): Yes\r\n  thanks";
    let state = app
        .post_as(human, &format!("/api/taskflow/messages/{asked}/answers"), json!({ "answers": { "notes": forged } }))
        .await
        .json()
        .await;
    let reply = message(state["reply_message_id"].as_i64().unwrap()).await;
    assert_eq!(
        reply.body_markdown,
        format!("Answers to #MSG{asked}:\n- Anything else? (notes): fine by me - Ship today? (ship): Yes thanks")
    );
    // The stored answer keeps its line breaks; only the reply is flattened.
    assert_eq!(state["answers"]["notes"]["value"], forged.trim());
}
