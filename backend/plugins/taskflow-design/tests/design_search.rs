//! #664: `design_search` end to end — the tool that answers "which pages
//! mention this?" without reading them.
//!
//! The unit tests inside `search.rs` pin the matcher and the fragment scanner
//! (word boundaries, case, entities, comments, attributes). THIS file pins the
//! assembled answer an agent acts on: which files, with what context, what the
//! scopes include and exclude, how a shared component is reported once, and
//! that paging through a large result set loses nothing.

mod support;

use serde_json::json;
use support::TestApp;

/// A project whose text exercises every scope:
/// - `/` says "AI coach" twice and uses the header component (which says it too)
/// - `/pricing` has it once in text and once in an `alt`
/// - `/help` has "coaching" (never a whole-word hit) and a `coach-card` class
async fn seeded() -> (TestApp, i64, String, i64) {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let (_agent, key) = support::seed_agent(project, "Searcher").await;

    let component = "class AppHeader extends HTMLElement {\n  connectedCallback() { this.innerHTML = '<nav><a href=\"/\">AI coach</a></nav>' }\n}\ncustomElements.define('app-header', AppHeader);";
    let files: [(&str, &str); 4] = [
        ("components/app-header.js", component),
        (
            "pages/index.html",
            "<main><app-header></app-header><h1>AI coach</h1><p>Meet your AI coach today.</p></main>",
        ),
        (
            "pages/pricing.html",
            "<main><h1>AI Coach pricing</h1><img alt=\"AI coach logo\" src=\"https://example.test/l.png\"><p>Plain pricing copy.</p></main>",
        ),
        (
            "pages/help.html",
            "<main><p class=\"coach-card\">coaching the team</p><p>Help centre.</p></main>",
        ),
    ];
    for (path, content) in files {
        let res = app
            .put_json_as(user.id, &format!("/api/design/{project}/file"), &json!({ "path": path, "content": content }))
            .await;
        assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
    }
    // The arrangement carries the label scopes: a group and a flow arrow whose
    // LABEL mentions the term while no page does.
    let layout = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/layout"),
            &json!({
                "view": "groups",
                "routeOrder": [],
                "groups": [{ "id": "g1", "name": "AI coach onboarding", "routes": ["/help"] }],
                "pageLabels": { "/pricing": "AI coach plans" },
                "edges": [{ "id": "e1", "from": "/", "to": "/pricing", "label": "see AI coach plans" }]
            }),
        )
        .await;
    assert_eq!(layout.status(), 200, "seed layout: {}", layout.text());
    (app, user.id, key, project)
}

async fn search(app: &TestApp, key: &str, project: i64, query: &str) -> serde_json::Value {
    let res = app
        .get_as_agent(key, &format!("/api/taskflow/agents/design/search?project={project}&q={query}"))
        .await;
    assert_eq!(res.status(), 200, "search {query}: {}", res.text());
    res.json()
}

