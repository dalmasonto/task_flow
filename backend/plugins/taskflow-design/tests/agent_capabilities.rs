//! #700 — a key denied `design:write` may still SEE the surface but may not
//! change it. The design half of the capability model: reads and renders stay
//! open (they cost the sidecar time, not other people's work), writes close.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent_with_denied};

fn layout_path(project: i64) -> String {
    format!("/api/taskflow/agents/design/layout?project={project}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_denied_design_key_reads_but_cannot_write() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = seed_agent_with_denied(project, "No Design", &["design:write"]).await;

    // A write is refused, and the refusal names the capability.
    let write = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Player" } } }),
        )
        .await;
    assert_eq!(write.status(), 403, "{}", write.text());
    let refusal = write.json();
    assert_eq!(refusal["error"], json!("capability_denied"));
    assert_eq!(refusal["capability"], json!("design:write"));
    assert!(
        refusal["message"].as_str().unwrap_or_default().contains("Connect-agents"),
        "the refusal says who can change it: {refusal}"
    );

    // The READ half of the same route still answers.
    let read = app.get_as_agent(&key, &layout_path(project)).await;
    assert_eq!(read.status(), 200, "{}", read.text());

    // And so does the guide — a read a denied key must keep to be able to work.
    let guide = app.get_as_agent(&key, &format!("/api/taskflow/agents/design/guide?project={project}")).await;
    assert_ne!(guide.status(), 403, "reads are never gated by a write denial");

    // A granted key (no policy) writes fine — the control.
    let (_id, open_key) = support::seed_agent(project, "Open Design").await;
    let ok = app
        .put_as_agent(
            &open_key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Bench" } } }),
        )
        .await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
    let _ = user;
}
