//! The agent layout write: four operations over one route.
//!
//! The read is in `agent_layout_read.rs`; this file owns everything that
//! CHANGES the arrangement.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

/// An app, a member with a project, and an agent credential for that project.
async fn app_with_agent() -> (TestApp, i64, i64, String) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = seed_agent(project, "Builder").await;
    (app, project, user.id, key)
}

/// One real page, through the operator file route, so the manifest has a route
/// a layout document can name.
async fn seed_page(app: &TestApp, project: i64, user: i64, path: &str, name: &str) {
    let res = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/file"),
            &json!({ "path": path, "content": format!("<main class=\"p-4\">{name}</main>") }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
}

/// The agent layout route, read or write — ONE path, and the query carries the
/// project. (The read and the write are the same URL by design: the body is
/// what differs, and only one of the two verbs accepts one.)
fn layout_path(project: i64) -> String {
    format!("/api/taskflow/agents/design/layout?project={project}")
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_creates_a_group_and_reads_it_back() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Player" } } }),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let body = res.json();
    assert_eq!(body["ok"], true);
    assert_eq!(body["version"], 1, "the first write creates the row at version 1");
    let group_id = body["changed"]["groups"][0].as_str().expect("the new group id");

    // And it is really there, through the read the agent already has.
    let read = app.get_as_agent(&key, &layout_path(project)).await;
    let doc = read.json();
    assert_eq!(doc["groups"][0]["id"], group_id);
    assert_eq!(doc["groups"][0]["name"], "Player");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_page_does_not_wedge_future_writes() {
    // Review Focus 1. The stored document still names a page that is gone;
    // `validate` REJECTS unknown routes while `load_layout` FILTERS them, so a
    // write that began from the raw row would fail forever on a page nobody can
    // see. The write must begin from the served view.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;
    seed_page(&app, project, user, "pages/b.html", "B").await;

    let created = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await
        .json();
    let group_id = created["changed"]["groups"][0].as_str().unwrap().to_string();

    // Arrange /b into that group, then delete /b behind the document's back.
    // The response is ASSERTED, not merely awaited: had this write failed, /b
    // would never have been in the stored document, and every assertion below
    // would pass while exercising nothing at all.
    let arranged = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "reorder_page": { "route": "/b", "group_id": group_id } } }),
        )
        .await;
    assert_eq!(
        arranged.status(),
        200,
        "the premise: /b has to be IN the document before it can go stale: {}",
        arranged.text()
    );
    // An existing row is UPDATED, so this is the other half of the version
    // arithmetic the create in `created` above never reaches. Both halves are
    // asserted: the number the caller is handed, and the number the row now
    // carries — a response that reported a bump the UPDATE never made would
    // leave every later `base_version` comparison wrong.
    assert_eq!(
        arranged.json()["version"],
        2,
        "the second write bumps the version to 2"
    );
    let updated_row = app.latest_layout_row(project).await;
    assert_eq!(updated_row.version, 2, "and that is what the row carries now");
    app.delete_page_row(project, "pages/b.html").await;

    // A fresh, unrelated write must still succeed.
    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Two" } } }),
        )
        .await;
    assert_eq!(res.status(), 200, "a dead route must not block an edit: {}", res.text());

    // The dead route is gone from what is STORED, not merely from what is
    // served. The read resolves `flow` over the already-filtered document, so a
    // route the manifest no longer has cannot appear there whether or not this
    // write pruned it — an assertion against the served view can never fail.
    let stored: serde_json::Value =
        serde_json::from_str(&app.latest_layout_row(project).await.layout_json)
            .expect("the stored document parses");
    let named: Vec<&str> = stored["routeOrder"]
        .as_array()
        .expect("routeOrder")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(!named.contains(&"/b"), "the stored flow prunes the dead route: {stored}");
    let claimed: Vec<&str> = stored["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .flat_map(|g| g["routes"].as_array().expect("a group's routes").iter())
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        !claimed.contains(&"/b"),
        "and no stored group still claims it — the prune is in what is SAVED: {stored}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unparseable_row_is_refused_rather_than_reset() {
    // Review Focus 2. `load_layout` degrades to `default_doc()` on a row that
    // will not parse. Doing that on the WRITE side would persist `default + op`
    // and silently discard the real arrangement.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // The operator arranges something real, then the bytes go bad underneath.
    app.put_json_as(
        user,
        &format!("/api/design/{project}/layout"),
        &json!({
            "view": "groups",
            "routeOrder": ["/a"],
            "groups": [{ "id": "gkeep", "name": "Keep Me", "routes": ["/a"] }],
            "pageLabels": {}
        }),
    )
    .await;
    app.write_layout_json(project, "{ this is not json").await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Player" } } }),
        )
        .await;
    assert_eq!(res.status(), 500, "refused, not repaired: {}", res.text());

    let row = app.latest_layout_row(project).await;
    assert_eq!(row.layout_json, "{ this is not json", "and nothing was written");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_write_another_projects_layout() {
    let (app, project, _user, key) = app_with_agent().await;
    let (_other_user, other_project) = app.create_member_with_project().await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(other_project),
            json!({ "project": other_project, "op": { "create_group": { "name": "Nope" } } }),
        )
        .await;
    assert!(res.status() >= 400, "the credential's own project only: {}", res.text());

    // Positive control: the SAME credential and the SAME body against its own
    // project is accepted, so the refusal above is about the project and not
    // about the request being malformed.
    let ok = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Nope" } } }),
        )
        .await;
    assert_eq!(ok.status(), 200, "{}", ok.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_out_of_range_position_is_refused_with_the_valid_range() {
    // What the two reorder descriptions promise: "a slot past the last group
    // comes back as a 400 naming the valid range", and out of range "refused,
    // not clamped". The sentence is the whole value of the refusal — a caller
    // told only `invalid_operation` cannot tell a bad slot from a bad group id —
    // and it is the message the MCP had to be taught to prefer over the
    // envelope's machine code (see `client.ts::extractDetail`).
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let created = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await;
    assert_eq!(created.status(), 200, "{}", created.text());
    let group_id = created.json()["changed"]["groups"][0]
        .as_str()
        .expect("the new group id")
        .to_string();

    // One group, so the only valid slot is 1 — and the refusal says so.
    let slot = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "op": { "reorder_group": { "group_id": group_id, "position": 99 } }
            }),
        )
        .await;
    assert_eq!(slot.status(), 400, "{}", slot.text());
    let body = slot.json();
    assert_eq!(
        body["error"], "invalid_operation",
        "the code the envelope carries BESIDE the sentence: {}",
        slot.text()
    );
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("1..=1 is valid"),
        "the refusal names the range that exists: {}",
        slot.text()
    );

    // The page variant counts the section AFTER the placed page is taken out of
    // it, so the one page this project has reads as "0 other page(s)" — the
    // count is about the pages already there, and the RANGE is still the one
    // slot that works.
    let page_slot = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "reorder_page": { "route": "/a", "position": 99 } } }),
        )
        .await;
    assert_eq!(page_slot.status(), 400, "{}", page_slot.text());
    assert!(
        page_slot.json()["message"]
            .as_str()
            .unwrap_or_default()
            .contains("0 other page(s), so 1..=1 is valid"),
        "the page refusal counts the OTHER pages and still names the range: {}",
        page_slot.text()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_arguments_are_refused_with_a_reason() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // A blank name is refused by `validate`, which owns the name rules.
    let blank = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "   " } } }),
        )
        .await;
    assert_eq!(blank.status(), 400, "{}", blank.text());
    assert!(
        blank.json()["message"].as_str().unwrap_or_default().contains("empty"),
        "validate's own message is surfaced: {}",
        blank.text()
    );

    // An unknown group id names the id.
    let ghost = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "update_group": { "group_id": "ghost", "name": "X" } } }),
        )
        .await;
    assert_eq!(ghost.status(), 400, "{}", ghost.text());
    assert!(ghost
        .json()["message"]
        .as_str()
        .unwrap_or_default()
        .contains("ghost"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reorder_page_that_asks_for_nothing_is_refused() {
    // Spec §6's cases: `group_id` alone appends to that group, `position` alone
    // moves the page within its section, both does both — and NEITHER asks for
    // nothing, which is refused rather than quietly re-appending the page to
    // the section it is already in and reporting success.
    //
    // Refused by the HANDLER, not only by the tool schema: a schema is a
    // client-side courtesy, and a direct call must not get a different answer.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // A real row, so that "nothing was written" has something to be true of and
    // the 400 cannot be a first-write refusal wearing this test's clothes.
    let first = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await;
    assert_eq!(first.status(), 200, "{}", first.text());
    let before = app.latest_layout_row(project).await;

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "reorder_page": { "route": "/a" } } }),
        )
        .await;
    assert_eq!(res.status(), 400, "{}", res.text());
    assert!(
        res.json()["message"]
            .as_str()
            .unwrap_or_default()
            .contains("group_id"),
        "the refusal says what is missing: {}",
        res.text()
    );

    let after = app.latest_layout_row(project).await;
    assert_eq!(
        after.layout_json, before.layout_json,
        "and nothing was written, not even the same document back"
    );
    assert_eq!(
        after.version, before.version,
        "nor bumped, which a write that changed nothing would still have done"
    );
}

