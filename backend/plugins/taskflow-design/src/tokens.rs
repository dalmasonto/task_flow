//! Design tokens JSON model + json<->css codec.
//!
//! Tokens are authored as JSON (`styles/tokens.json`, the source of truth)
//! and served as CSS (`styles/tokens.css`, generated). This module is the
//! ONE place that defines the `--var` naming convention, so:
//!   - the generated CSS keeps the exact `--<var>` names pages/components
//!     already reference (e.g. `bg-[var(--accent)]`), and
//!   - `manifest.rs` (Task 4) can read tokens back using the same rules via
//!     `var_name_to_category`, instead of duplicating the convention.
//!
//! ## Ordering
//! `indexmap` is not a dependency of this workspace (checked: absent from
//! `backend/Cargo.toml` and every plugin's `Cargo.toml`; it only appears in
//! `Cargo.lock` transitively via `toml_edit`, and `serde_json`'s
//! `preserve_order` feature is not enabled anywhere), so rather than add a
//! new dependency this module hand-rolls a minimal order-preserving map
//! (`OrderedMap`). This is safe and sufficient: serde_json's deserializer
//! visits map entries in the *textual* order they appear in the input
//! (driven by the token stream, not by an intermediate `Value`), regardless
//! of the `preserve_order` feature — that feature only changes how
//! `serde_json::Value`'s own `Map` type stores entries internally.

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::marker::PhantomData;

/// Known top-level token categories.
pub const KNOWN_CATEGORIES: &[&str] =
    &["colors", "spacing", "radius", "typography", "shadows", "custom"];

/// A `String`-keyed map that preserves insertion (or parse) order. See the
/// module docs for why this exists instead of `indexmap::IndexMap`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrderedMap<V>(pub Vec<(String, V)>);

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        OrderedMap(Vec::new())
    }

    pub fn iter(&self) -> impl Iterator<Item = &(String, V)> {
        self.0.iter()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// Insert `value` under `key`, or replace the existing entry in place
    /// (preserving its original position) if `key` is already present.
    pub fn insert(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        if let Some(existing) = self.get_mut(&key) {
            *existing = value;
        } else {
            self.0.push((key, value));
        }
    }

    /// Get the entry for `key`, inserting `default()` if absent, and return
    /// a mutable reference to it (mirrors `HashMap::entry(..).or_insert_with`).
    pub fn entry_or_insert_with(&mut self, key: &str, default: impl FnOnce() -> V) -> &mut V {
        if !self.0.iter().any(|(k, _)| k == key) {
            self.0.push((key.to_string(), default()));
        }
        self.get_mut(key).expect("just inserted")
    }
}

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedMapVisitor<V>(PhantomData<V>);

        impl<'de, V: Deserialize<'de>> Visitor<'de> for OrderedMapVisitor<V> {
            type Value = OrderedMap<V>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut out = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some((k, v)) = map.next_entry::<String, V>()? {
                    out.push((k, v));
                }
                Ok(OrderedMap(out))
            }
        }

        deserializer.deserialize_map(OrderedMapVisitor(PhantomData))
    }
}

/// A single token's value: always a light value, optionally a dark override.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenValue {
    pub light: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dark: Option<String>,
}

/// The tokens JSON source of truth: `styles/tokens.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokensDoc {
    pub version: u32,
    pub categories: OrderedMap<OrderedMap<TokenValue>>,
}

impl Default for TokensDoc {
    fn default() -> Self {
        TokensDoc {
            version: 1,
            categories: OrderedMap::new(),
        }
    }
}

/// Derive the CSS custom-property name for a token, given its category and
/// key. This is the ONE place the naming convention lives; `manifest.rs`
/// (Task 4) reuses `var_name_to_category` (the inverse) to read tokens back
/// from CSS with the exact same rules, so existing `var(--accent)` etc.
/// references in pages/components keep resolving.
///
/// Convention (matches the fixtures referenced by `manifest.rs:221` for
/// radius/spacing/typography; colors are bare per controller ruling — the
/// existing fixtures use `--accent`, `--bg`, NOT `--color-accent`):
///   - `colors`     -> `--<key>`               (bare)
///   - `radius`     -> `--radius-<key>`
///   - `spacing`    -> `--spacing-<key>`
///   - `shadows`    -> `--shadow-<key>`
///   - `typography` -> `--<key>` if `key` already starts with "font" or
///                     "text" (e.g. key `font-sans` -> `--font-sans`),
///                     else `--font-<key>` (arbitrary default prefix)
///   - anything else (including `custom`) -> `key` used VERBATIM as the
///     full `--...` name if it already starts with `--`, else `--<key>`
pub fn category_to_var_name(category: &str, key: &str) -> String {
    match category {
        "colors" => format!("--{key}"),
        "radius" => format!("--radius-{key}"),
        "spacing" => format!("--spacing-{key}"),
        "shadows" => format!("--shadow-{key}"),
        "typography" => {
            if key.starts_with("font") || key.starts_with("text") {
                format!("--{key}")
            } else {
                format!("--font-{key}")
            }
        }
        _ => {
            if let Some(stripped) = key.strip_prefix("--") {
                format!("--{stripped}")
            } else {
                format!("--{key}")
            }
        }
    }
}

