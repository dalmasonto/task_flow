//! Manifest derivation — the registry every consumer (composer, MCP tools,
//! chrome) reads instead of listing files.
//!
//! `manifest.json` in the spec is a DERIVED artifact: rows are the storage, and
//! this module rebuilds the manifest shape on every read/write. `usedOn` is
//! computed by scanning page fragments for registered custom-element tags; it
//! powers the blast-radius warning in the comment flow and the write response
//! that tells an agent how many routes it just touched. It is not optional.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

use crate::models::{DesignFile, DesignFileKind};
use crate::resources::{self, ResourceLink};
use crate::tokens::{TokensDoc, category_to_var_name};

#[derive(Debug, Clone, Serialize)]
pub struct RouteEntry {
    /// URL path served inside the sandbox frame: `/` or `/settings`.
    pub path: String,
    /// The page fragment backing it.
    pub file: String,
    /// Human title derived from the filename (`settings.html` → `Settings`).
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEntry {
    pub name: String,
    pub file: String,
    /// Attributes declared via `static get observedAttributes` — best-effort
    /// parse, purely informational for the registry UI and tool output.
    pub attrs: Vec<String>,
    /// Routes whose fragment uses this component. The blast radius.
    pub used_on: Vec<String>,
    /// Total number of times the tag appears across all fragments.
    pub usage_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenGroup {
    pub name: String,
    /// `--name: value` entries (the light/default value), in source order.
    /// Back-compat: existing consumers that only read `variables` keep
    /// working unchanged after the tokens.json rework (this is still the
    /// light value, exactly as when it was parsed straight from CSS).
    pub variables: Vec<(String, String)>,
    /// Dark-mode override for the tokens in this group that HAVE one, as
    /// `(name, dark_value)` pairs — a subset of `variables` by name (not
    /// index-aligned; look up by name). Additive field: empty (and omitted
    /// from JSON) when nothing in the group has a dark override, which is
    /// always true for the legacy-tokens.css fallback path, so a manifest
    /// built from legacy CSS serializes identically to before this change.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables_dark: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignManifest {
    pub project: i64,
    pub routes: Vec<RouteEntry>,
    pub components: Vec<ComponentEntry>,
    pub tokens: Vec<TokenGroup>,
    /// Monotonic stamp bumped on every accepted write so consumers can cheaply
    /// detect "manifest changed" without diffing.
    pub revision: i64,
    /// The project's external resources — web fonts and their companion links —
    /// as `(is_script, link)` pairs, in document order, from ENABLED sets only.
    /// Derived from the `styles/resources.json` row by the same forgiving read
    /// as the tokens above; a project with no such row (most of them) composes
    /// exactly as it did before this field existed.
    pub resources: Vec<(bool, ResourceLink)>,
}

/// The route a page file serves: `pages/index.html` → `/`, else `/<stem>`.
pub fn route_for_page(path: &str) -> Option<String> {
    let stem = path.strip_prefix("pages/")?.strip_suffix(".html")?;
    if stem.is_empty() || stem.contains('/') {
        return None;
    }
    Some(if stem == "index" {
        "/".to_string()
    } else {
        format!("/{stem}")
    })
}

/// Inverse of [`route_for_page`] for lookups by route.
pub fn page_path_for_route(route: &str) -> Option<String> {
    let route = route.trim_end_matches('/');
    if route.is_empty() {
        return Some("pages/index.html".to_string());
    }
    let stem = route.strip_prefix('/')?;
    if stem.is_empty() || stem.contains('/') || !stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(format!("pages/{stem}.html"))
}

fn title_for(stem: &str) -> String {
    let mut out = String::new();
    for (i, word) in stem.split(['-', '_']).filter(|w| !w.is_empty()).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    if out.is_empty() {
        stem.to_string()
    } else {
        out
    }
}

/// Best-effort parse of `static get observedAttributes() { return ['a','b']; }`.
fn observed_attributes(js: &str) -> Vec<String> {
    let marker = "observedAttributes";
    let Some(pos) = js.find(marker) else {
        return Vec::new();
    };
    let after = &js[pos + marker.len()..];
    // Take up to the closing brace of the getter body.
    let Some(body_end) = after.find('}') else {
        return Vec::new();
    };
    let body = &after[..body_end];
    body.split(|c| c == '\'' || c == '"')
        .skip(1)
        .step_by(2)
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .map(str::to_string)
        .collect()
}

/// Count occurrences of `<name` followed by whitespace/`>`/`/` in all page
/// fragments. Returns `(routes_using, total_occurrences)` sorted by route.
fn usage_of(name: &str, pages: &[(String, String)]) -> (Vec<String>, usize) {
    let mut routes = Vec::new();
    let mut count = 0usize;
    let needle_open = format!("<{name}");
    for (route, content) in pages {
        let mut hits = 0usize;
        let mut scan = 0usize;
        while let Some(rel) = content[scan..].find(&needle_open) {
            let abs = scan + rel;
            let after = content[abs + needle_open.len()..]
                .chars()
                .next();
            if matches!(after, Some(c) if c.is_whitespace() || c == '>' || c == '/') {
                hits += 1;
            }
            scan = abs + needle_open.len();
        }
        if hits > 0 {
            routes.push(route.clone());
            count += hits;
        }
    }
    routes.sort();
    (routes, count)
}

/// Build the manifest from the project's current rows. `revision` should be
/// the max file version seen (or any monotonic counter the caller keeps).
pub fn build(project_id: i64, files: &[DesignFile], revision: i64) -> DesignManifest {
    let mut pages: Vec<(String, String)> = Vec::new(); // (route, content)
    let mut routes: Vec<RouteEntry> = Vec::new();
    let mut component_rows: Vec<(String, String)> = Vec::new(); // (name, content)

    for f in files {
        match f.kind {
            DesignFileKind::Page => {
                if let Some(route) = route_for_page(&f.path) {
                    pages.push((route.clone(), f.content.clone()));
                    routes.push(RouteEntry {
                        path: route,
                        file: f.path.clone(),
                        title: title_for(
                            f.path
                                .strip_prefix("pages/")
                                .and_then(|p| p.strip_suffix(".html"))
                                .unwrap_or("page"),
                        ),
                    });
                }
            }
            DesignFileKind::Component => {
                let name = f.path.strip_prefix("components/").and_then(|p| p.strip_suffix(".js"));
                if let Some(name) = name {
                    component_rows.push((name.to_string(), f.content.clone()));
                }
            }
            _ => {}
        }
    }

    routes.sort_by(|a, b| a.path.cmp(&b.path));

    let components: Vec<ComponentEntry> = component_rows
        .iter()
        .map(|(name, js)| {
            let (used_on, usage_count) = usage_of(name, &pages);
            ComponentEntry {
                name: name.clone(),
                file: format!("components/{name}.js"),
                attrs: observed_attributes(js),
                used_on,
                usage_count,
            }
        })
        .collect();

    // Tokens: prefer the tokens.json source of truth (Task 1's TokensDoc),
    // grouped by its own categories using the SAME name convention the
    // json<->css codec uses (`category_to_var_name`), so a bare color like
    // `--accent` lands in "colors" instead of being misclassified. Fall back
    // to a regex-ish scan of legacy `styles/tokens.css` only when there's no
    // json row (or it fails to parse, which validation should prevent, but
    // don't panic the manifest builder over it).
    let tokens = files
        .iter()
        .find(|f| f.kind == DesignFileKind::Token && f.path == "styles/tokens.json")
        .and_then(|f| serde_json::from_str::<TokensDoc>(&f.content).ok())
        .map(|doc| token_groups_from_doc(&doc))
        .unwrap_or_else(|| {
            let tokens_css = files
                .iter()
                .find(|f| f.kind == DesignFileKind::Token && f.path == "styles/tokens.css")
                .map(|f| f.content.clone())
                .unwrap_or_default();
            parse_token_groups(&tokens_css)
        });

    let resources = resources_from(files);

    DesignManifest {
        project: project_id,
        routes,
        components,
        tokens,
        revision,
        resources,
    }
}

/// The project's enabled resource links, in document order — [`build`]'s
/// `resources` field on its own.
///
/// Split out for callers that need only this: `build` also scans every page
/// fragment once per registered component (`usage_of`), parses the token
/// document and sorts the routes, none of which the link list depends on. The
/// exported `page.html` is such a caller — it needs the links and nothing else —
/// and it is what made the cost worth naming.
///
/// Absent, unparseable, or invalid: no links, page composes normally. The read
/// path is forgiving by design — a bad resource document must never stop a page
/// from rendering, because the page is the thing being worked on.
///
/// `validate` runs BEFORE `enabled_links`, and that order is the security
/// property, not a formality: it is why `composer::resources_tags` can ESCAPE
/// its values instead of FILTERING them. A document carrying a refused url —
/// `javascript:`, a bare path, a scheme-relative `//host` — contributes no links
/// at all, so the composer never holds one.
///
/// This is the ONE implementation of that read. `build` calls it rather than
/// repeating it, so the two cannot drift; a caller that re-derived the links
/// itself would be a second place for the validate-before-emit order to be lost.
pub fn resources_from(files: &[DesignFile]) -> Vec<(bool, ResourceLink)> {
    files
        .iter()
        .find(|f| f.path == resources::RESOURCES_PATH)
        .and_then(|f| resources::parse(&f.content).ok())
        .and_then(|d| resources::validate(d).ok())
        .map(|d| resources::enabled_links(&d).into_iter().map(|(s, l)| (s, l.clone())).collect())
        .unwrap_or_default()
}

/// Group custom properties from `@theme` into named groups by prefix.
fn parse_token_groups(css: &str) -> Vec<TokenGroup> {
    const PREFIXES: [&str; 5] = ["--color", "--spacing", "--radius", "--font", "--text"];
    let lower = css.to_ascii_lowercase();
    let mut groups: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();

    let theme_start = lower.find("@theme");
    let scope: &str = match theme_start {
        Some(start) => {
            let after = &lower[start..];
            let end = after.find('}').map(|k| start + k).unwrap_or(lower.len());
            &css[start.min(css.len())..end.min(css.len())]
        }
        None => "",
    };

    let mut rest = scope;
    while let Some(pos) = rest.find("--") {
        let tail = &rest[pos + 2..];
        let Some(name_end) = tail.find(':') else {
            break;
        };
        let raw_name = &tail[..name_end];
        let value = tail[name_end + 1..]
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        let full = format!("--{raw_name}");
        let group = PREFIXES
            .iter()
            .find(|p| full.starts_with(*p))
            .map(|p| p.trim_start_matches('-').to_string())
            .unwrap_or_else(|| "other".to_string());
        groups.entry(group).or_default().push((full, value));
        rest = &tail[name_end..];
    }

    groups
        .into_iter()
        .map(|(name, variables)| TokenGroup {
            name,
            variables,
            variables_dark: Vec::new(),
        })
        .collect()
}

/// Build [`TokenGroup`]s straight from a [`TokensDoc`] (the tokens.json
/// path). Each JSON category becomes one group (its categories ARE the
/// groups — no re-derivation of a naming convention), and each entry's
/// `--var` name is derived via the shared [`category_to_var_name`], the same
/// function the served CSS is generated with, so group membership and var
/// names never drift from what `styles/tokens.css` actually contains.
fn token_groups_from_doc(doc: &TokensDoc) -> Vec<TokenGroup> {
    doc.categories
        .iter()
        .map(|(category, entries)| {
            let mut variables = Vec::new();
            let mut variables_dark = Vec::new();
            for (key, value) in entries.iter() {
                let var_name = category_to_var_name(category, key);
                variables.push((var_name.clone(), value.light.clone()));
                if let Some(dark) = &value.dark {
                    variables_dark.push((var_name, dark.clone()));
                }
            }
            TokenGroup {
                name: category.clone(),
                variables,
                variables_dark,
            }
        })
        .collect()
}

/// Convenience: manifest as the JSON value handlers return.
pub fn to_json(manifest: &DesignManifest) -> Value {
    serde_json::to_value(manifest).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CommentScope, CommentStatus, DesignComment};
    use umbral::orm::ForeignKey;

    /// The KEYS of a JSON object, sorted. The assertions below name all of them
    /// rather than a few, because the failure this guards is a key that is not
    /// the one the frontend declares: a subset check passes on exactly the
    /// misspelling it is meant to catch.
    fn keys(value: &Value) -> Vec<&str> {
        let mut out: Vec<&str> =
            value.as_object().expect("expected a JSON object").keys().map(String::as_str).collect();
        out.sort_unstable();
        out
    }

    fn token_file(path: &str, content: &str) -> DesignFile {
        DesignFile {
            id: 0,
            project: ForeignKey::new(1),
            kind: DesignFileKind::Token,
            path: path.to_string(),
            content: content.to_string(),
            version: 1,
            updated_by: "test".to_string(),
            created_at: None,
            updated_at: None,
        }
    }

    fn resource_file(content: &str) -> DesignFile {
        DesignFile {
            id: 0,
            project: ForeignKey::new(1),
            kind: DesignFileKind::Token,
            path: resources::RESOURCES_PATH.to_string(),
            content: content.to_string(),
            version: 1,
            updated_by: "test".to_string(),
            created_at: None,
            updated_at: None,
        }
    }

    fn page_file(path: &str) -> DesignFile {
        DesignFile {
            kind: DesignFileKind::Page,
            path: path.to_string(),
            content: "<main>x</main>".to_string(),
            ..resource_file("")
        }
    }

    #[test]
    fn enabled_sets_reach_the_manifest_and_disabled_ones_do_not() {
        let doc = r#"{"version":1,"sets":[
            {"id":"on","name":"On","enabled":true,
             "links":[{"rel":"preconnect","href":"https://fonts.googleapis.com"},
                      {"rel":"stylesheet","href":"https://fonts.googleapis.com/css2?family=Inter&display=swap"}]},
            {"id":"off","name":"Off","enabled":false,
             "links":[{"rel":"stylesheet","href":"https://example.com/off.css"}]}
        ]}"#;
        let files = vec![page_file("pages/index.html"), resource_file(doc)];
        let m = build(1, &files, 0);
        let hrefs: Vec<_> = m.resources.iter().map(|(_, l)| l.href.as_deref()).collect();
        assert_eq!(m.resources.len(), 2, "only the enabled set contributes: {hrefs:?}");
        assert!(m.resources.iter().all(|(is_script, _)| !*is_script));
        assert!(hrefs.contains(&Some("https://fonts.googleapis.com")), "{hrefs:?}");
        assert!(
            !hrefs.contains(&Some("https://example.com/off.css")),
            "a disabled set must not contribute: {hrefs:?}"
        );
    }

    #[test]
    fn a_document_with_a_dangerous_scheme_contributes_nothing() {
        // The end-to-end half of the scheme rule: `validate` refuses the whole
        // document, the forgiving read collapses it to no links, and the emitter
        // therefore has nothing dangerous to escape.
        let doc = r#"{"version":1,"sets":[{"id":"a","name":"A","enabled":true,
            "links":[{"rel":"stylesheet","href":"javascript:alert(1)"}]}]}"#;
        let m = build(1, &[page_file("pages/index.html"), resource_file(doc)], 0);
        assert!(m.resources.is_empty(), "a refused document yields no links");
    }

    #[test]
    fn an_absent_or_unparseable_resource_row_contributes_nothing() {
        for doc in [None, Some("{ not json")] {
            let mut files = vec![page_file("pages/index.html")];
            if let Some(c) = doc {
                files.push(resource_file(c));
            }
            let m = build(1, &files, 0);
            assert!(m.resources.is_empty(), "forgiving read: {doc:?}");
        }
    }

    #[test]
    fn tokens_json_row_yields_grouped_light_and_dark_values() {
        let json = serde_json::json!({
            "version": 1,
            "categories": {
                "colors": { "accent": { "light": "#6366f1", "dark": "#818cf8" } },
                "radius": { "md": { "light": "8px" } }
            }
        })
        .to_string();

        let files = vec![token_file("styles/tokens.json", &json)];
        let manifest = build(1, &files, 1);

        let colors = manifest
            .tokens
            .iter()
            .find(|g| g.name == "colors")
            .expect("colors group present (bare --accent must be grouped as a color, not 'other')");
        assert!(
            colors
                .variables
                .contains(&("--accent".to_string(), "#6366f1".to_string())),
            "expected --accent light value in colors group, got {:?}",
            colors.variables
        );
        assert!(
            colors
                .variables_dark
                .contains(&("--accent".to_string(), "#818cf8".to_string())),
            "expected --accent dark override in colors group, got {:?}",
            colors.variables_dark
        );

        let radius = manifest
            .tokens
            .iter()
            .find(|g| g.name == "radius")
            .expect("radius group present");
        assert!(
            radius
                .variables
                .contains(&("--radius-md".to_string(), "8px".to_string()))
        );
        assert!(
            radius.variables_dark.is_empty(),
            "radius/md has no dark override, so variables_dark must stay empty"
        );
    }

    #[test]
    fn legacy_css_fallback_used_when_no_json_row() {
        let css = "@theme {\n  --accent: #6366f1;\n  --radius-md: 8px;\n}\n:root {\n  --accent: #6366f1;\n  --radius-md: 8px;\n}\n";
        let files = vec![token_file("styles/tokens.css", css)];
        let manifest = build(1, &files, 1);

        assert!(
            !manifest.tokens.is_empty(),
            "legacy CSS fallback should still produce token groups when no tokens.json row exists"
        );
        let has_radius_md = manifest
            .tokens
            .iter()
            .any(|g| g.variables.iter().any(|(n, v)| n == "--radius-md" && v == "8px"));
        assert!(has_radius_md, "legacy fallback should still find --radius-md");
    }

    #[test]
    fn json_row_takes_priority_over_a_legacy_css_row() {
        let json = serde_json::json!({
            "version": 1,
            "categories": {
                "colors": { "accent": { "light": "#000000" } }
            }
        })
        .to_string();
        let css = "@theme {\n  --accent: #ffffff;\n}\n:root {\n  --accent: #ffffff;\n}\n";

        let files = vec![
            token_file("styles/tokens.css", css),
            token_file("styles/tokens.json", &json),
        ];
        let manifest = build(1, &files, 1);

        let colors = manifest.tokens.iter().find(|g| g.name == "colors").expect("colors group");
        assert!(
            colors
                .variables
                .contains(&("--accent".to_string(), "#000000".to_string())),
            "tokens.json must win over legacy tokens.css when both rows exist"
        );
    }

    /// The serialised KEY NAMES of the shapes `v2_fe/src/lib/design-api.ts`
    /// mirrors by hand, asserted against the JSON the server actually emits:
    /// `DesignManifest` (with `RouteEntry`, `ComponentEntry`, `TokenGroup` and
    /// its `resources` tuples), `ResourceLink` and the stored
    /// `ResourcesDoc`/`ResourceSet` document, `views::FileSummary`,
    /// `DesignComment`, and the `DesignFile` row.
    ///
    /// SHAPE BY SHAPE, and not "every shape", because the claim is the thing
    /// that decays. That file enumerates its own mirrors (`design-api.ts:37-53`)
    /// and it lists more than the list above: `ValidationError` is not here (its
    /// keys are read by the existing rejection tests) and neither is
    /// `LayoutDoc`/`LayoutGroup` (the layout endpoint's tests pin it with a
    /// `contains`). Naming the two keeps a reader from reading a shorter list as
    /// full coverage — and the shape this test originally omitted was
    /// `DesignComment`, which is the one whose `page_path`/`pagePath` mismatch
    /// started this whole class. Adding a shape is one `assert_eq!` and a
    /// fixture.
    ///
    /// Nothing else checks the wire against the type. `tsc` pins a reader
    /// against the TYPE, never the type against the WIRE, so a key spelled
    /// differently on this side is `undefined` at runtime with no error
    /// anywhere — which is how `variables_dark` sat here promising a value under
    /// a name the frontend never receives. A field's own name does not decide
    /// its key: the CONTAINER's `#[serde(rename_all)]` does, and reading the
    /// field while missing the container is the mistake this pins.
    ///
    /// The exclusion, stated precisely, because the loose version of it would
    /// read as "everything under a `json!` is out of reach": what is excluded is
    /// the keys TYPED INTO a literal — `views::put_file`'s `affected_routes`,
    /// `conflict_response`'s `current_version`. There is no Rust type behind
    /// those, so no assertion on this side can see a rename; `design-api.ts`
    /// records that they rest on the Rust source alone. A literal that EMBEDS a
    /// struct is a different case and is NOT excluded: `put_file`'s
    /// `"file": row` is a `DesignFile` and `rejection_response`'s
    /// `"errors": verdict.errors` is a `Vec<ValidationError>`, both
    /// struct-decided, both emitted by the server.
    #[test]
    fn the_mirrored_shapes_serialise_under_the_key_names_the_frontend_declares() {
        let json = serde_json::json!({
            "version": 1,
            "categories": {
                "colors": { "accent": { "light": "#6366f1", "dark": "#818cf8" } }
            }
        })
        .to_string();
        let resources_doc = r#"{"version":1,"sets":[{"id":"a","name":"A","enabled":true,
            "links":[{"rel":"preconnect","href":"https://fonts.googleapis.com"}]}]}"#
            .to_string();
        let component = DesignFile {
            kind: DesignFileKind::Component,
            path: "components/app-header.js".to_string(),
            content: "<app-header></app-header>".to_string(),
            ..resource_file("")
        };
        let files = vec![
            page_file("pages/index.html"),
            token_file("styles/tokens.json", &json),
            resource_file(&resources_doc),
            component,
        ];
        let m = to_json(&build(1, &files, 1));

        // `DesignManifest` (`rename_all = "camelCase"`, all single-word keys).
        assert_eq!(keys(&m), ["components", "project", "resources", "revision", "routes", "tokens"]);

        // `RouteEntry` — NO `rename_all`, and still right only because none of
        // its keys has a second word. Add one and the two spellings part company.
        assert_eq!(keys(&m["routes"][0]), ["file", "path", "title"]);

        // `ComponentEntry` — camelCase: this is where `usedOn`/`usageCount` come
        // from, and `phase1_storage_composer.rs` reads the SAME two off a served
        // response, so the pair is pinned end to end.
        assert_eq!(keys(&m["components"][0]), ["attrs", "file", "name", "usageCount", "usedOn"]);

        // `TokenGroup` — camelCase, and `variablesDark` is why this test exists:
        // the Rust field is `variables_dark` and it carries no `rename_all` of
        // its own, so the container is the whole of the answer. A group with a
        // dark override also proves the field is not omitted when it has one.
        assert_eq!(keys(&m["tokens"][0]), ["name", "variables", "variablesDark"]);

        // `DesignManifest.resources` is a `Vec<(bool, ResourceLink)>`: a tuple
        // serialises as an ARRAY, so each entry is `[isScript, link]` and never
        // an object with `0`/`1` keys. `ResourceLink` carries NO
        // `skip_serializing_if`, so all six keys are present even here, where
        // four of them are null/false.
        let entry = &m["resources"][0];
        assert!(entry.is_array(), "a tuple is a JSON array: {entry}");
        assert_eq!(entry[0], Value::Bool(false));
        assert_eq!(
            keys(&entry[1]),
            ["crossorigin", "href", "isAsync", "isScript", "rel", "script"]
        );

        // The stored resources document itself (`ResourcesDoc`/`ResourceSet`),
        // which the editor round-trips through `v2_fe/src/lib/resources.ts` —
        // same container attribute, same class of mistake, no manifest needed.
        let doc = serde_json::to_value(resources::parse(&resources_doc).unwrap()).unwrap();
        assert_eq!(keys(&doc), ["sets", "version"]);
        assert_eq!(keys(&doc["sets"][0]), ["enabled", "id", "links", "name"]);

        // `views::FileSummary` — a hand-written view struct with NO rename, so
        // its keys are the column names it chose. `updated_by`/`updated_at` are
        // the snake_case pair `design-api.ts`'s `DesignFileSummary` declares.
        let summary = crate::views::FileSummary {
            path: "pages/index.html".to_string(),
            kind: DesignFileKind::Page,
            version: 1,
            updated_by: "test".to_string(),
            updated_at: None,
            bytes: 4,
        };
        assert_eq!(
            keys(&serde_json::to_value(&summary).unwrap()),
            ["bytes", "kind", "path", "updated_at", "updated_by", "version"]
        );

        // `DesignFile` — the ORM row itself, served on its own by `get_file`
        // and embedded as `"file": row` in every accepted write
        // (`views::put_file`). `design-api.ts`'s `DesignFileRow` mirrors it, and
        // `updated_by` is the second snake_case pair this test pins. Nine keys,
        // no `rename_all`: every one of them is the field as written.
        assert_eq!(
            keys(&serde_json::to_value(&files[0]).unwrap()),
            [
                "content", "created_at", "id", "kind", "path", "project", "updated_at",
                "updated_by", "version"
            ]
        );

        // `DesignComment` — the row `views.rs`'s comment handlers serialise
        // whole (list, create, update), and the shape this class STARTED with:
        // `design-api.ts`'s own note records that the inspector read `pagePath`
        // while the endpoint sent `page_path`. Seventeen keys, no `rename_all`,
        // so the wire is the column names. Only `resolution_note` is pinned
        // anywhere else on the wire (`phase3_agent_surface.rs`), and
        // `design-comments.test.ts` pins the CLIENT helpers against the wire
        // they read — hand-typed JSON through the real `readJson` — so what is
        // left to this test is the SERVER's side of the same shape. That is the
        // gap it closes.
        let comment = DesignComment {
            id: 1,
            project: ForeignKey::new(1),
            page_path: "/settings".to_string(),
            component_name: None,
            element_path: "app-header > div:nth-child(2)".to_string(),
            src_ref: None,
            viewport: "iphone-16-pro".to_string(),
            rect: r#"{"x":0,"y":0,"w":1,"h":1}"#.to_string(),
            snippet: "<div></div>".to_string(),
            body: "make it blue".to_string(),
            scope: CommentScope::Instance,
            status: CommentStatus::Open,
            thread_id: None,
            author: "operator".to_string(),
            resolution_note: None,
            orphaned: false,
            created_at: None,
        };
        assert_eq!(
            keys(&serde_json::to_value(&comment).unwrap()),
            [
                "author", "body", "component_name", "created_at", "element_path", "id",
                "orphaned", "page_path", "project", "rect", "resolution_note", "scope",
                "snippet", "src_ref", "status", "thread_id", "viewport"
            ]
        );
    }
}