// ---------------------------------------------------------------------------
// The version, end to end
//
// The number `read_layout` hands out is the number a write's `base_version` is
// checked against: the layout ROW's own version, not the manifest's `revision`
// (which is `max(design_file.version)` and answers a different question), and
// 0 while no row exists — the base a project's first arrangement is written
// from. Review Focus 5 lives here: an agent that never read must never be
// blocked, and one that did read must be TOLD when someone moved the board
// under it.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_read_reports_the_layouts_own_version() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;
    // Save the same page again, so the manifest's `revision` — the max of the
    // FRAGMENT versions — sits at 2, deliberately NOT where the layout row's
    // own version will be. With the two at the same number, an assertion that
    // they differ would pass on a read that had confused them; with a real gap
    // between them it fails on exactly that confusion.
    seed_page(&app, project, user, "pages/a.html", "A, saved again").await;

    // Nobody has arranged anything yet.
    let fresh = app.get_as_agent(&key, &layout_path(project)).await.json();
    assert_eq!(
        fresh["revision"], 2,
        "the premise: the manifest's own number is not the layout's: {fresh}"
    );
    assert_eq!(fresh["version"], 0, "no row yet, so 0 is the base to write from");

    // Asserted, not merely awaited: a write that failed would leave the read
    // below reporting 0 and this test would say "the version is wrong" about a
    // write that never landed.
    let created = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await;
    assert_eq!(created.status(), 200, "{}", created.text());
    assert_eq!(created.json()["version"], 1);

    let after = app.get_as_agent(&key, &layout_path(project)).await.json();
    assert_eq!(after["version"], 1);
    assert_ne!(
        after["version"], after["revision"],
        "the manifest revision is a different number and must not be mistaken for this one"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stale_base_version_is_refused_with_the_current_document() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let first = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await
        .json();
    let stale = first["version"].as_i64().unwrap();

    // Someone else moves the board on.
    let second = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "Two" } } }),
        )
        .await;
    assert_eq!(
        second.status(),
        200,
        "the premise: the board has to have moved on for `stale` to be stale: {}",
        second.text()
    );

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "base_version": stale,
                "op": { "create_group": { "name": "Three" } }
            }),
        )
        .await;
    assert_eq!(res.status(), 409, "{}", res.text());
    let body = res.json();
    assert_eq!(body["error"], "version_conflict");
    assert_eq!(body["current_version"], stale + 1);
    // TWO groups, so this is the LIVE document and not the caller's stale view
    // (one group) and not the document the refused write meant to store (three).
    // `groups` is spelled the same in both casings, so the assertion does not
    // depend on the response's camelCase convention.
    assert_eq!(
        body["current_document"]["groups"].as_array().map(|g| g.len()),
        Some(2),
        "the current document comes back so a caller can merge rather than guess"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_omitted_base_version_never_conflicts() {
    // Review Focus 5, and the whole point of D1: an agent that never read is
    // never blocked. Ten writes in a row, none of them sending a version.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    for n in 0..10 {
        let res = app
            .put_as_agent(
                &key,
                &layout_path(project),
                json!({ "project": project, "op": { "create_group": { "name": format!("G{n}") } } }),
            )
            .await;
        assert_eq!(res.status(), 200, "write {n}: {}", res.text());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_round_trip_base_version_is_accepted() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    // Hand back exactly what the read handed out — with NO row stored yet, so
    // the base is 0.
    let read = app.get_as_agent(&key, &layout_path(project)).await.json();
    let version = read["version"].as_i64().unwrap();
    assert_eq!(version, 0, "the premise: nothing has been arranged yet: {read}");

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "base_version": version,
                "op": { "create_group": { "name": "One" } }
            }),
        )
        .await;
    assert_eq!(res.status(), 200, "the version the read just handed out is current: {}", res.text());

    // And the same round trip over a row that NOW EXISTS — the shape the two
    // 409 cases exercise. Read, hand the number straight back, expect 200.
    // Without this the file has no case where a supplied base is ACCEPTED
    // against a stored row, and an implementation that refused every supplied
    // `base_version` the moment a row existed would pass every other test here.
    let read = app.get_as_agent(&key, &layout_path(project)).await.json();
    let version = read["version"].as_i64().unwrap();
    assert_eq!(version, 1, "the premise: the write above created the row: {read}");

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "base_version": version,
                "op": { "create_group": { "name": "Two" } }
            }),
        )
        .await;
    assert_eq!(
        res.status(),
        200,
        "and a version read from a row that exists is current too: {}",
        res.text()
    );
    assert_eq!(res.json()["version"], 2, "so the write lands, one past the base");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_operator_save_makes_a_held_version_stale() {
    // The operator sends no version and always wins, but their save must move
    // the number or an agent holding an old one would never be told.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;

    let first = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await
        .json();
    let held = first["version"].as_i64().unwrap();

    // The operator's own save, on the operator's own route, with the shape the
    // panel sends. No version, because the human looking at the board always
    // wins — the assertion is only that it was accepted.
    let op = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/layout"),
            &json!({
                "view": "groups",
                "routeOrder": ["/a"],
                "groups": [{ "id": "goperator", "name": "Operator", "routes": ["/a"] }],
                "pageLabels": {}
            }),
        )
        .await;
    assert_eq!(op.status(), 200, "{}", op.text());

    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "base_version": held,
                "op": { "create_group": { "name": "Two" } }
            }),
        )
        .await;
    assert_eq!(res.status(), 409, "the operator's save moved the number: {}", res.text());
}