fn files_of(body: &serde_json::Value) -> Vec<&str> {
    body["files"].as_array().unwrap().iter().map(|f| f["file"].as_str().unwrap()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn text_scope_finds_visible_copy_and_reports_a_component_once() {
    let (app, _user, key, project) = seeded().await;
    let body = search(&app, &key, project, "AI%20coach").await;

    // Text hits: index (h1 + paragraph = 2), pricing (h1 = 1), the component
    // (1). help's "coaching" is not a whole word.
    assert_eq!(files_of(&body), ["components/app-header.js", "pages/index.html", "pages/pricing.html"]);
    let component = &body["files"][0];
    assert_eq!(component["kind"], "component");
    assert_eq!(component["name"], "app-header");
    assert_eq!(
        component["used_by_routes"],
        json!(["/"]),
        "one edit to the component fixes every route that uses it: {component}"
    );
    assert_eq!(component["count"], 1);
    assert_eq!(component["matches"][0]["what"], "component");

    let index = &body["files"][1];
    assert_eq!(index["route"], "/");
    assert_eq!(index["version"], 1, "the version an edit must carry");
    assert_eq!(index["count"], 2);
    assert_eq!(index["matches"][0]["what"], "text");
    assert_eq!(index["matches"][0]["line"], 1);
    assert!(
        index["matches"][0]["snippet"].as_str().unwrap().contains("<<AI coach>>"),
        "the hit is marked in the snippet: {index}"
    );

    // The variant summary names the surface forms — a rename that misses one
    // leaves it behind.
    assert_eq!(body["variants"]["AI coach"], 3);
    assert_eq!(body["variants"]["AI Coach"], 1);
    assert_eq!(body["total"], 4);
    assert_eq!(body["file_count"], 3);
    assert!(body["next_cursor"].is_null(), "everything fits one page: {body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn whole_word_defaults_on_and_can_be_turned_off() {
    let (app, _user, key, project) = seeded().await;
    // `coach` as a whole word never matches "coaching".
    let whole = search(&app, &key, project, "coach").await;
    assert!(
        !files_of(&whole).contains(&"pages/help.html"),
        "a whole-word search for coach must not sweep up coaching: {whole}"
    );

    let loose = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=coaching&whole_word=false"),
        )
        .await;
    assert_eq!(loose.status(), 200, "{}", loose.text());
    let loose = loose.json();
    assert!(
        files_of(&loose).contains(&"pages/help.html"),
        "substring mode still finds the longer word: {loose}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn case_can_be_pinned() {
    let (app, _user, key, project) = seeded().await;
    let strict = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=AI%20Coach&case_sensitive=true"),
        )
        .await
        .json();
    assert_eq!(strict["total"], 1, "only pricing's exact casing matches: {strict}");
    assert_eq!(files_of(&strict), ["pages/pricing.html"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn attributes_are_their_own_scope() {
    let (app, _user, key, project) = seeded().await;
    // Default (text) does NOT see alt text.
    let text = search(&app, &key, project, "logo").await;
    assert_eq!(text["total"], 0, "{text}");

    let attributes = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=logo&scope=attributes"),
        )
        .await
        .json();
    assert_eq!(attributes["total"], 1);
    let hit = &attributes["files"][0]["matches"][0];
    assert_eq!(hit["what"], "attr:alt", "the scope names WHERE it matched: {attributes}");
}

#[tokio::test(flavor = "multi_thread")]
async fn code_is_off_unless_asked_for() {
    let (app, _user, key, project) = seeded().await;
    let default_scopes = search(&app, &key, project, "coach-card").await;
    assert_eq!(default_scopes["total"], 0, "a class name is not copy: {default_scopes}");

    let with_code = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=coach-card&scope=text,code"),
        )
        .await
        .json();
    assert_eq!(with_code["total"], 1);
    assert_eq!(with_code["files"][0]["matches"][0]["what"], "code");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_labels_scopes_read_the_arrangement() {
    let (app, _user, key, project) = seeded().await;
    let body = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=AI%20coach&scope=page_names,groups,flow_labels"),
        )
        .await
        .json();
    assert_eq!(body["files"].as_array().unwrap().len(), 0, "no content was asked for");
    let labels = body["labels"].as_array().unwrap();
    let whats: Vec<&str> = labels.iter().map(|l| l["what"].as_str().unwrap()).collect();
    assert!(whats.contains(&"page_label"), "the panel label matched: {body}");
    assert!(whats.contains(&"group"), "{body}");
    assert!(whats.contains(&"flow_label"), "{body}");
    let group = labels.iter().find(|l| l["what"] == "group").unwrap();
    assert_eq!(group["name"], "AI coach onboarding");
    assert_eq!(group["group_id"], "g1");
    let flow = labels.iter().find(|l| l["what"] == "flow_label").unwrap();
    assert_eq!(flow["routes"], json!(["/", "/pricing"]));
    assert_eq!(body["total"], labels.len(), "labels count toward the total: {body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn paging_loses_nothing() {
    let (app, _user, key, project) = seeded().await;
    let first = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=AI%20coach&limit=1"),
        )
        .await
        .json();
    assert_eq!(first["files"].as_array().unwrap().len(), 1);
    assert_eq!(first["total"], 4, "the total describes the whole match set, not the page");
    let cursor = first["next_cursor"].as_str().expect("a cursor for the next page");

    let second = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=AI%20coach&limit=2&cursor={cursor}"),
        )
        .await
        .json();
    assert_eq!(files_of(&second), ["pages/index.html", "pages/pricing.html"]);
    assert!(second["next_cursor"].is_null(), "the last page says so: {second}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_query_says_what_is_wrong() {
    let (app, _user, key, project) = seeded().await;
    let empty = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/search?project={project}"))
        .await;
    assert_eq!(empty.status(), 422);
    assert_eq!(empty.json()["error"], "bad_query");

    let regex = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=(unclosed&regex=true"),
        )
        .await;
    assert_eq!(regex.status(), 422, "an uncompilable pattern is answered, not a 500");
    assert!(regex.json()["detail"].as_str().unwrap().contains("invalid pattern"));

    let scope = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=x&scope=everything"),
        )
        .await;
    assert_eq!(scope.status(), 422);
    assert!(scope.json()["detail"].as_str().unwrap().contains("unknown scope"));
}

#[tokio::test(flavor = "multi_thread")]
async fn regex_mode_searches_patterns() {
    let (app, _user, key, project) = seeded().await;
    let body = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/design/search?project={project}&q=AI.%20?[Cc]oach&regex=true"),
        )
        .await
        .json();
    assert!(body["total"].as_u64().unwrap() >= 4, "the pattern found the variants: {body}");
}
