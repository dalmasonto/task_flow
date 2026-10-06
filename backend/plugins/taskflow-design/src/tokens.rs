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

    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    /// Remove `key`, returning its value if it was present.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(at).1)
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

/// The base theme every other theme inherits from. Always exists.
pub const LIGHT: &str = "light";
/// The theme a legacy document (no `themes` list) declares implicitly.
pub const DARK: &str = "dark";
/// Themes per project, light included.
pub const MAX_THEMES: usize = 8;
/// Never a theme name: `light` is the implicit base; `both` and `all` are
/// design_screenshot's multi-theme values.
pub const RESERVED_THEME_NAMES: &[&str] = &["light", "both", "all"];

/// A theme name is a lowercase slug, `^[a-z][a-z0-9-]{0,31}$`. It lands in a
/// CSS attribute selector (`[data-theme="<name>"]`), an HTML attribute and a
/// URL query, so nothing else is ever accepted.
pub fn is_theme_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// A theme's display name when it has no label: the slug title-cased
/// (`high-contrast` -> `High Contrast`).
pub fn default_theme_label(name: &str) -> String {
    name.split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// One declared theme besides light: `{"name": "ocean", "label"?: "Ocean"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeDecl {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl ThemeDecl {
    pub fn named(name: impl Into<String>) -> Self {
        ThemeDecl { name: name.into(), label: None }
    }
}

/// A single token's values: the light (base) value plus one override per
/// theme that changes it. Serialised FLAT — `{"light": v, "dark": v, "ocean": v}`
/// — so the legacy `{light, dark?}` shape IS this shape with one theme and
/// every stored document reads and writes unchanged. A theme with no entry
/// inherits `light`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TokenValue {
    pub light: String,
    /// Theme name → value, in document order. Never holds `light`.
    pub themes: OrderedMap<String>,
}

impl TokenValue {
    pub fn new(light: impl Into<String>) -> Self {
        TokenValue { light: light.into(), themes: OrderedMap::new() }
    }

    /// Builder form of [`TokenValue::set`].
    pub fn with(mut self, theme: &str, value: impl Into<String>) -> Self {
        self.set(theme, value);
        self
    }

    /// The token's OWN value in `theme`: light's for `light`, else the
    /// override, if it has one.
    pub fn get(&self, theme: &str) -> Option<&str> {
        if theme == LIGHT {
            Some(self.light.as_str())
        } else {
            self.themes.get(theme).map(String::as_str)
        }
    }

    /// What the token renders with in `theme`: its override, else light.
    pub fn resolve(&self, theme: &str) -> &str {
        self.get(theme).unwrap_or(self.light.as_str())
    }

    pub fn set(&mut self, theme: &str, value: impl Into<String>) {
        if theme == LIGHT {
            self.light = value.into();
        } else {
            self.themes.insert(theme, value.into());
        }
    }

    /// Drop `theme`'s override (it inherits light again). Light itself is
    /// never removed — remove the token for that.
    pub fn remove(&mut self, theme: &str) -> Option<String> {
        if theme == LIGHT { None } else { self.themes.remove(theme) }
    }

    /// Every value: light first, then each override in order.
    pub fn values(&self) -> impl Iterator<Item = &String> {
        std::iter::once(&self.light).chain(self.themes.iter().map(|(_, v)| v))
    }
}

impl Serialize for TokenValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1 + self.themes.0.len()))?;
        map.serialize_entry(LIGHT, &self.light)?;
        for (theme, value) in self.themes.iter() {
            map.serialize_entry(theme, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for TokenValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // `null` for a theme reads as "no override" (old clients send
        // `"dark": null`); every other key is a theme name, which
        // `validate_tokens_json` checks against the declared list on write.
        let raw = OrderedMap::<Option<String>>::deserialize(deserializer)?;
        let mut light = None;
        let mut themes = OrderedMap::new();
        for (key, value) in raw.0 {
            if key == LIGHT {
                light = value;
            } else if let Some(value) = value {
                themes.insert(key, value);
            }
        }
        let light = light.ok_or_else(|| serde::de::Error::missing_field("light"))?;
        Ok(TokenValue { light, themes })
    }
}

/// The tokens JSON source of truth: `styles/tokens.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokensDoc {
    pub version: u32,
    /// #619: the themes besides light, in order. Absent on every legacy
    /// document, which then declares `dark` implicitly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub themes: Option<Vec<ThemeDecl>>,
    pub categories: OrderedMap<OrderedMap<TokenValue>>,
}

