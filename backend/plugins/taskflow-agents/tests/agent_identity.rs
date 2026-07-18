//! Stage 1 of the agent identity system: the mint endpoint, the `RequireAgent`
//! auth extractor, and agent-authored sends. These prove an agent gets a stable,
//! credentialed identity and can only ever act as ITSELF.

use serde_json::json;

mod support;
use support::{
    TestApp, make_active_project_member, seed_channel_of_kind, seed_project,
};
use taskflow_agents::models::TaskflowChannelKind;

/// Mint a fresh key for `(project, display_name, profile)` as `user`. Returns the
/// parsed 200 body. Panics (with the body) on any non-200 so a broken mint fails
/// loudly at the call site rather than deep in an assertion.
async fn mint(app: &TestApp, user: i64, project: i64, display_name: &str, profile: &str) -> serde_json::Value {
    let resp = app
        .post_as(
            user,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": display_name, "profile": profile }),
        )
        .await;
    assert_eq!(resp.status(), 200, "mint failed: {:?}", resp.json().await);
    resp.json().await
}

// A human links a profile → 200 with a `tfk_…` key + agent_id. Linking the SAME
// (project, display_name, profile) again REUSES the agent id (stable identifier)
// but issues a NEW key each time.
#[tokio::test]
async fn mint_returns_key_once_and_creates_agent() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let first = mint(&app, user, project, "Builder", "main").await;

    let key = first["key"].as_str().expect("key present");
    assert!(key.starts_with("tfk_"), "key should be a tfk_ key, got {key}");
    let agent_id = first["agent_id"].as_i64().expect("agent_id present");
    // The profile block the caller pastes into `.taskflow.json` carries the same
    // key + agent id.
    assert_eq!(first["taskflow_profile"]["key"], json!(key));
    assert_eq!(first["taskflow_profile"]["agent_id"], json!(agent_id));

    // Re-link the exact same profile: same agent (stable identifier), new key.
    let second = mint(&app, user, project, "Builder", "main").await;
    assert_eq!(
        second["agent_id"].as_i64().unwrap(),
        agent_id,
        "re-linking the same profile must reuse the agent id"
    );
    assert_eq!(second["identifier"], first["identifier"]);
    assert_ne!(
        second["key"].as_str().unwrap(),
        key,
        "each link must mint a fresh key"
    );
}

// A human who is not a member of the project cannot mint an agent into it.
#[tokio::test]
async fn non_member_human_cannot_mint() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let outsider = app.create_user().await; // real, logged-in, but not a member

    let resp = app
        .post_as(
            outsider,
            "/api/taskflow/agents/link",
            json!({ "project": project, "display_name": "Sneaky", "profile": "main" }),
        )
        .await;

    assert_eq!(resp.status(), 403);
}

// The minted key authenticates the agent-send path: a valid key stamps the
// message as the agent; a garbage key and a REVOKED key are both rejected 401.
#[tokio::test]
async fn agent_auth_accepts_valid_key_rejects_bad_and_revoked() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let minted = mint(&app, user, project, "Builder", "main").await;
    let key = minted["key"].as_str().unwrap().to_string();
    let agent_id = minted["agent_id"].as_i64().unwrap();

    // A shared project room in the agent's project: project scope authorizes it.
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;

    // Valid key → 200, stamped as the agent.
    let ok = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": channel, "body_markdown": "hello from the agent" }),
        )
        .await;
    assert_eq!(ok.status(), 200, "body: {:?}", ok.json().await);
    let row = ok.json().await;
    assert_eq!(row["sender_kind"], json!("agent"));
    assert_eq!(row["sender_agent"], json!(agent_id));
    assert_eq!(row["sender_user"], json!(null));
    assert_eq!(row["sender_label"], json!("Builder"));

    // Garbage key → 401.
    let bad = app
        .post_as_agent(
            "tfk_deadbeef0000_notarealsecret",
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": channel, "body_markdown": "let me in" }),
        )
        .await;
    assert_eq!(bad.status(), 401);

    // Malformed (not even a tfk_ key) → 401.
    let malformed = app
        .post_as_agent(
            "garbage",
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": channel, "body_markdown": "nope" }),
        )
        .await;
    assert_eq!(malformed.status(), 401);

    // Revoke the credential → the once-valid key is now 401.
    app.revoke_agent_credentials(agent_id).await;
    let revoked = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": channel, "body_markdown": "still here?" }),
        )
        .await;
    assert_eq!(revoked.status(), 401);
}

