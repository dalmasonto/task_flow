use taskflow_design::tokens::{css_to_tokens_json, tokens_json_to_css, ThemeDecl, TokensDoc};

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
    // Dark values go under the sandbox's data-theme selector (and `.dark`),
    // matching how the composer applies the theme; light under :root.
    let dark_sel = "[data-theme=\"dark\"]";
    assert!(css.contains(dark_sel), "dark block selector missing: {css}");
    let root = css.split(dark_sel).next().unwrap();
    assert!(root.contains("--accent: #6366f1"));
    let dark = &css[css.find(dark_sel).expect("dark block")..];
    assert!(dark.contains("--accent: #818cf8"));
    assert!(dark.contains("--bg: #0b0b10"));
    // shadcn globals.css shape: dark also under .dark; the bridge, not raw @theme.
    assert!(css.contains(":root[data-theme=\"dark\"], .dark {"));
    assert!(!css.contains("@theme {"));
    assert!(css.contains("@theme inline {"));
}

#[test]
fn parses_dark_from_both_data_theme_and_dot_dark() {
    // Our generated CSS uses :root[data-theme="dark"]; hand-authored CSS may use
    // a .dark class. Both must import their dark overrides.
    let generated = "@theme {\n  --accent: #6366f1;\n}\n:root {\n  --accent: #6366f1;\n}\n:root[data-theme=\"dark\"] {\n  --accent: #818cf8;\n}\n";
    let via_data_theme = css_to_tokens_json(generated);
    assert!(tokens_json_to_css(&via_data_theme).contains("--accent: #818cf8"));

    let hand = ":root {\n  --accent: #6366f1;\n}\n.dark {\n  --accent: #818cf8;\n}\n";
    let via_dot_dark = css_to_tokens_json(hand);
    let regen = tokens_json_to_css(&via_dot_dark);
    assert!(regen.contains("--accent: #6366f1"));
    assert!(regen.contains("--accent: #818cf8"), "pasted .dark must import: {regen}");
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

#[test]
fn generated_css_round_trips_without_bridge_pollution() {
    use taskflow_design::defaults::effective_tokens;
    let css = tokens_json_to_css(&effective_tokens(&TokensDoc::default()));
    let reimported = css_to_tokens_json(&css);
    let regen = tokens_json_to_css(&reimported);
    let root = &regen[..regen.find("@theme inline").unwrap()];
    assert!(!root.contains("--color-"), "bridge leaked into tokens: {root}");
    assert!(!root.contains("--radius-sm"), "radius scale leaked into tokens: {root}");
    assert!(root.contains("  --primary: oklch(0.205 0 0);"));
    assert!(root.contains("  --radius: 0.625rem;"));
}

#[test]
fn a_real_shadcn_globals_css_imports_its_dark_values() {
    let css = r#"@import "tailwindcss";
@custom-variant dark (&:is(.dark *));
@theme inline {
  --color-primary: var(--primary);
  --radius-lg: var(--radius);
}
:root {
  --radius: 0.625rem;
  --primary: oklch(0.205 0 0);
}
.dark {
  --primary: oklch(0.922 0 0);
}
"#;
    let doc = css_to_tokens_json(css);
    let p = &doc.categories.iter().find(|(c, _)| c == "custom").expect("custom").1
        .iter().find(|(k, _)| k == "--primary").expect("--primary").1;
    assert_eq!(p.light, "oklch(0.205 0 0)");
    assert_eq!(p.get("dark"), Some("oklch(0.922 0 0)"));
    let json = serde_json::to_string(&doc).unwrap();
    assert!(!json.contains("--color-") && !json.contains("\"lg\""), "{json}");
}

#[test]
fn token_keys_must_be_identifiers() {
    use taskflow_design::validation::validate_tokens_json;
    let bad = r#"{"version":1,"categories":{"colors":{"x;} body{display:none} @theme inline{--y":{"light":"red"}}}}"#;
    let v = validate_tokens_json(bad);
    assert!(!v.ok);
    assert_eq!(v.errors[0].rule, "token-key");
    assert!(validate_tokens_json(r#"{"version":1,"categories":{"colors":{"ok-1_a":{"light":"red"}},"custom":{"--radius":{"light":"1px"},"radius":{"light":"1px"}}}}"#).ok);
}

fn themed_doc() -> TokensDoc {
    serde_json::from_str(
        r##"{"version":1,"themes":[{"name":"dark"},{"name":"ocean"}],"categories":{
        "colors":{"primary":{"light":"#15803D","dark":"#22C55E","ocean":"#00AAFF"},"bg":{"light":"#ffffff","ocean":"#002233"},"fg":{"light":"#111111"}}}}"##,
    )
    .unwrap()
}

#[test]
fn each_theme_gets_one_block_with_only_its_overrides() {
    let css = tokens_json_to_css(&themed_doc());
    assert!(css.contains(":root[data-theme=\"dark\"], .dark {\n  --primary: #22C55E;\n}\n"), "{css}");
    assert!(css.contains(":root[data-theme=\"ocean\"] {\n  --primary: #00AAFF;\n  --bg: #002233;\n}\n"), "{css}");
    let ocean = &css[css.find("[data-theme=\"ocean\"]").unwrap()..css.find("@theme inline").unwrap()];
    assert!(!ocean.contains("--fg"), "an inherited token is not repeated: {ocean}");
    assert!(css.find("data-theme=\"dark\"") < css.find("data-theme=\"ocean\""), "blocks follow the theme order");
}

#[test]
fn a_theme_with_no_overrides_emits_no_block() {
    let mut doc = themed_doc();
    doc.themes = Some(vec![ThemeDecl::named("dark"), ThemeDecl::named("ocean"), ThemeDecl::named("sunset")]);
    assert!(!tokens_json_to_css(&doc).contains("sunset"));
}

#[test]
fn an_undeclared_override_is_never_emitted() {
    let mut doc = themed_doc();
    doc.themes = Some(vec![ThemeDecl::named("ocean")]);
    let css = tokens_json_to_css(&doc);
    assert!(!css.contains("data-theme=\"dark\""), "dark is no longer declared: {css}");
    assert!(css.contains(":root[data-theme=\"ocean\"] {"), "{css}");
}

#[test]
fn n_theme_css_round_trips() {
    let css = tokens_json_to_css(&themed_doc());
    let back = css_to_tokens_json(&css);
    assert_eq!(back.declared_themes(), ["light", "dark", "ocean"].map(String::from).to_vec());
    // Compare the theme blocks only: the `@theme inline` bridge is derived from
    // the `colors` category, and a bare `--bg` imports as `custom` (not colors).
    let blocks = |c: &str| c[..c.find("@theme inline").unwrap()].to_string();
    assert_eq!(blocks(&tokens_json_to_css(&back)), blocks(&css), "css -> json -> css is stable");
}

#[test]
fn css_with_only_dark_stays_a_legacy_document() {
    let back = css_to_tokens_json(":root {\n  --a: #fff;\n}\n.dark {\n  --a: #000;\n}\n");
    assert_eq!(back.themes, None);
}

#[test]
fn pasted_css_imports_any_data_theme_block_and_dot_dark() {
    let hand = r#"@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
:root {
  --primary: #111;
}
[data-theme="ocean"] {
  --primary: #0af;
  --wave: #123;
}
.dark {
  --primary: #eee;
}
"#;
    let doc = css_to_tokens_json(hand);
    assert_eq!(doc.declared_themes(), ["light", "dark", "ocean"].map(String::from).to_vec(), "dark first");
    let css = tokens_json_to_css(&doc);
    assert!(css.contains(":root[data-theme=\"dark\"], .dark {\n  --primary: #eee;\n}"), "{css}");
    assert!(css.contains(":root[data-theme=\"ocean\"] {\n  --primary: #0af;\n  --wave: #123;\n}"), "{css}");
    assert!(!css.contains("*));"), "the @custom-variant line is not a block: {css}");
}

#[test]
fn a_descendant_theme_rule_is_not_a_root_override() {
    let hand = r#":root {
  --primary: #111;
}
[data-theme="dark"] .card {
  --primary: #f00;
  --card-only: #f00;
}
[data-theme="ocean"], .ocean {
  --primary: #0af;
}
:root[data-theme="sun"] {
  --primary: #fa0;
}
"#;
    let doc = css_to_tokens_json(hand);
    // `.card`'s rule is skipped entirely: no dark theme, no `--card-only` token.
    assert_eq!(doc.declared_themes(), ["light", "ocean", "sun"].map(String::from).to_vec());
    let json = serde_json::to_string(&doc).unwrap();
    assert!(!json.contains("#f00") && !json.contains("card-only"), "{json}");
    assert_eq!(doc.resolve_var("--primary", "ocean"), Some("#0af"));
    assert_eq!(doc.resolve_var("--primary", "sun"), Some("#fa0"));
}

#[test]
fn an_undeclared_dark_gets_no_block_even_with_shadcn_defaults() {
    use taskflow_design::defaults::effective_tokens;
    let doc: TokensDoc = serde_json::from_str(
        r##"{"version":1,"themes":[{"name":"ocean"}],"categories":{"colors":{"brand":{"light":"#111111","ocean":"#00AAFF"}}}}"##,
    )
    .unwrap();
    let css = tokens_json_to_css(&effective_tokens(&doc));
    assert!(css.contains(":root[data-theme=\"ocean\"] {"), "{css}");
    assert!(!css.contains("data-theme=\"dark\""), "{css}");
    assert!(!css.contains(".dark"), "{css}");
    assert!(css.contains("--primary:"), "shadcn defaults still in :root: {css}");
}
