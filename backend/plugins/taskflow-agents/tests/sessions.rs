//! Stage 3 of the agent identity system: live sessions + streamed terminal
//! frames. An agent registers a session (which brings it online), heartbeats its
//! liveness, appends terminal frames that get a per-session incrementing
//! sequence, and closes it (which takes the agent offline once no session is
//! live). Every op that names a session is gated on ownership: an agent may only
//! touch its own sessions.

use serde_json::json;

mod support;
use support::{TestApp, make_active_project_member, seed_project};
use taskflow_agents::models::{
    TaskflowAgentSessionStatus, TaskflowAgentStatus, TaskflowAgentTerminalFrame,
    taskflow_agent_terminal_frame,
};
use umbral::orm::Model;

/// Mint a fresh agent key for `(project, display_name, profile)` as `user`,
/// returning `(key, agent_id)`. Distinct `(display_name, profile)` pairs map to
/// distinct agents (the identifier is `agent:{project}:{slug}:{profile}`), which
/// is how the ownership test stands up two agents in one project.
async fn mint_agent(
    app: &TestApp,
    user: i64,
    project: i64,
    display_name: &str,
    profile: &str,
) -> (String, i64) {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": display_name, "profile": profile }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    let body = resp.json().await;
    (
        body["key"].as_str().unwrap().to_string(),
        body["agent_id"].as_i64().unwrap(),
    )
}

/// Register (or reconnect) a session by identifier as the given agent key.
async fn register(app: &TestApp, key: &str, session_identifier: &str) -> support::TestResponse {
    app.post_as_agent(
        key,
        "/api/taskflow/agents/sessions",
        json!({ "session_identifier": session_identifier, "host": "box-1", "pid": 4242 }),
    )
    .await
}

// Registering a session creates a connected row and brings the agent online.
// Re-registering the SAME identifier as the SAME agent flips a disconnected row
// back to connected and bumps last_seen_at. A DIFFERENT agent registering that
// identifier is rejected (the identifier is globally unique).
#[tokio::test]
async fn session_register_and_reconnect() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Register → connected session, agent online.
    let resp = register(&app, &key, "sess-abc").await;
    assert_eq!(resp.status(), 200, "body: {:?}", resp.json().await);
    let row = resp.json().await;
    assert_eq!(row["status"], json!("connected"));
    assert_eq!(row["agent"], json!(agent_id));
    assert_eq!(row["project"], json!(project));
    assert_eq!(row["host"], json!("box-1"));
    assert_eq!(row["disconnected_at"], json!(null));
    let session_id = row["id"].as_i64().expect("session id");
    let first_seen = row["last_seen_at"].as_str().expect("last_seen_at").to_string();

    // The agent row itself is now connected.
    assert_eq!(app.agent(agent_id).await.status, TaskflowAgentStatus::Connected);

    // Close it so the reconnect flips a disconnected row back to connected.
    let closed = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/sessions/{session_id}/close"),
            json!({}),
        )
        .await;
    assert_eq!(closed.status(), 200);
    assert_eq!(
        app.session(session_id).await.status,
        TaskflowAgentSessionStatus::Disconnected
    );

    // Re-register the same identifier as the same agent → the SAME row, flipped
    // back to connected, disconnected_at cleared, last_seen advanced.
    let again = register(&app, &key, "sess-abc").await;
    assert_eq!(again.status(), 200);
    let again_row = again.json().await;
    assert_eq!(again_row["id"].as_i64().unwrap(), session_id, "reconnect must reuse the row");
    assert_eq!(again_row["status"], json!("connected"));
    assert_eq!(again_row["disconnected_at"], json!(null));
    let second_seen = again_row["last_seen_at"].as_str().unwrap().to_string();
    assert!(second_seen >= first_seen, "last_seen_at must not go backwards");

    // A DIFFERENT agent (same project) cannot claim that identifier → 409.
    let (other_key, _other_id) = mint_agent(&app, user, project, "Rival", "main").await;
    let conflict = register(&app, &other_key, "sess-abc").await;
    assert_eq!(conflict.status(), 409, "a foreign agent must not claim the identifier");
}

