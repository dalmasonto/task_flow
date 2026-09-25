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
//!
//! Every assertion is WHOLE-STRING equality. An earlier version of this file
//! mandated `contains` instead, on the theory that the passes after the rewrite
//! (`data-src` stamping, `<ui-*>` expansion) made whole-string equality
//! impossible. They do not: the output is deterministic — one
//! `data-src="pages/settings.html:1"` per start tag, on line 1 for these
//! single-line fragments — and `contains` is what let a doubled closing quote
//! (`href="mailto:a@b.c""`) sit in the served markup through an entire green
//! suite. `assert_eq!` is the only shape that can see a rewrite which is right
//! in principle and one byte wrong in fact.

use taskflow_design::composer;

fn routes() -> Vec<String> {
    ["/", "/app", "/settings"].iter().map(|r| r.to_string()).collect()
}

/// The `data-src` every start tag in a one-line `pages/settings.html` fragment
/// is stamped with, and the same for `pages/index.html`. Spelled out once, so a
/// row can be read against the RULE rather than against the pipeline's
/// plumbing.
const SETTINGS_SRC: &str = r#" data-src="pages/settings.html:1""#;
const INDEX_SRC: &str = r#" data-src="pages/index.html:1""#;

/// The composed output of a fragment that must be left byte-identical: the
/// markup itself, with the one `data-src` stamp `annotate_sources` inserts
/// before the start tag's `>`. Exactness is the point — see the header.
fn stamped(markup: &str, src: &str) -> String {
    markup.replacen(">", &format!("{src}>"), 1)
}

/// Compose through the REAL pipeline, for a NON-ROOT page (`/settings`).
///
/// The route is not decoration: a RELATIVE href resolves differently on the
/// root page than on any other, so which page is being composed is part of the
/// input. See [`root_body`] and
/// `a_relative_href_is_rewritten_on_the_root_page_only`.
fn body(fragment: &str) -> String {
    composer::compose_body_fragment(
        "tok",
        "/settings",
        "pages/settings.html",
        fragment,
        &routes(),
    )
}

/// The same pipeline for the ROOT page (`/`) — the one page whose frame URL is
/// the bare `/s/tok`.
fn root_body(fragment: &str) -> String {
    composer::compose_body_fragment("tok", "/", "pages/index.html", fragment, &routes())
}

