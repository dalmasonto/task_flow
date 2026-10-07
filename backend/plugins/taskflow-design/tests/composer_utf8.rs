//! #633: literal non-ASCII text in a page's HTML must reach the served
//! document byte-for-byte. `annotate_sources` used to copy every text byte as
//! `bytes[i] as char`, re-encoding each UTF-8 continuation byte as its own
//! Latin-1 code point — "•" (E2 80 A2) came out as "â\u{80}¢", 🔥 as
//! "ð\u{9f}\u{94}¥". The sandbox document feeds the canvas, `design_screenshot`
//! and the image/PDF export, so all three showed mojibake.

mod support;

use support::TestApp;
use taskflow_design::composer;
use taskflow_design::manifest::DesignManifest;

const TEXT: &str = "• 🔥 é — “quoted” 日本";

fn manifest() -> DesignManifest {
    DesignManifest {
        project: 1,
        routes: vec![],
        components: vec![],
        tokens: vec![],
        revision: 1,
        resources: vec![],
        tokens_bridge: String::new(),
        themes: vec![],
    }
}

#[test]
fn annotate_sources_keeps_multibyte_text_intact() {
    let out = composer::annotate_sources(&format!("<p>{TEXT}</p>\n{TEXT}"), "pages/index.html");
    assert_eq!(out, format!(r#"<p data-src="pages/index.html:1">{TEXT}</p>"#) + "\n" + TEXT);
}

#[test]
fn multibyte_text_survives_attributes_and_a_trailing_fragment() {
    // Inside a start tag (copied as a slice) and as the very last bytes.
    let out = composer::annotate_sources(r#"<a title="• 🔥">é</a>🔥"#, "p.html");
    assert_eq!(out, r#"<a title="• 🔥" data-src="p.html:1">é</a>🔥"#);
}

#[test]
fn the_body_fragment_pipeline_keeps_multibyte_text_intact() {
    // Through rewrite_hrefs, annotate_sources and <ui-*> expansion together.
    let out = composer::compose_body_fragment(
        "tok",
        "/",
        "pages/index.html",
        &format!("<ul><li>{TEXT}</li></ul><ui-accordion title=\"🔥 é\">{TEXT}</ui-accordion>"),
        &["/".to_string()],
    );
    assert_eq!(out.matches(TEXT).count(), 2, "{out}");
    assert!(out.contains("🔥 é"), "{out}");
    assert!(!out.contains('\u{e2}') && !out.contains('\u{f0}'), "mojibake in {out}");
}

#[test]
fn the_sandbox_document_declares_utf8_first_and_keeps_the_text() {
    let html = composer::compose_document(
        "tok", &manifest(), "/", "pages/index.html", &format!("<p>{TEXT}</p>"), &[], "light", None,
    );
    assert!(html.contains(TEXT), "the literal text reaches the served document");
    let charset = html.find(r#"<meta charset="utf-8">"#).expect("a charset declaration");
    // The HTML spec only honours a <meta charset> within the first 1024 bytes.
    assert!(charset < 1024, "charset declared at byte {charset}, past the 1024-byte prescan");
}

#[test]
fn the_export_document_declares_utf8_first_and_keeps_the_text() {
    let html = composer::compose_export_document(
        "pages/index.html", &format!("<p>{TEXT}</p>"), "light", ":root{}", "", &[], &[],
    );
    assert!(html.contains(TEXT));
    let charset = html.find(r#"<meta charset="utf-8">"#).expect("a charset declaration");
    assert!(charset < 1024);
}

/// End to end over HTTP: the stored page, served as the sandbox document (what
/// the canvas iframe and the headless renderer load), as `page.html`, and as
/// the `fragment=1` body, keeps the literal text and says it is UTF-8.
#[tokio::test(flavor = "multi_thread")]
async fn every_served_form_of_a_page_keeps_literal_multibyte_text() {
    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;
    let res = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project_id}/file"),
            &serde_json::json!({ "path": "pages/index.html", "content": format!("<main><p>{TEXT}</p></main>") }),
        )
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());

    let token = taskflow_design::sandbox::mint(project_id);
    let sandbox = app.get_sandbox(&format!("/s/{token}/")).await;
    assert_eq!(sandbox.status(), 200);
    assert_eq!(sandbox.header("content-type").as_deref(), Some("text/html; charset=utf-8"));
    assert!(sandbox.text().contains(TEXT), "sandbox document: {}", sandbox.text());

    for q in ["", "&fragment=1"] {
        let res = app.get_as(user.id, &format!("/api/design/{project_id}/page.html?route=/{q}")).await;
        assert_eq!(res.status(), 200, "page.html{q}");
        assert_eq!(res.header("content-type").as_deref(), Some("text/html; charset=utf-8"), "page.html{q}");
        assert!(res.text().contains(TEXT), "page.html{q}: {}", res.text());
    }
}
