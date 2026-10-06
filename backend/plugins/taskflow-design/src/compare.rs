//! `design_compare` and token overrides (#522): render screens with UNSAVED
//! design changes, and many of them side by side in one picture.
//!
//! OVERRIDES. A variant is a set of CSS custom-property values (plus, rarely,
//! a little extra CSS). They are never stored: they travel base64url-encoded
//! in the sandbox URL (`?ov=`) and the composer appends them as
//! `<style id="tf-override">` after `tokens.css`, so they win at equal
//! specificity. Because anyone holding a sandbox token could hand-craft that
//! parameter, every value is validated here, on the way in AND on the way
//! out (the sandbox route decodes and re-validates): names must be custom
//! properties, values cannot close a declaration, a block or the `<style>`
//! element, and nothing can load a resource. At worst a crafted override
//! restyles the crafter's own view of a page they can already read.
//!
//! THE GRID. `/s/{token}/compare.grid?spec=` is a sandbox page of its own (a
//! page route can never contain a dot, so it cannot shadow a real page): a
//! labelled table with one scaled `<iframe>` per route × variant × theme,
//! each pointing at the ordinary sandbox page with that variant's `?ov=` and
//! `?theme=`. The frames are same-origin, so the grid's own script waits for
//! each to load, measures the requested contrast `checks` inside them, and
//! exposes `window.__tfReady` / `window.__tfResult` for the renderer.

use std::collections::BTreeMap;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::tokens::{LIGHT, OrderedMap, TokenValue, TokensDoc, category_to_var_name, is_theme_name};

/// An override's value: one value for every theme, or per theme
/// (`{"light"?, "dark"?, "<theme>"?}` — #619: any theme slug).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OverrideValue {
    Both(String),
    PerTheme(BTreeMap<String, String>),
}

/// One variant's unsaved changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Overrides {
    /// `--name` → value.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tokens: BTreeMap<String, OverrideValue>,
    /// Extra CSS for what tokens cannot express yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
}

impl Overrides {
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty() && self.css.as_deref().is_none_or(|c| c.trim().is_empty())
    }
}

const MAX_OVERRIDES: usize = 40;
const MAX_VALUE_LEN: usize = 200;
const MAX_CSS_LEN: usize = 4000;
/// Substrings that could load a resource or run code, in a value or in `css`.
const FORBIDDEN: [&str; 6] = ["url(", "@", "expression", "javascript:", "\\", "/*"];

