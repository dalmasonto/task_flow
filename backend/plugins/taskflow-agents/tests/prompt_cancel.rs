//! Cancelling a prompt — the missing HUMAN half of the #127 message gate.
//!
//! `mcp/src/prompt-gate.ts` pauses pane delivery while THIS agent has an open
//! prompt (typing into a pane that is waiting on one corrupts the answer), and
//! it hydrates that gate from `GET /api/taskflow/agents/prompts`. Every way to
//! stop a prompt being `pending` was driven by the AGENT itself — a new report
//! supersedes, the pane-watcher clears when the prompt leaves the screen — so a
//! prompt answered at the keyboard that the MCP missed the transition for stays
//! `pending` for ever and every message for that agent queues behind it, silently.
//!
//! The assertion that matters most here is
//! [`cancelling_drops_the_prompt_out_of_the_agents_open_list`]: that endpoint is
//! the gate's ONLY authority, so a cancel that leaves the row listed does nothing
//! for the user however green the rest of this file looks. It is arranged so it
//! cannot pass vacuously — the prompt is asserted to be IN the list first — and
//! it was mutation-checked (see the task report): with the status write removed
//! from `views::cancel_prompt_row`, it fails.

mod support;

use serde_json::json;
use support::{TestApp, make_active_project_member, seed_project};

async fn mint(app: &TestApp, user: i64, project: i64, display: &str) -> (i64, String) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": display, "profile": display }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed");
    let b = resp.json().await;
    (
        b["agent_id"].as_i64().expect("agent_id"),
        b["key"].as_str().expect("key").to_string(),
    )
}

/// Unique per call: a session is keyed by `session_identifier` and every test in
/// this binary shares one database, so a fixed id collides with a 409.
static NEXT_SESSION: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

async fn register_session(app: &TestApp, key: &str) -> i64 {
    let n = NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resp = app
        .post_as_agent(
            key,
            "/api/taskflow/agents/sessions",
            json!({ "session_identifier": format!("cancel:pane:{n}"), "host": "t", "pid": 1, "cwd": "/tmp" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "register failed");
    resp.json().await["id"].as_i64().expect("session id")
}

async fn report(app: &TestApp, key: &str, session: i64) -> i64 {
    let resp = app
        .post_as_agent(
            key,
            &format!("/api/taskflow/agents/sessions/{session}/prompt"),
            json!({
                "question": "Colour?",
                "options_json": r#"[{"number":1,"label":"Red"},{"number":2,"label":"Green"}]"#,
                "kind": "single",
                "fingerprint": "f1",
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "report failed: {:?}", resp.json().await);
    resp.json().await["id"].as_i64().expect("prompt id")
}

/// What the MCP's gate reads: the agent's own OPEN (pending) prompts.
async fn open_prompt_ids(app: &TestApp, key: &str) -> Vec<i64> {
    let resp = app.get_as_agent(key, "/api/taskflow/agents/prompts").await;
    assert_eq!(resp.status(), 200, "open-prompts read failed");
    resp.json()
        .await
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["id"].as_i64().expect("prompt id"))
        .collect()
}

/// THE test. `list_open_prompts_as_agent` is the gate's only authority: the
/// cancel has to remove the row from it, not merely write `cancelled` somewhere.
#[tokio::test]
async fn cancelling_drops_the_prompt_out_of_the_agents_open_list() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent, key) = mint(&app, user, project, "claude").await;
    let session = register_session(&app, &key).await;
    let prompt = report(&app, &key, session).await;

    // Precondition, and the guard against a vacuous pass: this exact endpoint
    // must be LISTING the prompt before the cancel, or "empty afterwards" would
    // prove nothing at all.
    assert_eq!(
        open_prompt_ids(&app, &key).await,
        vec![prompt],
        "precondition: the prompt is open, so the agent's message gate is closed"
    );

    let resp = app
        .post_as(user, &format!("/api/taskflow/prompts/{prompt}/cancel"), json!({}))
        .await;
    assert_eq!(resp.status(), 200, "cancel failed: {:?}", resp.json().await);

    // THE ASSERTION, and deliberately the first one after the call. Still listed
    // → the gate stays shut and the bug is unfixed. Everything below it is
    // cosmetic by comparison, so a regression must break HERE.
    assert!(
        open_prompt_ids(&app, &key).await.is_empty(),
        "a cancelled prompt is still listed as open, so the agent's message gate \
         never opens — this is the bug the endpoint exists to fix"
    );
    assert_eq!(
        resp.json().await["status"].as_str(),
        Some("cancelled"),
        "the response must report the row as cancelled"
    );
}

/// Ruling 1's authorisation half: an authenticated NON-member must not be able to
/// unblock someone else's agent.
#[tokio::test]
async fn a_non_member_cannot_cancel() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_active_project_member(project, owner).await;
    let (_agent, key) = mint(&app, owner, project, "claude").await;
    let session = register_session(&app, &key).await;
    let prompt = report(&app, &key, session).await;

    // Authenticated, but a stranger to this project.
    let stranger = app.create_user().await;
    let resp = app
        .post_as(stranger, &format!("/api/taskflow/prompts/{prompt}/cancel"), json!({}))
        .await;
    assert_eq!(resp.status(), 403, "a non-member must be refused");

    // Not merely a 403: the refusal must not have half-applied.
    assert_eq!(
        open_prompt_ids(&app, &key).await,
        vec![prompt],
        "the refused cancel must leave the prompt exactly as it was"
    );
}

