//! Realtime broadcast on the BULK write path — the `signals.rs` bridge.
//!
//! Regression test for a silent half of the design surface's realtime wiring.
//! `backend/src/realtime.rs` exposes `DesignFile` and `DesignLayout` through
//! `Expose`, which subscribes to the ORM's per-row `post_save` signal only. But
//! the two writes that actually matter for a live canvas go through
//! `update_values` instead:
//!
//! - `store::write_file`'s update branch — every edit of an EXISTING page; and
//! - `put_layout`'s update branch — every RE-arrangement of an existing
//!   document.
//!
//! `update_values` fires `bulk_post_save` and never `post_save`, so before the
//! bridge the FIRST save of a row broadcast (that path is a `create`) and every
//! later change was silent: a second viewer kept a stale canvas until they
//! reloaded. Both halves are asserted below — the create path emits nothing
//! here (it is `Expose`'s job, and `Expose` is registered by the backend, not
//! by this harness), and the update path must emit exactly one id-only event on
//! the project's group.

mod support;

use std::collections::HashSet;

use serde_json::{json, Value};
use support::TestApp;
use taskflow_design::models::{DesignFile, DesignLayout, design_file, design_layout};
use umbral_realtime::Event;
use umbral_realtime::Realtime;

/// Watch one group the way the SSE handler does — minus the handshake, which is
/// policy's business, not this bridge's.
async fn watch(group: &str) -> tokio::sync::mpsc::Receiver<Event> {
    let (_id, rx) = Realtime::registry()
        .register(None, HashSet::from([group.to_string()]), 16)
        .await
        .expect("register a realtime connection");
    rx
}

/// Everything buffered on the receiver, as `(channel, event, data)`.
fn drain(rx: &mut tokio::sync::mpsc::Receiver<Event>) -> Vec<(String, String, Value)> {
    let mut out = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        out.push((ev.channel, ev.event, ev.data));
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn re_arranging_an_existing_layout_broadcasts_to_the_project_group() {
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let group = format!("project:{project}:design_layout");
    let mut rx = watch(&group).await;

    let layout = |name: &str| {
        json!({
            "view": "groups",
            "routeOrder": [],
            "groups": [{ "id": "g1", "name": name, "routes": [] }]
        })
    };

    // Save #1 creates the row — the per-row `post_save` path. `Expose` covers
    // it in production; this harness registers no `Expose`, so hearing nothing
    // is the expected shape of "the bridge is not what serves creates".
    let first = app
        .put_json_as(user.id, &format!("/api/design/{project}/layout"), &layout("Auth"))
        .await;
    assert_eq!(first.status(), 200, "{}", first.text());
    assert!(
        drain(&mut rx).is_empty(),
        "the create path belongs to Expose, not to the bulk bridge"
    );

    let row = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project))
        .first()
        .await
        .expect("read the layout row")
        .expect("the first save created one");

    // Save #2 takes `put_layout`'s UPDATE branch, which runs `update_values` —
    // the bulk signal. Silence here was the bug.
    let second = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/layout"),
            &layout("Settings"),
        )
        .await;
    assert_eq!(second.status(), 200, "{}", second.text());

    let events = drain(&mut rx);
    assert_eq!(events.len(), 1, "one broadcast per re-arrangement: {events:?}");
    let (channel, event, data) = &events[0];
    assert_eq!(channel, &group, "the event must land on the project's group");
    assert_eq!(event, "updated", "an update, not a create");
    assert_eq!(
        data,
        &json!({ "id": row.id }),
        "id-only payload, exactly what Expose projects for these models"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn editing_an_existing_page_broadcasts_to_the_project_group() {
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let group = format!("project:{project}:design_files");
    let mut rx = watch(&group).await;

    // Save #1 creates the page (per-row `post_save`, Expose's path).
    let first = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/index.html", "content": "<p>v1</p>" }),
        )
        .await;
    assert_eq!(first.status(), 201, "{}", first.text());
    assert!(
        drain(&mut rx).is_empty(),
        "the create path belongs to Expose, not to the bulk bridge"
    );

    let row = DesignFile::objects()
        .filter(design_file::PROJECT.eq(project))
        .first()
        .await
        .expect("read the file row")
        .expect("the first write created one");

    // Save #2 goes through `store::write_file`'s update branch — the edit that
    // used to leave every other viewer's canvas stale until a reload.
    let second = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/index.html", "content": "<p>v2</p>", "base_version": 1 }),
        )
        .await;
    assert_eq!(second.status(), 201, "{}", second.text());

    let events = drain(&mut rx);
    assert_eq!(events.len(), 1, "one broadcast per page edit: {events:?}");
    let (channel, event, data) = &events[0];
    assert_eq!(channel, &group, "the event must land on the project's group");
    assert_eq!(event, "updated", "an update, not a create");
    assert_eq!(
        data,
        &json!({ "id": row.id }),
        "id-only payload — the chrome refetches content over REST"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn retiring_a_component_broadcasts_a_delete_to_the_project_group() {
    // A delete is the third write path through this module's subject, and the
    // only one the ORM cannot route. `QuerySet::delete` fires its per-row
    // `post_delete` with the primary key alone — `{ "instance": { "id": N } }` —
    // so a registration that derives the group from the row's `project` column
    // has nothing to derive it from and falls back to `taskflow:projects`. That
    // fallback is not inert: the frontend maps it to the project LIST, whose
    // handler filters the sidebar by id. `backend/tests/design_delete_routing.rs`
    // pins the backend half (the misrouted event is never sent); this pins the
    // half that has to work instead — the deleting handler emitting the real
    // event itself, on the right group, with the payload the chrome reads.
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let (agent_id, key) = support::seed_agent(project, "Retirer").await;
    let _ = (user.id, agent_id);
    let group = format!("project:{project}:design_files");
    let mut rx = watch(&group).await;
    // NOT watched here: `taskflow:projects`. The failure mode is delivery to the
    // wrong room, but that room is reached through `Expose`, which this harness
    // does not register (see this file's header) — so a watch on it here could
    // never fire, and an assertion that cannot fail is worse than none.
    // `backend/tests/design_delete_routing.rs` boots the PRODUCTION spec and is
    // where that claim is pinned.

    let seeded = app
        .put_as_agent(
            &key,
            "/api/taskflow/agents/design/component",
            json!({
                "project": project,
                "name": "app-header",
                "js": support::sample_header_component(),
                "reason": "the settings page needs a header"
            }),
        )
        .await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());
    let row_id = seeded.json()["file"]["id"].as_i64().expect("the created row id");

    let deleted = app
        .delete_json_as_agent(
            &key,
            "/api/taskflow/agents/design/component",
            &json!({
                "project": project,
                "name": "app-header",
                "reason": "nothing in the registry needs it any more"
            }),
        )
        .await;
    assert_eq!(deleted.status(), 200, "{}", deleted.text());

    let events = drain(&mut rx);
    assert_eq!(
        events.len(),
        1,
        "exactly one broadcast per retirement — a second would mean the ORM's \
         delete path is emitting again: {events:?}"
    );
    let (channel, event, data) = &events[0];
    assert_eq!(
        channel, &group,
        "the delete must land on the PROJECT's group: a viewer of this project is \
         who needs to know the component is gone"
    );
    assert_eq!(event, "deleted", "a delete, not an update");
    assert_eq!(
        data,
        &json!({ "id": row_id }),
        "id-only, the same projection every other event on this group carries — \
         the row is gone, so there is nothing else to send and the chrome \
         refetches over REST"
    );
}