/// Inverse of [`category_to_var_name`]: bucket a raw `--var` name from CSS
/// into `(category, key)`. Prefix-matches the known non-color categories
/// first (radius/spacing/shadow/font/text); anything left over — including
/// bare names like `--accent` — falls into `custom` with the FULL var name
/// kept verbatim as the key, since a bare `--name` alone can't be
/// distinguished from an intentionally-verbatim custom property once it's
/// only visible as raw CSS text (no category is recorded in plain CSS).
/// This still regenerates byte-identical CSS (`custom` also emits its key
/// verbatim), so `css -> json -> css` is stable even though the category
/// label for a bare color var may differ from how it was originally
/// authored in JSON.
pub fn var_name_to_category(var_name: &str) -> (&'static str, String) {
    if let Some(rest) = var_name.strip_prefix("--radius-") {
        return ("radius", rest.to_string());
    }
    if let Some(rest) = var_name.strip_prefix("--spacing-") {
        return ("spacing", rest.to_string());
    }
    if let Some(rest) = var_name.strip_prefix("--shadow-") {
        return ("shadows", rest.to_string());
    }
    if let Some(rest) = var_name.strip_prefix("--font-") {
        return ("typography", format!("font-{rest}"));
    }
    if let Some(rest) = var_name.strip_prefix("--text-") {
        return ("typography", format!("text-{rest}"));
    }
    ("custom", var_name.to_string())
}

/// Generate the served CSS from the JSON tokens document.
///
/// Emits, in order: `@theme { <light values> }` (all light values, so
/// Tailwind's scale container is present), `:root { <light values> }` (the
/// runtime vars pages reference), then `.dark { <only tokens with a dark
/// value> }`. Category/key iteration order follows `doc.categories`'
/// insertion order so the output is stable and diffable.
pub fn tokens_json_to_css(doc: &TokensDoc) -> String {
    let mut light_lines: Vec<String> = Vec::new();
    let mut dark_lines: Vec<String> = Vec::new();

    for (category, tokens) in doc.categories.iter() {
        for (key, value) in tokens.iter() {
            let var_name = category_to_var_name(category, key);
            light_lines.push(format!("  {var_name}: {};", value.light));
            if let Some(dark) = &value.dark {
                dark_lines.push(format!("  {var_name}: {dark};"));
            }
        }
    }

    let mut out = String::new();
    out.push_str("@theme {\n");
    for line in &light_lines {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("}\n\n:root {\n");
    for line in &light_lines {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("}\n");

    if !dark_lines.is_empty() {
        out.push_str("\n.dark {\n");
        for line in &dark_lines {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str("}\n");
    }

    out
}

/// Extract the raw contents of the first `{ ... }` block following the
/// literal `selector` text (e.g. `"@theme"`, `":root"`, `".dark"`). Assumes
/// flat (non-nested) declaration blocks, matching `manifest.rs`'s
/// `parse_token_groups` scan approach.
fn extract_block<'a>(css: &'a str, selector: &str) -> Option<&'a str> {
    let start = css.find(selector)?;
    let after_selector = &css[start + selector.len()..];
    let brace = after_selector.find('{')?;
    let body_start = &after_selector[brace + 1..];
    let end = body_start.find('}')?;
    Some(&body_start[..end])
}

/// Scan a flat declaration block for `--name: value;` pairs, in the order
/// they appear.
fn parse_decls(block: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = block;
    while let Some(pos) = rest.find("--") {
        let tail = &rest[pos..];
        let Some(colon) = tail.find(':') else {
            break;
        };
        let name = tail[..colon].trim().to_string();
        let after_colon = &tail[colon + 1..];
        let (value, consumed) = match after_colon.find(';') {
            Some(semi) => (after_colon[..semi].trim().to_string(), semi + 1),
            None => (after_colon.trim().to_string(), after_colon.len()),
        };
        out.push((name, value));
        rest = &after_colon[consumed..];
    }
    out
}

/// Parse legacy/hand-authored CSS (or CSS-shaped input from an agent) back
/// into a [`TokensDoc`]. Scans `@theme` and `:root` for light values (merged,
/// first occurrence per name wins — they're normally identical since the
/// generator emits both) and `.dark` for dark overrides, then buckets each
/// `--var` name into a category via [`var_name_to_category`].
pub fn css_to_tokens_json(css: &str) -> TokensDoc {
    let mut lights: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for selector in ["@theme", ":root"] {
        if let Some(block) = extract_block(css, selector) {
            for (name, value) in parse_decls(block) {
                if seen.insert(name.clone()) {
                    lights.push((name, value));
                }
            }
        }
    }

    let darks: std::collections::HashMap<String, String> = extract_block(css, ".dark")
        .map(|block| parse_decls(block).into_iter().collect())
        .unwrap_or_default();

    let mut categories: OrderedMap<OrderedMap<TokenValue>> = OrderedMap::new();

    for (name, light) in &lights {
        let (category, key) = var_name_to_category(name);
        let dark = darks.get(name).cloned();
        categories
            .entry_or_insert_with(category, OrderedMap::new)
            .insert(key, TokenValue {
                light: light.clone(),
                dark,
            });
    }

    // Dark-only vars (no matching light decl) still need to round-trip.
    for (name, dark_value) in &darks {
        if lights.iter().any(|(n, _)| n == name) {
            continue;
        }
        let (category, key) = var_name_to_category(name);
        categories
            .entry_or_insert_with(category, OrderedMap::new)
            .insert(key, TokenValue {
                light: dark_value.clone(),
                dark: Some(dark_value.clone()),
            });
    }

    TokensDoc {
        version: 1,
        categories,
    }
}
