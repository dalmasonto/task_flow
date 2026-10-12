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
//! reloaded.
//!
//! #665 merged the two emitters. `signals::subscribe` now owns BOTH the per-row
//! `post_save:design_file` signal (every `create`) and the `bulk_post_save`
//! bridge (every edit of an existing row); the backend's former
//! `Expose::<DesignFile>` registration is gone, so there is exactly ONE payload
//! definition. Every design-file event now carries the file's `path`, its
//! `version` and the `affected_routes` whose rendered output changed, so a
//! viewer's canvas remounts only the boards that actually changed.

mod support;

use std::collections::HashSet;

use serde_json::{json, Value};
use support::TestApp;
use taskflow_design::models::{DesignFile, DesignLayout, design_file, design_layout};
use umbral_realtime::Event;
use umbral_realtime::Realtime;

/// A minimal valid tokens document, and an edited copy for the update path
/// (a no-op rewrite would be rejected as an identical write).
const TOKENS_JSON: &str =
    r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"}}}}"##;
const TOKENS_JSON_EDITED: &str =
    r##"{"version":1,"categories":{"colors":{"primary":{"light":"#166534","dark":"#22C55E"}}}}"##;

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
async fn creating_a_page_broadcasts_its_own_route() {
    // The per-row `post_save` path — a queryset `create`, which is the first
    // write of a page. Since #665 this path emits from `signals.rs` too, with
    // the same widened payload as an edit, so a viewer remounts only this
    // page's boards when an agent creates one.
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let group = format!("project:{project}:design_files");
    let mut rx = watch(&group).await;

    let first = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/index.html", "content": "<p>v1</p>" }),
        )
        .await;
    assert_eq!(first.status(), 201, "{}", first.text());
    let row_id = first.json()["file"]["id"].as_i64().expect("the created row id");

    let events = drain(&mut rx);
    assert_eq!(events.len(), 1, "one broadcast per create: {events:?}");
    let (channel, event, data) = &events[0];
    assert_eq!(channel, &group, "the event must land on the project's group");
    assert_eq!(event, "created", "a create, not an update");
    assert_eq!(
        data,
        &json!({
            "id": row_id,
            "version": 1,
            "path": "pages/index.html",
            "affected_routes": ["/"],
        }),
        "a new page's own route is the whole blast radius"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn editing_an_existing_page_broadcasts_its_own_route() {
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let group = format!("project:{project}:design_files");
    let mut rx = watch(&group).await;

    // Save #1 creates the page (per-row `post_save`); its own broadcast is
    // asserted by the create test above, so it is drained away here.
    let first = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/index.html", "content": "<p>v1</p>" }),
        )
        .await;
    assert_eq!(first.status(), 201, "{}", first.text());
    drain(&mut rx);

    let row = DesignFile::objects()
        .filter(design_file::PROJECT.eq(project))
        .first()
        .await
        .expect("read the file row")
        .expect("the first write created one");

    // Save #2 goes through `store::write_file`'s update branch — the bulk
    // signal, and the edit that used to leave every other viewer's canvas
    // stale until a reload.
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
        &json!({
            "id": row.id,
            "version": 2,
            "path": "pages/index.html",
            "affected_routes": ["/"],
        }),
        "an edit of one page affects that page's route alone"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn editing_the_tokens_broadcasts_every_route() {
    // Tokens feed every composed document, so a token write's blast radius is
    // the whole manifest — the one scope that legitimately remounts the canvas.
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let group = format!("project:{project}:design_files");
    let mut rx = watch(&group).await;

    for (path, content) in [
        ("pages/index.html", "<main><h1>Home</h1></main>"),
        ("pages/setup.html", "<main><h1>Setup</h1></main>"),
        ("styles/tokens.json", TOKENS_JSON),
    ] {
        let res = app
            .put_json_as(
                user.id,
                &format!("/api/design/{project}/file"),
                &json!({ "path": path, "content": content }),
            )
            .await;
        assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
    }
    // The three creates' own broadcasts; this test is about the edit below.
    assert_eq!(drain(&mut rx).len(), 3, "each seed broadcasts its create");

    let edited = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({
                "path": "styles/tokens.json",
                "content": TOKENS_JSON_EDITED,
                "base_version": 1,
            }),
        )
        .await;
    assert_eq!(edited.status(), 201, "{}", edited.text());

    let events = drain(&mut rx);
    assert_eq!(events.len(), 1, "one broadcast per token edit: {events:?}");
    let (channel, event, data) = &events[0];
    assert_eq!(channel, &group);
    assert_eq!(event, "updated");
    let mut routes: Vec<&str> = data["affected_routes"]
        .as_array()
        .expect("affected_routes is a list")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    routes.sort_unstable();
    assert_eq!(
        routes,
        ["/", "/setup"],
        "a token write affects EVERY route, and the list must name them"
    );
    assert_eq!(data["path"], "styles/tokens.json");
    assert_eq!(data["version"], 2);
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
    // The seed's own create broadcast — the per-row path, owned by this module
    // since #665 (its payload is asserted in the page create test).
    assert_eq!(drain(&mut rx).len(), 1, "the seed broadcasts its create");

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
        &json!({
            "id": row_id,
            "version": 1,
            "path": "components/app-header.js",
            // The delete was only allowed because NOTHING used the component
            // (`DeleteOutcome::InUse` refuses otherwise), so the blast radius
            // is authoritatively empty — the canvas remounts nothing, and the
            // manifest refetch alone drops the component from the registry.
            "affected_routes": [],
        }),
        "a component delete names nothing to remount, and says so explicitly"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agents_rearrangement_broadcasts_to_the_project_group() {
    // The bridge covers `bulk_post_save:design_layout`, which is what any
    // `update_values` on the row fires. An agent's write must reach the same
    // group the operator's does: the panel watches this group, and an agent
    // that rearranged the board would otherwise leave every viewer looking at a
    // stale one until they reloaded — the exact silence the bridge was built to
    // end, reintroduced through the newer of the two write routes.
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = support::seed_agent(project, "Builder").await;
    let group = format!("project:{project}:design_layout");

    // One real page, through the operator file route, so the manifest has a
    // route a layout document may name.
    let seeded = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/a.html", "content": "<main class=\"p-4\">A</main>" }),
        )
        .await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());

    let path = format!("/api/taskflow/agents/design/layout?project={project}");

    let mut rx = watch(&group).await;

    // The first write CREATES the row — the per-row `post_save` path, which
    // belongs to `Expose` rather than the bridge (this harness registers no
    // `Expose`). WATCHED rather than merely skipped: a create that wrongly
    // fired the bulk bridge is exactly the regression this file exists to
    // catch, and a watch opened after it could never see it.
    let created = app
        .put_as_agent(
            &key,
            &path,
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await;
    assert_eq!(created.status(), 200, "{}", created.text());
    assert!(
        drain(&mut rx).is_empty(),
        "the create path belongs to Expose, not to the bulk bridge"
    );

    // The second write takes the agent route's UPDATE branch — the same
    // `update_values` the operator's `put_layout` runs, and the half that used
    // to be silent.
    let second = app
        .put_as_agent(
            &key,
            &path,
            json!({ "project": project, "op": { "create_group": { "name": "Two" } } }),
        )
        .await;
    assert_eq!(second.status(), 200, "{}", second.text());

    let row = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project))
        .first()
        .await
        .expect("read the layout row")
        .expect("the first write created one");

    let events = drain(&mut rx);
    assert_eq!(
        events.len(),
        1,
        "one broadcast per agent re-arrangement, not one per field: {events:?}"
    );
    let (channel, event, data) = &events[0];
    assert_eq!(
        channel, &group,
        "an agent's write must land on the group the panel already watches"
    );
    assert_eq!(event, "updated", "an update, not a create");
    assert_eq!(
        data,
        &json!({ "id": row.id }),
        "id-only, the same projection the operator's write emits"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn trashing_a_page_broadcasts_its_own_route() {
    // The trash emits from the WRITER (the ORM's delete payload cannot route);
    // it carries the same widened shape, so a viewer who has this page open
    // remounts that one board — which then learns the page is gone — and every
    // other board on the canvas stays untouched.
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let group = format!("project:{project}:design_files");
    let mut rx = watch(&group).await;

    let seeded = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/about.html", "content": "<p>about</p>" }),
        )
        .await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());
    let row_id = seeded.json()["file"]["id"].as_i64().expect("the created row id");
    drain(&mut rx);

    let trashed = app
        .delete_as(user.id, &format!("/api/design/{project}/page?route=/about"))
        .await;
    assert_eq!(trashed.status(), 200, "{}", trashed.text());

    let events = drain(&mut rx);
    assert_eq!(events.len(), 1, "one broadcast per trash: {events:?}");
    let (channel, event, data) = &events[0];
    assert_eq!(channel, &group);
    assert_eq!(event, "deleted", "a trash is a delete to every viewer");
    assert_eq!(
        data,
        &json!({
            "id": row_id,
            "version": 1,
            "path": "pages/about.html",
            "affected_routes": ["/about"],
        }),
        "the trashed page's own route is the whole blast radius"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restoring_a_page_broadcasts_its_own_route() {
    let app = TestApp::new_with_realtime().await;
    let (user, project) = app.create_member_with_project().await;
    let group = format!("project:{project}:design_files");
    let mut rx = watch(&group).await;

    let seeded = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/about.html", "content": "<p>about</p>" }),
        )
        .await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());
    let row_id = seeded.json()["file"]["id"].as_i64().expect("the created row id");
    let trashed = app
        .delete_as(user.id, &format!("/api/design/{project}/page?route=/about"))
        .await;
    assert_eq!(trashed.status(), 200, "{}", trashed.text());
    drain(&mut rx);

    let restored = app
        .post_json_as(
            user.id,
            &format!("/api/design/{project}/trash/restore"),
            &json!({ "path": "pages/about.html" }),
        )
        .await;
    assert_eq!(restored.status(), 200, "{}", restored.text());

    let events = drain(&mut rx);
    assert_eq!(events.len(), 1, "one broadcast per restore: {events:?}");
    let (channel, event, data) = &events[0];
    assert_eq!(channel, &group);
    assert_eq!(event, "updated", "a restore brings the row back");
    assert_eq!(
        data,
        &json!({
            "id": row_id,
            "version": 1,
            "path": "pages/about.html",
            "affected_routes": ["/about"],
        }),
        "the restored page's own route is the whole blast radius"
    );
}
