use taskflow_design::validation::{find_palette_class, validate_component, validate_page_fragment};

#[test]
fn finds_palette_classes_with_variants_and_opacity() {
    for (html, want) in [
        (r#"<div class="p-4 bg-blue-500">"#, "bg-blue-500"),
        (r#"<a class="hover:bg-blue-600">"#, "hover:bg-blue-600"),
        (r#"<p class="dark:text-zinc-400/80">"#, "dark:text-zinc-400/80"),
        (r#"<div class="md:border-red-200">"#, "md:border-red-200"),
        (r#"<div class="ring-offset-slate-50">"#, "ring-offset-slate-50"),
        (r#"<div class="from-emerald-400 to-teal-500">"#, "from-emerald-400"),
    ] {
        assert_eq!(find_palette_class(html).map(|(c, _)| c), Some(want.to_string()), "{html}");
    }
}

#[test]
fn accepts_semantic_and_neutral_words() {
    for html in [
        r#"<div class="bg-primary text-primary-foreground border-border rounded-lg">"#,
        r#"<div class="bg-black/50 text-white bg-transparent text-current">"#,
        r#"<div class="bg-[var(--brand)] text-muted-foreground">"#,
        r#"<p>the blue-500 line and text-sky are words</p>"#,
        r#"<div class="text-sm font-medium p-4 gap-2">"#,
    ] {
        assert_eq!(find_palette_class(html), None, "{html}");
    }
}

#[test]
fn page_write_rejects_with_semantic_suggestion() {
    let v = validate_page_fragment("pages/index.html", r#"<main class="bg-blue-500 text-white">x</main>"#, &[]);
    let err = v.errors.first().expect("rejected");
    assert_eq!(err.rule, "palette-color");
    assert_eq!(err.found.as_deref(), Some("bg-blue-500"));
    assert!(err.suggest.as_deref().unwrap().contains("bg-primary"));
}

#[test]
fn component_write_rejects_too() {
    let js = "class X extends HTMLElement { connectedCallback(){ this.innerHTML = '<p class=\"text-zinc-500\">x</p>' } } customElements.define('x-y', X)";
    let v = validate_component("components/x-y.js", js);
    assert_eq!(v.errors.first().map(|e| e.rule), Some("palette-color"));
}

#[test]
fn nbsp_offset_calculation_is_precise() {
    // A page with a NBSP before a palette class should still be found and offset should be correct
    let html = "<p>\u{a0}<span class=\"bg-red-500\">";
    let (found, offset) = find_palette_class(html).expect("should find palette class");
    assert_eq!(found, "bg-red-500");
    // Verify the offset calculation is correct by checking that the substring at offset matches
    assert_eq!(&html[offset..offset + found.len()], "bg-red-500");
    // Also verify via validate_page_fragment that line_of doesn't panic
    let result = validate_page_fragment("pages/index.html", html, &[]);
    assert_eq!(result.errors.len(), 1);
    let err = result.errors.first().unwrap();
    assert_eq!(err.rule, "palette-color");
    assert_eq!(err.found.as_deref(), Some("bg-red-500"));
}

#[test]
fn oversize_component_with_palette_color_is_rejected() {
    // A component over 6 KB with a palette color should be rejected, not just warned
    let mut js = "class X extends HTMLElement { connectedCallback(){ this.innerHTML = '<p class=\"text-zinc-500\">x</p>' } } customElements.define('x-y', X)".to_string();
    // Pad with a long comment to exceed 6 KB (6144 bytes)
    js.push_str("\n// ");
    js.push_str(&"x".repeat(7000));

    let v = validate_component("components/x-y.js", &js);
    assert_eq!(v.errors.len(), 1, "should have exactly one error (palette-color, not size warning)");
    let err = v.errors.first().unwrap();
    assert_eq!(err.rule, "palette-color", "error should be palette-color, not component-size");
}