// A heartbeat bumps the session's and the agent's last_seen_at, and applies the
// activity-status hint (idle/busy) to the agent.
#[tokio::test]
async fn heartbeat_bumps_last_seen() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    let session_id = register(&app, &key, "sess-hb").await.json().await["id"]
        .as_i64()
        .unwrap();

    let before_session = app.session(session_id).await.last_seen_at;
    let before_agent = app.agent(agent_id).await.last_seen_at;

    // Heartbeat with a "busy" hint.
    let hb = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/sessions/{session_id}/heartbeat"),
            json!({ "status": "busy" }),
        )
        .await;
    assert_eq!(hb.status(), 200, "body: {:?}", hb.json().await);

    let after_session = app.session(session_id).await;
    let after_agent = app.agent(agent_id).await;
    assert!(after_session.last_seen_at >= before_session, "session last_seen bumped");
    assert!(after_agent.last_seen_at >= before_agent, "agent last_seen bumped");
    assert_eq!(after_agent.status, TaskflowAgentStatus::Busy, "hint applied");

    // A plain heartbeat (no hint) returns the agent to connected.
    let hb2 = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/sessions/{session_id}/heartbeat"),
            json!({}),
        )
        .await;
    assert_eq!(hb2.status(), 200);
    assert_eq!(app.agent(agent_id).await.status, TaskflowAgentStatus::Connected);
}

// Three frame posts to one session get sequence 1, 2, 3 and store their content;
// each response carries the row fields the realtime projection also puts on the
// wire (sequence + content).
#[tokio::test]
async fn frames_append_incrementing_sequence() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    let session_id = register(&app, &key, "sess-frames").await.json().await["id"]
        .as_i64()
        .unwrap();

    for (i, line) in ["line one", "line two", "line three"].iter().enumerate() {
        let resp = app
            .post_as_agent(
                &key,
                &format!("/api/taskflow/agents/sessions/{session_id}/frames"),
                json!({ "content": line }),
            )
            .await;
        assert_eq!(resp.status(), 200, "body: {:?}", resp.json().await);
        let row = resp.json().await;
        assert_eq!(row["sequence"], json!(i as i64 + 1), "sequence must be 1,2,3");
        assert_eq!(row["content"], json!(*line));
        assert_eq!(row["stream"], json!("stdout"), "stream defaults to stdout");
        assert_eq!(row["session"], json!(session_id));
        assert_eq!(row["agent"], json!(agent_id));
        assert_eq!(row["project"], json!(project));
    }
    assert_eq!(app.count_frames(session_id).await, 3);

    // A batch continues the sequence (4, 5) from where the singles left off.
    let batch = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/sessions/{session_id}/frames"),
            json!({ "frames": [
                { "content": "four", "stream": "stderr" },
                { "content": "five" },
            ] }),
        )
        .await;
    assert_eq!(batch.status(), 200, "body: {:?}", batch.json().await);
    let frames = batch.json().await;
    let arr = frames["frames"].as_array().expect("frames array");
    assert_eq!(arr[0]["sequence"], json!(4));
    assert_eq!(arr[0]["stream"], json!("stderr"));
    assert_eq!(arr[1]["sequence"], json!(5));
    assert_eq!(app.count_frames(session_id).await, 5);

    // Oversized content is rejected 400.
    let big = "x".repeat(20_001);
    let rejected = app
        .post_as_agent(
            &key,
            &format!("/api/taskflow/agents/sessions/{session_id}/frames"),
            json!({ "content": big }),
        )
        .await;
    assert_eq!(rejected.status(), 400);
    assert_eq!(app.count_frames(session_id).await, 5, "a rejected frame writes nothing");
}

