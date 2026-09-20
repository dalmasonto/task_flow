use taskflow_design::tokens::{css_to_tokens_json, tokens_json_to_css, TokensDoc};

fn sample_json() -> &'static str {
    r##"{"version":1,"categories":{
        "colors":{"accent":{"light":"#6366f1","dark":"#818cf8"},"bg":{"light":"#ffffff","dark":"#0b0b10"}},
        "radius":{"md":{"light":"8px"}}
    }}"##
}

#[test]
fn json_generates_css_with_root_and_dark_preserving_var_names() {
    let doc: TokensDoc = serde_json::from_str(sample_json()).unwrap();
    let css = tokens_json_to_css(&doc);
    // The exact --var names must appear so page/component var() refs resolve.
    assert!(css.contains("--accent: #6366f1"), "css: {css}");
    assert!(css.contains("--bg: #ffffff"));
    assert!(css.contains("--radius-md: 8px") || css.contains("--md: 8px"));
    // Dark values go under .dark; light under :root.
    let root = css.split(".dark").next().unwrap();
    assert!(root.contains("--accent: #6366f1"));
    let dark = &css[css.find(".dark").expect("dark block")..];
    assert!(dark.contains("--accent: #818cf8"));
    assert!(dark.contains("--bg: #0b0b10"));
    // @theme block present (Tailwind scale container, matches existing contract).
    assert!(css.contains("@theme"));
}

#[test]
fn legacy_css_parses_into_json_round_trip() {
    let css = "@theme {\n  --accent: #6366f1;\n  --radius-md: 8px;\n}\n:root { --spacing-1: 4px; }";
    let doc = css_to_tokens_json(css);
    let regen = tokens_json_to_css(&doc);
    assert!(regen.contains("--accent: #6366f1"));
    assert!(regen.contains("--radius-md: 8px"));
    assert!(regen.contains("--spacing-1: 4px"));
}