impl Default for TokensDoc {
    fn default() -> Self {
        TokensDoc {
            version: 1,
            themes: None,
            categories: OrderedMap::new(),
        }
    }
}

impl TokensDoc {
    /// The themes besides light, in order. A document with no `themes` list
    /// is the legacy light/dark pair, so `dark` is declared implicitly.
    pub fn theme_decls(&self) -> Vec<ThemeDecl> {
        self.themes.clone().unwrap_or_else(|| vec![ThemeDecl::named(DARK)])
    }

    /// Every theme a page can render in, light first.
    pub fn declared_themes(&self) -> Vec<String> {
        std::iter::once(LIGHT.to_string())
            .chain(self.theme_decls().into_iter().map(|t| t.name))
            .collect()
    }

    /// The theme's label, else [`default_theme_label`] (light is "Light").
    pub fn theme_label(&self, theme: &str) -> String {
        self.theme_decls()
            .into_iter()
            .find(|t| t.name == theme)
            .and_then(|t| t.label)
            .unwrap_or_else(|| default_theme_label(theme))
    }

    /// What the `--var` (emitted name) renders with in `theme`, found through
    /// the emitter's own naming rule, so `custom["--primary"]` counts too.
    pub fn resolve_var(&self, var: &str, theme: &str) -> Option<&str> {
        for (category, tokens) in self.categories.iter() {
            for (key, value) in tokens.iter() {
                if category_to_var_name(category, key) == var {
                    return Some(value.resolve(theme));
                }
            }
        }
        None
    }

    pub fn declares(&self, theme: &str) -> bool {
        theme == LIGHT || self.theme_decls().iter().any(|t| t.name == theme)
    }
}