fn valid_name(name: &str) -> bool {
    name.len() <= 64
        && name
            .strip_prefix("--")
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

fn check_value(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > MAX_VALUE_LEN {
        return Err(format!("{name}: a value must be 1–{MAX_VALUE_LEN} characters"));
    }
    if value.contains([';', '{', '}', '<', '>', '"', '\'', '\n', '\r']) {
        return Err(format!("{name}: a value may not contain ; {{ }} < > quotes or newlines"));
    }
    let lower = value.to_ascii_lowercase();
    if let Some(bad) = FORBIDDEN.iter().find(|bad| lower.contains(**bad)) {
        return Err(format!("{name}: `{bad}` is not allowed in an override"));
    }
    Ok(())
}

/// Refuse anything that is not a plain custom-property override.
pub fn validate(ov: &Overrides) -> Result<(), String> {
    if ov.tokens.len() > MAX_OVERRIDES {
        return Err(format!("at most {MAX_OVERRIDES} token overrides per variant"));
    }
    for (name, value) in &ov.tokens {
        if !valid_name(name) {
            return Err(format!("`{name}` is not a CSS custom property name (--letters-digits-dashes)"));
        }
        match value {
            OverrideValue::Both(v) => check_value(name, v)?,
            OverrideValue::PerTheme(themes) => {
                if themes.is_empty() {
                    return Err(format!("{name}: give a value, or per theme {{\"light\"?, \"dark\"?, \"<theme>\"?}}"));
                }
                for (theme, v) in themes {
                    // The key lands in `[data-theme="…"]`: slugs only.
                    if !is_theme_name(theme) {
                        return Err(format!("{name}: `{theme}` is not a theme name"));
                    }
                    check_value(name, v)?;
                }
            }
        }
    }
    if let Some(css) = &ov.css {
        if css.len() > MAX_CSS_LEN {
            return Err(format!("css is limited to {MAX_CSS_LEN} characters"));
        }
        let lower = css.to_ascii_lowercase();
        if css.contains('<') {
            return Err("css may not contain `<`".into());
        }
        if let Some(bad) = FORBIDDEN.iter().find(|bad| lower.contains(**bad)) {
            return Err(format!("`{bad}` is not allowed in css"));
        }
        if css.matches('{').count() != css.matches('}').count() {
            return Err("css has unbalanced braces".into());
        }
    }
    Ok(())
}

/// #619: every per-theme override names a theme the project declares — an
/// undeclared one would never render, and its `apply` patch would be refused.
pub fn check_override_themes(ov: &Overrides, declared: &[String]) -> Result<(), String> {
    for (name, value) in &ov.tokens {
        if let OverrideValue::PerTheme(themes) = value {
            if let Some(theme) = themes.keys().find(|t| !declared.contains(t)) {
                return Err(format!(
                    "{name}: theme `{theme}` is not declared in this project (themes: {})",
                    declared.join(", ")
                ));
            }
        }
    }
    Ok(())
}

/// The `<style>` block the composer appends to `<head>`. A single value goes
/// in `:root` and in `:root[data-theme]` (later and more specific than every
/// theme block in tokens.css), so it applies in every theme — which is what
/// "set --primary to X" means. A per-theme value goes in that theme's own block.
pub fn style_block(ov: &Overrides) -> String {
    let mut light = String::new();
    let mut every = String::new();
    let mut per_theme: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in &ov.tokens {
        match value {
            OverrideValue::Both(v) => {
                light.push_str(&format!("{name}:{v};"));
                every.push_str(&format!("{name}:{v};"));
            }
            OverrideValue::PerTheme(themes) => {
                for (theme, v) in themes {
                    if theme == LIGHT {
                        light.push_str(&format!("{name}:{v};"));
                    } else {
                        per_theme.entry(theme.clone()).or_default().push_str(&format!("{name}:{v};"));
                    }
                }
            }
        }
    }
    let mut css = String::new();
    if !light.is_empty() {
        css.push_str(&format!(":root{{{light}}}"));
    }
    if !every.is_empty() {
        css.push_str(&format!(":root[data-theme]{{{every}}}"));
    }
    for (theme, decls) in &per_theme {
        css.push_str(&format!(":root[data-theme=\"{theme}\"]{{{decls}}}"));
    }
    if let Some(extra) = ov.css.as_deref() {
        css.push_str(extra);
    }
    format!("<style id=\"tf-override\">{css}</style>")
}

/// `?ov=` value for these overrides (base64url JSON).
pub fn encode(ov: &Overrides) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(ov).unwrap_or_default())
}

/// Decode and re-validate an `?ov=` value.
pub fn decode(raw: &str) -> Result<Overrides, String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.trim_end_matches('='))
        .map_err(|_| "ov is not valid base64url".to_string())?;
    let ov: Overrides = serde_json::from_slice(&bytes).map_err(|e| format!("ov is not valid JSON: {e}"))?;
    validate(&ov)?;
    Ok(ov)
}

/// Insert the override block at the end of `<head>` (after `tokens.css`).
pub fn inject(html: String, ov: &Overrides) -> String {
    if ov.is_empty() {
        return html;
    }
    match html.find("</head>") {
        Some(at) => format!("{}{}{}", &html[..at], style_block(ov), &html[at..]),
        None => html,
    }
}

// ---------------------------------------------------------------------------
// apply: turn a variant into a design_write_tokens payload
// ---------------------------------------------------------------------------

/// The current tokens document with a variant's token overrides written into
/// it — exactly what `design_write_tokens { tokens }` needs to make the
/// variant the design. A `--var` is found through the emitter's own naming
/// rule run over the CURRENT document (the lossy inverse would file
/// `--primary` under `custom`); a name the document does not have is added
/// under `custom`, which emits it verbatim. Returns the names so added.
pub fn apply_to(doc: &TokensDoc, ov: &Overrides) -> (TokensDoc, Vec<String>) {
    let mut out = doc.clone();
    let mut index: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (category, entries) in doc.categories.iter() {
        for (key, _) in entries.iter() {
            index.insert(category_to_var_name(category, key), (category.clone(), key.clone()));
        }
    }
    let mut added = Vec::new();
    for (name, value) in &ov.tokens {
        let (category, key) = index.get(name).cloned().unwrap_or_else(|| {
            added.push(name.clone());
            ("custom".to_string(), name.clone())
        });
        let entries = out.categories.entry_or_insert_with(&category, OrderedMap::new);
        let token = entries.entry_or_insert_with(&key, TokenValue::default);
        match value {
            OverrideValue::Both(v) => {
                // As rendered: one value for every theme the token has.
                token.light = v.clone();
                for (_, existing) in token.themes.0.iter_mut() {
                    *existing = v.clone();
                }
            }
            OverrideValue::PerTheme(themes) => {
                for (theme, v) in themes {
                    token.set(theme, v.clone());
                }
                if token.light.is_empty() {
                    // A theme-only override of a token that had no light value.
                    token.light = themes.values().next().cloned().unwrap_or_default();
                }
            }
        }
    }
    // #619: the built-in defaults always carry `dark`; a project that does not
    // declare it (e.g. light + ocean only) must never get a dark value back,
    // or `design_write_tokens` refuses the patch ("unknown theme `dark`").
    // Keep light plus the DECLARED themes on every value.
    let declared = doc.declared_themes();
    for (_, entries) in out.categories.0.iter_mut() {
        for (_, token) in entries.0.iter_mut() {
            token.themes.0.retain(|(theme, _)| declared.contains(theme));
        }
    }
    (out, added)
}