#[test]
fn a_link_to_a_known_route_becomes_a_sandbox_url() {
    assert_eq!(
        body(r#"<a href="/app" class="btn">Open</a>"#),
        stamped(r#"<a href="/s/tok/app" class="btn">Open</a>"#, SETTINGS_SRC)
    );
}

#[test]
fn the_root_route_maps_to_the_bare_sandbox_url() {
    // The client's `sandboxUrl` drops the path for "/" (`design-api.ts:23`), and
    // the server serves BOTH `/s/{token}` and `/s/{token}/` (`urls.rs:94-95`),
    // so the bare form has to be asserted NEGATIVELY as well: a `contains` for
    // `/s/tok` is satisfied by `/s/tok/` too, which is exactly the trap the
    // brief's fixture called out. The exact equality is what actually pins it.
    let out = body(r#"<a href="/">Home</a>"#);
    assert_eq!(out, stamped(r#"<a href="/s/tok">Home</a>"#, SETTINGS_SRC));
    assert!(!out.contains(r#"href="/s/tok/""#), "must be the bare form: {out}");
}

#[test]
fn hrefs_that_are_not_pages_are_left_alone() {
    // Byte-identity, for each of them, against the WHOLE composed string. Four
    // rows are here for their own reasons: `mailto:`/`tel:` are the links this
    // pass used to break outright; `#section` and `?tab=2` survive because an
    // empty PATH names no route; `/s/tok/app` is the idempotence guard; and the
    // last two carry an href that is not the first attribute and a legal empty
    // attribute value, because neither may disturb the walk.
    for (html, expected_markup) in [
        (r#"<a href="https://example.com/x">ext</a>"#, r#"<a href="https://example.com/x">ext</a>"#),
        (r#"<a href="//cdn.example/x">proto-relative</a>"#, r#"<a href="//cdn.example/x">proto-relative</a>"#),
        (r#"<a href="mailto:a@b.c">mail</a>"#, r#"<a href="mailto:a@b.c">mail</a>"#),
        (r#"<a href="tel:+1">tel</a>"#, r#"<a href="tel:+1">tel</a>"#),
        // `r##` not `r#`: the fragment itself contains the `"#` sequence
        // (`href="#section"`), which would close a single-hash raw string.
        (r##"<a href="#section">anchor</a>"##, r##"<a href="#section">anchor</a>"##),
        (r#"<a href="?tab=2">same page, new query</a>"#, r#"<a href="?tab=2">same page, new query</a>"#),
        (r#"<a href="/not-a-page">not a page</a>"#, r#"<a href="/not-a-page">not a page</a>"#),
        (r#"<a href="/s/tok/app">already tokenized</a>"#, r#"<a href="/s/tok/app">already tokenized</a>"#),
        (r#"<a href="app">relative</a>"#, r#"<a href="app">relative</a>"#),
        (r#"<a class="btn" href="/not-a-page">x</a>"#, r#"<a class="btn" href="/not-a-page">x</a>"#),
        (r#"<a href="/not-a-page" alt="">x</a>"#, r#"<a href="/not-a-page" alt="">x</a>"#),
    ] {
        assert_eq!(
            body(html),
            stamped(expected_markup, SETTINGS_SRC),
            "must be byte-identical: {html}"
        );
    }
}

#[test]
fn a_route_href_carrying_a_query_a_fragment_or_a_trailing_slash_is_rewritten() {
    // The route a link names is decided by its PATH; the query and the fragment
    // ride along with the rewrite. These all worked before the route-membership
    // rule — the older, blunter pass rewrote them — and stopped working when the
    // comparison became byte-exact against the href as written: they were left
    // to resolve on the sandbox origin's bare `/app`, which is not a sandbox
    // route, so a link that worked 404'd. They ARE reachable:
    // `/s/{token}/app?tab=2` and `/s/{token}/app#x` both serve (axum matches the
    // path, and a browser never sends the fragment), and so does the root's own
    // query form.
    for (html, expected_markup) in [
        (r#"<a href="/app?tab=2">Tabs</a>"#, r#"<a href="/s/tok/app?tab=2">Tabs</a>"#),
        (r#"<a href="/app#section">Jump</a>"#, r#"<a href="/s/tok/app#section">Jump</a>"#),
        (r#"<a href="/app/?tab=2">Dir, queried</a>"#, r#"<a href="/s/tok/app?tab=2">Dir, queried</a>"#),
        // A trailing slash is NOT part of a route path here. Only the ROOT is
        // registered in both shapes; for a child route `/s/{token}/app/` 404s
        // where `/s/{token}/app` serves, so the rewrite emits the route's own
        // slashless spelling rather than appending `/app/` verbatim and moving
        // the 404 inside the namespace.
        (r#"<a href="/app/">Dir</a>"#, r#"<a href="/s/tok/app">Dir</a>"#),
        // The root route keeps the bare base, and a query on it still serves.
        (r#"<a href="/?tab=2">Home, queried</a>"#, r#"<a href="/s/tok?tab=2">Home, queried</a>"#),
        (r##"<a href="/#section">Home, anchored</a>"##, r##"<a href="/s/tok#section">Home, anchored</a>"##),
        // Membership still governs: a query cannot smuggle an unknown path in.
        (r#"<a href="/not-a-page?tab=2">nope</a>"#, r#"<a href="/not-a-page?tab=2">nope</a>"#),
    ] {
        assert_eq!(body(html), stamped(expected_markup, SETTINGS_SRC), "{html}");
    }
}

#[test]
fn a_relative_href_is_rewritten_on_the_root_page_only() {
    // The brief's premise — "a relative href already resolves correctly inside
    // the frame, so it needs no help" — holds for every route EXCEPT the root.
    // The root frame's document URL is the bare `/s/{token}`, with no trailing
    // slash (`serve_page_root` is registered without one and the request is
    // served, not redirected), so a browser resolves `href="app"` against `/s/`
    // and lands on `/s/app`: a 404, and outside the project's namespace. On
    // `/s/{token}/settings` the same href lands on `/s/{token}/app` by itself,
    // which is why nothing is done to it there.
    //
    // The asymmetry is the point — same href, two pages, two different
    // resolutions — and it is pinned here rather than left to be rediscovered.
    assert_eq!(
        root_body(r#"<a href="app">app</a>"#),
        stamped(r#"<a href="/s/tok/app">app</a>"#, INDEX_SRC)
    );
    assert_eq!(
        body(r#"<a href="app">app</a>"#),
        stamped(r#"<a href="app">app</a>"#, SETTINGS_SRC)
    );

    // A relative href that names no route is still left alone on the root: the
    // root branch widens WHICH hrefs are considered, not which paths qualify.
    assert_eq!(
        root_body(r#"<a href="not-a-page">nope</a>"#),
        stamped(r#"<a href="not-a-page">nope</a>"#, INDEX_SRC)
    );

    // Query and fragment ride along on the relative form too.
    assert_eq!(
        root_body(r#"<a href="app?tab=2">tabs</a>"#),
        stamped(r#"<a href="/s/tok/app?tab=2">tabs</a>"#, INDEX_SRC)
    );

    // ... while these name the CURRENT page, not another route: a bare query or
    // fragment resolves against the document's own URL and must never be
    // prefixed, on the root page or anywhere else. `mailto:` is here because a
    // relative href is the one shape that could have swallowed it.
    for html in [
        r#"<a href="?tab=2">query only</a>"#,
        r##"<a href="#section">fragment only</a>"##,
        r#"<a href="mailto:a@b.c">mail</a>"#,
    ] {
        assert_eq!(
            root_body(html),
            stamped(html, INDEX_SRC),
            "must be left alone on the root page too: {html}"
        );
    }
}

#[test]
fn a_new_tab_link_is_left_alone_however_it_is_spelled() {
    // Every row below is legal HTML for the same instruction. The attribute
    // name is case-insensitive, whitespace may surround the `=`, and the value
    // may be double-quoted, single-quoted or BARE — a fixed
    // `target="_blank"` substring missed the last three and silently hijacked
    // those links into the frame.
    for html in [
        r#"<a href="/app" target="_blank">Open</a>"#,
        r#"<a href="/app" target='_blank'>Open</a>"#,
        r#"<a href="/app" target=_blank>Open</a>"#,
        r#"<a href="/app" target ="_blank">Open</a>"#,
        r#"<a href="/app" target = '_blank'>Open</a>"#,
        r#"<a href="/app" TARGET="_blank">Open</a>"#,
        r#"<a href="/app" target="_BLANK">Open</a>"#,
    ] {
        assert_eq!(body(html), stamped(html, SETTINGS_SRC), "{html}");
    }

    // ... and the near misses are near misses: a DIFFERENT attribute whose name
    // merely ends in `target`, and a target that is not `_blank`, both leave the
    // link to be rewritten like any other.
    for (html, expected_markup) in [
        (r#"<a href="/app" data-target="_blank">x</a>"#, r#"<a href="/s/tok/app" data-target="_blank">x</a>"#),
        (r#"<a href="/app" target="_self">x</a>"#, r#"<a href="/s/tok/app" target="_self">x</a>"#),
        (r#"<a href="/app" target="_blankish">x</a>"#, r#"<a href="/s/tok/app" target="_blankish">x</a>"#),
    ] {
        assert_eq!(body(html), stamped(expected_markup, SETTINGS_SRC), "{html}");
    }
}

#[test]
fn several_links_in_one_fragment_are_all_rewritten() {
    // Whole-string: the walk resumes after each href's own closing quote, so
    // each of the three links is composed exactly once, and the link that must
    // not be touched is untouched.
    assert_eq!(
        body(r#"<a href="/app">a</a><a href="/settings">b</a><a href="https://x.example">c</a>"#),
        format!(
            r#"<a href="/s/tok/app"{SETTINGS_SRC}>a</a><a href="/s/tok/settings"{SETTINGS_SRC}>b</a><a href="https://x.example"{SETTINGS_SRC}>c</a>"#
        )
    );
}

#[test]
fn a_href_left_alone_keeps_exactly_one_closing_quote() {
    // "Left alone" has to mean BYTE-identical, which is more than `contains`
    // can tell: the walk once re-emitted every href's closing quote, so even a
    // href it meant to leave untouched came out as `href="mailto:a@b.c""`, and
    // the served markup carried a stray attribute literally named `"`.
    //
    // This test used to assert `!out.contains("\"\"")` for that. It does not
    // any more, deliberately: the check is blunt enough to false-fail on any
    // legitimate empty attribute value — which the last two rows carry, in both
    // positions — while exact equality catches the doubled quote AND everything
    // else.
    for (html, expected_markup) in [
        (r#"<a href="mailto:a@b.c">mail</a>"#, r#"<a href="mailto:a@b.c">mail</a>"#),
        (r#"<a href="tel:+1">tel</a>"#, r#"<a href="tel:+1">tel</a>"#),
        (r##"<a href="#section">anchor</a>"##, r##"<a href="#section">anchor</a>"##),
        (r#"<a href="/not-a-page">nope</a>"#, r#"<a href="/not-a-page">nope</a>"#),
        (r#"<a href="/not-a-page" alt="">empty value</a>"#, r#"<a href="/not-a-page" alt="">empty value</a>"#),
        (r#"<a class="" href="/not-a-page">empty value first</a>"#, r#"<a class="" href="/not-a-page">empty value first</a>"#),
    ] {
        assert_eq!(body(html), stamped(expected_markup, SETTINGS_SRC), "{html}");
    }
}