// Close flips the session to disconnected and sets disconnected_at. The agent
// goes offline only when it has NO other connected session — a second live
// session keeps it online.
#[tokio::test]
async fn close_marks_disconnected_and_offline() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    // Two live sessions for the same agent.
    let s1 = register(&app, &key, "sess-1").await.json().await["id"].as_i64().unwrap();
    let s2 = register(&app, &key, "sess-2").await.json().await["id"].as_i64().unwrap();
    assert_eq!(app.agent(agent_id).await.status, TaskflowAgentStatus::Connected);

    // Close the first → session disconnected, but the agent stays connected
    // because the second session is still live.
    let close1 = app
        .post_as_agent(&key, &format!("/api/taskflow/agents/sessions/{s1}/close"), json!({}))
        .await;
    assert_eq!(close1.status(), 200);
    let closed_row = close1.json().await;
    assert_eq!(closed_row["status"], json!("disconnected"));
    assert_ne!(closed_row["disconnected_at"], json!(null));
    assert_eq!(
        app.agent(agent_id).await.status,
        TaskflowAgentStatus::Connected,
        "another live session keeps the agent online"
    );

    // Close the second → no session remains connected → agent offline.
    let close2 = app
        .post_as_agent(&key, &format!("/api/taskflow/agents/sessions/{s2}/close"), json!({}))
        .await;
    assert_eq!(close2.status(), 200);
    assert_eq!(
        app.session(s2).await.status,
        TaskflowAgentSessionStatus::Disconnected
    );
    assert_eq!(
        app.agent(agent_id).await.status,
        TaskflowAgentStatus::Offline,
        "no live session → agent offline"
    );
}

// Ownership: agent B cannot heartbeat, frame, or close agent A's session. Each
// is a 403, and a missing session is a 404.
#[tokio::test]
async fn session_ops_require_ownership() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let (key_a, _a) = mint_agent(&app, user, project, "Alice", "main").await;
    let (key_b, _b) = mint_agent(&app, user, project, "Bob", "main").await;

    // Agent A owns the session.
    let session_id = register(&app, &key_a, "sess-owned").await.json().await["id"]
        .as_i64()
        .unwrap();

    // Agent B is rejected on every op that names A's session.
    let hb = app
        .post_as_agent(
            &key_b,
            &format!("/api/taskflow/agents/sessions/{session_id}/heartbeat"),
            json!({}),
        )
        .await;
    assert_eq!(hb.status(), 403);

    let frame = app
        .post_as_agent(
            &key_b,
            &format!("/api/taskflow/agents/sessions/{session_id}/frames"),
            json!({ "content": "not yours" }),
        )
        .await;
    assert_eq!(frame.status(), 403);

    let close = app
        .post_as_agent(
            &key_b,
            &format!("/api/taskflow/agents/sessions/{session_id}/close"),
            json!({}),
        )
        .await;
    assert_eq!(close.status(), 403);

    // Nothing B did wrote a frame, and the session is untouched (still connected).
    assert_eq!(app.count_frames(session_id).await, 0);
    assert_eq!(
        app.session(session_id).await.status,
        TaskflowAgentSessionStatus::Connected
    );

    // An unknown session id is a 404 (before any ownership decision leaks).
    let missing = app
        .post_as_agent(
            &key_b,
            "/api/taskflow/agents/sessions/999999/heartbeat",
            json!({}),
        )
        .await;
    assert_eq!(missing.status(), 404);
}

// A session whose process died (still `connected`, no heartbeat in a long time)
// must not report the agent as online. Before this, `whoami` read the stored
// column straight out and an agent that crashed once claimed to be "busy"
// forever, because only an explicit `/close` ever corrected the column.
#[tokio::test]
async fn whoami_reports_offline_once_the_session_goes_stale() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    let session = register(&app, &key, "sess-stale").await.json().await["id"]
        .as_i64()
        .unwrap();

    // While beating, the agent reports itself live.
    let fresh = app.get_as_agent(&key, "/api/taskflow/agents/whoami").await;
    assert_eq!(fresh.status(), 200);
    assert_ne!(
        fresh.json().await["status"],
        json!("offline"),
        "a heartbeating session must read as online"
    );

    // The process dies: no close, no further beats.
    app.backdate_session_heartbeat(session, 600).await;

    let stale = app.get_as_agent(&key, "/api/taskflow/agents/whoami").await;
    assert_eq!(
        stale.json().await["status"],
        json!("offline"),
        "a session with no recent heartbeat must not keep the agent online"
    );

    // The STORED column is deliberately left alone — deriving on read keeps this
    // a pure GET (no write, no realtime event fired by a status query).
    assert_ne!(
        app.agent(agent_id).await.status,
        TaskflowAgentStatus::Offline,
        "whoami derives; it must not write the correction back"
    );
}