/// What a variant CHANGES, in the stored patch shape
/// `{category: {key: {light, dark?}}}` — pass it as `patch` to
/// `design_write_tokens` to make the variant the design. Only the tokens the
/// variant overrides appear (the reply stays small); each carries the values
/// it rendered with. Returns the names added under `custom` too.
pub fn apply_diff(doc: &TokensDoc, ov: &Overrides) -> (serde_json::Value, Vec<String>) {
    let (merged, added) = apply_to(doc, ov);
    let mut index: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (category, entries) in merged.categories.iter() {
        for (key, _) in entries.iter() {
            index.insert(category_to_var_name(category, key), (category.clone(), key.clone()));
        }
    }
    let mut patch = serde_json::Map::new();
    for name in ov.tokens.keys() {
        let (category, key) = if added.contains(name) {
            ("custom".to_string(), name.clone())
        } else {
            match index.get(name) {
                Some(found) => found.clone(),
                None => continue,
            }
        };
        let Some(value) = merged
            .categories
            .iter()
            .find(|(c, _)| *c == category)
            .and_then(|(_, tokens)| tokens.iter().find(|(k, _)| *k == key))
            .map(|(_, v)| v)
        else {
            continue;
        };
        let entry = patch
            .entry(category)
            .or_insert_with(|| serde_json::Value::Object(Default::default()));
        if let Some(obj) = entry.as_object_mut() {
            obj.insert(key, serde_json::to_value(value).unwrap_or_default());
        }
    }
    (serde_json::Value::Object(patch), added)
}

/// Layer a variant's own overrides over shared ones: global tokens, then the
/// shared `tokens`, then the variant's (a name in both takes the variant's);
/// shared `css` first, then the variant's.
pub fn layered(shared: &Overrides, own: &Overrides) -> Overrides {
    let mut tokens = shared.tokens.clone();
    tokens.extend(own.tokens.clone());
    let css = match (shared.css.as_deref(), own.css.as_deref()) {
        (Some(a), Some(b)) => Some(format!("{a}\n{b}")),
        (a, b) => a.or(b).map(str::to_string),
    };
    Overrides { tokens, css }
}

