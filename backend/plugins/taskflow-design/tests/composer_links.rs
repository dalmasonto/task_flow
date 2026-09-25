//! In-device navigation: which hrefs the composer rewrites into sandbox URLs.
//!
//! Every test here goes through [`composer::compose_body_fragment`] — the
//! function `compose_document` actually calls to build a served page — and not
//! through the private helper it delegates to. That is deliberate: this whole
//! task exists because a rewrite rule that is correct but wired nowhere passes
//! its own unit tests while the served page keeps the old behaviour. A test of
//! the private helper could not tell those two apart.
//!
//! The mechanism itself is old: `<a href="/settings">` has become
//! `/s/{token}/settings` since an earlier phase, so a click inside the frame is
//! a real navigation, the frame has its own session history, and back/forward —
//! and an agent-written `history.back()` — work with nothing further built.
//! What these tests pin down is the rule AROUND that: which hrefs qualify.

use taskflow_design::composer;

fn routes() -> Vec<String> {
    ["/", "/app", "/settings"].iter().map(|r| r.to_string()).collect()
}

/// Compose through the REAL pipeline. It also stamps `data-src` and expands
/// `<ui-*>` primitives, so assert containment, never whole-string equality.
fn body(fragment: &str) -> String {
    composer::compose_body_fragment("tok", "pages/index.html", fragment, &routes())
}

#[test]
fn a_link_to_a_known_route_becomes_a_sandbox_url() {
    let out = body(r#"<a href="/app" class="btn">Open</a>"#);
    assert!(out.contains(r#"href="/s/tok/app""#), "{out}");
    assert!(out.contains(r#"class="btn""#), "other attributes survive: {out}");
}

#[test]
fn the_root_route_maps_to_the_bare_sandbox_url() {
    // The client's `sandboxUrl` drops the path for "/" (`design-api.ts:18`) and
    // the server serves BOTH `/s/{token}` and `/s/{token}/` (`views.rs:808-812`),
    // so assert the exact form: `/s/tok/` CONTAINS `/s/tok`, and a `contains` on
    // the bare form alone would pin nothing.
    let out = body(r#"<a href="/">Home</a>"#);
    assert!(out.contains(r#"href="/s/tok""#), "{out}");
    assert!(!out.contains(r#"href="/s/tok/""#), "must be the bare form: {out}");
}

#[test]
fn hrefs_that_are_not_pages_are_left_alone() {
    // Each of these is broken by today's pass — `mailto:`/`tel:` worst of all.
    for (html, expected) in [
        (r#"<a href="https://example.com/x">ext</a>"#, r#"href="https://example.com/x""#),
        (r#"<a href="//cdn.example/x">proto-relative</a>"#, r#"href="//cdn.example/x""#),
        (r#"<a href="mailto:a@b.c">mail</a>"#, r#"href="mailto:a@b.c""#),
        (r#"<a href="tel:+1">tel</a>"#, r#"href="tel:+1""#),
        // `r##` not `r#`: the fragment itself contains the `"#` sequence
        // (`href="#section"`), which would close a single-hash raw string.
        (r##"<a href="#section">anchor</a>"##, r##"href="#section""##),
        (r#"<a href="/not-a-page">not a page</a>"#, r#"href="/not-a-page""#),
        (r#"<a href="app">relative</a>"#, r#"href="app""#),
    ] {
        let out = body(html);
        assert!(out.contains(expected), "must be untouched: {html} gave {out}");
    }
}

#[test]
fn a_new_tab_link_is_left_alone() {
    let out = body(r#"<a href="/app" target="_blank">Open</a>"#);
    assert!(out.contains(r#"href="/app""#), "{out}");
}

#[test]
fn several_links_in_one_fragment_are_all_rewritten() {
    let out = body(r#"<a href="/app">a</a><a href="/settings">b</a><a href="https://x.example">c</a>"#);
    assert_eq!(out.matches("/s/tok/").count(), 2, "{out}");
}

#[test]
fn a_href_left_alone_keeps_exactly_one_closing_quote() {
    // "Left alone" has to mean BYTE-identical, which is more than `contains`
    // can tell: the walk re-emitted every href's closing quote, so even a href
    // it meant to leave untouched came out as `href="mailto:a@b.c""` and the
    // served markup carried a stray attribute literally named `"`. After the
    // href's own closing quote must come the space before the `data-src` the
    // next pass stamps — never a second quote.
    for (html, expected) in [
        (r#"<a href="mailto:a@b.c">mail</a>"#, r#"<a href="mailto:a@b.c" "#),
        (r#"<a href="tel:+1">tel</a>"#, r#"<a href="tel:+1" "#),
        (r##"<a href="#section">anchor</a>"##, r##"<a href="#section" "##),
        (r#"<a href="/not-a-page">nope</a>"#, r#"<a href="/not-a-page" "#),
    ] {
        let out = body(html);
        assert!(out.contains(expected), "{html} gave {out}");
        assert!(!out.contains("\"\""), "stray duplicate quote: {html} gave {out}");
    }
}
