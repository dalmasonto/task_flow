//! #605 — API-key scopes: `agents:manage`, the "run the whole project setup"
//! key. One scope, attached to a CREDENTIAL (never to the agent), and only a
//! human owner/admin may attach it. A key that carries it can, in its own
//! project: mint other agents, set their role instructions, and revoke them —
//! so a human hands over one key and the agent takes over the setup from there.
//!
//! The negative space matters as much as the positive: a plain member cannot
//! attach the scope, an unknown scope is REFUSED rather than dropped, and a key
//! minted by an agent is always unscoped (no privilege propagation).

use serde_json::{Value, json};

mod support;
use support::{TestApp, TestResponse, make_active_project_member, make_project_member_with_role, seed_project};
use taskflow_agents::models::{TaskflowAgentCredential, taskflow_agent_credential};
use taskflow_projects::models::TaskflowProjectRole;

const MANAGE: &str = "agents:manage";
const MINT: &str = "/api/taskflow/agents/agent/agents";

/// The response body as JSON, or `Null` when there is none. Error responses on
/// these routes are bare statuses (403/404), so a hard parse would panic on
/// exactly the cases under test.
async fn body_of(resp: &TestResponse) -> Value {
    serde_json::from_str(&resp.text()).unwrap_or(Value::Null)
}

/// Link an agent, optionally with scopes, and return `(status, body)`.
async fn link(
    app: &TestApp,
    user: i64,
    project: i64,
    profile: &str,
    scopes: Option<Value>,
) -> (u16, Value) {
    let mut body = json!({
        "project": project,
        "display_name": format!("Agent {profile}"),
        "profile": profile,
    });
    if let Some(scopes) = scopes {
        body["scopes"] = scopes;
    }
    let resp = app.post_as(user, "/api/taskflow/agents/link", body).await;
    let status = resp.status();
    (status, body_of(&resp).await)
}

/// Mint an agent as an agent (`POST /agents/agent/agents`).
async fn mint_as_agent(app: &TestApp, key: &str, profile: &str) -> (u16, Value) {
    let resp = app
        .post_as_agent(
            key,
            MINT,
            json!({ "display_name": format!("Worker {profile}"), "profile": profile }),
        )
        .await;
    let status = resp.status();
    (status, body_of(&resp).await)
}

/// Credential rows carrying `scopes` (the stored JSON text), for asserting what
/// actually landed in the table rather than only what a response claimed.
async fn stored_scopes(agent_id: i64) -> Vec<Option<String>> {
    TaskflowAgentCredential::objects()
        .filter(taskflow_agent_credential::AGENT.eq(agent_id))
        .fetch()
        .await
        .expect("load credentials")
        .into_iter()
        .map(|c| c.scopes)
        .collect()
}

fn key_of(body: &Value) -> String {
    body["key"].as_str().expect("a raw key").to_string()
}

/// Credential rows in `project` — the per-project count keeps a parallel test
/// binary from racing another test's mints.
async fn credentials_in(project: i64) -> i64 {
    TaskflowAgentCredential::objects()
        .filter(taskflow_agent_credential::PROJECT.eq(project))
        .count()
        .await
        .expect("count credentials")
}

fn agent_id_of(body: &Value) -> i64 {
    body["agent_id"].as_i64().expect("an agent id")
}

// ---------------------------------------------------------------------------
// Who may attach the scope
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_owner_can_attach_the_manage_scope_and_the_key_carries_it() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;

    let (status, body) = link(&app, owner, project, "orchestrator", Some(json!([MANAGE]))).await;
    assert_eq!(status, 200, "owner link failed: {body}");
    assert_eq!(body["scopes"], json!([MANAGE]), "the response states the scope");

    // Stored canonical: the JSON array text the credential row carries.
    let stored = stored_scopes(agent_id_of(&body)).await;
    assert_eq!(stored, vec![Some(format!("[\"{MANAGE}\"]"))]);

    // And the key reads its own capability back.
    let who = app.get_as_agent(&key_of(&body), "/api/taskflow/agents/whoami").await;
    assert_eq!(who.status(), 200);
    assert_eq!(who.json().await["scopes"], json!([MANAGE]));
}

