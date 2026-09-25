//! `design_read_layout`: the agent's read of the arrangement.
//!
//! The gap this closes is not a 404 — `design_list_components` answers, and
//! answers with a flat `{file, path, title}` array in the manifest's own
//! sequence, from which the grouping and the order cannot be recovered at any
//! price. So the assertions below are about the SHAPE of the answer (ruling 3:
//! the arrangement as the panel shows it) and about the two ways the read could
//! be wrong in the other direction: too permissive (another project's
//! arrangement) and too strict (a document naming a page that has since been
//! deleted, refused instead of filtered).

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

/// An app, a member with a project, and an agent credential for that project.
async fn app_with_agent() -> (TestApp, i64, i64, String) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent_id, key) = seed_agent(project, "Designer").await;
    (app, project, user.id, key)
}

/// One real page, through the operator file route, so the manifest has a route
/// a layout document can actually name.
async fn seed_page(app: &TestApp, project: i64, user: i64, path: &str, body: &str) {
    let res = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/file"),
            &json!({ "path": path, "content": format!("<main class=\"p-4\">{body}</main>") }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
}

async fn put_layout(app: &TestApp, user: i64, project: i64, body: serde_json::Value) {
    let res = app
        .put_json_as(user, &format!("/api/design/{project}/layout"), &body)
        .await;
    assert_eq!(res.status(), 200, "operator layout write failed: {}", res.text());
}

fn agent_layout_path(project: i64) -> String {
    format!("/api/taskflow/agents/design/layout?project={project}")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_agent_reads_the_arrangement_as_the_panel_shows_it() {
    // Ruling 3. A 200 is not the claim: the claim is that the answer carries the
    // groups with their names, the order the groups are in, the pages each one
    // holds, the flow, and the labels — so an agent can read the arrangement
    // rather than re-derive it from ids.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/index.html", "Dashboard").await;
    seed_page(&app, project, user, "pages/settings.html", "Settings").await;
    seed_page(&app, project, user, "pages/signup.html", "Sign up").await;

    // A flow that is deliberately NOT the manifest's order (the manifest is
    // /, /settings, /signup), and two groups in a deliberate order (Ops is not
    // alphabetically after Auth by accident — "Ops" sorts before it, so a name
    // sort anywhere in the read fails this).
    put_layout(
        &app,
        user,
        project,
        json!({
            "view": "groups",
            "routeOrder": ["/signup", "/", "/settings"],
            "groups": [
                { "id": "g1", "name": "Auth", "routes": ["/settings"] },
                { "id": "g2", "name": "Ops", "routes": ["/"] }
            ],
            "pageLabels": { "/settings": "Preferences" }
        }),
    )
    .await;

    let res = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let v = res.json();

    // The groups, their names, and their order.
    let names: Vec<&str> = v["groups"]
        .as_array()
        .expect("groups array")
        .iter()
        .map(|g| g["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Auth", "Ops"], "group order and names: {v}");

    // Each group's own ordered routes, and the pages no group claims — the
    // panel's two halves, which together list every page exactly once.
    assert_eq!(v["groups"][0]["routes"], json!(["/settings"]));
    assert_eq!(v["groups"][1]["routes"], json!(["/"]));
    assert_eq!(v["ungrouped"], json!(["/signup"]));

    // The flow: the order the panel lists pages in and the canvas draws in.
    assert_eq!(v["flow"], json!(["/signup", "/", "/settings"]));

    // The labels, and the name each page is listed under (a label where it has
    // one, the manifest's own title otherwise).
    assert_eq!(v["page_labels"]["/settings"], "Preferences");
    let entries = v["pages"].as_array().expect("pages array");
    assert_eq!(
        entries.len(),
        3,
        "every page of the manifest is listed exactly once: {v}"
    );
    let page = |route: &str| {
        entries
            .iter()
            .find(|p| p["route"] == route)
            .cloned()
            .unwrap_or_else(|| panic!("no page entry for {route}: {v}"))
    };
    let settings = page("/settings");
    assert_eq!(settings["name"], "Preferences");
    assert_eq!(settings["title"], "Settings", "the manifest's title is still carried");
    // `file`, NOT `path`: in `design_list_components` a route's `path` IS the
    // route, so an agent reaching for `pages.find(p => p.path === route)` — the
    // habit that tool teaches — must find nothing here rather than a file name.
    assert_eq!(settings["file"], "pages/settings.html");
    assert_eq!(settings["path"], serde_json::Value::Null, "`path` means the route elsewhere");
    assert_eq!(page("/signup")["name"], "Signup", "unlabelled pages read by their title");
    assert_eq!(page("/")["name"], "Index");

    // The view the canvas is in, and a note that says what the reader is
    // looking at — the field an agent arriving from `design_list_components`
    // has no other way to interpret.
    assert_eq!(v["view"], "groups");
    assert!(v["note"].as_str().unwrap_or("").contains("groups"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_group_holds_its_pages_in_flow_order_not_the_documents_own() {
    // The stored `routes` array is ASSIGNMENT order: the client appends on
    // assignment, so it is an order nobody chose. The panel lists a group's
    // pages in the flow, and so must this read — otherwise the agent reads a
    // group whose pages are in an order no one is looking at.
    let (app, project, user, key) = app_with_agent().await;
    for (path, title) in [
        ("pages/index.html", "Dashboard"),
        ("pages/settings.html", "Settings"),
        ("pages/signup.html", "Sign up"),
    ] {
        seed_page(&app, project, user, path, title).await;
    }

    // The document assigns /settings BEFORE /signup, and the flow says signup
    // comes first. The panel draws signup first, so this read must too.
    put_layout(
        &app,
        user,
        project,
        json!({
            "view": "groups",
            "routeOrder": ["/signup", "/settings", "/"],
            "groups": [{ "id": "g1", "name": "Auth", "routes": ["/settings", "/signup"] }]
        }),
    )
    .await;

    let res = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    assert_eq!(
        res.json()["groups"][0]["routes"],
        json!(["/signup", "/settings"]),
        "the group lists its pages in flow order, not the array's assignment order"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_document_naming_a_page_that_is_gone_is_served_filtered() {
    // Ruling 2: reads are forgiving. A stored document outlives the pages it
    // names, and an agent asking what the arrangement IS must get an answer —
    // refusing would leave it with no way to learn the grouping, which is the
    // whole point of the tool.
    use taskflow_design::models::{DesignFile, design_file};

    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/index.html", "Dashboard").await;
    seed_page(&app, project, user, "pages/settings.html", "Settings").await;

    put_layout(
        &app,
        user,
        project,
        json!({
            "view": "groups",
            "routeOrder": ["/settings", "/"],
            "groups": [{ "id": "g1", "name": "Auth", "routes": ["/settings"] }],
            "pageLabels": { "/settings": "Preferences" }
        }),
    )
    .await;

    // The page goes away under the stored document's feet.
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project) & design_file::PATH.eq("pages/settings.html"))
        .delete()
        .await
        .expect("delete the page");

    let res = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(
        res.status(),
        200,
        "a vanished route is filtered, never an error: {}",
        res.text()
    );
    let v = res.json();

    // The grouping survives — it is a decision about the project, not a
    // property of one page — with the vanished route dropped from it.
    assert_eq!(v["groups"][0]["name"], "Auth");
    assert_eq!(v["groups"][0]["routes"], json!([]));
    assert_eq!(v["flow"], json!(["/"]), "the flow names only pages that exist");
    assert_eq!(v["ungrouped"], json!(["/"]));
    assert_eq!(
        v["page_labels"].as_object().map(|m| m.len()),
        Some(0),
        "the label for the vanished page goes with it: {v}"
    );
    assert!(
        !v["pages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["route"] == "/settings"),
        "a deleted page is not listed: {v}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_nobody_has_arranged_still_answers() {
    // The default document is an ANSWER, not a failure: every page ungrouped,
    // in the manifest's order. An agent must not have to special-case a fresh
    // project before it can ask how the pages are arranged.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/index.html", "Dashboard").await;
    seed_page(&app, project, user, "pages/settings.html", "Settings").await;

    let res = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(res.status(), 200, "{}", res.text());
    let v = res.json();
    assert_eq!(v["view"], "rows");
    assert_eq!(v["groups"], json!([]));
    assert_eq!(v["flow"], json!(["/", "/settings"]), "manifest order is the fallback flow");
    assert_eq!(v["ungrouped"], json!(["/", "/settings"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_cannot_read_another_projects_layout() {
    // The authorisation boundary. `project` is an ASSERTION that must equal the
    // credential's project — never a routing hint — and the arrangement is the
    // one document an agent could otherwise read across the wall, since the
    // route's operator twin is membership-gated rather than project-pinned.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/index.html", "Dashboard").await;
    put_layout(
        &app,
        user,
        project,
        json!({
            "view": "groups",
            "routeOrder": ["/"],
            "groups": [{ "id": "g1", "name": "My Board", "routes": ["/"] }]
        }),
    )
    .await;

    // A second project, with its own arrangement, that this agent does not
    // belong to.
    let (other_user, other_project) = app.create_member_with_project().await;
    seed_page(&app, other_project, other_user.id, "pages/index.html", "Other").await;
    put_layout(
        &app,
        other_user.id,
        other_project,
        json!({
            "view": "groups",
            "routeOrder": ["/"],
            "groups": [{ "id": "g1", "name": "Secret Ops", "routes": ["/"] }]
        }),
    )
    .await;

    let foreign = app.get_as_agent(&key, &agent_layout_path(other_project)).await;
    assert_eq!(
        foreign.status(),
        403,
        "the credential pins ONE project: {}",
        foreign.text()
    );
    assert!(
        !foreign.text().contains("Secret Ops"),
        "and a refusal carries none of the other project's arrangement: {}",
        foreign.text()
    );

    // The positive control: the same credential, its own project, its own
    // board — so the 403 above is about the project and not a broken route.
    let own = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(own.status(), 200, "{}", own.text());
    assert_eq!(own.json()["groups"][0]["name"], "My Board");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_layout_read_is_not_a_write_surface() {
    // Ruling 1/4: read-only, and the URL is the reason rather than the doc.
    // The agent route exists for GET; a PUT to it is not routed at all, so an
    // agent that tries to arrange the board is refused by the router rather
    // than by a validator it could learn its way around.
    let (app, project, user, key) = app_with_agent().await;
    seed_page(&app, project, user, "pages/index.html", "Dashboard").await;

    // A body that would be OBSERVABLE if it were stored: a named group with a
    // real page in it. An empty document would read back as an empty document
    // whether or not the write happened, which is a status assertion wearing a
    // second assertion's clothes.
    let hijack = json!({
        "view": "groups",
        "routeOrder": ["/"],
        "groups": [{ "id": "g1", "name": "Hijacked", "routes": ["/"] }]
    });

    let put = app
        .put_as_agent(&key, &agent_layout_path(project), hijack.clone())
        .await;
    assert!(
        put.status() >= 400,
        "there is no agent-writeable layout route: {}",
        put.text()
    );

    // And nothing changed — the read is what proves it, since a 4xx that had
    // stored the body on its way out would look identical from the status.
    let res = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(res.status(), 200);
    let v = res.json();
    assert_eq!(v["groups"], json!([]), "the refused write left no group: {v}");
    assert!(
        !v["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["name"] == "Hijacked"),
        "the refused document is not readable back: {v}"
    );

    // That those two assertions have teeth is shown by the same body through a
    // route that DOES write: the operator's. This is the positive control for
    // the negative above — the payload is not merely unobservable by accident.
    put_layout(&app, user, project, hijack).await;
    let after = app.get_as_agent(&key, &agent_layout_path(project)).await;
    assert_eq!(after.json()["groups"][0]["name"], "Hijacked");
}
