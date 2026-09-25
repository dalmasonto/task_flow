use taskflow_design::composer;
use taskflow_design::resources::{
    enabled_links, parse, to_json_string, validate, ResourcesDoc, ResourceLink, ResourceSet,
    ALLOWED_REL, MAX_HREF, MAX_LINKS_PER_SET, MAX_SETS, RESOURCES_PATH,
};
use std::collections::HashMap;

mod support;

fn link(rel: &str, href: &str) -> ResourceLink {
    ResourceLink { rel: Some(rel.into()), href: Some(href.into()), crossorigin: false,
                   script: None, is_script: false, is_async: false }
}

fn doc(sets: Vec<ResourceSet>) -> ResourcesDoc {
    ResourcesDoc { version: 1, sets }
}

fn set(name: &str, links: Vec<ResourceLink>) -> ResourceSet {
    ResourceSet { id: format!("set_{name}"), name: name.into(), enabled: true, links }
}

#[test]
fn round_trips() {
    let d = doc(vec![set("Inter", vec![link("stylesheet", "https://fonts.googleapis.com/css2?family=Inter")])]);
    assert_eq!(parse(&to_json_string(&d)).unwrap(), d);
}

#[test]
fn accepts_the_google_fonts_triple() {
    let d = doc(vec![set("Inter", vec![
        link("preconnect", "https://fonts.googleapis.com"),
        ResourceLink { crossorigin: true, ..link("preconnect", "https://fonts.gstatic.com") },
        link("stylesheet", "https://fonts.googleapis.com/css2?family=Inter&display=swap"),
    ])]);
    assert!(validate(d).is_ok());
}

#[test]
fn refuses_dangerous_schemes_in_every_spelling() {
    // Review Focus #1. Case and whitespace must not be a bypass.
    for bad in [
        "javascript:alert(1)", "JaVaScRiPt:alert(1)", "  javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>", "DATA:text/html,x",
        "http://fonts.googleapis.com/css",            // not https
        "//fonts.googleapis.com/css",                 // scheme-relative
        "/local/thing.css",                           // not absolute
        // Unicode whitespace: `str::trim` strips these, a URL parser does not,
        // so trimming them here would hand the browser a value with no scheme
        // that it resolves as a RELATIVE url — the bare-path case by another
        // name. The strip must be C0-or-space only, as the parser's is.
        "\u{a0}https://ok.example/x",
        "\u{3000}https://ok.example/x",
    ] {
        let d = doc(vec![set("Bad", vec![link("stylesheet", bad)])]);
        assert!(validate(d).is_err(), "should refuse: {bad}");
    }
}

#[test]
fn refuses_a_url_containing_a_nul() {
    // The one character the strip above cannot cover. The HTML tokenizer
    // rewrites U+0000 to U+FFFD before any URL parsing happens, and U+FFFD is
    // neither a C0 control nor a space, so it is not stripped: a leading NUL
    // would leave the browser with a value that has no scheme, resolved as a
    // RELATIVE url — https-looking in the document, not https in the browser.
    // Refused wherever it appears, not merely un-stripped, because an interior
    // NUL mangles the address just as silently.
    for bad in [
        "\u{0}https://ok.example/x",
        "https://ok.example/x\u{0}",
        "https://ok.example/\u{0}x",
    ] {
        let d = doc(vec![set("Bad", vec![link("stylesheet", bad)])]);
        assert!(validate(d).is_err(), "should refuse a url containing U+0000: {bad:?}");
    }
}

#[test]
fn refuses_a_script_with_a_dangerous_scheme() {
    let mut l = link("stylesheet", "https://ok.example/x.js");
    l.is_script = true;
    l.rel = None;
    l.script = Some("javascript:alert(1)".into());
    assert!(validate(doc(vec![set("X", vec![l])])).is_err());
}

#[test]
fn refuses_a_link_that_carries_both_url_fields() {
    // `is_script` decides which field IS the url, so a link holding both
    // strands the unchecked one beside a checked one — same url, two readers,
    // one of them not looking. One shape, one url field.
    let mut both = link("stylesheet", "https://ok.example/x");
    both.is_script = true;
    both.script = Some("https://ok.example/x.js".into());
    assert!(validate(doc(vec![set("X", vec![both.clone()])])).is_err());

    // Dangerous beside safe is refused by the shape, before any scheme runs.
    let mut sneaky = link("stylesheet", "javascript:alert(1)");
    sneaky.script = Some("https://ok.example/x.js".into());
    assert!(validate(doc(vec![set("X", vec![sneaky])])).is_err());

    // And the honest script shape — script only — still passes, so the rule
    // above is about the ambiguity and not about scripts.
    both.href = None;
    assert!(validate(doc(vec![set("X", vec![both])])).is_ok());
}