// The agent membership gate: a DM the agent is not on the roster of rejects with
// 403; adding the agent to that DM's roster then lets it post.
#[tokio::test]
async fn agent_send_requires_membership() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let minted = mint(&app, user, project, "Builder", "main").await;
    let key = minted["key"].as_str().unwrap().to_string();
    let agent_id = minted["agent_id"].as_i64().unwrap();

    // A DM is private to its explicit roster. The agent is not on it → 403.
    let dm = seed_channel_of_kind(project, TaskflowChannelKind::Direct).await;
    let denied = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": dm, "body_markdown": "let me into this DM" }),
        )
        .await;
    assert_eq!(denied.status(), 403);

    // Add the agent to the DM roster → it may now post.
    app.add_agent_to_channel_roster(project, dm, agent_id).await;
    let allowed = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": dm, "body_markdown": "now I'm in" }),
        )
        .await;
    assert_eq!(allowed.status(), 200, "body: {:?}", allowed.json().await);
    assert_eq!(allowed.json().await["sender_agent"], json!(agent_id));
}

// An agent from one project cannot post into another project's shared room even
// though the room is not a DM — project scope is the boundary.
#[tokio::test]
async fn agent_cannot_post_in_foreign_project_room() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let minted = mint(&app, user, project, "Builder", "main").await;
    let key = minted["key"].as_str().unwrap().to_string();

    // A shared project room in a DIFFERENT project.
    let other_project = seed_project().await;
    let foreign_room = seed_channel_of_kind(other_project, TaskflowChannelKind::Project).await;

    let resp = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": foreign_room, "body_markdown": "trespassing" }),
        )
        .await;
    assert_eq!(resp.status(), 403);
}

// Idempotency on the agent path: the same nonce in the same channel stores one
// row and returns it, exactly like the human send.
#[tokio::test]
async fn agent_send_is_idempotent_per_nonce() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let minted = mint(&app, user, project, "Builder", "main").await;
    let key = minted["key"].as_str().unwrap().to_string();
    let channel = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;

    let body = json!({
        "channel": channel,
        "body_markdown": "only once",
        "client_nonce": "agent-nonce-1",
    });
    let first = app
        .post_as_agent(&key, "/api/taskflow/agents/agent/messages", body.clone())
        .await;
    let second = app
        .post_as_agent(&key, "/api/taskflow/agents/agent/messages", body)
        .await;

    assert_eq!(first.status(), 200);
    assert_eq!(second.status(), 200);
    assert_eq!(first.json().await["id"], second.json().await["id"]);
    assert_eq!(app.count_messages(channel).await, 1);
}

// Linking into a project with NO channels creates the shared room and rosters
// the agent into it. Without this the agent is mute (nowhere to post) and deaf
// (review report-back silently skips when no room exists) until a human happens
// to open the chat UI, which is what lazily created the room before.
#[tokio::test]
async fn linking_bootstraps_a_shared_room() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    let minted = mint(&app, user, project, "Builder", "main").await;
    let key = minted["key"].as_str().unwrap().to_string();

    // The freshly linked agent can see a room without anyone having sent a thing.
    let resp = app.get_as_agent(&key, "/api/taskflow/agents/channels").await;
    assert_eq!(resp.status(), 200);
    let channels = resp.json().await;
    let rooms = channels.as_array().expect("channels array");
    assert_eq!(rooms.len(), 1, "expected exactly one bootstrapped room, got {channels:?}");

    // ...and can actually post into it, which is the whole point.
    let room = rooms[0]["id"].as_i64().expect("room id");
    let sent = app
        .post_as_agent(
            &key,
            "/api/taskflow/agents/agent/messages",
            json!({ "channel": room, "body_markdown": "linked and ready" }),
        )
        .await;
    assert_eq!(sent.status(), 200, "agent should be able to post in its bootstrapped room");
}

// The bootstrap is idempotent: re-linking (which mints a fresh key) must not
// pile up duplicate rooms or duplicate roster rows. The `(channel, user)` unique
// index does NOT cover agent rows -- `user` is NULL for them and SQL treats
// NULLs as distinct -- so nothing at the schema level would catch a regression.
#[tokio::test]
async fn linking_twice_reuses_one_room() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;

    mint(&app, user, project, "Builder", "main").await;
    let second = mint(&app, user, project, "Builder", "main").await;
    let key = second["key"].as_str().unwrap().to_string();

    let resp = app.get_as_agent(&key, "/api/taskflow/agents/channels").await;
    let channels = resp.json().await;
    assert_eq!(
        channels.as_array().expect("channels array").len(),
        1,
        "re-linking must reuse the existing room, got {channels:?}"
    );
}

// An existing shared room is adopted rather than duplicated -- the human
// frontend may well have created one already.
#[tokio::test]
async fn linking_adopts_an_existing_room() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let user = app.create_user().await;
    make_active_project_member(project, user).await;
    let existing = seed_channel_of_kind(project, TaskflowChannelKind::Project).await;

    let minted = mint(&app, user, project, "Builder", "main").await;
    let key = minted["key"].as_str().unwrap().to_string();

    let resp = app.get_as_agent(&key, "/api/taskflow/agents/channels").await;
    let channels = resp.json().await;
    let rooms = channels.as_array().expect("channels array");
    assert_eq!(rooms.len(), 1, "should adopt the existing room, got {channels:?}");
    assert_eq!(rooms[0]["id"].as_i64().unwrap(), existing);
}