// ---------------------------------------------------------------------------
// `changed.routes`
//
// Collateral renumbering, the one thing an agent cannot predict from the call
// it made: a placement renumbers the section it landed in, so pages the caller
// never named change their visible position. Spec §11 leans on this list as the
// caller's only warning, and the reorder_page description promises it "names
// every page whose visible position moved, and always the page you named".
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn changed_routes_names_the_pages_that_visibly_moved() {
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/a.html", "A").await;
    seed_page(&app, project, user, "pages/b.html", "B").await;
    seed_page(&app, project, user, "pages/c.html", "C").await;

    // /c takes a section of its own, so the section under test has a neighbour:
    // what happens to /c is what says the diff is by IN-SECTION position rather
    // than by the global flow index.
    let created = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "create_group": { "name": "One" } } }),
        )
        .await;
    assert_eq!(created.status(), 200, "{}", created.text());
    let group_id = created.json()["changed"]["groups"][0]
        .as_str()
        .expect("the new group id")
        .to_string();
    let placed = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "op": { "reorder_page": { "route": "/c", "group_id": group_id } }
            }),
        )
        .await;
    assert_eq!(
        placed.status(),
        200,
        "the premise: /c has to be IN that group before it can be the untouched \
         neighbour: {}",
        placed.text()
    );

    // The ungrouped section is now [/a, /b] in manifest order. Placing /b FIRST
    // in it displaces /a from slot 1 to slot 2 — /a moves without the call
    // naming it, which is the whole reason the caller needs the list. /c keeps
    // slot 1 of its own section, so it must NOT be reported.
    let res = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({ "project": project, "op": { "reorder_page": { "route": "/b", "position": 1 } } }),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let body = res.json();
    let changed: Vec<&str> = body["changed"]["routes"]
        .as_array()
        .expect("changed.routes")
        .iter()
        .map(|v| v.as_str().expect("a route"))
        .collect();
    assert_eq!(
        changed,
        vec!["/a", "/b"],
        "the page the call displaced is named as well as the one it placed, so a \
         caller that reads only `changed.groups` is not left thinking /a is still \
         first: {}",
        res.text()
    );

    // And the converse, which is what pins WHICH numbering the diff reads: /a
    // changes section here, so its own slot is 2 before and 2 after and its
    // global flow index is 2 before and 3 after — while /c's global index moves
    // the other way (3 → 2) and its in-section slot does not move at all. A diff
    // over the raw flow would report /c; the in-section diff reports only the
    // page the caller named.
    let moved = app
        .put_as_agent(
            &key,
            &layout_path(project),
            json!({
                "project": project,
                "op": { "reorder_page": { "route": "/a", "group_id": group_id } }
            }),
        )
        .await;
    assert_eq!(moved.status(), 200, "{}", moved.text());
    let body = moved.json();
    let changed: Vec<&str> = body["changed"]["routes"]
        .as_array()
        .expect("changed.routes")
        .iter()
        .map(|v| v.as_str().expect("a route"))
        .collect();
    assert_eq!(
        changed,
        vec!["/a"],
        "no page's VISIBLE position moved here, every section's numbering is what \
         it was, and the page the caller named is reported anyway: {}",
        moved.text()
    );
}
