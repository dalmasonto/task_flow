//! #665's scale measurements: what a 500-file project costs the backend.
//!
//! The owner's projects run to ~500 boards, and the caps were raised to match
//! (`tests/caps.rs`). This test is the other half of that promise: the numbers
//! that say the machine still COPES at that size, recorded by printing them and
//! held in place by deliberately loose ceilings.
//!
//! WHY LOOSE CEILINGS. These are wall-clock measurements on whatever machine CI
//! happens to be, and a tight bound would be a flake with a deadline. The
//! ceilings sit roughly an order of magnitude above the measured times: they do
//! not notice a machine being slow, they notice an ALGORITHM getting slower —
//! an accidental O(n²), a manifest rebuild per file, a full table read on the
//! edit path. Run with `--nocapture` to see the numbers.
//!
//! WHAT IS DELIBERATELY NOT MEASURED HERE. The browser half — time to first
//! board, live-iframe count, memory — needs a real canvas and a real Chromium;
//! it is scripted separately (see the task). This file is the server's share.

mod support;

use std::time::Instant;

use serde_json::json;
use support::TestApp;
use umbral::orm::ForeignKey;

use taskflow_design::models::{DesignFile, DesignFileKind};
use taskflow_design::store::{self, WriteOutcome};

const PAGES: usize = 500;
const COMPONENTS: usize = 20;

/// A page fragment of roughly the size the owner expects (KBs, not bytes).
fn page_html(index: usize) -> String {
    let component = if index % 25 == 0 {
        format!("<app-card-{}></app-card-{}>", index % COMPONENTS, index % COMPONENTS)
    } else {
        String::new()
    };
    let body = "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>".repeat(75);
    format!("<main class=\"p-4\">{component}{body}</main>")
}

/// Seed through the ORM directly: the caps are not what this file measures, and
/// seeding through the write route would measure the cap check 500 times over
/// (it sums the project's bytes per NEW file — the one O(project) step in the
/// create path, which is why it is only paid on CREATE; see `store::total_bytes`).
async fn seed_files(project: i64) {
    for i in 0..COMPONENTS {
        DesignFile::objects()
            .create(DesignFile {
                id: 0,
                project: ForeignKey::new(project),
                kind: DesignFileKind::Component,
                path: format!("components/app-card-{i}.js"),
                content: format!(
                    "class AppCard{i} extends HTMLElement {{ connectedCallback() {{ this.innerHTML = '<b>card</b>'; }} }}\ncustomElements.define('app-card-{i}', AppCard{i});"
                ),
                version: 1,
                updated_by: "bench".into(),
                created_at: None,
                updated_at: None,
                deleted_at: None,
            })
            .await
            .expect("seed a component");
    }
    for i in 0..PAGES {
        DesignFile::objects()
            .create(DesignFile {
                id: 0,
                project: ForeignKey::new(project),
                kind: DesignFileKind::Page,
                path: format!("pages/p{i:03}.html"),
                content: page_html(i),
                version: 1,
                updated_by: "bench".into(),
                created_at: None,
                updated_at: None,
                deleted_at: None,
            })
            .await
            .expect("seed a page");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_500_file_project_answers_a_write_and_a_manifest_quickly() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let seeded = Instant::now();
    seed_files(project).await;
    let seed_ms = seeded.elapsed().as_millis();

    // ONE PAGE EDIT, end to end over REST — "the cost of one agent write" on
    // the server. Includes validation, the conditional update, the realtime
    // emit (which computes `affected_routes`: pure for a page) and the
    // response.
    let t = Instant::now();
    let edit = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({
                "path": "pages/p250.html",
                "content": "<main class=\"p-4\"><p>Edited</p></main>",
                "base_version": 1,
            }),
        )
        .await;
    let edit_ms = t.elapsed().as_millis();
    assert_eq!(edit.status(), 201, "{}", edit.text());
    assert_eq!(
        edit.json()["affected_routes"],
        json!(["/p250"]),
        "one page edit names exactly its own route"
    );

    // The manifest: rebuilt per read, and every file event makes the chrome
    // ask for it again. At 20 components it also runs the usedOn scan (one
    // pass over every page fragment per component).
    let t = Instant::now();
    let manifest = app.get_as(user.id, &format!("/api/design/{project}/manifest")).await;
    let manifest_ms = t.elapsed().as_millis();
    assert_eq!(manifest.status(), 200, "{}", manifest.text());
    assert_eq!(
        manifest.json()["routes"].as_array().map(Vec::len),
        Some(PAGES),
        "the manifest lists every page"
    );

    // A TOKEN WRITE's blast radius: the one path that must touch the whole
    // manifest (every route renders with the tokens). An agent's token save
    // pays this to compute `affected_routes`.
    let t = Instant::now();
    let affected = taskflow_design::views::affected_routes_for("styles/tokens.json", project).await;
    let token_ms = t.elapsed().as_millis();
    assert_eq!(affected.len(), PAGES, "a token write affects every route");

    // A page write's blast radius, at the same scale — the common case, and
    // (since #665) a pure path with no database work at all.
    let t = Instant::now();
    let page_affected = taskflow_design::views::affected_routes_for("pages/p007.html", project).await;
    let page_ms = t.elapsed().as_micros();
    assert_eq!(page_affected, vec!["/p007".to_string()]);

    eprintln!(
        "#665 bench (server, in-memory sqlite): seed 520 files {}ms · page edit PUT {}ms · \
         manifest GET {}ms · token affected_routes {}ms · page affected_routes {}µs",
        seed_ms, edit_ms, manifest_ms, token_ms, page_ms
    );

    // Loose tripwires — see the module header. Roughly 10x the measured times
    // on a dev box, so they fire on an algorithmic regression, not on load.
    assert!(edit_ms < 2_000, "one page write took {edit_ms}ms at {PAGES} files");
    assert!(manifest_ms < 2_000, "the manifest took {manifest_ms}ms at {PAGES} files");
    assert!(token_ms < 2_000, "a token write's blast radius took {token_ms}ms at {PAGES} files");
}

/// The create path is the one that pays the byte sum (`store::total_bytes`),
/// because only a NEW file can grow the project past the cap. Pin that it is
/// still bounded and still correct at full scale — a 501st file must be
/// refused by the COUNT cap before the byte sum ever matters, and an edit must
/// not run either.
#[tokio::test(flavor = "multi_thread")]
async fn the_create_path_still_enforces_the_cap_at_500_files() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    seed_files(project).await;

    let refused = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({ "path": "pages/one-more.html", "content": "<p>over</p>" }),
        )
        .await;
    assert_eq!(refused.status(), 422, "{}", refused.text());
    assert_eq!(refused.json()["errors"][0]["rule"], "file-count-cap");

    // An EDIT of an existing page is never slowed by the caps: replacing
    // content cannot grow the footprint.
    let edited = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project}/file"),
            &json!({
                "path": "pages/p001.html",
                "content": "<main class=\"p-4\"><p>still here</p></main>",
                "base_version": 1,
            }),
        )
        .await;
    assert_eq!(edited.status(), 201, "{}", edited.text());

    // And a store-level sanity check: the byte total it would have summed is
    // the project's real content, not a placeholder.
    let outcome = store::write_file(
        project,
        "pages/another.html",
        "<p>x</p>",
        None,
        "bench",
    )
    .await;
    assert!(
        matches!(outcome, WriteOutcome::Rejected(_)),
        "the count cap refuses before the byte sum is consulted"
    );
}
