use taskflow_design::resources::{
    enabled_links, parse, to_json_string, validate, ResourcesDoc, ResourceLink, ResourceSet,
    ALLOWED_REL, MAX_HREF, MAX_LINKS_PER_SET, MAX_SETS,
};

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