/// The one rule set for a theme list (stored document and patch alike):
/// light is never listed, reserved names refused, slugs only, no duplicate,
/// labels 1-40 characters, at most [`MAX_THEMES`] including light.
pub fn check_theme_list(themes: &[ThemeDecl]) -> Result<(), String> {
    if themes.len() + 1 > MAX_THEMES {
        return Err(format!(
            "at most {MAX_THEMES} themes including light; this lists {}",
            themes.len() + 1
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for theme in themes {
        let name = theme.name.as_str();
        if name == LIGHT {
            return Err("`light` is the implicit base theme: list only the other themes, e.g. [{\"name\":\"dark\"},{\"name\":\"ocean\"}]".into());
        }
        if RESERVED_THEME_NAMES.contains(&name) {
            return Err(format!("`{name}` is reserved (design_screenshot uses it); pick another theme name"));
        }
        if !is_theme_name(name) {
            return Err(format!(
                "theme name `{name}` must be a lowercase slug: a letter, then letters, digits or `-`, at most 32"
            ));
        }
        if !seen.insert(name) {
            return Err(format!("theme `{name}` is listed twice"));
        }
        if let Some(label) = &theme.label {
            if label.trim().is_empty() || label.chars().count() > 40 {
                return Err(format!("theme `{name}`: a label is 1-40 characters"));
            }
        }
    }
    Ok(())
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

/// Generate the served CSS from a (normally EFFECTIVE) tokens document, in
/// shadcn's `globals.css` shape:
///
/// 1. `:root { <light values> }`
/// 2. One block per declared theme: dark as `:root[data-theme="dark"], .dark`
///    (the sandbox toggles `data-theme` (composer.rs); `.dark` makes the file
///    drop into a shadcn app), every other theme as
///    `:root[data-theme="<name>"]`, each with only its overrides; a theme with
///    none emits nothing.
/// 3. [`theme_bridge`] — `@theme inline`, mapping tokens into Tailwind's
///    namespaces. A plain stylesheet ignores it; the composer feeds the same
///    block to the Tailwind browser build as `text/tailwindcss`.
///
/// There is deliberately NO raw `@theme { values }` block any more: the browser
/// never compiled it, and in an app it would register `--primary` itself as a
/// theme variable.
pub fn tokens_json_to_css(doc: &TokensDoc) -> String {
    // Declared themes only, and only real slugs: a name reaches an attribute
    // selector here, so an unvalidated document can never inject one.
    let themes: Vec<String> = doc
        .theme_decls()
        .into_iter()
        .map(|t| t.name)
        .filter(|name| is_theme_name(name) && !RESERVED_THEME_NAMES.contains(&name.as_str()))
        .collect();
    let mut light_lines: Vec<String> = Vec::new();
    let mut theme_lines: Vec<Vec<String>> = vec![Vec::new(); themes.len()];
    for (category, tokens) in doc.categories.iter() {
        for (key, value) in tokens.iter() {
            let var_name = category_to_var_name(category, key);
            light_lines.push(format!("  {var_name}: {};", value.light));
            for (i, theme) in themes.iter().enumerate() {
                if let Some(v) = value.themes.get(theme) {
                    theme_lines[i].push(format!("  {var_name}: {v};"));
                }
            }
        }
    }

    let mut out = String::from(":root {\n");
    for line in &light_lines {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("}\n");
    for (theme, lines) in themes.iter().zip(&theme_lines) {
        if lines.is_empty() {
            continue;
        }
        if theme == DARK {
            // Byte-identical to the pre-#619 dark block (tests/tokens_legacy_pin.rs).
            out.push_str("\n:root[data-theme=\"dark\"], .dark {\n");
        } else {
            out.push_str(&format!("\n:root[data-theme=\"{theme}\"] {{\n"));
        }
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
        out.push_str("}\n");
    }
    out.push('\n');
    out.push_str(&theme_bridge(doc));
    out
}

/// The `@theme inline` block that makes Tailwind utilities read the tokens:
/// `--color-<k>: var(--<k>)` for every colour (the doc's `colors` keys plus the
/// shadcn colour names, which an effective doc always defines somewhere), and
/// the radius scale derived from `--radius` when the doc defines it. `inline`
/// keeps the `var()` reference, so a theme switch restyles at runtime.
/// A bare CSS-identifier-ish token key: `[A-Za-z0-9_-]+`.
pub fn is_ident(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn theme_bridge(doc: &TokensDoc) -> String {
    let mut names: Vec<String> = Vec::new();
    let mut defined: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (category, tokens) in doc.categories.iter() {
        for (key, _) in tokens.iter() {
            defined.insert(category_to_var_name(category, key));
            if category == "colors" && is_ident(key) && !names.contains(key) {
                names.push(key.clone());
            }
        }
    }
    for name in crate::defaults::default_color_names() {
        if defined.contains(&format!("--{name}")) && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }

    let mut out = String::from("@theme inline {\n");
    for name in &names {
        out.push_str(&format!("  --color-{name}: var(--{name});\n"));
    }
    if defined.contains("--radius") {
        for (step, expr) in [
            ("sm", "calc(var(--radius) * 0.6)"),
            ("md", "calc(var(--radius) * 0.8)"),
            ("lg", "var(--radius)"),
            ("xl", "calc(var(--radius) * 1.4)"),
            ("2xl", "calc(var(--radius) * 1.8)"),
            ("3xl", "calc(var(--radius) * 2.2)"),
            ("4xl", "calc(var(--radius) * 2.6)"),
        ] {
            // A project's own `radius.<step>` token wins over the derived one.
            if defined.contains(&format!("--radius-{step}")) {
                continue;
            }
            out.push_str(&format!("  --radius-{step}: {expr};\n"));
        }
    }
    out.push_str("}\n");
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

/// Like [`extract_block`], but `selector` must be a real selector: the first
/// occurrence directly followed (modulo whitespace) by `{`, so a mention such
/// as `@custom-variant dark (&:is(.dark *));` is not mistaken for it.
fn extract_selector_block<'a>(css: &'a str, selector: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(i) = css[from..].find(selector) {
        let at = from + i + selector.len();
        let rest = &css[at..];
        if rest.trim_start().starts_with('{') {
            let body = &rest[rest.find('{')? + 1..];
            let end = body.find('}')?;
            return Some(&body[..end]);
        }
        from = at;
    }
    None
}

/// `css` with every `@theme inline { … }` block removed.
fn strip_theme_inline(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(pos) = rest.find("@theme") {
        let after = &rest[pos + "@theme".len()..];
        if after.trim_start().starts_with("inline") {
            out.push_str(&rest[..pos]);
            match after.find('}') {
                Some(end) => rest = &after[end + 1..],
                None => return out,
            }
        } else {
            out.push_str(&rest[..pos + "@theme".len()]);
            rest = after;
        }
    }
    out.push_str(rest);
    out
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

/// Every `[data-theme="<name>"] … { … }` rule in `css`, in order: `(name,
/// body)`. Only a selector list may sit between the attribute and its `{` —
/// so `@custom-variant dark (&:where([data-theme="dark"] *));`, which has a
/// `;` before any brace, is not a block. Names that are not theme slugs (and
/// `light`/`both`/`all`) are skipped.
fn theme_blocks(css: &str) -> Vec<(String, &str)> {
    const OPEN: &str = "[data-theme=\"";
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = css[from..].find(OPEN) {
        let name_start = from + i + OPEN.len();
        let Some(close) = css[name_start..].find("\"]") else { break };
        let name = &css[name_start..name_start + close];
        let after = name_start + close + 2;
        from = after;
        let rest = &css[after..];
        let Some(brace) = rest.find('{') else { break };
        if rest[..brace].contains(['}', ';']) {
            continue;
        }
        let body = &rest[brace + 1..];
        let Some(end) = body.find('}') else { break };
        if is_theme_name(name) && !RESERVED_THEME_NAMES.contains(&name) {
            out.push((name.to_string(), &body[..end]));
        }
        from = after + brace + 1 + end + 1;
    }
    out
}

/// Parse legacy/hand-authored CSS (or CSS-shaped input from an agent) back
/// into a [`TokensDoc`]. Scans `@theme` and `:root` for light values (merged,
/// first occurrence per name wins — they're normally identical since the
/// generator emits both) and every `[data-theme="<name>"]` block plus `.dark` for theme overrides, then buckets
/// each `--var` name into a category via [`var_name_to_category`].
///
/// The dark block is read from BOTH our generated `:root[data-theme="dark"]`
/// selector AND a `.dark` class selector, so hand-authored / pasted CSS that
/// uses the common `.dark { … }` convention still imports its dark values. The
/// `@theme`/`:root` light scan must run first: `extract_block(":root")` matches
/// the `:root` inside `:root[data-theme="dark"]`, so scanning light before dark
/// (and de-duping by name) keeps light values from the plain `:root` block.
pub fn css_to_tokens_json(css: &str) -> TokensDoc {
    let mut lights: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // A plain `@theme {` (legacy) is a value source; `@theme inline {` is our
    // generated bridge (`--color-x: var(--x)`) and must never become tokens.
    let legacy_css = strip_theme_inline(css);
    for selector in ["@theme", ":root"] {
        if let Some(block) = extract_block(&legacy_css, selector) {
            for (name, value) in parse_decls(block) {
                if seen.insert(name.clone()) {
                    lights.push((name, value));
                }
            }
        }
    }

    // Theme overrides, theme by theme: every `[data-theme="<name>"]` block
    // (our generated selectors and hand-written ones alike), then a `.dark { … }`
    // class block for pasted shadcn CSS. A var set twice for one theme keeps
    // its first value, so `[data-theme="dark"]` wins over `.dark`.
    let mut theme_values: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut add = |theme: &str, decls: Vec<(String, String)>| {
        let at = match theme_values.iter().position(|(t, _)| t == theme) {
            Some(at) => at,
            None => {
                theme_values.push((theme.to_string(), Vec::new()));
                theme_values.len() - 1
            }
        };
        for (name, value) in decls {
            if !theme_values[at].1.iter().any(|(n, _)| *n == name) {
                theme_values[at].1.push((name, value));
            }
        }
    };
    for (theme, block) in theme_blocks(&legacy_css) {
        add(&theme, parse_decls(block));
    }
    if let Some(block) = extract_selector_block(&legacy_css, ".dark") {
        add(DARK, parse_decls(block));
    }
    // `dark` leads the imported themes, as it does in every generated file.
    theme_values.sort_by_key(|(theme, _)| theme != DARK);

    let mut by_var: OrderedMap<TokenValue> = OrderedMap::new();
    for (name, light) in &lights {
        by_var.insert(name.clone(), TokenValue::new(light.clone()));
    }
    for (theme, decls) in &theme_values {
        for (name, value) in decls {
            match by_var.get_mut(name) {
                Some(token) => token.set(theme, value.clone()),
                // A var only a theme sets still round-trips: light takes that value.
                None => by_var.insert(name.clone(), TokenValue::new(value.clone()).with(theme, value.clone())),
            }
        }
    }

    let mut categories: OrderedMap<OrderedMap<TokenValue>> = OrderedMap::new();
    for (name, value) in by_var.0 {
        let (category, key) = var_name_to_category(&name);
        categories.entry_or_insert_with(category, OrderedMap::new).insert(key, value);
    }
    let names: Vec<&str> = theme_values.iter().map(|(t, _)| t.as_str()).collect();
    // Only dark (or nothing): the legacy shape, so a light/dark import is unchanged.
    let themes = if names.is_empty() || names == [DARK] {
        None
    } else {
        Some(names.iter().map(|n| ThemeDecl::named(*n)).collect())
    };
    TokensDoc { version: 1, themes, categories }
}

/// What a patch's `themes` list did, for the write reply.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ThemeChanges {
    /// Themes the new list left out: deleted with every value they held.
    pub removed: Vec<String>,
    /// `(from, to)` renames; their values moved with them.
    pub renamed: Vec<(String, String)>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThemePatchEntry {
    name: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    rename_from: Option<String>,
}

/// Replace the document's theme list with a patch's `themes` — the FULL
/// ordered list besides light. A `rename_from` moves that theme's values to
/// the new name; a theme left out loses its values.
fn apply_theme_list(doc: &mut TokensDoc, raw: &serde_json::Value) -> Result<ThemeChanges, String> {
    let entries: Vec<ThemePatchEntry> = serde_json::from_value(raw.clone()).map_err(|e| {
        format!(
            "patch.themes must be the FULL ordered list of themes besides light, e.g. \
             [{{\"name\":\"dark\"}},{{\"name\":\"ocean\",\"label\":\"Ocean\"}}]: {e}"
        )
    })?;
    let next: Vec<ThemeDecl> = entries
        .iter()
        .map(|e| ThemeDecl { name: e.name.clone(), label: e.label.clone() })
        .collect();
    check_theme_list(&next).map_err(|e| format!("patch.themes: {e}"))?;
    let declared_before = doc.declared_themes();
    let current: Vec<String> = doc.theme_decls().into_iter().map(|t| t.name).collect();
    let mut changes = ThemeChanges::default();
    for entry in &entries {
        let Some(from) = entry.rename_from.as_deref() else { continue };
        if from == entry.name {
            continue;
        }
        if !current.iter().any(|c| c == from) {
            return Err(format!(
                "patch.themes: cannot rename `{from}`: it is not a theme here (themes: {})",
                declared_before.join(", ")
            ));
        }
        // "Also kept" = an entry still named `from` that is NOT itself a rename
        // target (in a swap, the entry named `from` came from elsewhere).
        if entries
            .iter()
            .any(|e| e.name == from && e.rename_from.as_deref().is_none_or(|f| f == from))
        {
            return Err(format!("patch.themes: `{from}` is renamed to `{}` and also kept; list it once", entry.name));
        }
        if changes.renamed.iter().any(|(f, _)| f == from) {
            return Err(format!("patch.themes: `{from}` is renamed twice"));
        }
        changes.renamed.push((from.to_string(), entry.name.clone()));
    }
    changes.removed = current
        .iter()
        .filter(|c| !next.iter().any(|t| &t.name == *c) && !changes.renamed.iter().any(|(f, _)| f == *c))
        .cloned()
        .collect();
    for (_, tokens) in doc.categories.0.iter_mut() {
        for (_, value) in tokens.0.iter_mut() {
            for gone in &changes.removed {
                value.themes.remove(gone);
            }
            // Take every renamed value out first, then put them back, so a
            // swap (dark→ocean, ocean→dark) cannot overwrite itself.
            let moved: Vec<(String, String)> = changes
                .renamed
                .iter()
                .filter_map(|(from, to)| value.themes.remove(from).map(|v| (to.clone(), v)))
                .collect();
            for (to, v) in moved {
                value.themes.insert(to, v);
            }
        }
    }
    doc.themes = Some(next);
    Ok(changes)
}

/// Merge a PATCH into a tokens document, in its stored shape:
/// `{ "themes"?: [...], "<category>": { "<key>": { "light"?: v, "<theme>"?: v } | null } }`.
///
/// `themes` (when given) is applied first and is the FULL new list besides
/// light (see [`apply_theme_list`]); then each token replaces only the themes
/// it names — a string sets, `null` drops that theme's value (light cannot be
/// dropped; null the token to remove it), and a name the document (after the
/// list change) does not declare is an error. `null` for a token removes it
/// (an emptied category goes too); a new category or key is added at the end.
/// `design_write_tokens({patch})` and `design_compare`'s `apply` speak this shape.
pub fn apply_patch(doc: &mut TokensDoc, patch: &serde_json::Value) -> Result<ThemeChanges, String> {
    let categories = patch
        .as_object()
        .ok_or("patch must be an object of categories, e.g. {\"colors\": {\"primary\": {\"light\": \"#448502\"}}}")?;
    let changes = match categories.get("themes") {
        Some(themes) => apply_theme_list(doc, themes)?,
        None => ThemeChanges::default(),
    };
    let declared = doc.declared_themes();
    for (category, entries) in categories {
        if category == "themes" {
            continue;
        }
        let entries = entries
            .as_object()
            .ok_or_else(|| format!("patch.{category} must be an object of tokens"))?;
        for (key, value) in entries {
            if value.is_null() {
                if let Some(existing) = doc.categories.get_mut(category) {
                    existing.0.retain(|(k, _)| k != key);
                }
                continue;
            }
            let fields = value.as_object().ok_or_else(|| {
                format!("patch.{category}.{key} must be {{\"light\"?, \"<theme>\"?: value}} or null")
            })?;
            if fields.is_empty() {
                return Err(format!(
                    "patch.{category}.{key}: give light and/or a theme's value (or null to remove the token)"
                ));
            }
            if let Some(unknown) = fields.keys().find(|name| !declared.contains(*name)) {
                return Err(format!(
                    "patch.{category}.{key}: unknown theme `{unknown}` (themes: {}). Declare it in the same \
                     patch: {{\"themes\": [<every theme to keep>, {{\"name\": \"{unknown}\"}}]}}",
                    declared.join(", ")
                ));
            }
            let tokens = doc.categories.entry_or_insert_with(category, OrderedMap::new);
            let token = tokens.entry_or_insert_with(key, TokenValue::default);
            for (theme, v) in fields {
                match v {
                    serde_json::Value::String(s) => token.set(theme, s.clone()),
                    serde_json::Value::Null if theme == LIGHT => {
                        return Err(format!(
                            "patch.{category}.{key}.light cannot be null: null the whole token to remove it"
                        ));
                    }
                    serde_json::Value::Null => {
                        token.remove(theme);
                    }
                    _ => {
                        return Err(format!(
                            "patch.{category}.{key}.{theme} must be a string, or null to drop that theme's value"
                        ));
                    }
                }
            }
            if token.light.is_empty() {
                return Err(format!("patch.{category}.{key}: a new token needs a light value"));
            }
        }
    }
    doc.categories.0.retain(|(_, tokens)| !tokens.is_empty());
    Ok(changes)
}

/// The project's STORED token document: the `styles/tokens.json` row, else a
/// legacy `styles/tokens.css` row imported via [`css_to_tokens_json`], else
/// empty. This is what the project defines — NOT what renders; pass it through
/// `defaults::effective_tokens` for that.
pub fn project_tokens_doc(files: &[crate::models::DesignFile]) -> TokensDoc {
    use crate::models::DesignFileKind;
    let content = |path: &str| {
        files
            .iter()
            .find(|f| f.kind == DesignFileKind::Token && f.path == path)
            .map(|f| f.content.as_str())
    };
    project_tokens_doc_from(content("styles/tokens.json"), content("styles/tokens.css"))
}

/// The one place the precedence lives: a parseable `styles/tokens.json` row
/// wins, else the legacy `styles/tokens.css` row imported, else empty.
pub fn project_tokens_doc_from(json: Option<&str>, css: Option<&str>) -> TokensDoc {
    json.and_then(|j| serde_json::from_str::<TokensDoc>(j).ok())
        .or_else(|| css.map(css_to_tokens_json))
        .unwrap_or_default()
}

/// [`project_tokens_doc`] loading only the two token rows (not every file).
pub async fn load_project_tokens_doc(project_id: i64) -> TokensDoc {
    let json = crate::store::load_file(project_id, "styles/tokens.json").await;
    let css = crate::store::load_file(project_id, "styles/tokens.css").await;
    project_tokens_doc_from(json.as_ref().map(|f| f.content.as_str()), css.as_ref().map(|f| f.content.as_str()))
}

#[cfg(test)]
mod patch_tests {
    use super::*;

    fn doc() -> TokensDoc {
        serde_json::from_str(
            r##"{"version":1,"categories":{
              "colors":{"primary":{"light":"#15803D","dark":"#22C55E"},"bg":{"light":"#fff","dark":"#000"}},
              "radius":{"md":{"light":"8px"}}}}"##,
        )
        .expect("doc")
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let mut d = doc();
        apply_patch(&mut d, &serde_json::json!({ "colors": { "primary": { "light": "#448502" } } })).expect("ok");
        let json = serde_json::to_value(&d).expect("json");
        assert_eq!(json["categories"]["colors"]["primary"], serde_json::json!({ "light": "#448502", "dark": "#22C55E" }));
        assert_eq!(json["categories"]["colors"]["bg"], serde_json::json!({ "light": "#fff", "dark": "#000" }));
        assert_eq!(json["categories"]["radius"]["md"], serde_json::json!({ "light": "8px" }));
        // Order is kept: colors stays first, primary stays before bg.
        assert_eq!(serde_json::to_string(&d).expect("s").find("primary") < serde_json::to_string(&d).expect("s").find("\"bg\""), true);
    }

    #[test]
    fn a_patch_can_target_any_declared_theme() {
        let mut d = doc();
        let changes = apply_patch(
            &mut d,
            &serde_json::json!({ "themes": [{ "name": "dark" }, { "name": "ocean" }], "colors": { "primary": { "ocean": "#0af" } } }),
        )
        .expect("ok");
        assert_eq!(changes, ThemeChanges::default());
        let json = serde_json::to_value(&d).expect("json");
        assert_eq!(json["categories"]["colors"]["primary"], serde_json::json!({ "light": "#15803D", "dark": "#22C55E", "ocean": "#0af" }));
        apply_patch(&mut d, &serde_json::json!({ "colors": { "primary": { "ocean": null } } })).expect("null drops");
        assert_eq!(serde_json::to_value(&d).expect("json")["categories"]["colors"]["primary"], serde_json::json!({ "light": "#15803D", "dark": "#22C55E" }));
        let err = apply_patch(&mut doc(), &serde_json::json!({ "colors": { "primary": { "sunset": "#f00" } } })).unwrap_err();
        assert!(err.contains("unknown theme `sunset`") && err.contains("light, dark"), "{err}");
        assert!(apply_patch(&mut doc(), &serde_json::json!({ "colors": { "primary": { "light": null } } })).is_err());
    }

    #[test]
    fn the_theme_list_renames_reorders_and_deletes() {
        let mut d = doc();
        apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "dark" }, { "name": "ocean" }], "colors": { "primary": { "ocean": "#0af" } } })).expect("add");
        let changes = apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "sea", "rename_from": "ocean" }, { "name": "night", "rename_from": "dark" }] })).expect("rename + reorder");
        assert_eq!(changes.renamed, vec![("ocean".to_string(), "sea".to_string()), ("dark".to_string(), "night".to_string())]);
        assert_eq!(d.declared_themes(), ["light", "sea", "night"].map(String::from).to_vec());
        assert_eq!(serde_json::to_value(&d).expect("json")["categories"]["colors"]["primary"], serde_json::json!({ "light": "#15803D", "sea": "#0af", "night": "#22C55E" }));
        let changes = apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "sea" }] })).expect("delete night");
        assert_eq!(changes.removed, vec!["night".to_string()]);
        assert!(serde_json::to_value(&d).expect("json")["categories"]["colors"]["bg"].get("night").is_none());
        // Swapping two names is two renames, not a collision.
        let mut s = doc();
        apply_patch(&mut s, &serde_json::json!({ "themes": [{ "name": "dark" }, { "name": "ocean" }], "colors": { "primary": { "ocean": "#0af" } } })).expect("add");
        apply_patch(&mut s, &serde_json::json!({ "themes": [{ "name": "ocean", "rename_from": "dark" }, { "name": "dark", "rename_from": "ocean" }] })).expect("swap");
        assert_eq!(serde_json::to_value(&s).expect("json")["categories"]["colors"]["primary"], serde_json::json!({ "light": "#15803D", "ocean": "#22C55E", "dark": "#0af" }));
        for bad in [
            serde_json::json!({ "themes": [{ "name": "light" }] }),
            serde_json::json!({ "themes": [{ "name": "x", "rename_from": "nope" }] }),
            serde_json::json!({ "themes": [{ "name": "x", "rename_from": "dark" }, { "name": "dark" }] }),
            serde_json::json!({ "themes": [{ "name": "x", "colour": "red" }] }),
            serde_json::json!({ "themes": "dark" }),
        ] {
            assert!(apply_patch(&mut doc(), &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn null_removes_and_new_tokens_need_a_light_value() {
        let mut d = doc();
        apply_patch(&mut d, &serde_json::json!({ "radius": { "md": null }, "colors": { "accent": { "light": "#f00" } } })).expect("ok");
        let json = serde_json::to_value(&d).expect("json");
        assert!(json["categories"].get("radius").is_none(), "an emptied category goes too");
        assert_eq!(json["categories"]["colors"]["accent"]["light"], "#f00");
        assert!(apply_patch(&mut doc(), &serde_json::json!({ "colors": { "x": { "dark": "#000" } } })).is_err());
        assert!(apply_patch(&mut doc(), &serde_json::json!({ "colors": { "primary": { "shade": "#000" } } })).is_err());
        assert!(apply_patch(&mut doc(), &serde_json::json!(["nope"])).is_err());
    }
}

/// One token's change between two documents, for a compact write reply.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TokenChange {
    /// `category.key`, the path a patch uses.
    pub token: String,
    /// The CSS custom property it emits, what pages reference.
    pub var: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<TokenValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<TokenValue>,
}

/// Every token added, changed or removed from `old` to `new`, in `new`'s
/// order then removals.
pub fn diff(old: &TokensDoc, new: &TokensDoc) -> Vec<TokenChange> {
    let find = |doc: &TokensDoc, category: &str, key: &str| -> Option<TokenValue> {
        doc.categories
            .iter()
            .find(|(c, _)| c == category)
            .and_then(|(_, tokens)| tokens.iter().find(|(k, _)| k == key))
            .map(|(_, v)| v.clone())
    };
    let mut changes = Vec::new();
    for (category, tokens) in new.categories.iter() {
        for (key, after) in tokens.iter() {
            let before = find(old, category, key);
            if before.as_ref() != Some(after) {
                changes.push(TokenChange {
                    token: format!("{category}.{key}"),
                    var: category_to_var_name(category, key),
                    before,
                    after: Some(after.clone()),
                });
            }
        }
    }
    for (category, tokens) in old.categories.iter() {
        for (key, before) in tokens.iter() {
            if find(new, category, key).is_none() {
                changes.push(TokenChange {
                    token: format!("{category}.{key}"),
                    var: category_to_var_name(category, key),
                    before: Some(before.clone()),
                    after: None,
                });
            }
        }
    }
    changes
}

#[cfg(test)]
mod theme_model_tests {
    use super::*;

    #[test]
    fn a_legacy_document_declares_light_and_dark_implicitly() {
        let raw = r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"},"bg":{"light":"#fff"}}}}"##;
        let doc: TokensDoc = serde_json::from_str(raw).expect("legacy doc");
        assert_eq!(doc.themes, None);
        assert_eq!(doc.declared_themes(), vec!["light".to_string(), "dark".to_string()]);
        assert!(doc.declares("dark") && !doc.declares("ocean"));
        assert_eq!(serde_json::to_string(&doc).expect("json"), raw);
    }

    #[test]
    fn named_themes_are_flat_keys_beside_light() {
        let raw = r##"{"version":1,"themes":[{"name":"dark"},{"name":"ocean","label":"Ocean"}],"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E","ocean":"#00AAFF"}}}}"##;
        let doc: TokensDoc = serde_json::from_str(raw).expect("themed doc");
        assert_eq!(doc.declared_themes(), ["light", "dark", "ocean"].map(String::from).to_vec());
        let primary = doc.categories.get("colors").and_then(|c| c.get("primary")).expect("primary");
        assert_eq!(primary.get("ocean"), Some("#00AAFF"));
        assert_eq!(primary.get("light"), Some("#15803D"));
        assert_eq!(primary.resolve("ocean"), "#00AAFF");
        assert_eq!(primary.resolve("sunset"), "#15803D", "a theme with no override inherits light");
        assert_eq!(serde_json::to_string(&doc).expect("json"), raw);
    }

    #[test]
    fn a_null_override_reads_as_absent_and_light_is_required() {
        let doc: TokensDoc =
            serde_json::from_str(r#"{"version":1,"categories":{"colors":{"x":{"light":"red","dark":null}}}}"#)
                .expect("null dark");
        assert!(doc.categories.get("colors").and_then(|c| c.get("x")).expect("x").themes.is_empty());
        assert!(serde_json::from_str::<TokensDoc>(r#"{"version":1,"categories":{"colors":{"x":{"dark":"red"}}}}"#).is_err());
        assert!(serde_json::from_str::<TokensDoc>(r#"{"version":1,"categories":{"colors":{"x":{"light":3}}}}"#).is_err());
    }

    #[test]
    fn set_and_remove_address_one_theme() {
        let mut v = TokenValue::new("#111").with("dark", "#eee");
        v.set("ocean", "#0af");
        v.set("light", "#222");
        assert_eq!(v.light, "#222");
        assert_eq!(v.remove("dark"), Some("#eee".to_string()));
        assert_eq!(v.remove("light"), None, "light is never removed");
        assert_eq!(v.values().cloned().collect::<Vec<_>>(), vec!["#222".to_string(), "#0af".to_string()]);
    }

    #[test]
    fn theme_names_are_lowercase_slugs() {
        for ok in ["dark", "ocean", "high-contrast", "a1"] {
            assert!(is_theme_name(ok), "{ok}");
        }
        let long = "a".repeat(33);
        for bad in ["", "Ocean", "1ocean", "my theme", "-x", "x\"]", long.as_str()] {
            assert!(!is_theme_name(bad), "{bad}");
        }
    }
}
