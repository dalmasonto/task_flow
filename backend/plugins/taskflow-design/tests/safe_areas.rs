//! #626: device safe areas. The composed page declares `--safe-top` and
//! `--safe-bottom` as 0px and nothing else: only the canvas's device frame
//! raises them, at runtime, by postMessage. So a frameless board, a
//! screenshot and a downloaded page.html render exactly as before.

mod support;

use serde_json::json;
use support::TestApp;
use taskflow_design::validation::validate_page_fragment;

/// Every value a `--safe-top:` / `--safe-bottom:` declaration in `html` sets.
fn safe_values(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    for name in ["--safe-top", "--safe-bottom"] {
        let mut rest = html;
        while let Some(i) = rest.find(name) {
            rest = &rest[i + name.len()..];
            if let Some(value) = rest.trim_start().strip_prefix(':') {
                out.push(value.split([';', '}']).next().unwrap_or("").trim().to_string());
            }
        }
    }
    out
}

const PAGE: &str = r#"<main><div class="bg-primary pt-[var(--safe-top)]" data-status-bar="light"><h1>Hi</h1></div><div class="fixed bottom-0 pb-[calc(0.75rem+var(--safe-bottom))]">Tabs</div></main>"#;

#[tokio::test(flavor = "multi_thread")]
async fn frameless_documents_declare_only_zero_safe_areas() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let res = app
        .put_json_as(user.id, &format!("/api/design/{project}/file"), &json!({ "path": "pages/index.html", "content": PAGE }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let token = taskflow_design::sandbox::mint(project);

    for query in ["", "?theme=dark"] {
        let html = app.get_sandbox(&format!("/s/{token}/{query}")).await.text();
        let values = safe_values(&html);
        assert_eq!(values, vec!["0px".to_string(), "0px".to_string()], "sandbox{query}: {values:?}");
        assert!(html.contains("design:status-bar"), "the sandbox page reports to the frame");
    }

    let export = app.get_as(user.id, &format!("/api/design/{project}/page.html?route=/")).await.text();
    assert_eq!(safe_values(&export), vec!["0px".to_string(), "0px".to_string()], "page.html");
    assert!(!export.contains("design:status-bar"), "page.html carries no runtime");
}

#[test]
fn a_page_padding_by_the_safe_areas_validates() {
    let v = validate_page_fragment("pages/index.html", PAGE, &[]);
    assert!(v.ok, "{:?}", v.errors);
}
