use taskflow_design::defaults::{effective_tokens, missing_defaults, shadcn_defaults};
use taskflow_design::tokens::{css_to_tokens_json, theme_bridge, tokens_json_to_css, TokensDoc};

fn doc(json: &str) -> TokensDoc {
    serde_json::from_str(json).unwrap()
}

#[test]
fn empty_project_gets_every_default() {
    let eff = effective_tokens(&TokensDoc::default());
    let css = tokens_json_to_css(&eff);
    for name in ["--background", "--foreground", "--primary", "--primary-foreground", "--muted-foreground",
                 "--popover", "--popover-foreground", "--border", "--ring", "--chart-5", "--sidebar-ring", "--radius"] {
        assert!(css.contains(&format!("  {name}: ")), "missing {name} in {css}");
    }
    assert_eq!(missing_defaults(&TokensDoc::default()), shadcn_defaults());
}

#[test]
fn project_token_wins_in_both_themes() {
    let project = doc(r#"{"version":1,"categories":{"colors":{"primary":{"light":"oklch(0.5 0.2 250)"}}}}"#);
    let eff = effective_tokens(&project);
    let css = tokens_json_to_css(&eff);
    assert!(css.contains("--primary: oklch(0.5 0.2 250);"));
    // The project gave no dark value: the default's dark must NOT leak in.
    let dark = &css[css.find(".dark").unwrap()..];
    assert!(!dark.contains("  --primary: "), "default dark leaked: {dark}");
    assert!(missing_defaults(&project).categories.iter()
        .all(|(_, t)| t.iter().all(|(k, _)| k != "primary")));
}

#[test]
fn custom_dash_name_shadows_default_and_stays_bridged() {
    // What css_to_tokens_json produces for an imported `--primary`.
    let project = doc(r#"{"version":1,"categories":{"custom":{"--primary":{"light":"red"}}}}"#);
    let eff = effective_tokens(&project);
    let css = tokens_json_to_css(&eff);
    assert_eq!(css.matches("  --primary: ").count(), 1, "duplicated: {css}");
    assert!(css.contains("--primary: red;"));
    assert!(theme_bridge(&eff).contains("--color-primary: var(--primary);"));
}

#[test]
fn legacy_invented_names_survive_beside_defaults() {
    let legacy = css_to_tokens_json(":root {\n  --bg: #fff;\n  --accent: #6366f1;\n}\n");
    let css = tokens_json_to_css(&effective_tokens(&legacy));
    assert!(css.contains("--bg: #fff;"));
    // `--accent` is ALSO a shadcn name: the project's value wins, no duplicate.
    assert_eq!(css.matches("  --accent: ").count(), 1);
    assert!(css.contains("--accent: #6366f1;"));
    assert!(css.contains("  --background: "));
}

#[test]
fn css_has_globals_shape() {
    let css = tokens_json_to_css(&effective_tokens(&TokensDoc::default()));
    assert!(!css.contains("@theme {"), "raw @theme block must be gone: {css}");
    let root = css.find(":root {").unwrap();
    let dark = css.find(":root[data-theme=\"dark\"], .dark {").unwrap();
    let bridge = css.find("@theme inline {").unwrap();
    assert!(root < dark && dark < bridge);
    for line in ["--radius-sm: calc(var(--radius) * 0.6);", "--radius-md: calc(var(--radius) * 0.8);",
                 "--radius-lg: var(--radius);", "--radius-xl: calc(var(--radius) * 1.4);",
                 "--radius-2xl: calc(var(--radius) * 1.8);", "--radius-3xl: calc(var(--radius) * 2.2);",
                 "--radius-4xl: calc(var(--radius) * 2.6);",
                 "--color-background: var(--background);", "--color-muted-foreground: var(--muted-foreground);"] {
        assert!(css.contains(line), "missing `{line}`");
    }
}

#[test]
fn bridge_covers_project_only_colours() {
    let project = doc(r#"{"version":1,"categories":{"colors":{"brand":{"light":"oklch(0.6 0.2 30)"}}}}"#);
    assert!(theme_bridge(&effective_tokens(&project)).contains("--color-brand: var(--brand);"));
}

#[test]
fn no_radius_means_no_radius_scale() {
    // theme_bridge on a doc with no --radius (only reachable without defaults).
    let bare = doc(r#"{"version":1,"categories":{"colors":{"x":{"light":"red"}}}}"#);
    let bridge = theme_bridge(&bare);
    assert!(!bridge.contains("--radius-sm"));
    assert!(bridge.contains("--color-x: var(--x);"));
}

#[test]
fn project_radius_step_is_not_overridden_by_the_bridge() {
    let project = doc(r#"{"version":1,"categories":{"radius":{"md":{"light":"8px"}}}}"#);
    let eff = effective_tokens(&project);
    let bridge = theme_bridge(&eff);
    assert!(!bridge.contains("--radius-md"), "{bridge}");
    assert!(bridge.contains("--radius-sm:") && bridge.contains("--radius-lg:"), "{bridge}");
    assert!(tokens_json_to_css(&eff).contains("--radius-md: 8px"));
}

#[test]
fn bridge_skips_non_ident_colour_keys() {
    let mut project = doc(r#"{"version":1,"categories":{"colors":{"ok":{"light":"red"}}}}"#);
    project
        .categories
        .entry_or_insert_with("colors", taskflow_design::tokens::OrderedMap::new)
        .insert("x;} body{display:none}".to_string(), taskflow_design::tokens::TokenValue { light: "red".into(), dark: None });
    let bridge = theme_bridge(&effective_tokens(&project));
    assert!(bridge.contains("--color-ok: var(--ok);"));
    assert!(!bridge.contains("body{"), "{bridge}");
}