#[test]
fn refuses_rel_outside_the_allowlist() {
    let d = doc(vec![set("X", vec![link("import", "https://ok.example/x")])]);
    assert!(validate(d).is_err());
    for rel in ALLOWED_REL {
        let d = doc(vec![set("X", vec![link(rel, "https://ok.example/x")])]);
        assert!(validate(d).is_ok(), "{rel} should be allowed");
    }
}

#[test]
fn refuses_preload_because_without_an_as_attribute_it_fetches_nothing() {
    // `preload` used to be in the allowlist. It is not any more: `ResourceLink`
    // has no `as` field, and per HTML a preload without one does not fetch, so
    // the entry bought a `<link>` that sat in the DOM doing nothing — the same
    // silent no-op this phase exists to remove from the CSP. Every entry that
    // stays must be useful on its own.
    let d = doc(vec![set("X", vec![link("preload", "https://ok.example/font.woff2")])]);
    let err = validate(d).expect_err("a preload link fetches nothing and must be refused");

    // The refusal has to be actionable: a user who configured this cannot fix
    // it unless the message names the rel refused AND what is accepted. The
    // accepted list is enumerated from `ALLOWED_REL`, so it cannot drift from
    // the constant it describes.
    assert!(err.contains("preload"), "the refusal must name the rel it refused: {err}");
    for rel in ALLOWED_REL {
        assert!(err.contains(rel), "the refusal must offer {rel} as an alternative: {err}");
    }
}

#[test]
fn refuses_over_long_hrefs_caps_and_duplicate_names() {
    let long = format!("https://ok.example/{}", "x".repeat(MAX_HREF));
    assert!(validate(doc(vec![set("X", vec![link("stylesheet", &long)])])).is_err());

    let many: Vec<ResourceSet> = (0..=MAX_SETS)
        .map(|i| set(&format!("S{i}"), vec![])) // distinct names
        .collect();
    assert!(validate(doc(many)).is_err());

    let too_many_links = vec![link("stylesheet", "https://ok.example/x"); MAX_LINKS_PER_SET + 1];
    assert!(validate(doc(vec![set("X", too_many_links)])).is_err());

    let dupes = vec![set("Same", vec![]), set("same", vec![])];
    assert!(validate(doc(dupes)).is_err());
}

#[test]
fn refuses_duplicate_set_ids() {
    // Distinct names, one id. The name check alone passes this, but the id is
    // what the editor keys a toggle by, so a duplicate makes one switch flip
    // two rows — the document has no stable address for either set.
    let a = ResourceSet { id: "set_same".into(), name: "One".into(), enabled: true, links: vec![] };
    let b = ResourceSet { id: "set_same".into(), name: "Two".into(), enabled: true, links: vec![] };
    assert!(validate(doc(vec![a, b])).is_err());
}

#[test]
fn enabled_links_skips_disabled_sets_and_keeps_order() {
    let mut off = set("Off", vec![link("stylesheet", "https://off.example/x")]);
    off.enabled = false;
    let d = doc(vec![off, set("On", vec![link("stylesheet", "https://on.example/x")])]);
    let out = enabled_links(&d);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].1.href.as_deref(), Some("https://on.example/x"));
}