/// Ruling 3: a stale card is a quiet success, never an error — and the cancel
/// must not clobber the answer it finds.
#[tokio::test]
async fn cancelling_an_answered_prompt_is_a_quiet_no_op() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent, key) = mint(&app, user, project, "claude").await;
    let session = register_session(&app, &key).await;
    let prompt = report(&app, &key, session).await;

    // The agent was answered in the terminal and the MCP got there first — the
    // exact race that leaves a stale card on screen.
    let answered = app
        .post_as(user, &format!("/api/taskflow/prompts/{prompt}/answer"), json!({ "choice": 1 }))
        .await;
    assert_eq!(answered.status(), 200, "answer failed");

    let resp = app
        .post_as(user, &format!("/api/taskflow/prompts/{prompt}/cancel"), json!({}))
        .await;
    assert_eq!(
        resp.status(),
        200,
        "cancelling an already-settled prompt is a no-op, not an error"
    );
    assert_eq!(
        resp.json().await["status"].as_str(),
        Some("answered"),
        "the cancel must not overwrite an ANSWER — it is not a dismissal of work \
         that was actually done"
    );
    assert!(open_prompt_ids(&app, &key).await.is_empty());
}

/// Ruling 1's per-prompt half: the user is dismissing ONE card. Another question
/// the same agent still has open must keep its own gate closed — a session-wide
/// clear here would un-gate an agent that is genuinely still waiting.
#[tokio::test]
async fn cancelling_one_prompt_leaves_another_open() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (_agent, key) = mint(&app, user, project, "claude").await;

    // Two sessions, so the second report does NOT supersede the first (a
    // supersede is per session).
    let first_session = register_session(&app, &key).await;
    let second_session = register_session(&app, &key).await;
    let first = report(&app, &key, first_session).await;
    let second = report(&app, &key, second_session).await;
    assert_eq!(open_prompt_ids(&app, &key).await, vec![first, second]);

    let resp = app
        .post_as(user, &format!("/api/taskflow/prompts/{first}/cancel"), json!({}))
        .await;
    assert_eq!(resp.status(), 200, "cancel failed");

    assert_eq!(
        open_prompt_ids(&app, &key).await,
        vec![second],
        "cancelling one card must not touch the agent's other open question"
    );
}

#[tokio::test]
async fn cancelling_a_prompt_that_does_not_exist_is_404() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let resp = app
        .post_as(user, "/api/taskflow/prompts/99999999/cancel", json!({}))
        .await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn requires_authentication() {
    // Fresh client, no default header: an unauthenticated caller never reaches
    // the handler (the same gate `answer_prompt` has).
    let app = TestApp::new().await;
    let resp = app
        .post_json_noauth("/api/taskflow/prompts/1/cancel", json!({}))
        .await;
    assert_eq!(resp.status(), 401);
}
