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
pub struct TokenGroup {
    pub name: String,
    /// `--name: value` entries parsed from tokens.css, in file order.
    pub variables: Vec<(String, String)>,
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

    // Tokens: group top-level custom properties in @theme by their prefix
    // (--color-*, --spacing-*, --radius-*, --font-*), plus an "other" group.
    let tokens_css = files
        .iter()
        .find(|f| f.kind == DesignFileKind::Token && f.path == "styles/tokens.css")
        .map(|f| f.content.clone())
        .unwrap_or_default();
    let tokens = parse_token_groups(&tokens_css);

    DesignManifest {
        project: project_id,
        routes,
        components,
        tokens,
        revision,
    }
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
        .map(|(name, variables)| TokenGroup { name, variables })
        .collect()
}

/// Convenience: manifest as the JSON value handlers return.
pub fn to_json(manifest: &DesignManifest) -> Value {
    serde_json::to_value(manifest).unwrap_or(Value::Null)
}
