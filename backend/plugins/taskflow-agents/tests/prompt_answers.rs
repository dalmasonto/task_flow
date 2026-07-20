//! Answering an agent's `AskUserQuestion` from the dashboard.
//!
//! The tool accepts SEVERAL questions in one call, and the agent's terminal
//! presents them one at a time. A whole set is therefore stored as ONE prompt row
//! and answered as a set, so the agent is woken once and replays the keystrokes
//! in order — a half-answered set would send the remaining digits at whatever
//! screen the agent had moved on to.
//!
//! Two shapes are accepted, because rows written before multi-question support
//! are still in the table:
//!
//!   legacy  options_json = [{number, label}]      answered with choice/choices
//!   set     options_json = [{question, options}]  answered with `answers`
//!
//! The endpoint had no tests at all before this file; the legacy cases below pin
//! the behaviour that already existed.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, seed_project};

async fn mint(app: &TestApp, user: i64, project: i64) -> (i64, String) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Builder", "profile": "main" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed");
    let body = resp.json().await;
    (
        body["agent_id"].as_i64().expect("agent_id"),
        body["key"].as_str().expect("key").to_string(),
    )
}

/// Unique per call: sessions are keyed by `session_identifier`, and these tests
/// share one database, so a fixed id makes every test after the first collide
/// with a 409.
static NEXT_SESSION: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

async fn register_session(app: &TestApp, key: &str) -> i64 {
    let n = NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resp = app
        .post_as_agent(
            key,
            "/api/taskflow/agents/sessions",
            json!({ "session_identifier": format!("test:pane:{n}"), "host": "test", "pid": 1, "cwd": "/tmp" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "register failed");
    resp.json().await["id"].as_i64().expect("session id")
}

/// Report a prompt as the agent and return its id.
async fn report(app: &TestApp, key: &str, session: i64, options_json: &str, kind: &str) -> i64 {
    let resp = app
        .post_as_agent(
            key,
            &format!("/api/taskflow/agents/sessions/{session}/prompt"),
            json!({
                "question": "Colour?",
                "options_json": options_json,
                "kind": kind,
                "fingerprint": "f1",
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "report failed: {:?}", resp.json().await);
    resp.json().await["id"].as_i64().expect("prompt id")
}

const LEGACY: &str = r#"[{"number":1,"label":"Red"},{"number":2,"label":"Green"}]"#;

/// Two questions: a single-select and a multi-select.
const SET: &str = r#"[
  {"question":"Colour?","kind":"single","options":[{"number":1,"label":"Red"},{"number":2,"label":"Green"}]},
  {"question":"Checks?","kind":"multi","options":[{"number":1,"label":"Lint"},{"number":2,"label":"Types"},{"number":3,"label":"Tests"}]}
]"#;

struct Fixture {
    app: TestApp,
    user: i64,
    key: String,
    session: i64,
}

async fn fixture() -> Fixture {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent, key) = mint(&app, user, project).await;
    let session = register_session(&app, &key).await;
    Fixture { app, user, key, session }
}

#[tokio::test]
async fn a_legacy_single_select_is_answered_with_one_choice() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, LEGACY, "single").await;

    let resp = f
        .app
        .post_as(f.user, &format!("/api/taskflow/prompts/{prompt}/answer"), json!({ "choice": 2 }))
        .await;
    assert_eq!(resp.status(), 200);
    let body = resp.json().await;
    assert_eq!(body["status"], json!("answered"));
    assert_eq!(body["answer"], json!(2));
    assert_eq!(body["answer_json"], json!("[2]"));
}

// The option numbers are typed into a LIVE terminal, so an unoffered number must
// never be accepted.
#[tokio::test]
async fn an_unoffered_number_is_refused() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, LEGACY, "single").await;
    let resp = f
        .app
        .post_as(f.user, &format!("/api/taskflow/prompts/{prompt}/answer"), json!({ "choice": 9 }))
        .await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
async fn a_set_is_answered_with_one_choice_list_per_question() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, SET, "set").await;

    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[2], [1, 3]] }),
        )
        .await;
    assert_eq!(resp.status(), 200, "answering a full set must succeed");
    let body = resp.json().await;
    assert_eq!(body["status"], json!("answered"));
    // Stored nested so the agent can replay each question's keystrokes in order.
    assert_eq!(body["answer_json"], json!("[[2],[1,3]]"));
    // `answer` keeps the first choice for display.
    assert_eq!(body["answer"], json!(2));
}

// Every question must be answered before the agent is woken: the terminal shows
// them one at a time, so replaying a partial set sends the leftover digits at
// the wrong screen.
#[tokio::test]
async fn a_partially_answered_set_is_refused() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, SET, "set").await;
    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[2]] }),
        )
        .await;
    assert_eq!(resp.status(), 400, "one answer for two questions must be refused");
}

// Each question carries its OWN kind, so validation is per question — question 1
// here is single-select and cannot take two numbers.
#[tokio::test]
async fn a_single_select_question_inside_a_set_still_takes_exactly_one() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, SET, "set").await;
    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[1, 2], [1]] }),
        )
        .await;
    assert_eq!(resp.status(), 400);
}

// Numbers are validated against the question they belong to, not the union of
// every question's options — 3 is valid for "Checks?" but not for "Colour?".
#[tokio::test]
async fn a_number_valid_for_another_question_is_refused() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, SET, "set").await;
    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[3], [1]] }),
        )
        .await;
    assert_eq!(resp.status(), 400, "3 is not an option for question 1");
}

#[tokio::test]
async fn an_empty_choice_list_for_a_question_is_refused() {
    let f = fixture().await;
    let prompt = report(&f.app, &f.key, f.session, SET, "set").await;
    let resp = f
        .app
        .post_as(
            f.user,
            &format!("/api/taskflow/prompts/{prompt}/answer"),
            json!({ "answers": [[], [1]] }),
        )
        .await;
    assert_eq!(resp.status(), 400);
}
