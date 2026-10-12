//! #700 — a key denied `toolbox:write` may read the project's toolbox but may
//! not change it: no saves, no deprecations, no run reports, no vetting notes.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent_key, seed_member, seed_project};

#[tokio::test(flavor = "multi_thread")]
async fn a_denied_toolbox_key_reads_but_cannot_write() {
    let app = TestApp::new().await;
    let (user, project) = seed_project(&app).await;
    let _ = seed_member(project, user.id, "owner").await;

    // An entry for the read to find (saved by the human, who is never gated).
    let saved = app
        .post_json_as(
            user.id,
            &format!("/api/taskflow/toolbox/{project}/entry/house-rules"),
            json!({
                "kind": "memory",
                "title": "House rules",
                "description": "Read before touching the deploy.",
                "body_markdown": "Never restart Caddy on this host.",
            }),
        )
        .await;
    assert_eq!(saved.status(), 200, "{}", saved.text());

    let key = seed_agent_key(project, &["toolbox:write"]).await;

    let listing = app.get_as_agent(&key, &format!("/api/taskflow/agents/toolbox?project={project}")).await;
    assert_eq!(listing.status(), 200, "a denial never closes the read: {}", listing.text());

    let write = app
        .post_json_as_agent(
            &key,
            &format!("/api/taskflow/agents/toolbox/agent-note"),
            json!({ "kind": "memory", "title": "Nope", "description": "no", "body_markdown": "no" }),
        )
        .await;
    assert_eq!(write.status(), 403, "{}", write.text());
    let refusal = write.json().await;
    assert_eq!(refusal["error"], json!("capability_denied"));
    assert_eq!(refusal["capability"], json!("toolbox:write"));
    assert!(
        refusal["message"].as_str().unwrap_or_default().contains("Connect-agents"),
        "the refusal says who can change it: {refusal}"
    );

    let run = app
        .post_json_as_agent(
            &key,
            &format!("/api/taskflow/agents/toolbox/house-rules/run"),
            json!({ "ok": true, "note": "did it" }),
        )
        .await;
    assert_eq!(run.status(), 403, "reporting a run is still a write: {}", run.text());

    // The control: a key with no policy writes through the same route.
    let open_key = seed_agent_key(project, &[]).await;
    let ok = app
        .post_json_as_agent(
            &open_key,
            &format!("/api/taskflow/agents/toolbox/agent-note"),
            json!({ "kind": "memory", "title": "Fine", "description": "ok", "body_markdown": "ok" }),
        )
        .await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
}