// ---------------------------------------------------------------------------
// The grid page
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridRoute {
    pub route: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridVariant {
    pub label: String,
    #[serde(default)]
    pub overrides: Overrides,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContrastCheck {
    pub fg: String,
    pub bg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Everything the grid page needs, carried in its URL (`?spec=`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridSpec {
    pub routes: Vec<GridRoute>,
    pub variants: Vec<GridVariant>,
    pub themes: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    #[serde(default)]
    pub checks: Vec<ContrastCheck>,
}

/// The grid page's route segment under `/s/{token}/`.
pub const GRID_ROUTE: &str = "compare.grid";

pub const MAX_ROUTES: usize = 6;
pub const MAX_VARIANTS: usize = 4;
/// The renderer loads every cell as a full page in one Chromium; past this
/// its memory limit, not the picture, is the constraint.
pub const MAX_CELLS: usize = 24;
pub const MAX_CHECKS: usize = 6;

/// Padding around the grid, the label column's width and the gap between
/// cells, in CSS px — shared by the page and [`grid_width`].
const PAD: u32 = 24;
const LABEL_COL: u32 = 150;
const GAP: u32 = 16;

pub fn cell_size(spec: &GridSpec) -> (u32, u32) {
    (
        (spec.width as f32 * spec.scale).round() as u32,
        (spec.height as f32 * spec.scale).round() as u32,
    )
}

/// The CSS width the renderer should open the grid page at.
pub fn grid_width(spec: &GridSpec) -> u32 {
    let (cw, _) = cell_size(spec);
    PAD * 2 + LABEL_COL + spec.variants.len() as u32 * (cw + GAP)
}

/// Below this, a cell in the returned image is too small to read.
pub const MIN_CELL_PX: f32 = 180.0;

/// How wide one cell comes out, in px of the returned image, when the grid
/// is rendered at 2× and then fitted within `max_px` (0 = not fitted).
/// The height is estimated from the layout; the renderer does the real fit.
pub fn cell_px(spec: &GridSpec, max_px: u32) -> f32 {
    let (cw, ch) = cell_size(spec);
    let rows = (spec.routes.len() * spec.themes.len()) as u32;
    let width = grid_width(spec) as f32 * 2.0;
    let height = (PAD * 2 + 40 + rows * (ch + GAP)) as f32 * 2.0;
    let fit = if max_px == 0 { 1.0 } else { (max_px as f32 / width.max(height)).min(1.0) };
    cw as f32 * 2.0 * fit
}

/// The grids to render so every cell stays readable: the whole spec, or —
/// when its cells would come out under [`MIN_CELL_PX`] — one grid per route.
pub fn split_for_readability(spec: &GridSpec, max_px: u32) -> Vec<GridSpec> {
    if max_px == 0 || spec.routes.len() < 2 || cell_px(spec, max_px) >= MIN_CELL_PX {
        return vec![spec.clone()];
    }
    spec.routes
        .iter()
        .map(|route| GridSpec { routes: vec![route.clone()], ..spec.clone() })
        .collect()
}

pub fn validate_spec(spec: &GridSpec) -> Result<(), String> {
    if spec.routes.is_empty() || spec.routes.len() > MAX_ROUTES {
        return Err(format!("routes: give 1–{MAX_ROUTES}"));
    }
    if spec.variants.is_empty() || spec.variants.len() > MAX_VARIANTS {
        return Err(format!("variants: give 1–{MAX_VARIANTS}"));
    }
    // #619: any theme names (the handler checks they are declared); the cell
    // limit below is the only cap.
    if spec.themes.is_empty() {
        return Err("themes: give at least one theme, e.g. [\"light\", \"dark\"]".into());
    }
    if let Some(bad) = spec.themes.iter().find(|t| !is_theme_name(t)) {
        return Err(format!("themes: `{bad}` is not a theme name"));
    }
    if (1..spec.themes.len()).any(|i| spec.themes[..i].contains(&spec.themes[i])) {
        return Err("themes: a theme is listed twice".into());
    }
    let cells = spec.routes.len() * spec.variants.len() * spec.themes.len();
    if cells > MAX_CELLS {
        return Err(format!(
            "{cells} cells (routes × variants × themes) is over the limit of {MAX_CELLS}; split the comparison"
        ));
    }
    if !(0.2..=1.0).contains(&spec.scale) {
        return Err("scale must be 0.2–1".into());
    }
    if spec.checks.len() > MAX_CHECKS {
        return Err(format!("at most {MAX_CHECKS} checks"));
    }
    for check in &spec.checks {
        if !valid_name(&check.fg) || !valid_name(&check.bg) {
            return Err("checks: fg and bg must be CSS custom property names, e.g. --primary".into());
        }
    }
    for r in &spec.routes {
        if crate::manifest::page_path_for_route(&r.route).is_none() {
            return Err(format!("`{}` is not a page route", r.route));
        }
    }
    for v in &spec.variants {
        if v.label.trim().is_empty() || v.label.len() > 60 {
            return Err("every variant needs a label of 1–60 characters".into());
        }
        validate(&v.overrides).map_err(|e| format!("variant `{}`: {e}", v.label))?;
    }
    Ok(())
}

pub fn encode_spec(spec: &GridSpec) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(spec).unwrap_or_default())
}

pub fn decode_spec(raw: &str) -> Result<GridSpec, String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.trim_end_matches('='))
        .map_err(|_| "spec is not valid base64url".to_string())?;
    let spec: GridSpec = serde_json::from_slice(&bytes).map_err(|e| format!("spec is not valid JSON: {e}"))?;
    validate_spec(&spec)?;
    Ok(spec)
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The grid document. Row order: each route, then each theme within it;
/// columns are the variants in the order given.
pub fn grid_html(token: &str, spec: &GridSpec) -> String {
    let (cw, ch) = cell_size(spec);
    let mut head = String::from("<tr><th></th>");
    for v in &spec.variants {
        head.push_str(&format!("<th>{}</th>", esc(&v.label)));
    }
    head.push_str("</tr>");

    let mut rows = String::new();
    for r in &spec.routes {
        for theme in &spec.themes {
            let label = r.label.clone().unwrap_or_else(|| r.route.clone());
            rows.push_str(&format!(
                "<tr><td class=\"lab\"><b>{}</b><span>{}</span></td>",
                esc(&label),
                esc(theme)
            ));
            for (vi, v) in spec.variants.iter().enumerate() {
                let stem = r.route.trim_start_matches('/');
                let mut src = format!("/s/{token}/{stem}?theme={theme}");
                if let Some(state) = r.state.as_deref().filter(|s| !s.is_empty()) {
                    src.push_str(&format!("&state={}", state.replace(':', "%3A").replace('/', "%2F")));
                }
                if !v.overrides.is_empty() {
                    src.push_str(&format!("&ov={}", encode(&v.overrides)));
                }
                rows.push_str(&format!(
                    "<td><div class=\"cell\" style=\"width:{cw}px;height:{ch}px\"><iframe data-v=\"{vi}\" data-theme=\"{theme}\" data-route=\"{route}\" src=\"{src}\" width=\"{w}\" height=\"{h}\" style=\"transform:scale({s})\" onload=\"this.dataset.loaded='1'\"></iframe></div></td>",
                    route = esc(&r.route),
                    src = esc(&src),
                    w = spec.width,
                    h = spec.height,
                    s = spec.scale,
                ));
            }
            rows.push_str("</tr>");
        }
    }

    let checks = serde_json::to_string(&spec.checks).unwrap_or_else(|_| "[]".into());
    let labels = serde_json::to_string(&spec.variants.iter().map(|v| v.label.clone()).collect::<Vec<_>>())
        .unwrap_or_else(|_| "[]".into());
    format!(
        r##"<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><title>Compare</title><style>
html,body{{margin:0;background:#f4f4f5;color:#18181b;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}}
table{{border-collapse:separate;border-spacing:{gap}px;margin:{pad_rest}px}}
th{{text-align:left;font-size:14px;font-weight:650;padding:0 2px 4px}}
td.lab{{width:{labw}px;vertical-align:top;padding-top:6px}}
td.lab b{{display:block;font-size:13px;word-break:break-all}}
td.lab span{{display:inline-block;margin-top:4px;padding:1px 7px;border-radius:999px;background:#e4e4e7;font-size:11px}}
.cell{{overflow:hidden;border-radius:10px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 1px rgba(0,0,0,.06)}}
iframe{{border:0;display:block;transform-origin:0 0;pointer-events:none}}
</style></head><body><table>{head}{rows}</table>
<script>
(() => {{
  const CHECKS = {checks};
  const LABELS = {labels};
  const BUDGET = 25000;
  const frames = [...document.querySelectorAll("iframe")];
  const warnings = [];
  const loaded = (f) => new Promise((done) => {{
    const t0 = Date.now();
    const tick = () => {{
      if (f.dataset.loaded) return done(true);
      if (Date.now() - t0 > BUDGET) return done(false);
      setTimeout(tick, 50);
    }};
    tick();
  }});
  const frameReady = async (f) => {{
    if (!(await loaded(f))) {{ warnings.push(`cell ${{f.dataset.route}} · ${{LABELS[f.dataset.v]}} · ${{f.dataset.theme}} did not finish loading`); return; }}
    const doc = f.contentDocument;
    if (!doc) return;
    await Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
    await Promise.all([...doc.images].map((img) => img.complete ? null : new Promise((r) => {{ img.onload = img.onerror = r; setTimeout(r, 4000); }})));
    const state = await Promise.race([f.contentWindow.__tfStateReady ?? Promise.resolve(null), new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (state && !state.matched) warnings.push(`state "${{state.state}}" matched no element in ${{f.dataset.route}}; rendered without it`);
    await new Promise((r) => f.contentWindow.requestAnimationFrame(() => f.contentWindow.requestAnimationFrame(r)));
  }};
  // A resolved CSS colour (rgb(), oklch(), color(), …) as sRGB 0–255 + alpha,
  // through a canvas so every syntax Chromium can resolve is covered.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", {{ willReadFrequently: true }});
  const rgba = (css) => {{
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000"; ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : {{ r: r / (a / 255), g: g / (a / 255), b: b / (a / 255), a: a / 255 }};
  }};
  const over = (top, base) => ({{ r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 }});
  const lum = (c) => {{ const f = (v) => {{ v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }}; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }};
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
  const measure = (f, check) => {{
    const doc = f.contentDocument;
    const probe = doc.createElement("div");
    probe.style.cssText = `position:absolute;left:-99px;top:0;width:4px;height:4px;color:var(${{check.fg}});background-color:var(${{check.bg}})`;
    doc.body.appendChild(probe);
    const style = f.contentWindow.getComputedStyle(probe);
    const page = rgba(f.contentWindow.getComputedStyle(doc.body).backgroundColor) ?? (f.dataset.theme === "dark" ? {{ r: 0, g: 0, b: 0, a: 1 }} : {{ r: 255, g: 255, b: 255, a: 1 }});
    const bgRaw = rgba(style.backgroundColor);
    const fgRaw = rgba(style.color);
    probe.remove();
    if (!bgRaw || !fgRaw) return {{ error: `${{!fgRaw ? check.fg : check.bg}} did not resolve to a colour` }};
    const bg = bgRaw.a < 1 ? over(bgRaw, over(page, {{ r: 255, g: 255, b: 255, a: 1 }})) : bgRaw;
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    return {{ fgValue: hex(fg), bgValue: hex(bg), ratio, aa: ratio >= 4.5, aaLarge: ratio >= 3 }};
  }};
  window.__tfReady = (async () => {{
    await Promise.all(frames.map(frameReady));
    const checks = [];
    for (const check of CHECKS) {{
      const seen = new Set();
      for (const f of frames) {{
        const key = `${{f.dataset.v}}|${{f.dataset.theme}}`;
        if (seen.has(key) || !f.dataset.loaded || !f.contentDocument?.body) continue;
        seen.add(key);
        checks.push({{ variant: LABELS[f.dataset.v], theme: f.dataset.theme, fg: check.fg, bg: check.bg, label: check.label ?? null, ...measure(f, check) }});
      }}
    }}
    window.__tfResult = {{ checks, warnings }};
  }})();
}})();
</script></body></html>"##,
        gap = GAP,
        pad_rest = PAD - GAP,
        labw = LABEL_COL - GAP,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ov(pairs: &[(&str, &str)]) -> Overrides {
        Overrides {
            tokens: pairs.iter().map(|(k, v)| (k.to_string(), OverrideValue::Both(v.to_string()))).collect(),
            css: None,
        }
    }

    #[test]
    fn values_that_could_escape_are_refused() {
        assert!(validate(&ov(&[("--primary", "#448502")])).is_ok());
        assert!(validate(&ov(&[("--primary", "oklch(from var(--brand) l c h)")])).is_ok());
        for bad in ["red;} body{display:none", "</style><script>", "url(https://x/y.png)", "red /* x */", "@import x"] {
            assert!(validate(&ov(&[("--primary", bad)])).is_err(), "{bad}");
        }
        assert!(validate(&ov(&[("color", "red")])).is_err(), "not a custom property");
        let css = Overrides { tokens: BTreeMap::new(), css: Some("a{color:red}</style>".into()) };
        assert!(validate(&css).is_err());
    }

    #[test]
    fn style_block_puts_single_values_in_every_theme() {
        let mut o = ov(&[("--primary", "#448502")]);
        o.tokens.insert("--bg".into(), OverrideValue::PerTheme([("dark".to_string(), "#000".to_string())].into()));
        assert_eq!(
            style_block(&o),
            "<style id=\"tf-override\">:root{--primary:#448502;}:root[data-theme]{--primary:#448502;}:root[data-theme=\"dark\"]{--bg:#000;}</style>"
        );
    }

    #[test]
    fn per_theme_overrides_target_their_own_theme() {
        let mut o = Overrides::default();
        o.tokens.insert(
            "--primary".into(),
            OverrideValue::PerTheme([("ocean".to_string(), "#0af".to_string()), ("light".to_string(), "#111".to_string())].into()),
        );
        assert_eq!(style_block(&o), "<style id=\"tf-override\">:root{--primary:#111;}:root[data-theme=\"ocean\"]{--primary:#0af;}</style>");
        let bad = Overrides {
            tokens: [("--p".to_string(), OverrideValue::PerTheme([("Ocean\"]".to_string(), "#0af".to_string())].into()))].into(),
            css: None,
        };
        assert!(validate(&bad).is_err(), "a theme key must be a theme name");
        let empty = Overrides { tokens: [("--p".to_string(), OverrideValue::PerTheme(BTreeMap::new()))].into(), css: None };
        assert!(validate(&empty).is_err());
        // The wire shape is unchanged for light/dark callers.
        let parsed: Overrides = serde_json::from_str(r##"{"tokens":{"--a":"#000","--b":{"dark":"#fff","ocean":"#0af"}}}"##).expect("parse");
        assert_eq!(parsed.tokens["--a"], OverrideValue::Both("#000".into()));
        assert_eq!(parsed.tokens["--b"], OverrideValue::PerTheme([("dark".to_string(), "#fff".to_string()), ("ocean".to_string(), "#0af".to_string())].into()));
    }

    #[test]
    fn override_themes_must_be_declared() {
        let declared = vec!["light".to_string(), "dark".to_string()];
        let mut o = Overrides::default();
        o.tokens.insert("--p".into(), OverrideValue::PerTheme([("ocean".to_string(), "#0af".to_string())].into()));
        assert!(check_override_themes(&o, &declared).unwrap_err().contains("ocean"));
        assert!(check_override_themes(&ov(&[("--p", "#000")]), &declared).is_ok());
    }

    #[test]
    fn apply_writes_a_single_value_into_every_theme_the_token_has() {
        let doc: TokensDoc = serde_json::from_str(
            r##"{"version":1,"themes":[{"name":"dark"},{"name":"ocean"}],"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E","ocean":"#00AAFF"}}}}"##,
        )
        .expect("doc");
        let (out, _) = apply_to(&doc, &ov(&[("--primary", "#448502")]));
        assert_eq!(
            serde_json::to_value(&out).expect("json")["categories"]["colors"]["primary"],
            serde_json::json!({ "light": "#448502", "dark": "#448502", "ocean": "#448502" })
        );
        let mut only_ocean = Overrides::default();
        only_ocean.tokens.insert("--primary".into(), OverrideValue::PerTheme([("ocean".to_string(), "#0bf".to_string())].into()));
        let (out, _) = apply_to(&doc, &only_ocean);
        assert_eq!(
            serde_json::to_value(&out).expect("json")["categories"]["colors"]["primary"],
            serde_json::json!({ "light": "#15803D", "dark": "#22C55E", "ocean": "#0bf" })
        );
    }

    #[test]
    fn a_spec_takes_any_theme_names_up_to_the_cell_limit() {
        let variant = |label: &str| GridVariant { label: label.into(), overrides: Overrides::default() };
        let route = |r: &str| GridRoute { route: r.into(), state: None, label: None };
        let mut spec = GridSpec {
            routes: vec![route("/")],
            variants: vec![variant("Current")],
            themes: vec!["light".into(), "dark".into(), "ocean".into()],
            width: 393,
            height: 852,
            scale: 0.5,
            checks: vec![],
        };
        assert!(validate_spec(&spec).is_ok(), "three themes are fine");
        let html = grid_html("tok", &spec);
        assert_eq!(html.matches("<iframe").count(), 3, "acceptance 5: one row per theme");
        assert!(html.contains("/s/tok/?theme=ocean"), "{html}");
        spec.themes = vec!["light".into(), "light".into()];
        assert!(validate_spec(&spec).is_err(), "listed twice");
        spec.themes = vec!["Ocean".into()];
        assert!(validate_spec(&spec).is_err(), "not a theme name");
        spec.themes = vec![];
        assert!(validate_spec(&spec).is_err(), "at least one");
    }

    #[test]
    fn encode_round_trips_and_decode_revalidates() {
        let o = ov(&[("--primary", "#448502")]);
        assert_eq!(decode(&encode(&o)).expect("valid"), o);
        let bad = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"tokens":{"--a":"x;y"}}"#);
        assert!(decode(&bad).is_err());
    }

    #[test]
    fn apply_maps_vars_through_the_emitter_names() {
        let doc: TokensDoc = serde_json::from_str(
            r##"{"version":1,"categories":{
              "colors":{"primary":{"light":"#15803D","dark":"#22C55E"}},
              "radius":{"md":{"light":"8px"}}}}"##,
        )
        .expect("doc");
        let mut o = ov(&[("--primary", "#448502"), ("--radius-md", "12px"), ("--brand-new", "#111")]);
        o.tokens.insert("--radius-md".into(), OverrideValue::Both("12px".into()));
        let (out, added) = apply_to(&doc, &o);
        let json = serde_json::to_value(&out).expect("json");
        assert_eq!(json["categories"]["colors"]["primary"]["light"], "#448502");
        // A single value replaces the dark one too, as it did in the render.
        assert_eq!(json["categories"]["colors"]["primary"]["dark"], "#448502");
        assert_eq!(json["categories"]["radius"]["md"]["light"], "12px");
        assert_eq!(json["categories"]["custom"]["--brand-new"]["light"], "#111");
        assert_eq!(added, vec!["--brand-new".to_string()]);
    }

    #[test]
    fn apply_diff_names_only_what_the_variant_changes() {
        let doc: TokensDoc = serde_json::from_str(
            r##"{"version":1,"categories":{
              "colors":{"primary":{"light":"#15803D","dark":"#22C55E"},"bg":{"light":"#fff"}},
              "radius":{"md":{"light":"8px"}}}}"##,
        )
        .expect("doc");
        let (patch, added) = apply_diff(&doc, &ov(&[("--primary", "#448502"), ("--new-one", "#111")]));
        assert_eq!(
            patch,
            serde_json::json!({
                "colors": { "primary": { "light": "#448502", "dark": "#448502" } },
                "custom": { "--new-one": { "light": "#111" } }
            })
        );
        assert_eq!(added, vec!["--new-one".to_string()]);

        // Writing the diff back as a patch reproduces the rendered column.
        let mut written = doc.clone();
        crate::tokens::apply_patch(&mut written, &patch).expect("patch applies");
        assert_eq!(written, apply_to(&doc, &ov(&[("--primary", "#448502"), ("--new-one", "#111")])).0);
    }

    #[test]
    fn apply_diff_round_trips_a_per_theme_variant() {
        let doc: TokensDoc = serde_json::from_str(
            r##"{"version":1,"themes":[{"name":"dark"},{"name":"ocean"}],"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E","ocean":"#00AAFF"}}}}"##,
        )
        .expect("doc");
        let mut o = Overrides::default();
        o.tokens.insert("--primary".into(), OverrideValue::PerTheme([("ocean".to_string(), "oklch(0.6 0.2 250)".to_string())].into()));
        let (patch, added) = apply_diff(&doc, &o);
        assert!(added.is_empty(), "nothing lands in custom: {added:?}");
        assert_eq!(
            patch,
            serde_json::json!({ "colors": { "primary": { "light": "#15803D", "dark": "#22C55E", "ocean": "oklch(0.6 0.2 250)" } } })
        );
        let mut written = doc.clone();
        crate::tokens::apply_patch(&mut written, &patch).expect("patch applies");
        assert_eq!(written, apply_to(&doc, &o).0);
    }

    #[test]
    fn variant_overrides_win_over_shared_ones() {
        let shared = Overrides { tokens: ov(&[("--radius", "12px"), ("--primary", "#000")]).tokens, css: Some("#sheet{display:block}".into()) };
        let own = Overrides { tokens: ov(&[("--primary", "#BE123C")]).tokens, css: Some("a{color:red}".into()) };
        let out = layered(&shared, &own);
        assert_eq!(out.tokens["--primary"], OverrideValue::Both("#BE123C".into()));
        assert_eq!(out.tokens["--radius"], OverrideValue::Both("12px".into()));
        assert_eq!(out.css.as_deref(), Some("#sheet{display:block}\na{color:red}"));
        assert_eq!(layered(&shared, &Overrides::default()).tokens.len(), 2, "Current gets the shared base too");
    }

    #[test]
    fn a_tall_grid_is_split_per_route_when_cells_get_too_small() {
        let variant = |label: &str| GridVariant { label: label.into(), overrides: Overrides::default() };
        let route = |r: &str| GridRoute { route: r.into(), state: None, label: None };
        let spec = GridSpec {
            routes: vec![route("/a"), route("/b"), route("/c")],
            variants: vec![variant("x"), variant("y"), variant("z")],
            themes: vec!["light".into(), "dark".into()],
            width: 393,
            height: 852,
            scale: 0.5,
            checks: vec![],
        };
        assert!(cell_px(&spec, 1568) < MIN_CELL_PX, "18 cells in 1568px are too small");
        let parts = split_for_readability(&spec, 1568);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.routes.len() == 1 && cell_px(p, 1568) >= MIN_CELL_PX));
        assert_eq!(split_for_readability(&spec, 0).len(), 1, "max_px 0 never splits");
        let small = GridSpec { routes: vec![route("/a")], themes: vec!["light".into()], ..spec };
        assert_eq!(split_for_readability(&small, 1568).len(), 1);
    }

    #[test]
    fn spec_limits_are_enforced() {
        let variant = |label: &str| GridVariant { label: label.into(), overrides: Overrides::default() };
        let route = |r: &str| GridRoute { route: r.into(), state: None, label: None };
        let mut spec = GridSpec {
            routes: vec![route("/setup"), route("/onboarding")],
            variants: vec![variant("Current"), variant("Lime")],
            themes: vec!["light".into(), "dark".into()],
            width: 393,
            height: 852,
            scale: 0.5,
            checks: vec![],
        };
        assert!(validate_spec(&spec).is_ok());
        spec.routes = (0..6).map(|i| route(&format!("/p{i}"))).collect();
        spec.variants = (0..3).map(|i| variant(&format!("v{i}"))).collect();
        assert!(validate_spec(&spec).is_err(), "36 cells is over the limit");
        spec.routes.truncate(2);
        spec.routes[0] = route("/nested/page");
        assert!(validate_spec(&spec).is_err(), "not a page route");
    }
}