#[test]
fn garbage_is_an_error_not_a_panic() {
    assert!(parse("not json").is_err());
    assert!(parse(r#"{"sets":"nope"}"#).is_err());
    assert!(parse(r#"{"version":1}"#).is_ok()); // sets defaults to empty
}

#[test]
fn an_empty_document_is_valid_and_emits_nothing() {
    let d = validate(doc(vec![])).unwrap();
    assert!(enabled_links(&d).is_empty());
}

// ---------------------------------------------------------------------------
// Emission — the composer half of the feature: what the manifest's enabled
// links become in the document head, and what the sandbox CSP lets them load.
// ---------------------------------------------------------------------------

fn lk(rel: &str, href: &str) -> ResourceLink {
    ResourceLink { rel: Some(rel.into()), href: Some(href.into()), crossorigin: false,
                   script: None, is_script: false, is_async: false }
}
fn sc(src: &str) -> ResourceLink {
    ResourceLink { rel: None, href: None, crossorigin: false,
                   script: Some(src.into()), is_script: true, is_async: true }
}

#[test]
fn enabled_resource_links_are_emitted_in_document_order() {
    // Review Focus: the Google Fonts triple, in the order the user pasted it.
    let links = vec![
        (false, lk("preconnect", "https://fonts.googleapis.com")),
        (false, lk("stylesheet", "https://fonts.googleapis.com/css2?family=Inter&display=swap")),
        (true, sc("https://cdn.example/x.js")),
    ];
    let tags = composer::resources_tags(&links);
    let pre = tags.find("preconnect").expect("preconnect emitted");
    let sheet = tags.find("stylesheet").expect("stylesheet emitted");
    let js = tags.find("cdn.example").expect("script emitted");
    assert!(pre < sheet && sheet < js, "order must be preserved: {tags}");
    assert!(tags.contains("async"), "async is carried through: {tags}");
    assert!(!tags.contains("crossorigin"), "not set on these links: {tags}");
}

#[test]
fn crossorigin_is_emitted_when_set() {
    let mut l = lk("preconnect", "https://fonts.gstatic.com");
    l.crossorigin = true;
    assert!(composer::resources_tags(&[(false, l)]).contains("crossorigin"));
}

#[test]
fn an_empty_resource_list_emits_nothing() {
    // Review Focus #2: absent document, or every set disabled, is the normal
    // case for most projects and must produce no markup at all.
    assert_eq!(composer::resources_tags(&[]), "");
}

#[test]
fn an_attribute_breaking_url_is_escaped_not_executed() {
    // `validate` accepts this by design — a URL is opaque to it — so the EMIT
    // path is the only thing standing between it and execution, now that
    // `script-src` allows any https origin.
    let nasty = "https://ok.example/x\" onload=\"alert(1)";
    let tags = composer::resources_tags(&[(false, lk("stylesheet", nasty))]);
    assert!(!tags.contains("\" onload="), "attribute escaped: {tags}");
    assert!(tags.contains("&quot;") || tags.contains("&#34;"), "quote encoded: {tags}");
}

// The scheme refusal is deliberately NOT tested here. It lives in
// `resources::validate`, and Step 3 runs `validate` before `enabled_links`, so
// the emitter never receives a refused link. The emitter ESCAPES; it does not
// FILTER — a test that handed it a hand-built `javascript:` row would assert a
// property this design does not promise, and would pass whatever the emitter
// did, because a `javascript:` URL interpolated into `href` is perfectly
// well-escaped HTML. The property that actually protects the page is
// end-to-end — a document carrying a dangerous scheme emits nothing — and it is
// pinned in `src/manifest.rs`'s test module, where a two-file fixture costs
// three lines (the tests are in Step 3 below).

#[test]
fn the_sandbox_csp_allows_https_but_never_widens_dangerously() {
    let csp = composer::sandbox_csp("token");
    for directive in ["script-src", "style-src", "font-src"] {
        assert!(csp.contains(directive), "missing {directive}: {csp}");
    }
    assert!(csp.contains("https:"), "external fonts cannot load without it: {csp}");
    assert!(!csp.contains("http://"), "plain http must not be allowed: {csp}");
    assert!(!csp.contains("'unsafe-eval'"), "eval is never granted: {csp}");
}

#[test]
fn the_widening_reaches_the_three_fetch_directives_and_stops_there() {
    // The test above passes BOTH before and after the widening: `https:` is
    // already in the CSP via `https://cdn.jsdelivr.net`, so it cannot see the
    // change at all, and it would equally pass if `connect-src` had been
    // widened by mistake. This one pins the boundary in both directions — the
    // three directives that must carry a scheme source, and the four that must
    // not move.
    let csp = composer::sandbox_csp("token");
    let directives: HashMap<&str, &str> = csp
        .split(';')
        .filter_map(|part| part.trim().split_once(' '))
        .map(|(name, value)| (name, value.trim()))
        .collect();

    for directive in ["script-src", "style-src", "font-src"] {
        let value = directives.get(directive).copied().unwrap_or_default();
        assert!(
            value.split_whitespace().any(|src| src == "https:"),
            "{directive} must allow any https origin for a webfont to load: {csp}"
        );
        assert!(
            value.split_whitespace().any(|src| src == "https://cdn.jsdelivr.net"),
            "{directive} must keep the jsdelivr origin it already had: {csp}"
        );
    }

    // Unchanged, and asserted as values rather than as substrings so a widened
    // `connect-src` (which would let agent-authored JS POST the operator's
    // localhost and intranet anywhere) cannot slip through.
    assert_eq!(directives.get("default-src").copied(), Some("'self'"));
    assert_eq!(directives.get("img-src").copied(), Some("'self' data: blob:"));
    assert_eq!(directives.get("connect-src").copied(), Some("'self' https://cdn.jsdelivr.net"));
    assert_eq!(directives.get("form-action").copied(), Some("'none'"));
    assert_eq!(directives.get("base-uri").copied(), Some("'none'"));
    assert_eq!(directives.get("frame-ancestors").copied(), Some("*"));
}

// ---------------------------------------------------------------------------
// Wiring — the CALL SITES. Everything above tests the emitter and the manifest
// in isolation, which means the feature could be plugged into neither composed
// document and every one of those tests would still pass: exactly the seam
// where a mistake looks like every neighbouring unit passing. The task promises
// the links reach "every composed page and the downloaded page.html", so that
// promise is pinned where it is made — through the real write path, on both
// documents.
// ---------------------------------------------------------------------------

const SEEDED_RESOURCES: &str = r#"{"version":1,"sets":[
    {"id":"on","name":"Inter","enabled":true,"links":[
        {"rel":"preconnect","href":"https://fonts.googleapis.com"},
        {"rel":"stylesheet","href":"https://fonts.googleapis.com/css2?family=Inter&display=swap"}]},
    {"id":"off","name":"Off","enabled":false,"links":[
        {"rel":"stylesheet","href":"https://example.com/disabled.css"}]}
]}"#;

#[tokio::test(flavor = "multi_thread")]
async fn enabled_links_reach_both_the_composed_page_and_the_download() {
    let app = support::TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;

    for (path, content) in [
        // No custom elements: this project registers no components, and the
        // page validator refuses `<app-header>` until one is.
        ("pages/index.html", "<main class=\"p-4\"><h1>Resources</h1></main>".to_string()),
        (RESOURCES_PATH, SEEDED_RESOURCES.to_string()),
    ] {
        let res = app
            .put_json_as(
                user.id,
                &format!("/api/design/{project_id}/file"),
                &serde_json::json!({ "path": path, "content": content }),
            )
            .await;
        assert_eq!(res.status(), 201, "seed write of {path} failed: {}", res.text());
    }

    let token = taskflow_design::sandbox::mint(project_id);
    let html = app.get_sandbox(&format!("/s/{token}/")).await.text();

    let preconnect = "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">";
    // The url's `&` is escaped to `&amp;` in the attribute, which the browser
    // decodes straight back to `&` — the font still loads, and a quote in a url
    // has nowhere to break out to.
    let stylesheet = "<link rel=\"stylesheet\" \
                      href=\"https://fonts.googleapis.com/css2?family=Inter&amp;display=swap\">";
    assert!(html.contains(preconnect), "enabled preconnect missing from the page: {html}");
    assert!(html.contains(stylesheet), "enabled stylesheet missing from the page: {html}");
    assert!(
        !html.contains("disabled.css"),
        "a disabled set must contribute nothing: {html}"
    );
    assert!(
        html.find(preconnect).expect("preconnect") < html.find("f/styles/tokens.css").expect("tokens link"),
        "resource links must precede the page's own stylesheet, so a page can override a webfont"
    );

    let export = app
        .get_as(user.id, &format!("/api/design/{project_id}/page.html?route=/"))
        .await;
    assert_eq!(export.status(), 200, "export failed: {}", export.text());
    let downloaded = export.text();
    assert!(
        downloaded.contains(stylesheet),
        "the download must carry the font too, or the type silently changes: {downloaded}"
    );
    assert!(!downloaded.contains("disabled.css"), "{downloaded}");

    // Same placement rule in the second document. The sandbox half pins it
    // against the `f/styles/tokens.css` LINK; the export INLINES the tokens
    // CSS instead, so the marker here is the `<style>` element that carries it.
    // Without this, moving `{resource_tags}` after the tokens block in
    // `compose_export_document` would leave every test passing.
    let resource_at = downloaded
        .find(preconnect)
        .expect("the download must carry the preconnect too");
    let tokens_at = downloaded
        .find("<style>")
        .expect("the export inlines the generated tokens stylesheet");
    assert!(
        resource_at < tokens_at,
        "in page.html the resource tags must come BEFORE the inlined tokens stylesheet \
         (resources at {resource_at}, tokens stylesheet at {tokens_at}), as they do in the \
         sandbox head — placing them after it silently stops a page overriding a webfont: \
         {downloaded}"
    );
}