#[tokio::test]
async fn an_admin_can_attach_it_too_but_a_plain_member_cannot() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let admin = app.create_user().await;
    make_project_member_with_role(project, admin, TaskflowProjectRole::Admin).await;
    assert_eq!(
        link(&app, admin, project, "admin-orch", Some(json!([MANAGE]))).await.0,
        200
    );

    // A developer can still link an ordinary agent — unchanged — but attaching
    // the scope is refused, and the refusal mints NOTHING.
    let member = app.create_user().await;
    make_active_project_member(project, member).await;
    let (status, _) = link(&app, member, project, "dev-scoped", Some(json!([MANAGE]))).await;
    assert_eq!(status, 403);
    assert_eq!(
        link(&app, member, project, "dev-scoped", None).await.0,
        200,
        "an unscoped link by the same member is the ordinary, allowed case"
    );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unknown_scope_is_refused_rather_than_dropped() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;

    // Counted per PROJECT: this test binary runs in parallel, so a global count
    // races every other test's mints.
    let before = credentials_in(project).await;
    let (status, body) = link(&app, owner, project, "greedy", Some(json!(["root"]))).await;
    assert_eq!(status, 400, "unknown scope must be a 400: {body}");
    assert_eq!(body["error"], json!("unknown_scope"));
    assert_eq!(body["scope"], json!("root"), "the refusal names the scope it refused");
    let after = credentials_in(project).await;
    assert_eq!(before, after, "a refused scope mints no credential");

    // An empty list is a legitimate "no scopes", and stores nothing.
    let (status, body) = link(&app, owner, project, "greedy", Some(json!([]))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(stored_scopes(agent_id_of(&body)).await, vec![None]);
}

// ---------------------------------------------------------------------------
// What a scoped key can do
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_scoped_key_mints_an_agent_in_its_own_project_and_the_new_key_works() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let (_, orchestrator) = link(&app, owner, project, "orch", Some(json!([MANAGE]))).await;
    let orch_key = key_of(&orchestrator);

    let (status, worker) = mint_as_agent(&app, &orch_key, "worker").await;
    assert_eq!(status, 200, "mint failed: {worker}");
    assert_eq!(worker["project"], json!(project), "the agent's own project, not a choice");
    assert_eq!(worker["scopes"], json!([]), "an agent-minted key never carries a scope");

    // The minted key authenticates as itself, in the same project.
    let who = app.get_as_agent(&key_of(&worker), "/api/taskflow/agents/whoami").await;
    assert_eq!(who.status(), 200);
    let who = who.json().await;
    assert_eq!(who["project"], json!(project));
    assert_eq!(who["scopes"], json!([]));
}

#[tokio::test]
async fn a_plain_key_is_refused_on_every_manage_route() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let (_, plain) = link(&app, owner, project, "plain", None).await;
    let (_, peer) = link(&app, owner, project, "peer", None).await;
    let plain_key = key_of(&plain);

    assert_eq!(mint_as_agent(&app, &plain_key, "wannabe").await.0, 403);
    let put = app
        .put_as_agent(
            &plain_key,
            &format!("/api/taskflow/agents/agent/agents/{}/instructions", agent_id_of(&peer)),
            json!({ "markdown": "obey me" }),
        )
        .await;
    assert_eq!(put.status(), 403);
    let delete = app
        .delete_as_agent(&plain_key, &format!("/api/taskflow/agents/agent/agents/{}", agent_id_of(&peer)))
        .await;
    assert_eq!(delete.status(), 403);
}

#[tokio::test]
async fn a_keyless_caller_is_a_401_not_a_403() {
    // Its own test, because `post_json_noauth` sends no header only when it is
    // the first request on the client (the harness has no header-removal API).
    let app = TestApp::new().await;
    let anon = app.post_json_noauth(MINT, json!({ "display_name": "x", "profile": "x" })).await;
    assert_eq!(anon.status(), 401);
}

