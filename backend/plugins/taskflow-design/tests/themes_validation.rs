//! #619: `styles/tokens.json` is refused when its theme list is malformed or a
//! token carries a value for a theme the document does not declare.

use taskflow_design::validation::validate_tokens_json;

fn rule(json: &str) -> Option<&'static str> {
    let v = validate_tokens_json(json);
    if v.ok { None } else { Some(v.errors[0].rule) }
}

#[test]
fn declared_themes_validate() {
    assert_eq!(rule(r#"{"version":1,"themes":[{"name":"dark"},{"name":"ocean","label":"Ocean"}],"categories":{"colors":{"p":{"light":"red","ocean":"blue"}}}}"#), None);
    assert_eq!(rule(r#"{"version":1,"categories":{"colors":{"p":{"light":"red","dark":"blue"}}}}"#), None, "legacy dark needs no list");
}

#[test]
fn bad_theme_lists_are_theme_name() {
    for themes in [
        r#"[{"name":"light"}]"#,
        r#"[{"name":"Ocean"}]"#,
        r#"[{"name":"my theme"}]"#,
        r#"[{"name":"x\"]"}]"#,
        r#"[{"name":"both"}]"#,
        r#"[{"name":"all"}]"#,
        r#"[{"name":"ocean"},{"name":"ocean"}]"#,
        r#"[{"name":"ocean","label":""}]"#,
        r#"[{"name":"a"},{"name":"b"},{"name":"c"},{"name":"d"},{"name":"e"},{"name":"f"},{"name":"g"},{"name":"h"}]"#,
    ] {
        let doc = format!(r#"{{"version":1,"themes":{themes},"categories":{{}}}}"#);
        assert_eq!(rule(&doc), Some("theme-name"), "{themes}");
    }
    let seven = r#"[{"name":"a"},{"name":"b"},{"name":"c"},{"name":"d"},{"name":"e"},{"name":"f"},{"name":"g"}]"#;
    assert_eq!(rule(&format!(r#"{{"version":1,"themes":{seven},"categories":{{}}}}"#)), None, "8 including light is the cap");
}

#[test]
fn an_override_for_an_undeclared_theme_is_theme_unknown() {
    assert_eq!(rule(r#"{"version":1,"categories":{"colors":{"p":{"light":"red","ocean":"blue"}}}}"#), Some("theme-unknown"));
    assert_eq!(
        rule(r#"{"version":1,"themes":[{"name":"ocean"}],"categories":{"colors":{"p":{"light":"red","dark":"blue"}}}}"#),
        Some("theme-unknown"),
        "dark is not implicit once themes is listed"
    );
    let v = validate_tokens_json(r#"{"version":1,"categories":{"colors":{"p":{"light":"red","ocean":"blue"}}}}"#);
    assert!(v.errors[0].message.contains("light, dark"), "{}", v.errors[0].message);
}

#[test]
fn a_remote_url_in_any_theme_is_refused() {
    assert_eq!(
        rule(r#"{"version":1,"themes":[{"name":"ocean"}],"categories":{"colors":{"p":{"light":"red","ocean":"https://x.example/y"}}}}"#),
        Some("remote-url")
    );
}
