//! #682: renaming labels in bulk, and moving a page's route with everything
//! that pointed at it.
//!
//! Two different asks in one task, and the tests keep them apart: a LABEL is
//! the name the Pages panel shows (arrangement only — the route, the file and
//! every link are untouched), while a ROUTE is the page's URL, and moving one
//! has to move every reference or leave the design pointing at nothing.

mod support;

use serde_json::json;
use support::TestApp;

async fn seeded() -> (TestApp, i64, i64, String) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent, key) = support::seed_agent(project, "Renamer").await;
    for (path, content) in [
        ("pages/index.html", r#"<main><p>Home</p><a href="/ai-coach">Start</a><a href="/ai-coaching">Other</a></main>"#),
        ("pages/ai-coach.html", "<main><p>The coach page</p></main>"),
        ("pages/pricing.html", "<main><p>Pricing</p></main>"),
    ] {
        let res = app
            .put_json_as(user.id, &format!("/api/design/{project}/file"), &json!({ "path": path, "content": content }))
            .await;
        assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
    }
    (app, user.id, project, key)
}

async fn write_ops(app: &TestApp, key: &str, project: i64, ops: serde_json::Value) -> support::TestResponse {
    app.put_as_agent(
        key,
        &format!("/api/taskflow/agents/design/layout?project={project}"),
        json!({ "project": project, "ops": ops }),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn labels_are_set_cleared_and_bulked() {
    let (app, _user, project, key) = seeded().await;

    // A batch of label renames — the owner's ask: several pages in ONE request.
    let out = write_ops(
        &app,
        &key,
        project,
        json!([
            { "set_label": { "route": "/", "label": "Landing" } },
            { "set_label": { "route": "/pricing", "label": "Plans & pricing" } },
            { "set_label": { "route": "/ai-coach", "label": "  Coach  " } },
        ]),
    )
    .await;
    assert_eq!(out.status(), 200, "{}", out.text());

    let layout = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/layout?project={project}"))
        .await
        .json();
    let names: Vec<(String, String)> = layout["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["route"].as_str().unwrap().to_string(), p["name"].as_str().unwrap().to_string()))
        .collect();
    assert!(names.contains(&("/".into(), "Landing".into())), "{names:?}");
    assert!(names.contains(&("/pricing".into(), "Plans & pricing".into())), "{names:?}");
    assert!(
        names.contains(&("/ai-coach".into(), "Coach".into())),
        "trimmed, and the route itself is untouched: {names:?}"
    );

    // Clearing falls back to the manifest title.
    let cleared = write_ops(&app, &key, project, json!([{ "set_label": { "route": "/", "label": null } }])).await;
    assert_eq!(cleared.status(), 200, "{}", cleared.text());
    let layout = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/layout?project={project}"))
        .await
        .json();
    let home = layout["pages"].as_array().unwrap().iter().find(|p| p["route"] == "/").unwrap();
    // The manifest title is derived from the FILE NAME (`index.html` →
    // "Index"), not from the page's copy — which is exactly why a label is an
    // override worth having, and what clearing falls back to.
    assert_eq!(home["name"], "Index", "back to the page's own title");

    // A label names a page.
    let ghost = write_ops(&app, &key, project, json!([{ "set_label": { "route": "/ghost", "label": "x" } }])).await;
    assert_eq!(ghost.status(), 400, "a label names a page: {}", ghost.text());
    assert!(ghost.text().contains("not a page in this project"), "{}", ghost.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn renaming_a_route_moves_the_page_its_links_and_the_arrangement() {
    let (app, user, project, key) = seeded().await;

    // An arrangement that points at the old route in EVERY way it can: a
    // group membership, a label, an arrow end and a pinned position.
    let layout = app
        .put_json_as(
            user,
            &format!("/api/design/{project}/layout"),
            &json!({
                "view": "flow",
                "routeOrder": ["/", "/ai-coach", "/pricing"],
                "groups": [{ "id": "g1", "name": "Product", "routes": ["/ai-coach", "/pricing"] }],
                "pageLabels": { "/ai-coach": "Coach" },
                "edges": [{ "id": "e1", "from": "/", "to": "/ai-coach", "label": "start" }],
                "positions": { "/ai-coach": { "x": 10, "y": 20 } }
            }),
        )
        .await;
    assert_eq!(layout.status(), 200, "{}", layout.text());

    let renamed = app
        .post_json_as_agent(
            &key,
            "/api/taskflow/agents/design/rename-route",
            &json!({ "project": project, "from": "/ai-coach", "to": "/pulse" }),
        )
        .await;
    assert_eq!(renamed.status(), 200, "{}", renamed.text());
    let report = renamed.json();
    assert_eq!(report["to"], "/pulse");
    assert_eq!(
        report["pages_rewritten"],
        json!(["pages/index.html"]),
        "the page that linked to it was rewritten: {report}"
    );
    assert!(report["pages_skipped"].as_array().unwrap().is_empty());
    assert_eq!(report["layout_updated"], true);

    // The page file moved: the new route serves, the old one is gone.
    let manifest = app.get_as(user, &format!("/api/design/{project}/manifest")).await;
    let routes: Vec<String> = manifest.json()["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["path"].as_str().unwrap().to_string())
        .collect();
    assert!(routes.contains(&"/pulse".to_string()), "{routes:?}");
    assert!(!routes.contains(&"/ai-coach".to_string()), "{routes:?}");

    // The link followed, and only the exact route's links did.
    let index = app
        .get_as(user, &format!("/api/design/{project}/file?path=pages/index.html"))
        .await;
    let content = index.json()["content"].as_str().unwrap_or_default().to_string();
    assert!(content.contains(r#"href="/pulse""#), "the link moved: {content}");
    assert!(
        content.contains(r#"href="/ai-coaching""#),
        "a LONGER route is a different page and stays: {content}"
    );

    // The arrangement followed in every shape.
    let layout = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/layout?project={project}"))
        .await
        .json();
    let group_routes = layout["groups"][0]["routes"].clone();
    assert_eq!(group_routes, json!(["/pulse", "/pricing"]), "{layout}");
    let pages: Vec<(String, String)> = layout["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["route"].as_str().unwrap().to_string(), p["name"].as_str().unwrap().to_string()))
        .collect();
    assert!(pages.contains(&("/pulse".into(), "Coach".into())), "the label followed: {pages:?}");

    // The old page is recoverable, not gone.
    let trash = app.get_as(user, &format!("/api/design/{project}/trash")).await;
    assert!(
        trash.text().contains("pages/ai-coach.html"),
        "the old page is in the trash: {}",
        trash.text()
    );

    // Renaming a page's route does not touch the routes that merely MENTION it
    // in an image or a class name.
    let refused = app
        .post_json_as_agent(
            &key,
            "/api/taskflow/agents/design/rename-route",
            &json!({ "project": project, "from": "/missing", "to": "/x" }),
        )
        .await;
    assert_eq!(refused.status(), 422, "{}", refused.text());
    assert!(refused.text().contains("No page serves"), "{}", refused.text());

    let onto = app
        .post_json_as_agent(
            &key,
            "/api/taskflow/agents/design/rename-route",
            &json!({ "project": project, "from": "/pricing", "to": "/pulse" }),
        )
        .await;
    assert_eq!(onto.status(), 422, "{}", onto.text());
    assert!(onto.text().contains("already serves a page"), "{}", onto.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rename_refuses_a_trashed_target_rather_than_destroying_it() {
    let (app, user, project, key) = seeded().await;

    // Trash /pricing, then try to rename /ai-coach ONTO it. Writing at that
    // path would purge the trashed row for good (`store::write_file`), which is
    // a deletion nobody asked for.
    let trashed = app
        .delete_as(user, &format!("/api/design/{project}/page?route=/pricing"))
        .await;
    assert_eq!(trashed.status(), 200, "{}", trashed.text());

    let refused = app
        .post_json_as_agent(
            &key,
            "/api/taskflow/agents/design/rename-route",
            &json!({ "project": project, "from": "/ai-coach", "to": "/pricing" }),
        )
        .await;
    assert_eq!(refused.status(), 422, "{}", refused.text());
    assert!(refused.text().contains("trashed"), "{}", refused.text());

    // And the trashed page is still restorable.
    let restored = app
        .post_json_as(
            user,
            &format!("/api/design/{project}/trash/restore"),
            &json!({ "path": "pages/pricing.html" }),
        )
        .await;
    assert_eq!(restored.status(), 200, "{}", restored.text());
}