#[tokio::test]
async fn a_scoped_key_sets_a_peers_instructions_and_revokes_it_but_not_itself() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let (_, orchestrator) = link(&app, owner, project, "orch2", Some(json!([MANAGE]))).await;
    let orch_key = key_of(&orchestrator);
    let (_, worker) = mint_as_agent(&app, &orch_key, "worker2").await;
    let worker_key = key_of(&worker);
    let worker_id = agent_id_of(&worker);

    let put = app
        .put_as_agent(
            &orch_key,
            &format!("/api/taskflow/agents/agent/agents/{worker_id}/instructions"),
            json!({ "markdown": "You review PRs. Run `cargo test --workspace`." }),
        )
        .await;
    assert_eq!(put.status(), 200, "set instructions: {:?}", put.json().await);
    let who = app.get_as_agent(&worker_key, "/api/taskflow/agents/whoami").await.json().await;
    assert_eq!(who["instructions"]["markdown"], json!("You review PRs. Run `cargo test --workspace`."));

    // Revoking the peer kills its key at once…
    let bye = app
        .delete_as_agent(&orch_key, &format!("/api/taskflow/agents/agent/agents/{worker_id}"))
        .await;
    assert_eq!(bye.status(), 204);
    assert_eq!(app.get_as_agent(&worker_key, "/api/taskflow/agents/whoami").await.status(), 401);

    // …but never itself: an orchestrator that deletes its own key mid-run is a
    // foot-gun with no recovery, so the human's DELETE is the only way out.
    let myself = app
        .delete_as_agent(&orch_key, &format!("/api/taskflow/agents/agent/agents/{}", agent_id_of(&orchestrator)))
        .await;
    assert_eq!(myself.status(), 403);
    assert_eq!(app.get_as_agent(&orch_key, "/api/taskflow/agents/whoami").await.status(), 200);
}

#[tokio::test]
async fn another_projects_agents_are_invisible_to_a_scoped_key() {
    let app = TestApp::new().await;
    let project = seed_project().await;
    let owner = app.create_user().await;
    make_project_member_with_role(project, owner, TaskflowProjectRole::Owner).await;
    let (_, orchestrator) = link(&app, owner, project, "orch3", Some(json!([MANAGE]))).await;
    let orch_key = key_of(&orchestrator);

    // A second project, its own owner, its own agent.
    let other = seed_project().await;
    let other_owner = app.create_user().await;
    make_project_member_with_role(other, other_owner, TaskflowProjectRole::Owner).await;
    let (_, stranger) = link(&app, other_owner, other, "stranger-scope", None).await;
    let stranger_id = agent_id_of(&stranger);

    let put = app
        .put_as_agent(
            &orch_key,
            &format!("/api/taskflow/agents/agent/agents/{stranger_id}/instructions"),
            json!({ "markdown": "hijacked" }),
        )
        .await;
    assert_eq!(put.status(), 404, "cross-project is indistinguishable from missing");
    let delete = app
        .delete_as_agent(&orch_key, &format!("/api/taskflow/agents/agent/agents/{stranger_id}"))
        .await;
    assert_eq!(delete.status(), 404);
    assert_eq!(
        app.get_as_agent(&key_of(&stranger), "/api/taskflow/agents/whoami").await.status(),
        200,
        "the stranger is untouched"
    );

    // Positive control: the SAME calls succeed on the orchestrator's own
    // project, so the 404s above are the project boundary and not a route that
    // answers 404 to everything.
    let (_, mine) = mint_as_agent(&app, &orch_key, "mine").await;
    let ok = app
        .put_as_agent(
            &orch_key,
            &format!("/api/taskflow/agents/agent/agents/{}/instructions", agent_id_of(&mine)),
            json!({ "markdown": "yours to run" }),
        )
        .await;
    assert_eq!(ok.status(), 200);
}