// An abandoned session must not pin the agent online when its real session
// closes. Closing counted rows by `status = connected` alone, so one zombie kept
// the count above zero forever and the agent never went offline.
#[tokio::test]
async fn stale_session_does_not_block_going_offline() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, agent_id) = mint_agent(&app, user, project, "Builder", "main").await;

    let zombie = register(&app, &key, "sess-zombie").await.json().await["id"]
        .as_i64()
        .unwrap();
    let live = register(&app, &key, "sess-live").await.json().await["id"]
        .as_i64()
        .unwrap();
    app.backdate_session_heartbeat(zombie, 600).await;

    // Closing the only LIVE session takes the agent offline, even though the
    // zombie row still claims `connected`.
    let closed = app
        .post_as_agent(&key, &format!("/api/taskflow/agents/sessions/{live}/close"), json!({}))
        .await;
    assert_eq!(closed.status(), 200);
    assert_eq!(
        app.agent(agent_id).await.status,
        TaskflowAgentStatus::Offline,
        "an abandoned session must not keep the agent online"
    );
}

// The roster an agent sees when deciding whether a teammate is around gets the
// same correction — this is the call that drives "can I hand this to the
// reviewer?", so a stale `busy` there is worse than in whoami.
#[tokio::test]
async fn list_agents_reports_derived_liveness() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key_a, _) = mint_agent(&app, user, project, "Builder", "main").await;
    let (key_b, agent_b) = mint_agent(&app, user, project, "Reviewer", "reviewer").await;

    // B registers then goes away without closing; A stays live.
    let b_session = register(&app, &key_b, "sess-b").await.json().await["id"]
        .as_i64()
        .unwrap();
    register(&app, &key_a, "sess-a").await;
    app.backdate_session_heartbeat(b_session, 600).await;

    let resp = app.get_as_agent(&key_a, "/api/taskflow/agents/agents").await;
    assert_eq!(resp.status(), 200);
    let roster = resp.json().await;
    let b = roster
        .as_array()
        .expect("agents array")
        .iter()
        .find(|a| a["id"].as_i64() == Some(agent_b))
        .expect("reviewer present");
    assert_eq!(
        b["status"],
        json!("offline"),
        "a teammate that stopped heartbeating must read as offline"
    );
}

// A snapshot REPLACES the view, so old ones are dead weight — and the frontend
// fetches EVERY frame in a project when it loads, so unbounded growth lands on
// page load, not just on disk. Appending prunes all but the newest few.
#[tokio::test]
async fn snapshot_frames_are_pruned_to_the_newest_few() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, _agent_id) = mint_agent(&app, user, project, "Builder", "main").await;
    let session = register(&app, &key, "sess-snap").await.json().await["id"]
        .as_i64()
        .unwrap();

    for n in 0..8 {
        let resp = app
            .post_as_agent(
                &key,
                &format!("/api/taskflow/agents/sessions/{session}/frames"),
                json!({ "stream": "snapshot", "content": format!("screen {n}") }),
            )
            .await;
        assert_eq!(resp.status(), 200);
    }

    let kept = app.count_frames(session).await;
    assert!(
        kept <= 3,
        "8 snapshots should prune down to at most 3, kept {kept}"
    );

    // And what survives must be the NEWEST — a viewer opening the terminal has to
    // see current state, not whatever happened to be written first.
    let frames = TaskflowAgentTerminalFrame::objects()
        .filter(taskflow_agent_terminal_frame::SESSION.eq(session))
        .order_by(taskflow_agent_terminal_frame::SEQUENCE.desc())
        .fetch()
        .await
        .expect("load frames");
    assert_eq!(frames.first().expect("a frame survives").content, "screen 7");
}

// stdout/stderr frames are a transcript, not a view — pruning them would lose
// history that nothing else holds.
#[tokio::test]
async fn output_frames_are_never_pruned() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let (key, _agent_id) = mint_agent(&app, user, project, "Builder", "main").await;
    let session = register(&app, &key, "sess-out").await.json().await["id"]
        .as_i64()
        .unwrap();

    for n in 0..8 {
        app.post_as_agent(
            &key,
            &format!("/api/taskflow/agents/sessions/{session}/frames"),
            json!({ "stream": "stdout", "content": format!("line {n}") }),
        )
        .await;
    }
    assert_eq!(
        app.count_frames(session).await,
        8,
        "stdout frames are a transcript and must all survive"
    );
}
