# Design Named Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Design tokens support any number of named themes (light base + dark + names like `ocean`): the backend stores, validates, emits, imports and patches them; the canvas switches between them; the token panel edits one theme at a time; agents screenshot and compare any declared theme — with existing light/dark projects byte-identical.

**Architecture:** `TokenValue` becomes `light` + an ordered map of per-theme overrides (flat JSON, so legacy `{light, dark}` docs are already the new shape) and `TokensDoc` gains an optional ordered `themes` list (absent = implicit `dark`). Everything else derives from `TokensDoc::declared_themes()`: the emitter (one `[data-theme]` block per theme), validation, the patch (`themes` = full list, renames, deletes), the sandbox `?theme=`, the manifest's `themes` (with swatches, for the FE switcher), compare/screenshot validation. The FE edits the whole doc with pure helpers and saves through its existing PUT; the MCP schemas widen from enums to theme slugs.

**Tech Stack:** Rust (Umbral/axum, serde, `taskflow-design` plugin), Node renderer (`backend/renderer/*.mjs`), React 19 + Vite + TS + Base UI (`v2_fe`), vitest; MCP server (TypeScript, zod v4, vitest).

**Spec:** `docs/superpowers/specs/2026-10-06-design-named-themes-design.md`

## Global Constraints

- Worktree: `/home/dalmas/E/projects/ltt-themes` (branch `feat/themes-619`). Never touch `/home/dalmas/E/projects/local_task_tracker` or other worktrees.
- Rust tests: `cd /home/dalmas/E/projects/ltt-themes/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design …` (bare `cargo test` skips plugins).
- Theme name: `^[a-z][a-z0-9-]{0,31}$`; reserved: `light`, `both`, `all`; at most 8 themes including light (`MAX_THEMES = 8`).
- `themes` in tokens.json lists the themes BESIDES light; absent = `[{"name":"dark"}]` implicitly.
- Legacy light/dark output must stay byte-identical (pinned by `tests/tokens_legacy_pin.rs` + `tests/fixtures/legacy_effective_tokens.css`).
- Never rewrite an applied migration; this feature needs no migration.
- Never patch `backend/vendor/umbral-*`.
- Compare cell cap stays `MAX_CELLS = 24`; no separate theme cap in compare.
- FE: only `*.test.ts` files are collected; pure logic goes in `.ts` modules. `.tsx` files export components only (`react-refresh/only-export-components`).
- FE lint baseline: `npx eslint .` → `27 errors, 1 warning`; the count must not grow.
- FE Select is Base UI: pass `items` (value→label) on `<Select>`.
- After every FE task: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npm run build` (the build is a deploy for dalmas).
- MCP: no version bump, no publish.
- Commits: `git commit -m "…" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`; `git add` new files first; never `git add -A`; never commit `v2_fe/yarn.lock`.

## Review Focus

The five input classes most likely to bite users, each now pinned by a test in the owning task:

1. **An agent adds one theme and silently deletes `dark`** — `{"themes":[{"name":"ocean"}]}` on a legacy doc removes dark (the list is the FULL list). Test: Task 4 `rename_moves_values_and_an_omitted_theme_is_reported_removed` asserts `themes_removed: ["dark"]` and the note.
2. **Pasted shadcn CSS whose `@custom-variant` mentions `[data-theme="dark"]`** — must not be read as a theme block nor break the `.dark {}` import. Test: Task 2 `pasted_css_imports_any_data_theme_block_and_dot_dark`.
3. **A stale theme name** (a persisted canvas choice or `?theme=` for a theme since renamed/deleted) — must fall back to light, never blank or error. Tests: Task 6 `the_sandbox_renders_any_declared_theme_and_falls_back_to_light`; Task 11 `resolveActiveTheme` fallback.
4. **Reserved / malformed names** (`both`, `all`, `light`, `Ocean`, `my theme`, `x"]`) across validation, the patch, the FE name box and the screenshot query. Tests: Task 1 `theme_names_are_lowercase_slugs`, Task 3 `bad_theme_lists_are_theme_name`, Task 8 `only_declared_themes_pass`, Task 10 `themeNameError` cases.
5. **The MCP schema stripping per-theme keys** — zod `z.object({light, dark})` silently drops `{"ocean":"#0af"}`, so the agent's write "succeeds" with no change. Test: Task 14 `design_write_tokens passes per-theme keys and the themes list through intact`.

---

### Task 1: Token model — per-theme overrides and the theme list

**Files:**
- Create: `backend/plugins/taskflow-design/tests/tokens_legacy_pin.rs`, `backend/plugins/taskflow-design/tests/fixtures/legacy_effective_tokens.css` (generated)
- Modify: `backend/plugins/taskflow-design/src/tokens.rs` (OrderedMap `:38-74`, model `:110-132`, emitter `:226-228`, parser `:419-449`, apply_patch `:494-501`, new test module at end)
- Modify: `backend/plugins/taskflow-design/src/defaults.rs:47-55`
- Modify: `backend/plugins/taskflow-design/src/manifest.rs:295`
- Modify: `backend/plugins/taskflow-design/src/validation.rs:901`
- Modify: `backend/plugins/taskflow-design/src/compare.rs:208-226`
- Modify: `backend/plugins/taskflow-design/tests/tokens_codec.rs:91`, `backend/plugins/taskflow-design/tests/tokens_defaults.rs:102`

**Interfaces:**
- Consumes: nothing new.
- Produces (in `taskflow_design::tokens`):
  - `pub const LIGHT: &str = "light"; pub const DARK: &str = "dark"; pub const MAX_THEMES: usize = 8; pub const RESERVED_THEME_NAMES: &[&str]`
  - `pub fn is_theme_name(name: &str) -> bool`
  - `pub struct ThemeDecl { pub name: String, pub label: Option<String> }` + `ThemeDecl::named(impl Into<String>) -> ThemeDecl`
  - `pub struct TokenValue { pub light: String, pub themes: OrderedMap<String> }` (Default, Clone, PartialEq; hand-written flat serde) with `new(light)`, `with(theme, value) -> Self`, `get(&self, theme) -> Option<&str>`, `resolve(&self, theme) -> &str`, `set(&mut self, theme, value)`, `remove(&mut self, theme) -> Option<String>`, `values(&self) -> impl Iterator<Item=&String>`
  - `TokensDoc { version, themes: Option<Vec<ThemeDecl>>, categories }` with `theme_decls() -> Vec<ThemeDecl>`, `declared_themes() -> Vec<String>`, `declares(&str) -> bool`
  - `OrderedMap::get(&self, &str) -> Option<&V>`, `contains_key(&self, &str) -> bool`, `remove(&mut self, &str) -> Option<V>`

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the capture half of the legacy pin (characterisation, before any code change)**

Create `backend/plugins/taskflow-design/tests/tokens_legacy_pin.rs`:

```rust
//! #619: the light/dark output every existing project renders with is PINNED
//! byte for byte. The fixture is captured from the pre-#619 code (run
//! `capture_legacy_pin` once, before touching tokens.rs); the pin then holds
//! through every later change.

use taskflow_design::defaults::effective_tokens;
use taskflow_design::tokens::{tokens_json_to_css, TokensDoc};

/// A legacy document: light/dark, a light-only token, a radius scale step and
/// the shadcn `custom.radius` — compact, exactly as the server stores it.
const LEGACY: &str = r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"},"brand":{"light":"#111111"}},"radius":{"md":{"light":"8px"}},"custom":{"radius":{"light":"0.5rem"}}}}"##;

fn legacy_css() -> String {
    let doc: TokensDoc = serde_json::from_str(LEGACY).expect("legacy doc parses");
    tokens_json_to_css(&effective_tokens(&doc))
}

/// Run ONCE on the pre-#619 code: `cargo test -p taskflow-design --test tokens_legacy_pin -- --ignored capture_legacy_pin`.
#[test]
#[ignore]
fn capture_legacy_pin() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    std::fs::create_dir_all(dir).expect("fixtures dir");
    std::fs::write(format!("{dir}/legacy_effective_tokens.css"), legacy_css()).expect("write pin");
}
```

- [ ] **Step 2: Capture the fixture from the unchanged code**

Run: `cd /home/dalmas/E/projects/ltt-themes/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design --test tokens_legacy_pin -- --ignored capture_legacy_pin`
Expected: `1 passed`; `backend/plugins/taskflow-design/tests/fixtures/legacy_effective_tokens.css` now exists and contains `:root[data-theme="dark"], .dark {` and `--primary: #22C55E;`. (`git diff --stat backend/plugins/taskflow-design/src` must be empty at this point.)

- [ ] **Step 3: Add the pin tests and run them green on the unchanged code**

Append to `tests/tokens_legacy_pin.rs`:

```rust
#[test]
fn legacy_light_dark_css_is_byte_identical() {
    assert_eq!(legacy_css(), include_str!("fixtures/legacy_effective_tokens.css"));
}

#[test]
fn legacy_json_round_trips_byte_identically() {
    let doc: TokensDoc = serde_json::from_str(LEGACY).expect("legacy doc parses");
    assert_eq!(serde_json::to_string(&doc).expect("serialise"), LEGACY);
}
```

Run: `… cargo test -p taskflow-design --test tokens_legacy_pin`
Expected: `2 passed; 0 failed; 1 ignored`.

- [ ] **Step 4: Write the failing model tests**

Append to the end of `backend/plugins/taskflow-design/src/tokens.rs`:

```rust
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
```

- [ ] **Step 5: Run them to see them fail**

Run: `… cargo test -p taskflow-design --lib theme_model_tests`
Expected: compile errors — `no method named declared_themes`, `no field themes on type TokensDoc`, `cannot find function is_theme_name`, `no function or associated item named new`.

- [ ] **Step 6: Implement the model**

In `src/tokens.rs`, inside `impl<V> OrderedMap<V>` (after `entry_or_insert_with`, `:73`), add:

```rust
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
```

Replace `:110-132` (the `TokenValue` struct, `TokensDoc` struct and `impl Default for TokensDoc`) with:

```rust
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

    pub fn declares(&self, theme: &str) -> bool {
        theme == LIGHT || self.theme_decls().iter().any(|t| t.name == theme)
    }
}
```

Migrate the callers (same file and others):

- `src/tokens.rs` `tokens_json_to_css` (`:226`): `if let Some(dark) = &value.dark {` → `if let Some(dark) = value.themes.get(DARK) {`
- `src/tokens.rs` `css_to_tokens_json` (`:421-449`): replace the two `.insert(key, TokenValue { … })` bodies and the final literal:

```rust
    for (name, light) in &lights {
        let (category, key) = var_name_to_category(name);
        let mut value = TokenValue::new(light.clone());
        if let Some(dark) = darks.get(name) {
            value.set(DARK, dark.clone());
        }
        categories.entry_or_insert_with(category, OrderedMap::new).insert(key, value);
    }

    // Dark-only vars (no matching light decl) still need to round-trip.
    for (name, dark_value) in &darks {
        if lights.iter().any(|(n, _)| n == name) {
            continue;
        }
        let (category, key) = var_name_to_category(name);
        categories
            .entry_or_insert_with(category, OrderedMap::new)
            .insert(key, TokenValue::new(dark_value.clone()).with(DARK, dark_value.clone()));
    }

    TokensDoc {
        version: 1,
        themes: None,
        categories,
    }
```

- `src/tokens.rs` `apply_patch` (`:494-501`): `entry_or_insert_with(key, || TokenValue { light: String::new(), dark: None })` → `entry_or_insert_with(key, TokenValue::default)`; and replace

```rust
            if let Some(dark) = dark {
                // `"dark": null` drops the dark value, so the light one applies in both.
                token.dark = (!dark.is_empty()).then_some(dark);
            }
```
with
```rust
            if let Some(dark) = dark {
                // `"dark": null` drops the dark value, so the light one applies in both.
                if dark.is_empty() {
                    token.remove(DARK);
                } else {
                    token.set(DARK, dark);
                }
            }
```

- `src/defaults.rs:47-55`:

```rust
    for (key, light, dark) in COLORS {
        colors.insert(*key, TokenValue::new(*light).with("dark", *dark));
    }
    let mut custom = OrderedMap::new();
    custom.insert("radius", TokenValue::new("0.625rem"));
    let mut categories = OrderedMap::new();
    categories.insert("colors", colors);
    categories.insert("custom", custom);
    TokensDoc { version: 1, themes: None, categories }
```

- `src/manifest.rs:295`: `if let Some(dark) = &value.dark {` → `if let Some(dark) = value.themes.get("dark") {`
- `src/validation.rs:901`: `for value in [Some(&value.light), value.dark.as_ref()].into_iter().flatten() {` → `for value in value.values() {`
- `src/compare.rs:208-226` (`apply_to`): `|| TokenValue { light: String::new(), dark: None }` → `TokenValue::default`; `if token.dark.is_some() { token.dark = Some(v.clone()); }` → `if token.themes.contains_key("dark") { token.set("dark", v.clone()); }`; `token.dark = Some(v.clone());` → `token.set("dark", v.clone());`
- `tests/tokens_codec.rs:91`: `assert_eq!(p.dark.as_deref(), Some("oklch(0.922 0 0)"));` → `assert_eq!(p.get("dark"), Some("oklch(0.922 0 0)"));`
- `tests/tokens_defaults.rs:102`: `taskflow_design::tokens::TokenValue { light: "red".into(), dark: None }` → `taskflow_design::tokens::TokenValue::new("red")`

- [ ] **Step 7: Run the model tests and the whole crate**

Run: `… cargo test -p taskflow-design --lib theme_model_tests` → Expected: `5 passed`.
Run: `… cargo test -p taskflow-design` → Expected: all pass, including `tokens_legacy_pin` (2 passed, 1 ignored).

- [ ] **Step 8: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git add backend/plugins/taskflow-design/tests/tokens_legacy_pin.rs backend/plugins/taskflow-design/tests/fixtures/legacy_effective_tokens.css && git commit -m "feat(design): token model carries per-theme overrides and a theme list (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/src/defaults.rs backend/plugins/taskflow-design/src/manifest.rs backend/plugins/taskflow-design/src/validation.rs backend/plugins/taskflow-design/src/compare.rs backend/plugins/taskflow-design/tests/tokens_codec.rs backend/plugins/taskflow-design/tests/tokens_defaults.rs backend/plugins/taskflow-design/tests/tokens_legacy_pin.rs backend/plugins/taskflow-design/tests/fixtures/legacy_effective_tokens.css
```

---

### Task 2: Emitter and parser for N themes

**Files:**
- Modify: `backend/plugins/taskflow-design/src/tokens.rs` (`tokens_json_to_css` `:205-249`, `css_to_tokens_json` `:377-450`, new `theme_blocks` helper above it)
- Test: `backend/plugins/taskflow-design/tests/tokens_codec.rs` (append)

**Interfaces:**
- Consumes: Task 1 (`TokenValue`, `ThemeDecl`, `theme_decls`, `is_theme_name`, `LIGHT`, `DARK`, `RESERVED_THEME_NAMES`).
- Produces: `tokens_json_to_css(&TokensDoc) -> String` emitting one block per declared theme; `css_to_tokens_json(&str) -> TokensDoc` importing every `[data-theme="<slug>"]` block plus `.dark`, setting `themes` when anything besides dark was found.

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing tests**

Change the first line of `tests/tokens_codec.rs` to:

```rust
use taskflow_design::tokens::{css_to_tokens_json, tokens_json_to_css, ThemeDecl, TokensDoc};
```

Append:

```rust
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
    assert_eq!(tokens_json_to_css(&back), css, "css -> json -> css is stable");
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `… cargo test -p taskflow-design --test tokens_codec`
Expected: `each_theme_gets_one_block_with_only_its_overrides`, `n_theme_css_round_trips` and `pasted_css_imports_any_data_theme_block_and_dot_dark` FAIL (no ocean block is emitted/imported); `a_theme_with_no_overrides_emits_no_block` passes trivially.

- [ ] **Step 3: Implement the emitter**

Replace the body of `tokens_json_to_css` (keep its doc comment, updating item 2 to "one block per declared theme: dark as `:root[data-theme="dark"], .dark`, every other theme as `:root[data-theme="<name>"]`, each with only its overrides; a theme with none emits nothing") with:

```rust
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
```

- [ ] **Step 4: Implement the parser**

Add above `css_to_tokens_json`:

```rust
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
```

Replace `css_to_tokens_json` from the line `// Dark overrides: prefer the generated …` to the end of the function with:

```rust
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
```

(The `darks` HashMap and the two loops Task 1 migrated are removed by this replacement; update the function's doc comment to say "and every `[data-theme="<name>"]` block plus `.dark` for theme overrides".)

- [ ] **Step 5: Run the tests**

Run: `… cargo test -p taskflow-design --test tokens_codec` → Expected: all pass.
Run: `… cargo test -p taskflow-design` → Expected: all pass (the legacy pin stays green).

- [ ] **Step 6: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "feat(design): emit and import one CSS block per named theme (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/tests/tokens_codec.rs
```

---

### Task 3: Validate the theme list and per-theme overrides

**Files:**
- Modify: `backend/plugins/taskflow-design/src/tokens.rs` (add `check_theme_list` after `impl TokensDoc`)
- Modify: `backend/plugins/taskflow-design/src/validation.rs:862-921` (`validate_tokens_json`)
- Create: `backend/plugins/taskflow-design/tests/themes_validation.rs`

**Interfaces:**
- Consumes: Task 1.
- Produces: `pub fn check_theme_list(themes: &[ThemeDecl]) -> Result<(), String>` (tokens); validation rules `theme-name` and `theme-unknown`.

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing tests**

Create `tests/themes_validation.rs`:

```rust
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `… cargo test -p taskflow-design --test themes_validation`
Expected: `bad_theme_lists_are_theme_name` and `an_override_for_an_undeclared_theme_is_theme_unknown` FAIL (`left: None, right: Some("theme-name")`).

- [ ] **Step 3: Implement**

In `src/tokens.rs`, after `impl TokensDoc { … }`:

```rust
/// The one rule set for a theme list (stored document and patch alike):
/// light is never listed, reserved names refused, slugs only, no duplicate,
/// labels 1–40 characters, at most [`MAX_THEMES`] including light.
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
                return Err(format!("theme `{name}`: a label is 1–40 characters"));
            }
        }
    }
    Ok(())
}
```

In `src/validation.rs` `validate_tokens_json`, directly after the `let doc … = match serde_json::from_str(content) { … };` block insert:

```rust
    // #619: the theme list first, then every override must name one of them.
    if let Some(themes) = &doc.themes {
        if let Err(message) = crate::tokens::check_theme_list(themes) {
            return v.fail(ValidationError {
                line: 0,
                rule: "theme-name",
                message,
                found: None,
                suggest: Some(r#"{"themes":[{"name":"dark"},{"name":"ocean","label":"Ocean"}]}"#.into()),
            });
        }
    }
    let declared = doc.declared_themes();
```

and inside the `for (key, value) in tokens.iter()` loop, after the `token-key` check and before the `remote-url` loop:

```rust
            if let Some((theme, _)) = value.themes.iter().find(|(t, _)| !declared.contains(t)) {
                return v.fail(ValidationError {
                    line: 0,
                    rule: "theme-unknown",
                    message: format!(
                        "Token `{category}.{key}` has a value for theme `{theme}`, which the document does \
                         not declare (themes: {}). Add {{\"name\": \"{theme}\"}} to `themes` first.",
                        declared.join(", ")
                    ),
                    found: Some(theme.clone()),
                    suggest: None,
                });
            }
```

- [ ] **Step 4: Run the tests**

Run: `… cargo test -p taskflow-design --test themes_validation` → Expected: `4 passed`.
Run: `… cargo test -p taskflow-design` → Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git add backend/plugins/taskflow-design/tests/themes_validation.rs && git commit -m "feat(design): validate theme names and per-theme overrides (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/src/validation.rs backend/plugins/taskflow-design/tests/themes_validation.rs
```

---

### Task 4: Per-theme patch and theme management through design_write_tokens

**Files:**
- Modify: `backend/plugins/taskflow-design/src/tokens.rs` (`apply_patch` `:452-509`, add `ThemeChanges`, `ThemePatchEntry`, `apply_theme_list`; extend `patch_tests`)
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs` (`write_tokens` `:774-904`; `AgentWriteTokensInput.patch` doc `:739-743`)
- Create: `backend/plugins/taskflow-design/tests/named_themes.rs`

**Interfaces:**
- Consumes: Tasks 1, 3 (`check_theme_list`).
- Produces: `pub fn apply_patch(doc: &mut TokensDoc, patch: &serde_json::Value) -> Result<ThemeChanges, String>`; `pub struct ThemeChanges { pub removed: Vec<String>, pub renamed: Vec<(String, String)> }`; write reply fields `themes: [String]` and (when non-empty) `themes_removed: [String]`. Test helpers in `tests/named_themes.rs`: `seeded(&TestApp) -> (user_id, project, key)`, `patch(&TestApp, &str, i64, Value) -> support::TestResponse`, `stored(i64) -> Value`.

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing unit tests**

Append inside `mod patch_tests` in `src/tokens.rs`:

```rust
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `… cargo test -p taskflow-design --lib patch_tests`
Expected: compile error — `cannot find type ThemeChanges`.

- [ ] **Step 3: Implement `apply_patch`**

Replace `apply_patch` (`:452-509`, doc comment included) in `src/tokens.rs` with:

```rust
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
```

- [ ] **Step 4: Run the unit tests**

Run: `… cargo test -p taskflow-design --lib patch_tests` → Expected: `4 passed`.

- [ ] **Step 5: Write the failing endpoint tests**

Create `tests/named_themes.rs`:

```rust
//! #619: named design themes end to end — the token write, the manifest, the
//! sandbox, compare and screenshot validation. The renderer is not configured
//! in tests, so a render that got past validation answers 503.

mod support;

use serde_json::json;
use support::{TestApp, seed_agent};

const LEGACY_TOKENS: &str =
    r##"{"version":1,"categories":{"colors":{"primary":{"light":"#15803D","dark":"#22C55E"}}}}"##;

/// A project with a home page and the legacy light/dark tokens, plus an agent key.
async fn seeded(app: &TestApp) -> (i64, i64, String) {
    let (user, project) = app.create_member_with_project().await;
    for (path, content) in [("pages/index.html", "<main><h1>Home</h1></main>"), ("styles/tokens.json", LEGACY_TOKENS)] {
        let res = app
            .put_json_as(user.id, &format!("/api/design/{project}/file"), &json!({ "path": path, "content": content }))
            .await;
        assert_eq!(res.status(), 201, "seed {path}: {}", res.text());
    }
    let (_agent, key) = seed_agent(project, "Designer").await;
    (user.id, project, key)
}

async fn patch(app: &TestApp, key: &str, project: i64, patch: serde_json::Value) -> support::TestResponse {
    app.put_as_agent(
        key,
        "/api/taskflow/agents/design/tokens",
        json!({ "project": project, "reason": "Try a named theme palette", "patch": patch }),
    )
    .await
}

async fn stored(project: i64) -> serde_json::Value {
    let row = taskflow_design::store::load_file(project, "styles/tokens.json").await.expect("tokens row");
    serde_json::from_str(&row.content).expect("tokens json")
}

/// Declare `ocean` (keeping dark) with a primary of its own.
async fn add_ocean(app: &TestApp, key: &str, project: i64) {
    let res = patch(app, key, project, json!({
        "themes": [{ "name": "dark" }, { "name": "ocean" }],
        "colors": { "primary": { "ocean": "#0af" } },
    }))
    .await;
    assert_eq!(res.status(), 201, "{}", res.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_patch_declares_a_theme_and_edits_only_that_theme() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    let res = patch(&app, &key, project, json!({
        "themes": [{ "name": "dark" }, { "name": "ocean", "label": "Ocean" }],
        "colors": { "primary": { "ocean": "#0af" } },
    }))
    .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(res.json()["themes"], json!(["light", "dark", "ocean"]));
    let doc = stored(project).await;
    assert_eq!(doc["themes"], json!([{ "name": "dark" }, { "name": "ocean", "label": "Ocean" }]));
    assert_eq!(doc["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E", "ocean": "#0af" }));

    // Acceptance 6: a later per-theme patch touches ONLY that theme.
    let res = patch(&app, &key, project, json!({ "colors": { "primary": { "ocean": "#0bf" } } })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E", "ocean": "#0bf" }));

    // null drops the override: ocean inherits light again.
    let res = patch(&app, &key, project, json!({ "colors": { "primary": { "ocean": null } } })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_theme_is_a_clear_error() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    let res = patch(&app, &key, project, json!({ "colors": { "primary": { "sunset": "#f00" } } })).await;
    assert_eq!(res.status(), 422, "{}", res.text());
    let message = res.json()["errors"][0]["message"].as_str().unwrap_or_default().to_string();
    assert!(message.contains("unknown theme `sunset`") && message.contains("light, dark"), "{message}");
    // A whole-document write is held to the same rule by the validator.
    let res = app
        .put_as_agent(&key, "/api/taskflow/agents/design/tokens", json!({
            "project": project,
            "reason": "Replace the whole document",
            "tokens": { "version": 1, "categories": { "colors": { "p": { "light": "red", "sunset": "blue" } } } },
        }))
        .await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert_eq!(res.json()["errors"][0]["rule"], "theme-unknown");
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_moves_values_and_an_omitted_theme_is_reported_removed() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;

    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "dark" }, { "name": "sea", "rename_from": "ocean" }] })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert!(res.json().get("themes_removed").is_none(), "a rename removes nothing: {}", res.text());
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "dark": "#22C55E", "sea": "#0af" }));

    // Review focus 1: listing only the new theme deletes dark — and says so.
    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "sea" }] })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let reply = res.json();
    assert_eq!(reply["themes_removed"], json!(["dark"]), "{reply}");
    assert!(reply["note"].as_str().unwrap_or_default().contains("Removed theme(s) dark"), "{reply}");
    assert_eq!(stored(project).await["categories"]["colors"]["primary"], json!({ "light": "#15803D", "sea": "#0af" }));
}
```

- [ ] **Step 6: Run them to see them fail**

Run: `… cargo test -p taskflow-design --test named_themes`
Expected: FAIL — `a_patch_declares_a_theme_and_edits_only_that_theme` (`res.json()["themes"]` is `null`) and `rename_moves_values_and_an_omitted_theme_is_reported_removed` (`themes_removed` is `null`); `an_unknown_theme_is_a_clear_error` passes already.

- [ ] **Step 7: Implement the write reply**

In `src/agent_views.rs` `write_tokens`:

1. Before `let doc = if let Some(patch) = input.patch {` add `let mut renamed: Vec<(String, String)> = Vec::new();`.
2. Replace
```rust
        if let Err(err) = crate::tokens::apply_patch(&mut doc, &patch) {
            return Ok(tokens_validation_error("invalid-patch", err));
        }
```
with
```rust
        match crate::tokens::apply_patch(&mut doc, &patch) {
            Ok(changes) => renamed = changes.renamed,
            Err(err) => return Ok(tokens_validation_error("invalid-patch", err)),
        }
```
3. After the `let content = match serde_json::to_string(&doc) { … };` block add:
```rust
    // #619: a theme that left the list (not by a rename) took its values with
    // it. The reply says so, because `themes` is the FULL list and an agent
    // adding one theme can drop `dark` by leaving it out.
    let after_themes = doc.declared_themes();
    let removed_themes: Vec<String> = before
        .declared_themes()
        .into_iter()
        .filter(|t| !after_themes.contains(t) && !renamed.iter().any(|(from, _)| from == t))
        .collect();
```
4. In the `WriteOutcome::Saved(row, verdict)` arm change `let note = format!(` to `let mut note = format!(`, and replace the `Ok((StatusCode::CREATED, Json(json!({ … })),).into_response())` with:
```rust
            if !removed_themes.is_empty() {
                note.push_str(&format!(
                    " Removed theme(s) {} and their values (`themes` is the full list: a theme left out is deleted).",
                    removed_themes.join(", ")
                ));
            }
            let mut body = json!({
                "ok": true,
                "path": row.path,
                "version": row.version,
                "changed": changes.iter().take(SHOWN).collect::<Vec<_>>(),
                "changed_count": changes.len(),
                "routes_affected": routes,
                "themes": after_themes,
                "warnings": verdict.warnings,
                "note": note,
            });
            if !removed_themes.is_empty() {
                body["themes_removed"] = json!(removed_themes);
            }
            Ok((StatusCode::CREATED, Json(body)).into_response())
```
5. Update the `patch` field doc on `AgentWriteTokensInput` to: `/// Merge shape {"themes"?: [...full list besides light...], category: {key: {light?, <theme>?} | null}}: only what it names changes (see tokens::apply_patch).`

- [ ] **Step 8: Run the tests**

Run: `… cargo test -p taskflow-design --test named_themes` → Expected: `3 passed`.
Run: `… cargo test -p taskflow-design` → Expected: all pass (incl. `compare::a_token_patch_merges_and_refuses_a_stale_base_version`'s `< 800` bytes reply).

- [ ] **Step 9: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git add backend/plugins/taskflow-design/tests/named_themes.rs && git commit -m "feat(design): per-theme token patches and theme add/rename/reorder/delete (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/src/agent_views.rs backend/plugins/taskflow-design/tests/named_themes.rs
```

---

### Task 5: Themes in the manifest and design_get_tokens

**Files:**
- Modify: `backend/plugins/taskflow-design/src/tokens.rs` (add `default_theme_label`, `TokensDoc::theme_label`, `TokensDoc::resolve_var`)
- Modify: `backend/plugins/taskflow-design/src/manifest.rs` (`DesignManifest` `:62-78`, `build` `:227-245`, new `ThemeInfo`/`ThemeSwatch`/`theme_infos`)
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs` (`context` reply `:91-104`)
- Test: `backend/plugins/taskflow-design/tests/named_themes.rs` (append)

**Interfaces:**
- Consumes: Tasks 1–4; test helpers `seeded`, `add_ocean` from Task 4.
- Produces: `pub fn default_theme_label(name: &str) -> String`; `TokensDoc::theme_label(&self, &str) -> String`; `TokensDoc::resolve_var(&self, var: &str, theme: &str) -> Option<&str>`; `manifest::ThemeInfo { name: String, label: String, swatch: ThemeSwatch }`, `manifest::ThemeSwatch { primary: Option<String>, background: Option<String> }`, `manifest::theme_infos(&TokensDoc) -> Vec<ThemeInfo>`; `DesignManifest.themes` (JSON `themes`); context JSON `themes`.

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing test**

Append to `tests/named_themes.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn the_manifest_and_context_list_themes_with_swatches() {
    let app = TestApp::new().await;
    let (user, project, key) = seeded(&app).await;
    let manifest = app.get_as(user, &format!("/api/design/{project}/manifest")).await.json();
    let themes = manifest["themes"].clone();
    assert_eq!(themes.as_array().map(|t| t.len()), Some(2), "legacy: light + dark: {themes}");
    assert_eq!(themes[0]["name"], "light");
    assert_eq!(themes[1], json!({ "name": "dark", "label": "Dark", "swatch": { "primary": "#22C55E", "background": "oklch(0.145 0 0)" } }));

    add_ocean(&app, &key, project).await;
    let themes = app.get_as(user, &format!("/api/design/{project}/manifest")).await.json()["themes"].clone();
    // Ruling 3: ocean sets no background, so it inherits the LIGHT default.
    assert_eq!(themes[2], json!({ "name": "ocean", "label": "Ocean", "swatch": { "primary": "#0af", "background": "oklch(1 0 0)" } }));

    let ctx = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/context?project={project}"))
        .await
        .json();
    let names: Vec<serde_json::Value> = ctx["themes"].as_array().cloned().unwrap_or_default().iter().map(|t| t["name"].clone()).collect();
    assert_eq!(names, vec![json!("light"), json!("dark"), json!("ocean")]);
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `… cargo test -p taskflow-design --test named_themes the_manifest_and_context`
Expected: FAIL — `themes.as_array()` is `None` (field absent).

- [ ] **Step 3: Implement**

In `src/tokens.rs`, below `is_theme_name`:

```rust
/// A theme's display name when it has no label: the slug title-cased
/// (`high-contrast` → `High Contrast`).
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
```

and inside `impl TokensDoc`:

```rust
    /// The theme's label, else [`default_theme_label`] (light is "Light").
    pub fn theme_label(&self, theme: &str) -> String {
        self.theme_decls()
            .into_iter()
            .find(|t| t.name == theme)
            .and_then(|t| t.label)
            .unwrap_or_else(|| default_theme_label(theme))
    }

    /// What the `--var` (emitted name) renders with in `theme`, found through
    /// the emitter's own naming rule — so `custom["--primary"]` counts too.
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
```

In `src/manifest.rs`, below `DesignManifest`:

```rust
/// #619: one of the project's themes, for the canvas theme switcher.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ThemeInfo {
    pub name: String,
    pub label: String,
    /// What the switcher's swatch shows: the theme's resolved primary and background.
    pub swatch: ThemeSwatch,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ThemeSwatch {
    pub primary: Option<String>,
    pub background: Option<String>,
}

/// The project's themes, light first, labelled, with swatches resolved from
/// the EFFECTIVE tokens (a theme that does not set a colour shows light's,
/// defaults included).
pub fn theme_infos(effective: &TokensDoc) -> Vec<ThemeInfo> {
    effective
        .declared_themes()
        .into_iter()
        .map(|name| ThemeInfo {
            label: effective.theme_label(&name),
            swatch: ThemeSwatch {
                primary: effective.resolve_var("--primary", &name).map(str::to_string),
                background: effective.resolve_var("--background", &name).map(str::to_string),
            },
            name,
        })
        .collect()
}
```

Add to `DesignManifest` (after `tokens_bridge`):

```rust
    /// #619: the declared themes, light first, for the canvas switcher.
    pub themes: Vec<ThemeInfo>,
```

In `build`, after `let tokens_bridge = …;` add `let themes = theme_infos(&effective);` and add `themes,` to the `DesignManifest { … }` literal.

In `src/agent_views.rs` `context`, add to the reply object (after `"defaults": defaults,`):

```rust
        // #619: the ordered theme list (light first) with labels and swatches.
        "themes": manifest::to_json(&m)["themes"],
```

- [ ] **Step 4: Run the tests**

Run: `… cargo test -p taskflow-design --test named_themes` → Expected: `4 passed`.
Run: `… cargo test -p taskflow-design` → Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "feat(design): manifest and design_get_tokens list the themes with swatches (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/src/manifest.rs backend/plugins/taskflow-design/src/agent_views.rs backend/plugins/taskflow-design/tests/named_themes.rs
```

---

### Task 6: Sandbox `?theme=` accepts any declared theme

**Files:**
- Modify: `backend/plugins/taskflow-design/src/views.rs:1136-1171` (`serve_sandbox_page`)
- Test: `backend/plugins/taskflow-design/tests/named_themes.rs` (append)

**Interfaces:**
- Consumes: Task 1 (`project_tokens_doc(&files).declared_themes()`), Task 2 (ocean block in served CSS), Task 4 helpers.
- Produces: `/s/{token}/{route}?theme=<declared>` → `<html data-theme="<declared>">`; anything else → `light`.

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing test**

Append to `tests/named_themes.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn the_sandbox_renders_any_declared_theme_and_falls_back_to_light() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;
    let token = taskflow_design::sandbox::mint(project);
    for (query, expected) in [
        ("?theme=ocean", "ocean"),
        ("?theme=dark", "dark"),
        ("?theme=light", "light"),
        ("", "light"),
        // Review focus 3: a stale or bogus name renders light, never an error.
        ("?theme=sunset", "light"),
        ("?theme=both", "light"),
        ("?theme=Ocean", "light"),
        ("?theme=%22%3E%3Cscript%3E", "light"),
    ] {
        let res = app.get_sandbox(&format!("/s/{token}/{query}")).await;
        assert_eq!(res.status(), 200, "{query}: {}", res.text());
        assert!(
            res.text().contains(&format!("<html lang=\"en\" data-theme=\"{expected}\">")),
            "{query}: expected data-theme={expected}"
        );
    }
    let css = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css")).await.text();
    assert!(css.contains(":root[data-theme=\"ocean\"] {\n  --primary: #0af;\n}"), "{css}");
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `… cargo test -p taskflow-design --test named_themes the_sandbox_renders`
Expected: FAIL — `?theme=ocean: expected data-theme=ocean`.

- [ ] **Step 3: Implement**

In `src/views.rs` `serve_sandbox_page`, delete the block

```rust
    // `?theme=dark` renders the page dark from the first byte, the same
    // `data-theme` the canvas sets with `design:theme` after load — so a
    // screenshot has no light first paint to catch. Anything else is light.
    let theme = match query.and_then(|q| query_param(q, "theme")) {
        Some("dark") => "dark",
        _ => "light",
    };
```

and directly after `let files = store::list_files(project_id).await;` insert:

```rust
    // `?theme=<name>` renders the page in that theme from the first byte, the
    // same `data-theme` the canvas sets with `design:theme` after load — so a
    // screenshot has no light first paint to catch. #619: any theme the
    // project declares; anything else (including `both`) is light. Only a
    // declared slug can reach the HTML attribute.
    let declared = crate::tokens::project_tokens_doc(&files).declared_themes();
    let theme = match query.and_then(|q| query_param(q, "theme")) {
        Some(name) if declared.iter().any(|d| d == name) => name.to_string(),
        _ => "light".to_string(),
    };
```

In the `composer::compose_document(…)` call, the `theme,` argument becomes `&theme,`.

- [ ] **Step 4: Run the tests**

Run: `… cargo test -p taskflow-design --test named_themes` → Expected: `5 passed`.
Run: `… cargo test -p taskflow-design --test sandbox_caching` → Expected: pass (dark/both/none unchanged).

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "feat(design): sandbox renders any declared theme from the first byte (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/views.rs backend/plugins/taskflow-design/tests/named_themes.rs
```

---

### Task 7: Compare and overrides for N themes

**Files:**
- Modify: `backend/plugins/taskflow-design/src/compare.rs` (`OverrideValue` `:30-41`, `validate` `:96-106`, `style_block` `:126-155`, `apply_to` `:193-231`, `validate_spec` `:391-394`, new `check_override_themes`, tests `:581-723`)
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs` (`compare`, after the routes check ~`:1830`)
- Modify: `backend/plugins/taskflow-design/tests/compare.rs:220`
- Test: `backend/plugins/taskflow-design/tests/named_themes.rs` (append)

**Interfaces:**
- Consumes: Tasks 1, 4 (`add_ocean`), 6 (sandbox serves ocean cells).
- Produces: `pub enum OverrideValue { Both(String), PerTheme(BTreeMap<String, String>) }` (wire shape `"v"` or `{light?, dark?, <theme>?}`); `pub fn check_override_themes(ov: &Overrides, declared: &[String]) -> Result<(), String>`; `validate_spec` themes = ≥1 distinct theme slugs; compare handler 400 for undeclared themes.

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing unit tests**

In `src/compare.rs` `mod tests`:

1. Replace the test `style_block_puts_single_values_in_both_themes` with:

```rust
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
        let parsed: Overrides = serde_json::from_str(r#"{"tokens":{"--a":"#000","--b":{"dark":"#fff","ocean":"#0af"}}}"#).expect("parse");
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
```

2. In `a_tall_grid_is_split_per_route_when_cells_get_too_small` nothing changes. In the existing `style_block`-adjacent code nothing else references `PerTheme { … }` except the test you just replaced.

- [ ] **Step 2: Run them to see them fail**

Run: `… cargo test -p taskflow-design --lib compare::tests`
Expected: compile error — `OverrideValue::PerTheme` is a struct variant / `cannot find function check_override_themes`.

- [ ] **Step 3: Implement in `src/compare.rs`**

Import line: `use crate::tokens::{OrderedMap, TokenValue, TokensDoc, category_to_var_name, is_theme_name, LIGHT};`

Replace `OverrideValue`:

```rust
/// An override's value: one value for every theme, or per theme
/// (`{"light"?, "dark"?, "<theme>"?}` — #619: any theme slug).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OverrideValue {
    Both(String),
    PerTheme(BTreeMap<String, String>),
}
```

In `validate`, replace the `OverrideValue::PerTheme { light, dark } => { … }` arm with:

```rust
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
```

Add after `validate`:

```rust
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
```

Replace `style_block` (keep the doc comment, rewording: "A single value goes in `:root` and in `:root[data-theme]` — later and more specific than every theme block in tokens.css — so it applies in every theme, which is what 'set --primary to X' means. A per-theme value goes in that theme's own block."):

```rust
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
```

In `apply_to`, replace the `match value { … }` with:

```rust
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
```

In `validate_spec`, replace

```rust
    if spec.themes.is_empty() || spec.themes.iter().any(|t| t != "light" && t != "dark") || spec.themes.len() > 2 {
        return Err("themes: light and/or dark".into());
    }
```
with
```rust
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
```

Update `tests/compare.rs:220`: `OverrideValue::PerTheme { light: None, dark: Some("oklch(0.9 0.1 250)".into()) }` → `OverrideValue::PerTheme([("dark".to_string(), "oklch(0.9 0.1 250)".to_string())].into())`.

- [ ] **Step 4: Run the unit tests**

Run: `… cargo test -p taskflow-design --lib compare::tests` → Expected: all pass.

- [ ] **Step 5: Write the failing endpoint test**

Append to `tests/named_themes.rs`:

```rust
async fn compare(app: &TestApp, key: &str, body: serde_json::Value) -> support::TestResponse {
    app.post_json_as_agent(key, "/api/taskflow/agents/design/compare", &body).await
}

#[tokio::test(flavor = "multi_thread")]
async fn compare_takes_any_declared_theme_and_refuses_the_rest() {
    let app = TestApp::new().await;
    let (_user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;
    // Acceptance 5: three themes, no overrides — valid; no renderer in tests.
    let ok = compare(&app, &key, json!({ "project": project, "routes": ["/"], "variants": [{ "label": "Current" }], "themes": ["light", "dark", "ocean"] })).await;
    assert_eq!(ok.status(), 503, "{}", ok.text());
    let unknown = compare(&app, &key, json!({ "project": project, "routes": ["/"], "variants": [{ "label": "Current" }], "themes": ["light", "sunset"] })).await;
    assert_eq!(unknown.status(), 400, "{}", unknown.text());
    assert!(unknown.text().contains("sunset") && unknown.text().contains("light, dark, ocean"), "{}", unknown.text());
    let bad_variant = compare(&app, &key, json!({
        "project": project, "routes": ["/"],
        "variants": [{ "label": "X", "tokens": { "--primary": { "sunset": "#f00" } } }],
    }))
    .await;
    assert_eq!(bad_variant.status(), 400, "{}", bad_variant.text());
    // Review focus 5: an unsaved single value beats the ocean block on an ocean page.
    let token = taskflow_design::sandbox::mint(project);
    let ov = taskflow_design::compare::encode(&taskflow_design::compare::Overrides {
        tokens: [("--primary".to_string(), taskflow_design::compare::OverrideValue::Both("#448502".into()))].into(),
        css: None,
    });
    let html = app.get_sandbox(&format!("/s/{token}/?theme=ocean&ov={ov}")).await.text();
    assert!(html.contains(":root[data-theme]{--primary:#448502;}"), "{html}");
}
```

- [ ] **Step 6: Run it to see it fail**

Run: `… cargo test -p taskflow-design --test named_themes compare_takes`
Expected: FAIL — `unknown` answers 503 (no declared-theme check yet).

- [ ] **Step 7: Implement the handler check**

In `src/agent_views.rs` `compare`, directly after the `if let Some(missing) = spec.routes.iter().find(…) { return Ok(bad_request(…)); }` block insert:

```rust
    // #619: every theme row and every per-theme override must be a theme the
    // project declares — an unknown one would render light and look like a result.
    let declared = crate::tokens::project_tokens_doc(&files).declared_themes();
    if let Some(unknown) = spec.themes.iter().find(|t| !declared.contains(t)) {
        return Ok(bad_request(format!(
            "theme `{unknown}` is not declared in this project (themes: {}); add it with design_write_tokens first",
            declared.join(", ")
        )));
    }
    for v in &spec.variants {
        if let Err(e) = crate::compare::check_override_themes(&v.overrides, &declared) {
            return Ok(bad_request(format!("variant `{}`: {e}", v.label)));
        }
    }
```

Also update the doc comment on `AgentCompareInput.themes` to `/// Theme rows, any the project declares; ["light"] when absent.`

- [ ] **Step 8: Run the tests**

Run: `… cargo test -p taskflow-design --test named_themes` → Expected: `6 passed`.
Run: `… cargo test -p taskflow-design` → Expected: all pass (incl. `tests/compare.rs`).

- [ ] **Step 9: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "feat(design): compare and unsaved overrides for any declared theme (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/compare.rs backend/plugins/taskflow-design/src/agent_views.rs backend/plugins/taskflow-design/tests/compare.rs backend/plugins/taskflow-design/tests/named_themes.rs
```

---

### Task 8: Screenshots in any theme, `all`, and the renderer contract

**Files:**
- Modify: `backend/plugins/taskflow-design/src/screenshots.rs` (`Theme` `:101-118`, `RenderError` `:192-222`, `render_screenshot` `:353-388`, new `check_theme`/`theme_shots`, new test module)
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs` (`AgentScreenshotQuery.theme` doc `:1499`, `screenshot` `:1522-1610`, new `screenshot_error_response`)
- Modify: `backend/plugins/taskflow-design/src/views.rs` (`CreateScreenshotInput.theme` doc `:176`, `create_screenshot` `:190-224`)
- Modify: `backend/renderer/design-render.mjs` (`:7`, `:52`, `:150-154`), `backend/renderer/server.mjs` (`:11`, `:76-79`)
- Test: `backend/plugins/taskflow-design/tests/named_themes.rs` (append)

**Interfaces:**
- Consumes: Tasks 1, 4 (`add_ocean`), 7 (`check_override_themes`).
- Produces: `pub enum Theme { Light, Dark, Both, All, Named(String) }` (Clone, Default, PartialEq; string serde) with `Theme::parse(&str) -> Theme`, `Theme::as_str(&self) -> &str`; `pub fn check_theme(&Theme, &[String]) -> Result<(), RenderError>`; `pub fn theme_shots(&Theme, &[String]) -> Vec<Theme>`; `RenderError::BadTheme(String)`; agent screenshot reply for `all`: `{route, viewport, size, theme:"all", full_page, frame, warnings, mime, shots:[{theme, image, png_base64}]}`; renderer `--theme both|<slug>`.

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing unit tests**

Append to `src/screenshots.rs`:

```rust
#[cfg(test)]
mod theme_tests {
    use super::*;

    fn declared() -> Vec<String> {
        ["light", "dark", "ocean"].map(String::from).to_vec()
    }

    #[test]
    fn a_theme_parses_from_its_name_and_serialises_back() {
        for raw in ["light", "dark", "both", "all", "ocean"] {
            let theme: Theme = serde_json::from_value(serde_json::json!(raw)).expect("theme");
            assert_eq!(theme.as_str(), raw);
            assert_eq!(serde_json::to_value(&theme).expect("json"), serde_json::json!(raw));
        }
        assert_eq!(Theme::parse("ocean"), Theme::Named("ocean".into()));
        assert_eq!(Theme::parse("dark"), Theme::Dark);
    }

    #[test]
    fn only_declared_themes_pass() {
        assert!(check_theme(&Theme::Named("ocean".into()), &declared()).is_ok());
        assert!(check_theme(&Theme::Both, &declared()).is_ok());
        assert!(check_theme(&Theme::All, &declared()).is_ok());
        let err = check_theme(&Theme::Named("sunset".into()), &declared()).unwrap_err().to_string();
        assert!(err.contains("sunset") && err.contains("light, dark, ocean"), "{err}");
        let no_dark = ["light", "ocean"].map(String::from).to_vec();
        assert!(check_theme(&Theme::Dark, &no_dark).is_err(), "dark only when declared");
        assert!(check_theme(&Theme::Both, &no_dark).is_err(), "both needs dark");
        assert!(check_theme(&Theme::Named("Ocean\"]".into()), &declared()).is_err());
    }

    #[test]
    fn all_is_one_shot_per_declared_theme_in_order() {
        assert_eq!(
            theme_shots(&Theme::All, &declared()),
            vec![Theme::Light, Theme::Dark, Theme::Named("ocean".into())]
        );
        assert_eq!(theme_shots(&Theme::Both, &declared()), vec![Theme::Both]);
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `… cargo test -p taskflow-design --lib theme_tests`
Expected: compile error — `no variant named All`, `cannot find function check_theme`.

- [ ] **Step 3: Implement `Theme`, `check_theme`, `theme_shots`, `BadTheme`**

Replace `:101-118` (the `Theme` enum and its `impl`) in `src/screenshots.rs` with:

```rust
/// Which theme(s) a screenshot renders in: `light` (default), `dark`, `both`
/// (light and dark side by side), #619 any theme the project declares, or
/// `all` (one shot per declared theme — the agent endpoint loops; the
/// renderer never sees `all`). Travels as a plain string.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Theme {
    #[default]
    Light,
    Dark,
    Both,
    All,
    Named(String),
}

impl Theme {
    pub fn parse(raw: &str) -> Theme {
        match raw {
            "light" => Theme::Light,
            "dark" => Theme::Dark,
            "both" => Theme::Both,
            "all" => Theme::All,
            other => Theme::Named(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Theme::Light => "light",
            Theme::Dark => "dark",
            Theme::Both => "both",
            Theme::All => "all",
            Theme::Named(name) => name,
        }
    }
}

impl Serialize for Theme {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for Theme {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(deserializer)?;
        Ok(Theme::parse(&raw))
    }
}

/// Refuse a theme the project does not declare BEFORE anything renders: an
/// unknown name would otherwise come back as a light picture. `both` needs
/// `dark`; `all` is always fine.
pub fn check_theme(theme: &Theme, declared: &[String]) -> Result<(), RenderError> {
    let needed = match theme {
        Theme::Light | Theme::All => None,
        Theme::Dark | Theme::Both => Some("dark"),
        Theme::Named(name) => Some(name.as_str()),
    };
    match needed {
        Some(name) if !crate::tokens::is_theme_name(name) || !declared.iter().any(|d| d == name) => {
            Err(RenderError::BadTheme(format!(
                "theme `{name}` is not declared in this project (themes: {}; or \"both\", \"all\")",
                declared.join(", ")
            )))
        }
        _ => Ok(()),
    }
}

/// The shots a request takes: one per declared theme, in order, for `all`;
/// otherwise just itself.
pub fn theme_shots(theme: &Theme, declared: &[String]) -> Vec<Theme> {
    match theme {
        Theme::All => declared.iter().map(|name| Theme::parse(name)).collect(),
        other => vec![other.clone()],
    }
}
```

Fix the field doc on `ScreenshotRequest.theme` to `/// light (default), dark, both, or a declared theme name (never all here).`

In `RenderError`, add the variant after `BadOverrides(String),`:
```rust
    /// A theme the project does not declare (or `all` where one shot is meant).
    BadTheme(String),
```
and in its `Display`: `Self::BadTheme(why) => write!(f, "Bad theme: {why}."),`

At the top of `render_screenshot` (before reading the env) add:
```rust
    if req.theme == Theme::All {
        return Err(RenderError::BadTheme("render one theme at a time; `all` is expanded by the caller".into()));
    }
```

- [ ] **Step 4: Run the unit tests**

Run: `… cargo test -p taskflow-design --lib theme_tests` → Expected: compile errors move to the callers (`agent_views.rs`/`views.rs` move out of `q.theme`); continue to Step 5 before re-running.

- [ ] **Step 5: Update the two handlers**

In `src/agent_views.rs`, change the `AgentScreenshotQuery.theme` doc to `/// light | dark | both | all | a theme the project declares.` and replace the whole `pub async fn screenshot(…) { … }` with:

```rust
pub async fn screenshot(
    RequireAgent(agent): RequireAgent,
    Query(q): Query<AgentScreenshotQuery>,
) -> Result<Response, StatusCode> {
    use base64::Engine as _;
    authorized_project(&agent, q.project)?;
    let tokens = match q.tokens.as_deref().filter(|t| !t.trim().is_empty()) {
        Some(raw) => match serde_json::from_str(raw) {
            Ok(map) => map,
            Err(e) => {
                return Ok((
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "detail": format!("tokens must be a JSON object of --name → value: {e}") })),
                )
                    .into_response());
            }
        },
        None => Default::default(),
    };
    let overrides = crate::compare::Overrides { tokens, css: q.css.clone() };
    // #619: a theme is any name the project declares (plus `both` / `all`),
    // checked here, before the renderer, so an unknown name is a 400 and not
    // a light picture.
    let declared = crate::tokens::load_project_tokens_doc(agent.project_id).await.declared_themes();
    let checked = crate::screenshots::check_theme(&q.theme, &declared).and_then(|()| {
        crate::compare::check_override_themes(&overrides, &declared)
            .map_err(crate::screenshots::RenderError::BadOverrides)
    });
    if let Err(err) = checked {
        return Ok(screenshot_error_response(err));
    }
    let base = crate::screenshots::ScreenshotRequest {
        viewport: q.viewport.clone(),
        width: q.width,
        height: q.height,
        dpr: q.dpr,
        mobile: q.mobile,
        full_page: q.full_page,
        frame: q.frame,
        theme: q.theme.clone(),
        overrides,
        max_px: q.max_px.unwrap_or(crate::screenshots::AGENT_MAX_PX),
    };
    // One renderer run per theme: `all` is every declared theme, in order.
    let mut shots = Vec::new();
    for theme in crate::screenshots::theme_shots(&q.theme, &declared) {
        let req = crate::screenshots::ScreenshotRequest { theme: theme.clone(), ..base.clone() };
        match crate::screenshots::render_screenshot(&q.route, &req, q.state.as_deref(), || {
            crate::sandbox::mint(agent.project_id)
        })
        .await
        {
            Ok(shot) => shots.push((theme, shot)),
            Err(err) => return Ok(screenshot_error_response(err)),
        }
    }
    // A custom size is not the preset it was sent alongside.
    let viewport = if q.width.is_some() { "custom".to_string() } else { q.viewport.clone() };
    if q.theme == crate::screenshots::Theme::All {
        let warnings: Vec<String> = shots
            .iter()
            .flat_map(|(theme, shot)| shot.warnings.iter().map(move |w| format!("{}: {w}", theme.as_str())))
            .collect();
        let images: Vec<serde_json::Value> = shots
            .iter()
            .map(|(theme, shot)| {
                json!({
                    "theme": theme,
                    "image": png_size(&shot.png),
                    "png_base64": base64::engine::general_purpose::STANDARD.encode(&shot.png),
                })
            })
            .collect();
        return Ok(Json(json!({
            "route": q.route,
            "viewport": viewport,
            "size": shots.first().map(|(_, shot)| shot.viewport.clone()),
            "theme": q.theme,
            "full_page": q.full_page,
            "frame": q.frame,
            "warnings": warnings,
            "mime": "image/png",
            "shots": images,
        }))
        .into_response());
    }
    let Some((_, shot)) = shots.into_iter().next() else {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&shot.png);
    Ok(Json(json!({
        "route": q.route,
        "viewport": viewport,
        "size": shot.viewport,
        "image": png_size(&shot.png),
        "theme": q.theme,
        "full_page": q.full_page,
        "frame": q.frame,
        "warnings": shot.warnings,
        "mime": "image/png",
        "png_base64": b64,
    }))
    .into_response())
}

/// The agent screenshot's answer to a render error: 503 names what the
/// operator must configure; bad input is a 400; anything else a 502.
fn screenshot_error_response(err: crate::screenshots::RenderError) -> Response {
    use crate::screenshots::RenderError;
    match err {
        RenderError::Unconfigured(what) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "detail": format!(
                    "Screenshot renderer not configured on this backend ({what}). Ask your human to set it up."
                ),
            })),
        )
            .into_response(),
        err @ (RenderError::UnknownViewport(_)
        | RenderError::BadSize(_)
        | RenderError::BadOverrides(_)
        | RenderError::BadTheme(_)) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "detail": err.to_string() }))).into_response()
        }
        other => {
            eprintln!("design agent screenshot: {other}");
            (StatusCode::BAD_GATEWAY, Json(json!({ "detail": other.to_string() }))).into_response()
        }
    }
}
```

In `src/views.rs` `create_screenshot`, change the `CreateScreenshotInput.theme` doc to `/// light | dark | both | a theme the project declares (one PNG: never all).`, and after `ensure_member(user_id, project_id).await?;` insert:

```rust
    // #619: one declared theme (or both) per PNG here; `all` is the agent tool's.
    let declared = crate::tokens::load_project_tokens_doc(project_id).await.declared_themes();
    if input.theme == crate::screenshots::Theme::All
        || crate::screenshots::check_theme(&input.theme, &declared).is_err()
    {
        return Err(StatusCode::BAD_REQUEST);
    }
```

change `theme: input.theme,` to `theme: input.theme.clone(),`, and add `| crate::screenshots::RenderError::BadTheme(_)` to the `=> StatusCode::BAD_REQUEST` arm of its `map_err`.

- [ ] **Step 6: Update the renderer contract**

`backend/renderer/design-render.mjs`:
- `:7` comment: `[--theme light|dark|both|<theme name>]`
- `:52`: replace with
```js
/// light, dark, `both` (light + dark side by side) or any declared theme slug
/// (#619) — the backend has already checked it is declared.
const THEME_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const theme = args.theme === "both" || THEME_NAME.test(args.theme ?? "") ? args.theme : "light";
```
- `:153` (`emulateMediaFeatures`): `value: pageTheme` → `value: pageTheme === "dark" ? "dark" : "light"`, and extend the comment above it with: `Only dark asks for a dark colour scheme; a named theme restyles through its tokens.`

`backend/renderer/server.mjs`:
- `:11` comment: `theme (light|dark|both|<theme name>)`
- `:79`: replace with
```js
  if (theme !== "both" && !/^[a-z][a-z0-9-]{0,31}$/.test(theme)) return { error: "theme must be both or a theme name" };
```

Run: `node --check /home/dalmas/E/projects/ltt-themes/backend/renderer/design-render.mjs && node --check /home/dalmas/E/projects/ltt-themes/backend/renderer/server.mjs` → Expected: no output, exit 0.

- [ ] **Step 7: Write the failing endpoint test**

Append to `tests/named_themes.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn screenshot_themes_are_checked_before_rendering() {
    let app = TestApp::new().await;
    let (user, project, key) = seeded(&app).await;
    add_ocean(&app, &key, project).await;
    for (theme, status) in [("ocean", 503), ("all", 503), ("both", 503), ("dark", 503), ("light", 503), ("sunset", 400), ("Ocean", 400)] {
        let res = app
            .get_as_agent(&key, &format!("/api/taskflow/agents/design/screenshot?project={project}&route=/&theme={theme}"))
            .await;
        assert_eq!(res.status(), status, "{theme}: {}", res.text());
        if status == 400 {
            assert!(res.text().contains("light, dark, ocean"), "{theme}: {}", res.text());
        }
    }
    // The operator endpoint takes one theme per PNG: `all` and unknown names are refused.
    for theme in ["all", "sunset"] {
        let res = app
            .post_json_as(user, &format!("/api/design/{project}/screenshots"), &json!({ "route": "/", "viewport": "laptop", "theme": theme }))
            .await;
        assert_eq!(res.status(), 400, "{theme}: {}", res.text());
    }
}
```

(Verify the operator route path and body field names against `CreateScreenshotInput` in `src/views.rs` and `src/urls.rs` before running; adjust the path string only if it differs.)

- [ ] **Step 8: Run the tests**

Run: `… cargo test -p taskflow-design --lib theme_tests` → Expected: `3 passed`.
Run: `… cargo test -p taskflow-design --test named_themes` → Expected: `7 passed`.
Run: `… cargo test -p taskflow-design` → Expected: all pass (`phase6_screenshots` included).

- [ ] **Step 9: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "feat(design): screenshots in any declared theme, all = one per theme (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/screenshots.rs backend/plugins/taskflow-design/src/agent_views.rs backend/plugins/taskflow-design/src/views.rs backend/renderer/design-render.mjs backend/renderer/server.mjs backend/plugins/taskflow-design/tests/named_themes.rs
```

---

### Task 9: design_guide teaches themes

**Files:**
- Modify: `backend/plugins/taskflow-design/src/guide.rs` (`INDEX` `:8`, `TOKENS` `:18`, `:39-44`)
- Test: `backend/plugins/taskflow-design/tests/design_guide.rs` (append)

**Interfaces:**
- Consumes: the patch/compare/screenshot contracts of Tasks 4, 7, 8.
- Produces: `design_guide("tokens")` with a `## Themes` section containing the exact sentence `To try a palette, add a theme with design_write_tokens and compare themes. Don't overwrite light.`

**Parallel-safe with:** Task 10, Task 11, Task 13, Task 14

- [ ] **Step 1: Write the failing test**

Append to `tests/design_guide.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn tokens_topic_teaches_named_themes() {
    let app = TestApp::new().await;
    let (_p, key) = agent(&app).await;
    let text = app
        .get_as_agent(&key, "/api/taskflow/agents/design/guide?topic=tokens")
        .await
        .json()["text"]
        .as_str()
        .unwrap()
        .to_string();
    for must in [
        "## Themes",
        "To try a palette, add a theme with design_write_tokens and compare themes. Don't overwrite light.",
        "rename_from",
        "theme \"all\"",
        "themes [\"light\",\"dark\",\"ocean\"]",
        "FULL",
    ] {
        assert!(text.contains(must), "tokens topic lacks {must}");
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `… cargo test -p taskflow-design --test design_guide tokens_topic_teaches` → Expected: FAIL `tokens topic lacks ## Themes`.

- [ ] **Step 3: Implement**

In `src/guide.rs`:
- `INDEX` line for tokens: `- tokens: the shadcn colour names, light/dark and named themes, radius, the classes to write (bg-primary…), what is rejected. Read before your first design write.\n\`
- `TOKENS` heading `## Names (each has light + dark)` → `## Names (each has light + dark defaults)`.
- Replace the line `Check dark mode: design_screenshot with theme "dark". Compare options with design_compare before writing.` with:

```text
Check dark mode: design_screenshot with theme "dark". Compare options with design_compare before writing.

## Themes
light is the base. Every other theme (dark, or a named one like "ocean") sets only the tokens it changes and inherits the rest from light. design_get_tokens lists them in `themes`.
To try a palette, add a theme with design_write_tokens and compare themes. Don't overwrite light.
- Add: {"themes":[{"name":"dark"},{"name":"ocean","label":"Ocean"}],"colors":{"primary":{"ocean":"oklch(0.62 0.14 220)"}}} — `themes` is the FULL ordered list besides light: a theme you leave out is deleted with its values (keep dark).
- Rename: {"themes":[{"name":"dark"},{"name":"sea","rename_from":"ocean"}]}
- Edit one theme: {"colors":{"primary":{"ocean":"oklch(0.7 0.12 220)"}}}; {"ocean": null} drops that value (back to light's).
- Look: design_screenshot theme "ocean" (or theme "all": one image per theme); design_compare themes ["light","dark","ocean"].
Names: lowercase slug (letters, digits, -); light, both and all are reserved; at most 8 themes including light.
```

(Keep the `TOKENS` raw string delimiter `r#"…"#`: the added text contains no `"#` sequence — do not add hex colours.)

- [ ] **Step 4: Run the tests**

Run: `… cargo test -p taskflow-design --test design_guide` → Expected: all pass (index still < 1200 chars).
Run: `cd /home/dalmas/E/projects/ltt-themes/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test --workspace` → Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "docs(design): design_guide tokens topic teaches named themes (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/guide.rs backend/plugins/taskflow-design/tests/design_guide.rs
```

---

### Task 10: FE token types and pure theme helpers

**Files:**
- Modify: `v2_fe/src/lib/design-api.ts` (`TokenGroup`… `:76-122`, add `fetchTokensCss` after `exportTokensCss` `:428-440`)
- Modify: `v2_fe/src/pages/design/token-defaults.ts:1-3`
- Modify: `v2_fe/src/pages/design/token-filter.ts:34-67` (`valueMatches`)
- Create: `v2_fe/src/pages/design/token-themes.ts`, `v2_fe/src/pages/design/token-themes.test.ts`
- Modify: `v2_fe/src/pages/design/token-filter.test.ts` (append one case)

**Interfaces:**
- Consumes: the backend JSON shapes of Tasks 1, 5 (no runtime dependency for tests).
- Produces (design-api): `export type DesignTokenValue = { light: string; [theme: string]: string }`; `export type DesignThemeDecl = { name: string; label?: string }`; `DesignTokensDoc.themes?: DesignThemeDecl[]`; `export type DesignThemeInfo = { name: string; label: string; swatch: { primary: string | null; background: string | null } }`; `DesignManifest.themes?: DesignThemeInfo[]`; `export async function fetchTokensCss(projectId: number): Promise<string>`.
- Produces (token-themes): `LIGHT`, `MAX_THEMES`, `themeDecls(doc)`, `declaredThemes(doc): string[]`, `defaultThemeLabel(name)`, `themeLabel(doc, name)`, `themeNameError(doc, name, renaming?): string | null`, `addTheme(doc, name, label?)`, `duplicateTheme(doc, source, name)`, `renameTheme(doc, from, to)`, `deleteTheme(doc, name)`, `moveTheme(doc, name, delta: -1 | 1)`, `ownThemeValue(value, theme): string | undefined`, `setThemeValue(doc, category, key, theme, raw)` — all pure, returning new docs.

**Parallel-safe with:** Tasks 1–9, Task 14 (Task 11 and Task 13 depend on this task)

- [ ] **Step 1: Record the lint baseline**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npx eslint . 2>&1 | tail -2` → Expected: `✖ 28 problems (27 errors, 1 warning)`.

- [ ] **Step 2: Write the failing tests**

Create `v2_fe/src/pages/design/token-themes.test.ts`:

```ts
import { describe, expect, it } from "vitest"

import type { DesignTokensDoc } from "@/lib/design-api"
import {
  addTheme,
  declaredThemes,
  deleteTheme,
  duplicateTheme,
  moveTheme,
  ownThemeValue,
  renameTheme,
  setThemeValue,
  themeLabel,
  themeNameError,
} from "./token-themes"

// The document as `fetchDesignTokens` hands it over: parsed JSON, legacy shape.
const legacy = (): DesignTokensDoc =>
  JSON.parse(`{"version":1,"categories":{"colors":{"primary":{"light":"#111","dark":"#eee"},"bg":{"light":"#fff"}}}}`)

describe("declaredThemes", () => {
  it("treats a document with no list as the legacy light/dark pair", () => {
    expect(declaredThemes(legacy())).toEqual(["light", "dark"])
  })
})

describe("theme edits", () => {
  it("duplicates dark into ocean, copying every override (acceptance 2)", () => {
    const doc = duplicateTheme(legacy(), "dark", "ocean")
    expect(declaredThemes(doc)).toEqual(["light", "dark", "ocean"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee", ocean: "#eee" })
    expect(doc.categories.colors.bg).toEqual({ light: "#fff" })
  })

  it("duplicating light starts a theme with no overrides", () => {
    const doc = duplicateTheme(legacy(), "light", "paper")
    expect(declaredThemes(doc)).toEqual(["light", "dark", "paper"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee" })
  })

  it("renames a theme and moves its values", () => {
    const doc = renameTheme(duplicateTheme(legacy(), "dark", "ocean"), "ocean", "sea")
    expect(declaredThemes(doc)).toEqual(["light", "dark", "sea"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee", sea: "#eee" })
  })

  it("deletes a theme with its values, and never deletes light", () => {
    const doc = deleteTheme(legacy(), "dark")
    expect(declaredThemes(doc)).toEqual(["light"])
    expect(doc.categories.colors.primary).toEqual({ light: "#111" })
    expect(deleteTheme(legacy(), "light")).toEqual(legacy())
  })

  it("reorders themes and stops at the ends", () => {
    const doc = addTheme(addTheme(legacy(), "ocean"), "sunset")
    expect(declaredThemes(moveTheme(doc, "sunset", -1))).toEqual(["light", "dark", "sunset", "ocean"])
    expect(declaredThemes(moveTheme(doc, "dark", -1))).toEqual(["light", "dark", "ocean", "sunset"])
    expect(declaredThemes(moveTheme(doc, "sunset", 1))).toEqual(["light", "dark", "ocean", "sunset"])
  })

  it("never mutates the document it was given", () => {
    const before = legacy()
    const snapshot = JSON.stringify(before)
    renameTheme(duplicateTheme(before, "dark", "ocean"), "dark", "night")
    setThemeValue(before, "colors", "primary", "dark", "")
    deleteTheme(before, "dark")
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe("themeNameError", () => {
  it.each(["", "Ocean", "my theme", "1x", "x\"]", "light", "both", "all", "dark"])("refuses %j", (name) => {
    expect(themeNameError(legacy(), name)).not.toBeNull()
  })

  it("accepts a fresh slug, and a rename to its own name", () => {
    expect(themeNameError(legacy(), "ocean")).toBeNull()
    expect(themeNameError(legacy(), "dark", "dark")).toBeNull()
  })

  it("caps the list at 8 themes including light", () => {
    let doc = legacy()
    for (const name of ["a", "b", "c", "d", "e", "f"]) doc = addTheme(doc, name)
    expect(declaredThemes(doc)).toHaveLength(8)
    expect(themeNameError(doc, "g")).toMatch(/8/)
  })
})

describe("per-theme values", () => {
  it("edits one theme; an empty value removes the override so light shows through", () => {
    let doc = duplicateTheme(legacy(), "dark", "ocean")
    doc = setThemeValue(doc, "colors", "primary", "ocean", "#0af")
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee", ocean: "#0af" })
    doc = setThemeValue(doc, "colors", "primary", "ocean", "  ")
    expect(doc.categories.colors.primary).toEqual({ light: "#111", dark: "#eee" })
    expect(ownThemeValue(doc.categories.colors.primary, "ocean")).toBeUndefined()
    expect(ownThemeValue(doc.categories.colors.primary, "light")).toBe("#111")
    doc = setThemeValue(doc, "colors", "primary", "light", "#222")
    expect(doc.categories.colors.primary.light).toBe("#222")
  })

  it("labels themes from their declaration or their slug", () => {
    expect(themeLabel(legacy(), "light")).toBe("Light")
    expect(themeLabel(addTheme(legacy(), "high-contrast"), "high-contrast")).toBe("High Contrast")
    expect(themeLabel(addTheme(legacy(), "ocean", "Deep sea"), "ocean")).toBe("Deep sea")
  })
})
```

Append to `v2_fe/src/pages/design/token-filter.test.ts` (inside the file's top-level, after the last `describe`):

```ts
describe("filterTokenCategories over named themes", () => {
  it("matches a value set only in a named theme", () => {
    const doc = JSON.parse(
      `{"version":1,"themes":[{"name":"ocean"}],"categories":{"colors":{"primary":{"light":"#111111","ocean":"#00aaff"},"bg":{"light":"#ffffff"}}}}`,
    ) as DesignTokensDoc
    expect(Object.keys(filterTokenCategories(doc, "00aaff").categories.colors ?? {})).toEqual(["primary"])
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npx vitest run src/pages/design/token-themes.test.ts src/pages/design/token-filter.test.ts`
Expected: `token-themes.test.ts` fails to import (`Failed to resolve import "./token-themes"`); the new filter case FAILS (`expected [] to equal ["primary"]`).

- [ ] **Step 4: Implement the types**

In `v2_fe/src/lib/design-api.ts`, replace the `DesignTokensDoc` block (`:92-98`) with:

```ts
/// One token's values (#619): `light`, the base every theme inherits, plus
/// one key per theme that overrides it — `{light, dark?, ocean?, …}`. Mirrors
/// the backend's flat `TokenValue`; a theme with no key renders light's value.
export type DesignTokenValue = { light: string; [theme: string]: string }

/// A declared theme besides light. `label` is optional display text.
export type DesignThemeDecl = { name: string; label?: string }

/// Mirrors the backend's `TokensDoc` (styles/tokens.json): a version counter,
/// the ordered themes besides light (absent = the legacy light/dark pair),
/// and category → token-name → values.
export type DesignTokensDoc = {
  version: number
  themes?: DesignThemeDecl[]
  categories: Record<string, Record<string, DesignTokenValue>>
}

/// One of the project's themes as the manifest lists it (light first), with
/// the swatch the canvas switcher draws: the theme's resolved primary and
/// background (null when the project has neither).
export type DesignThemeInfo = {
  name: string
  label: string
  swatch: { primary: string | null; background: string | null }
}
```

In `DesignManifest` add (after `resources`):

```ts
  /// #619: the declared themes, light first. Absent from a backend that
  /// predates named themes — read it through `manifestThemes`.
  themes?: DesignThemeInfo[]
```

After `exportTokensCss` add:

```ts
/// The generated tokens.css as text, for the token panel's read-only "CSS
/// variables" view. Same endpoint and auth as `exportTokensCss`.
export async function fetchTokensCss(projectId: number): Promise<string> {
  const res = await designFetch(`/api/design/${projectId}/tokens.css`)
  if (!res.ok) throw new Error(`Could not load tokens.css (${res.status}).`)
  return res.text()
}
```

`v2_fe/src/pages/design/token-defaults.ts`: replace `import type { DesignTokensDoc } from "@/lib/design-api"` and `type TokenValue = { light: string; dark?: string }` with:

```ts
import type { DesignTokensDoc, DesignTokenValue } from "@/lib/design-api"

type TokenValue = DesignTokenValue
```

`v2_fe/src/pages/design/token-filter.ts`: replace the body of `valueMatches` with:

```ts
  if (typeof value !== "object" || value === null) return false
  // #619: light and every theme's override are all search surfaces.
  return Object.values(value as Record<string, unknown>).some((half) => halfMatches(half, needle))
```

and change the first sentence of its doc comment to "A token's own VALUES, as a search surface: light and every theme's override."

- [ ] **Step 5: Implement the helpers**

Create `v2_fe/src/pages/design/token-themes.ts`:

```ts
/// Pure edits over a tokens document's themes (#619). Every function returns
/// a NEW document and never mutates its input — the token editor keeps `doc`
/// in React state and saves it whole through `putDesignTokens`, which the
/// server validates (`validate_tokens_json`: rules `theme-name`, `theme-unknown`).
///
/// Shape: `themes` lists the themes besides light, in order; a document with
/// no list is the legacy pair, so `dark` is declared implicitly. A token's
/// `light` is the base; a theme key is an override; no key = inherits light.

import type { DesignThemeDecl, DesignTokensDoc, DesignTokenValue } from "@/lib/design-api"

export const LIGHT = "light"
/// Themes per project, light included — the server's `MAX_THEMES`.
export const MAX_THEMES = 8
const THEME_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const RESERVED = new Set(["light", "both", "all"])

/// The themes besides light, in order.
export function themeDecls(doc: DesignTokensDoc): DesignThemeDecl[] {
  return doc.themes ?? [{ name: "dark" }]
}

/// Every theme the document renders in, light first.
export function declaredThemes(doc: DesignTokensDoc): string[] {
  return [LIGHT, ...themeDecls(doc).map((t) => t.name)]
}

/// `high-contrast` → `High Contrast`.
export function defaultThemeLabel(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

export function themeLabel(doc: DesignTokensDoc, name: string): string {
  if (name === LIGHT) return "Light"
  return themeDecls(doc).find((t) => t.name === name)?.label ?? defaultThemeLabel(name)
}

/// Why `name` cannot be used, or null when it can. `renaming` is the theme
/// being renamed: keeping its own name is allowed and does not count twice.
export function themeNameError(doc: DesignTokensDoc, name: string, renaming?: string): string | null {
  if (!THEME_NAME_RE.test(name)) return "Use a lowercase name: a letter, then letters, digits or -."
  if (RESERVED.has(name)) return `${name} is reserved.`
  if (name !== renaming && declaredThemes(doc).includes(name)) return `${name} already exists.`
  if (renaming === undefined && declaredThemes(doc).length >= MAX_THEMES) return `At most ${MAX_THEMES} themes.`
  return null
}

function mapTokens(doc: DesignTokensDoc, fn: (value: DesignTokenValue) => DesignTokenValue): DesignTokensDoc {
  const categories: DesignTokensDoc["categories"] = {}
  for (const [category, tokens] of Object.entries(doc.categories)) {
    const next: Record<string, DesignTokenValue> = {}
    for (const [key, value] of Object.entries(tokens)) next[key] = fn(value)
    categories[category] = next
  }
  return { ...doc, categories }
}

export function addTheme(doc: DesignTokensDoc, name: string, label?: string): DesignTokensDoc {
  const decl: DesignThemeDecl = label ? { name, label } : { name }
  return { ...doc, themes: [...themeDecls(doc), decl] }
}

/// A new theme starting as a copy of `source`'s overrides — the fastest way to
/// start a palette. Duplicating light adds a theme with no overrides (it
/// already renders exactly like light).
export function duplicateTheme(doc: DesignTokensDoc, source: string, name: string): DesignTokensDoc {
  const withTheme = addTheme(doc, name)
  if (source === LIGHT) return withTheme
  return mapTokens(withTheme, (value) => (value[source] !== undefined ? { ...value, [name]: value[source] } : value))
}

/// Rename a theme; its values move with it. An explicit label is kept.
export function renameTheme(doc: DesignTokensDoc, from: string, to: string): DesignTokensDoc {
  if (from === LIGHT || from === to) return doc
  const themes = themeDecls(doc).map((t) => (t.name === from ? { ...t, name: to } : t))
  return mapTokens({ ...doc, themes }, (value) => {
    if (value[from] === undefined) return value
    const next: DesignTokenValue = { ...value, [to]: value[from] }
    delete next[from]
    return next
  })
}

/// Delete a theme and every value it held. Light cannot be deleted.
export function deleteTheme(doc: DesignTokensDoc, name: string): DesignTokensDoc {
  if (name === LIGHT) return doc
  const themes = themeDecls(doc).filter((t) => t.name !== name)
  return mapTokens({ ...doc, themes }, (value) => {
    if (value[name] === undefined) return value
    const next: DesignTokenValue = { ...value }
    delete next[name]
    return next
  })
}

/// Move a theme one place left (-1) or right (1) among the themes besides light.
export function moveTheme(doc: DesignTokensDoc, name: string, delta: -1 | 1): DesignTokensDoc {
  const themes = [...themeDecls(doc)]
  const from = themes.findIndex((t) => t.name === name)
  const to = from + delta
  if (from < 0 || to < 0 || to >= themes.length) return doc
  ;[themes[from], themes[to]] = [themes[to], themes[from]]
  return { ...doc, themes }
}

/// The token's OWN value in `theme`; undefined means it inherits light.
export function ownThemeValue(value: DesignTokenValue, theme: string): string | undefined {
  return theme === LIGHT ? value.light : value[theme]
}

/// Set one theme's value of one token. For a theme other than light, an empty
/// value removes the override, so the token inherits light again.
export function setThemeValue(
  doc: DesignTokensDoc,
  category: string,
  key: string,
  theme: string,
  raw: string,
): DesignTokensDoc {
  const tokens = doc.categories[category] ?? {}
  const next: DesignTokenValue = { ...(tokens[key] ?? { light: "" }) }
  if (theme === LIGHT) next.light = raw
  else if (raw.trim() === "") delete next[theme]
  else next[theme] = raw
  return { ...doc, categories: { ...doc.categories, [category]: { ...tokens, [key]: next } } }
}
```

- [ ] **Step 6: Run the tests, the build and lint**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npx vitest run src/pages/design/` → Expected: all pass.
Run: `npm run build` → Expected: exit 0. (`token-editor.tsx` still compiles: `{light, dark?}` literals are assignable to `DesignTokenValue`; if tsc flags `TokenMap`/`onOverride` there, change those annotations to `DesignTokenValue` — Task 13 rewrites them anyway.)
Run: `npx eslint . 2>&1 | tail -2` → Expected: `27 errors, 1 warning` (unchanged).

- [ ] **Step 7: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git add v2_fe/src/pages/design/token-themes.ts v2_fe/src/pages/design/token-themes.test.ts && git commit -m "feat(design-fe): theme-aware token types and pure theme helpers (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/lib/design-api.ts v2_fe/src/pages/design/token-defaults.ts v2_fe/src/pages/design/token-filter.ts v2_fe/src/pages/design/token-filter.test.ts v2_fe/src/pages/design/token-themes.ts v2_fe/src/pages/design/token-themes.test.ts v2_fe/src/pages/design/token-editor.tsx
```

(Drop `token-editor.tsx` from the path list if Step 6 did not need to touch it.)

---

### Task 11: FE switcher logic (pure)

**Files:**
- Create: `v2_fe/src/pages/design/theme-options.ts`, `v2_fe/src/pages/design/theme-options.test.ts`
- Modify: `v2_fe/src/pages/design/design-ui-state.test.ts` (append one case)

**Interfaces:**
- Consumes: Task 10 (`DesignManifest.themes`, `DesignThemeInfo`).
- Produces: `export type ThemeOption = DesignThemeInfo`; `manifestThemes(manifest: DesignManifest | null): ThemeOption[]`; `export type SwitcherMode = "none" | "toggle" | "menu"`; `switcherMode(themes): SwitcherMode`; `resolveActiveTheme(theme: string, themes: ThemeOption[]): string`; `toggledTheme(theme: string): string`; `themeSelectItems(themes): { value: string; label: string }[]`.

**Parallel-safe with:** Tasks 1–9, Task 13, Task 14

- [ ] **Step 1: Write the failing tests**

Create `v2_fe/src/pages/design/theme-options.test.ts`:

```ts
import { describe, expect, it } from "vitest"

import type { DesignManifest } from "@/lib/design-api"
import {
  manifestThemes,
  resolveActiveTheme,
  switcherMode,
  themeSelectItems,
  toggledTheme,
  type ThemeOption,
} from "./theme-options"

const opt = (name: string, label = name): ThemeOption => ({ name, label, swatch: { primary: null, background: null } })

describe("switcherMode", () => {
  it("keeps the sun/moon toggle for exactly light + dark (acceptance 4)", () => {
    expect(switcherMode([opt("light"), opt("dark")])).toBe("toggle")
  })
  it("uses the dropdown for three or more", () => {
    expect(switcherMode([opt("light"), opt("dark"), opt("ocean")])).toBe("menu")
  })
  it("uses the dropdown for a pair that is not light + dark", () => {
    expect(switcherMode([opt("light"), opt("ocean")])).toBe("menu")
  })
  it("shows nothing for light alone", () => {
    expect(switcherMode([opt("light")])).toBe("none")
  })
})

describe("resolveActiveTheme", () => {
  it("keeps a declared theme", () => {
    expect(resolveActiveTheme("ocean", [opt("light"), opt("dark"), opt("ocean")])).toBe("ocean")
  })
  it("falls back to light when the chosen theme was deleted or renamed (review focus 3)", () => {
    expect(resolveActiveTheme("ocean", [opt("light"), opt("dark")])).toBe("light")
  })
})

describe("manifestThemes", () => {
  it("reads the manifest's ordered list", () => {
    const manifest = { themes: [opt("light"), opt("sunset"), opt("dark")] } as unknown as DesignManifest
    expect(manifestThemes(manifest).map((t) => t.name)).toEqual(["light", "sunset", "dark"])
  })
  it("falls back to light + dark with no manifest yet or an older backend", () => {
    expect(manifestThemes(null).map((t) => t.name)).toEqual(["light", "dark"])
    expect(manifestThemes({} as DesignManifest).map((t) => t.name)).toEqual(["light", "dark"])
  })
})

describe("toggle and items", () => {
  it("toggles between light and dark", () => {
    expect(toggledTheme("light")).toBe("dark")
    expect(toggledTheme("dark")).toBe("light")
  })
  it("gives the Base UI Select its value → label map", () => {
    expect(themeSelectItems([opt("light", "Light"), opt("ocean", "Ocean")])).toEqual([
      { value: "light", label: "Light" },
      { value: "ocean", label: "Ocean" },
    ])
  })
})
```

Append to `v2_fe/src/pages/design/design-ui-state.test.ts` (top-level, after the existing blocks; add `parseUIState` to its import if it is not imported yet):

```ts
describe("parseUIState and named themes", () => {
  it("keeps a named theme as chosen (#619)", () => {
    expect(parseUIState({ theme: "ocean" }, 1, 2)?.theme).toBe("ocean")
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npx vitest run src/pages/design/theme-options.test.ts src/pages/design/design-ui-state.test.ts`
Expected: `theme-options.test.ts` fails to resolve `./theme-options`; the ui-state case passes already (it pins existing behaviour).

- [ ] **Step 3: Implement**

Create `v2_fe/src/pages/design/theme-options.ts`:

```ts
/// What the canvas theme switcher offers (#619), as pure logic so it is
/// tested: the component (`theme-switcher.tsx`) only draws it.
///
/// The list comes from the manifest, which the server rebuilds on every file
/// event — so saving a new theme in the token panel updates the switcher live.

import type { DesignManifest, DesignThemeInfo } from "@/lib/design-api"

export type ThemeOption = DesignThemeInfo

const LEGACY: ThemeOption[] = [
  { name: "light", label: "Light", swatch: { primary: null, background: null } },
  { name: "dark", label: "Dark", swatch: { primary: null, background: null } },
]

/// The manifest's ordered themes, or — before the manifest loads, or from a
/// backend that predates named themes — the light/dark pair.
export function manifestThemes(manifest: DesignManifest | null): ThemeOption[] {
  return manifest?.themes?.length ? manifest.themes : LEGACY
}

export type SwitcherMode = "none" | "toggle" | "menu"

/// Exactly light + dark keeps the sun/moon toggle; light alone needs no
/// control; anything else is a dropdown.
export function switcherMode(themes: ThemeOption[]): SwitcherMode {
  if (themes.length <= 1) return "none"
  if (themes.length === 2 && themes[0].name === "light" && themes[1].name === "dark") return "toggle"
  return "menu"
}

/// The theme to render: the chosen one while it exists, else light. The
/// choice itself stays as stored, so a restored theme comes back.
export function resolveActiveTheme(theme: string, themes: ThemeOption[]): string {
  return themes.some((t) => t.name === theme) ? theme : "light"
}

export function toggledTheme(theme: string): string {
  return theme === "dark" ? "light" : "dark"
}

/// Base UI's `SelectValue` shows the raw value unless the root gets this map.
export function themeSelectItems(themes: ThemeOption[]): { value: string; label: string }[] {
  return themes.map((t) => ({ value: t.name, label: t.label }))
}
```

- [ ] **Step 4: Run tests, build, lint**

Run: `npx vitest run src/pages/design/` → Expected: all pass.
Run: `npm run build` → Expected: exit 0.
Run: `npx eslint . 2>&1 | tail -2` → Expected: `27 errors, 1 warning`.

- [ ] **Step 5: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git add v2_fe/src/pages/design/theme-options.ts v2_fe/src/pages/design/theme-options.test.ts && git commit -m "feat(design-fe): theme switcher logic — toggle vs dropdown, stale-theme fallback (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/pages/design/theme-options.ts v2_fe/src/pages/design/theme-options.test.ts v2_fe/src/pages/design/design-ui-state.test.ts
```

---

### Task 12: Theme switcher on the canvas and in component dialogs

**Files:**
- Create: `v2_fe/src/pages/design/theme-switcher.tsx`
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (imports `:20-30`, after `:204`, `:654-677`, `:1063-1071`, `:1169`, `:1304`, `ComponentsPanel` `:1698-1772`)
- Modify: `v2_fe/src/pages/design/component-dialog.tsx` (`:1-7`, `:26-47`, `:96-106`, `:135`, `:161`)
- Modify: `v2_fe/src/pages/design/export/export-dialog.tsx:137`, `v2_fe/src/pages/design/export/export-run.ts:40`, `:403`

**Interfaces:**
- Consumes: Task 11 (`manifestThemes`, `resolveActiveTheme`, `switcherMode`, `themeSelectItems`, `toggledTheme`, `ThemeOption`).
- Produces: `export function ThemeSwitcher(props: { themes: ThemeOption[]; value: string; onChange: (theme: string) => void; compact?: boolean })`; `ComponentDialog` gains prop `themes: ThemeOption[]`; export `theme` fields widen to `string`.

**Parallel-safe with:** Tasks 1–9, Task 13, Task 14

- [ ] **Step 1: Pure logic is already tested (Task 11); this task is wiring. Confirm the baseline**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npx vitest run src/pages/design/theme-options.test.ts` → Expected: pass.

- [ ] **Step 2: Create the component**

Create `v2_fe/src/pages/design/theme-switcher.tsx`:

```tsx
/// The preview-theme control (#619) for the canvas toolbar and the component
/// dialog: the sun/moon toggle when the project has exactly light + dark, a
/// dropdown with a swatch per theme otherwise, nothing for light alone. Which
/// one is `switcherMode`'s call (`theme-options.ts`, tested).

import { MoonIcon, SunIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { switcherMode, themeSelectItems, toggledTheme, type ThemeOption } from "./theme-options"

export function ThemeSwitcher({
  themes,
  value,
  onChange,
  compact = false,
}: {
  themes: ThemeOption[]
  value: string
  onChange: (theme: string) => void
  /// The dialog's smaller, outlined variant.
  compact?: boolean
}) {
  const mode = switcherMode(themes)
  if (mode === "none") return null
  if (mode === "toggle") {
    return (
      <Button
        type="button"
        variant={compact ? "outline" : "ghost"}
        size={compact ? "icon-sm" : "icon"}
        className={compact ? "rounded-lg" : undefined}
        title="Toggle theme"
        onClick={() => onChange(toggledTheme(value))}
      >
        {value === "dark" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
        <span className="sr-only">Toggle theme</span>
      </Button>
    )
  }
  return (
    <Select
      value={value}
      items={themeSelectItems(themes)}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next)
      }}
    >
      <SelectTrigger className={compact ? "h-7 w-32 text-xs" : "h-8 w-36 text-xs"} aria-label="Preview theme" title="Preview theme">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {themes.map((theme) => (
          <SelectItem key={theme.name} value={theme.name}>
            <span className="flex items-center gap-2">
              {/* Background on the left, primary on the right: enough to tell
                  palettes apart at a glance. */}
              <span
                aria-hidden
                className="relative inline-block size-3.5 shrink-0 overflow-hidden rounded-full border border-border"
                style={{ background: theme.swatch.background ?? undefined }}
              >
                <span className="absolute inset-y-0 right-0 w-1/2" style={{ background: theme.swatch.primary ?? undefined }} />
              </span>
              {theme.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

- [ ] **Step 3: Wire the canvas**

In `v2_fe/src/pages/design/DesignSurfacePage.tsx`:
1. Remove `MoonIcon,` and `SunIcon,` from the `lucide-react` import (their only use is the toggle being replaced; confirm with `grep -n "SunIcon\|MoonIcon" src/pages/design/DesignSurfacePage.tsx`).
2. Add imports next to the other `./…` imports:
```ts
import { ThemeSwitcher } from "./theme-switcher"
import { manifestThemes, resolveActiveTheme } from "./theme-options"
```
3. Directly after `const [theme, setTheme] = useState("light")` (`:204`) add:
```ts
  // #619: the project's themes (light first) come from the manifest, so a
  // token save updates the switcher live. `theme` stays the user's choice (and
  // is what gets persisted); what renders is that choice while it exists, else light.
  const themeOptions = useMemo(() => manifestThemes(manifest), [manifest])
  const activeTheme = resolveActiveTheme(theme, themeOptions)
```
4. `downloadBoardImage` (`:666`): `theme: theme === "dark" ? "dark" : "light",` → `theme: activeTheme,` and its dependency list `[sandboxToken, projectId, getSandboxToken, theme, frameMode]` → `[sandboxToken, projectId, getSandboxToken, activeTheme, frameMode]`.
5. Replace the toolbar toggle `<Button variant="ghost" size="icon" title="Toggle theme" …>…</Button>` (`:1063-1071`) with:
```tsx
          <ThemeSwitcher themes={themeOptions} value={activeTheme} onChange={setTheme} />
```
6. `<DesignCanvas … theme={theme}` (`:1169`) → `theme={activeTheme}`.
7. `<ExportDialog … theme={theme === "dark" ? "dark" : "light"}` (`:1304`) → `theme={activeTheme}`.
8. In `ComponentsPanel`, pass the list to the dialog:
```tsx
      <ComponentDialog
        component={selected}
        sandboxToken={sandboxToken}
        themes={manifestThemes(manifest)}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
```

`v2_fe/src/pages/design/export/export-dialog.tsx:137`: `theme: "light" | "dark"` → `theme: string`. `v2_fe/src/pages/design/export/export-run.ts:40` and `:403`: `theme: "light" | "dark"` → `theme: string` (the value is only posted as `design:theme`, which takes any name).

- [ ] **Step 4: Wire the component dialog**

In `v2_fe/src/pages/design/component-dialog.tsx`:
1. `import { MoonIcon, SunIcon, XIcon } from "lucide-react"` → `import { XIcon } from "lucide-react"`; add
```ts
import { ThemeSwitcher } from "./theme-switcher"
import { resolveActiveTheme, type ThemeOption } from "./theme-options"
```
2. Props: add `themes,` to the destructuring and `themes: ThemeOption[]` to the type (after `sandboxToken`).
3. `const [theme, setTheme] = React.useState<"light" | "dark">("light")` → `const [theme, setTheme] = React.useState("light")`, and after the `useEffect` that resets it add `const activeTheme = resolveActiveTheme(theme, themes)`.
4. Replace the toggle `<Button type="button" variant="outline" size="icon-sm" className="rounded-lg" title="Toggle theme" …>…</Button>` (`:96-106`) with:
```tsx
            <ThemeSwitcher themes={themes} value={activeTheme} onChange={setTheme} compact />
```
5. `<ComponentSandboxFrame … theme={theme}` → `theme={activeTheme}`; in `ComponentSandboxFrame`'s prop type `theme: "light" | "dark"` → `theme: string`.

- [ ] **Step 5: Build, lint, tests**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npm run build` → Expected: exit 0.
Run: `npx eslint . 2>&1 | tail -2` → Expected: `27 errors, 1 warning`.
Run: `npx vitest run` → Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git add v2_fe/src/pages/design/theme-switcher.tsx && git commit -m "feat(design-fe): canvas and component-dialog theme switcher — toggle or dropdown (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/pages/design/theme-switcher.tsx v2_fe/src/pages/design/DesignSurfacePage.tsx v2_fe/src/pages/design/component-dialog.tsx v2_fe/src/pages/design/export/export-dialog.tsx v2_fe/src/pages/design/export/export-run.ts
```

---

### Task 13: Token panel — Theme / CSS variables tabs and the theme strip

**Files:**
- Create: `v2_fe/src/pages/design/theme-strip.tsx`, `v2_fe/src/pages/design/token-css-view.tsx`
- Modify: `v2_fe/src/pages/design/token-editor.tsx` (imports `:13-26`, `TokenMap` `:67`, `ValueField` `:95-97`, `CategorySection` `:180-273`, `TokenEditor` `:279-497`)

**Interfaces:**
- Consumes: Task 10 (`DesignTokenValue`, `fetchTokensCss`, `LIGHT`, `declaredThemes`, `ownThemeValue`, `setThemeValue`, `addTheme`, `duplicateTheme`, `renameTheme`, `deleteTheme`, `moveTheme`, `themeLabel`, `themeNameError`).
- Produces: `export function ThemeStrip(props: { doc: DesignTokensDoc; active: string; onSelect: (theme: string) => void; onDocChange: (doc: DesignTokensDoc) => void })`; `export function TokenCssView(props: { projectId: number; epoch: number })`; `TokenEditor` (same props as today).

**Parallel-safe with:** Tasks 1–9, Task 11, Task 12, Task 14

- [ ] **Step 1: Pure logic is tested in Task 10; confirm it passes**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npx vitest run src/pages/design/token-themes.test.ts src/pages/design/token-editor.test.ts` → Expected: pass.

- [ ] **Step 2: Create the theme strip**

Create `v2_fe/src/pages/design/theme-strip.tsx`:

```tsx
/// The token panel's theme strip (#619): `Light | Dark | … | +`. Picking a
/// chip makes the editor below show that theme's values; each chip's ⋯ menu
/// duplicates it (every theme) or renames / moves / deletes it (not light).
/// All edits are local to the editor's `doc` until "Save tokens", like every
/// other token edit; the document logic is `token-themes.ts` (tested).

import { useState } from "react"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DesignTokensDoc } from "@/lib/design-api"
import { cn } from "@/lib/utils"
import {
  LIGHT,
  addTheme,
  declaredThemes,
  deleteTheme,
  duplicateTheme,
  moveTheme,
  renameTheme,
  themeLabel,
  themeNameError,
} from "./token-themes"

type Editing = { mode: "add" } | { mode: "rename"; name: string } | { mode: "duplicate"; source: string }

export function ThemeStrip({
  doc,
  active,
  onSelect,
  onDocChange,
}: {
  doc: DesignTokensDoc
  active: string
  onSelect: (theme: string) => void
  onDocChange: (doc: DesignTokensDoc) => void
}) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [draft, setDraft] = useState("")
  const names = declaredThemes(doc)
  const movable = names.slice(1)
  const renaming = editing?.mode === "rename" ? editing.name : undefined
  const error = editing && draft.trim() ? themeNameError(doc, draft.trim(), renaming) : null

  const start = (next: Editing, initial: string) => {
    setEditing(next)
    setDraft(initial)
  }

  const commit = () => {
    if (!editing) return
    const name = draft.trim()
    if (themeNameError(doc, name, renaming)) return
    if (editing.mode === "add") onDocChange(addTheme(doc, name))
    else if (editing.mode === "rename") onDocChange(renameTheme(doc, editing.name, name))
    else onDocChange(duplicateTheme(doc, editing.source, name))
    onSelect(name)
    setEditing(null)
  }

  const remove = (name: string) => {
    onDocChange(deleteTheme(doc, name))
    if (active === name) onSelect(LIGHT)
  }

  return (
    <div className="border-b px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Theme">
        {names.map((name) => (
          <div
            key={name}
            className={cn(
              "flex items-center rounded-md border text-[11px]",
              name === active ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={name === active}
              className="px-2 py-0.5 font-medium"
              onClick={() => onSelect(name)}
            >
              {themeLabel(doc, name)}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="px-1 py-0.5 hover:text-foreground"
                    aria-label={`${themeLabel(doc, name)} theme actions`}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-40" align="start">
                <DropdownMenuItem onClick={() => start({ mode: "duplicate", source: name }, `${name === LIGHT ? "new" : name}-copy`)}>
                  Duplicate
                </DropdownMenuItem>
                {name !== LIGHT ? (
                  <>
                    <DropdownMenuItem onClick={() => start({ mode: "rename", name }, name)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem disabled={movable.indexOf(name) === 0} onClick={() => onDocChange(moveTheme(doc, name, -1))}>
                      Move left
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={movable.indexOf(name) === movable.length - 1}
                      onClick={() => onDocChange(moveTheme(doc, name, 1))}
                    >
                      Move right
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => remove(name)}>
                      Delete
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        <button
          type="button"
          title="Add a theme"
          aria-label="Add a theme"
          className="rounded-md border border-dashed px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => start({ mode: "add" }, "")}
        >
          <PlusIcon className="size-3" />
        </button>
      </div>
      {editing ? (
        <form
          className="mt-1.5 flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            commit()
          }}
        >
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null)
            }}
            placeholder={editing.mode === "rename" ? "new-name" : "theme-name"}
            aria-label={editing.mode === "rename" ? "New theme name" : "Theme name"}
            className="h-7 w-32 px-1.5 text-xs md:text-xs"
          />
          <button type="submit" className="rounded bg-muted px-1.5 py-0.5 text-[10px] hover:bg-muted/70">
            {editing.mode === "add" ? "Add" : editing.mode === "rename" ? "Rename" : "Duplicate"}
          </button>
          <button type="button" className="px-1 text-[10px] text-muted-foreground" onClick={() => setEditing(null)}>
            Cancel
          </button>
          {error ? <span className="text-[10px] text-destructive">{error}</span> : null}
        </form>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 3: Create the CSS view**

Create `v2_fe/src/pages/design/token-css-view.tsx`:

```tsx
/// The token panel's "CSS variables" tab (#619): the SAVED tokens as the
/// generated CSS — `:root`, one block per theme, and the `@theme inline`
/// bridge — read-only. `epoch` changes after a save so the view refetches.

import { useEffect, useState } from "react"

import { fetchTokensCss } from "@/lib/design-api"

export function TokenCssView({ projectId, epoch }: { projectId: number; epoch: number }) {
  const [css, setCss] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchTokensCss(projectId)
      .then((text) => {
        if (cancelled) return
        setCss(text)
        setError(null)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, epoch])

  return (
    <div className="flex flex-col">
      <p className="px-3 pt-2 text-[10px] text-muted-foreground">
        The saved tokens as CSS — read-only. Save in the Theme tab to update it.
      </p>
      {error ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {css === null && !error ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading CSS…</p> : null}
      {css !== null ? (
        <pre className="mx-3 my-2 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
          {css}
        </pre>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Rework the editor**

In `v2_fe/src/pages/design/token-editor.tsx`:

1. Imports: add `import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"`; add `type DesignTokenValue,` to the `@/lib/design-api` import; add
```ts
import { LIGHT, declaredThemes, ownThemeValue, setThemeValue } from "./token-themes"
import { ThemeStrip } from "./theme-strip"
import { TokenCssView } from "./token-css-view"
```
2. `type TokenMap = Record<string, { light: string; dark?: string }>` → `type TokenMap = Record<string, DesignTokenValue>`.
3. In `ValueField`, the colour swatch falls back to the placeholder (an inherited value) before black:
```tsx
    const swatch = HEX_COLOR_RE.test(value)
      ? value
      : placeholder && HEX_COLOR_RE.test(placeholder)
        ? placeholder
        : "#000000"
```
4. Replace the whole `CategorySection` function with:

```tsx
function CategorySection({
  category,
  tokens,
  theme,
  onSetValue,
  onAdd,
  onRemove,
  defaults,
  onOverride,
}: {
  category: string
  tokens: TokenMap
  /// The theme being edited (#619): each token shows ONE value — this theme's.
  theme: string
  defaults: [string, DesignTokenValue][]
  onOverride: (key: string, value: DesignTokenValue) => void
  onSetValue: (key: string, value: string) => void
  onAdd: (key: string) => void
  onRemove: (key: string) => void
}) {
  const entries = Object.entries(tokens)
  return (
    <div className="border-b px-3 py-2 last:border-b-0">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {categoryLabel(category)}
      </p>
      <div className="flex flex-col gap-2">
        {entries.map(([key, value]) => {
          const own = ownThemeValue(value, theme)
          // A theme other than light with no value of its own renders light's.
          const inherits = theme !== LIGHT && own === undefined
          return (
            <div key={key} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium" title={key}>
                  {key}
                </span>
                <button
                  type="button"
                  title={`Remove ${key}`}
                  onClick={() => onRemove(key)}
                  className="shrink-0 rounded px-1 text-[10px] leading-none text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-1 pl-2">
                <ValueField
                  category={category}
                  value={own ?? ""}
                  // The inherited light value shows as the placeholder, so an
                  // empty field never reads as "unset".
                  placeholder={theme === LIGHT ? undefined : value.light}
                  onChange={(v) => onSetValue(key, v)}
                />
                {theme !== LIGHT && !inherits ? (
                  <button
                    type="button"
                    title={`Reset ${key} to the light value`}
                    aria-label={`Reset ${key} to the light value`}
                    onClick={() => onSetValue(key, "")}
                    className="shrink-0 rounded px-1 text-[10px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    ↺
                  </button>
                ) : null}
                {inherits ? <span className="text-[9px] text-muted-foreground">from light</span> : null}
              </div>
            </div>
          )
        })}
        {defaults.map(([key, value]) => (
          <div key={`default:${key}`} className="flex items-center gap-1.5 opacity-70">
            <span className="min-w-0 flex-1 truncate text-[11px]" title={`${key}: ${ownThemeValue(value, theme) ?? value.light}`}>
              {key}
            </span>
            <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">default</span>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onOverride(key, value)}
            >
              Override
            </button>
          </div>
        ))}
        {!entries.length && !defaults.length ? (
          <p className="text-[10px] text-muted-foreground">No {category} tokens yet.</p>
        ) : null}
      </div>
      <AddTokenForm onAdd={onAdd} />
    </div>
  )
}
```

5. In `TokenEditor`:
   - Add state after `const [defaults, setDefaults] = …`:
```ts
  const [activeTheme, setActiveTheme] = useState(LIGHT)
  const [panel, setPanel] = useState<"theme" | "css">("theme")
  const [cssEpoch, setCssEpoch] = useState(0)
```
   - After the `useEffect(() => { void load() }, [load])` add:
```ts
  // The theme being edited, while it still exists in the (possibly just
  // edited) document; light otherwise.
  const shownTheme = doc && declaredThemes(doc).includes(activeTheme) ? activeTheme : LIGHT
```
   - `overrideDefault`'s `value: { light: string; dark?: string }` → `value: DesignTokenValue`.
   - Replace `setTokenValue` with:
```ts
  const setTokenValue = (category: string, key: string, value: string) =>
    setDoc((prev) => (prev ? setThemeValue(prev, category, key, shownTheme, value) : prev))
```
   - In `handleSave`, after `onSaved()` add `setCssEpoch((n) => n + 1)`.
   - Replace the whole `return ( … )` with:

```tsx
  return (
    <div className="flex flex-col">
      <Tabs value={panel} onValueChange={(value) => setPanel(value as "theme" | "css")}>
        {/* Sticky inside the Tokens tab's scroll container (the outer
            TabsContent): the inner tabs and the theme strip stay pinned while
            the token list scrolls. Nothing between here and that container may
            set `overflow`, or `sticky` sticks to the wrong box. */}
        <div className="sticky top-0 z-10 bg-background">
          <TabsList>
            <TabsTrigger value="theme">Theme</TabsTrigger>
            <TabsTrigger value="css">CSS variables</TabsTrigger>
          </TabsList>
          {panel === "theme" && doc ? (
            <ThemeStrip doc={doc} active={shownTheme} onSelect={setActiveTheme} onDocChange={setDoc} />
          ) : null}
        </div>

        <TabsContent value="theme" className="overflow-y-visible">
          <div className="px-3 pt-2">
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tokens…"
              aria-label="Search tokens"
            />
          </div>
          <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-1">
            <Button size="sm" variant="outline" disabled={!doc || saving} onClick={() => void handleSave()}>
              {saving ? "Saving…" : "Save tokens"}
            </Button>
            <Button size="sm" variant="ghost" disabled={exporting} onClick={() => void handleExport()}>
              {exporting ? "Exporting…" : "Export CSS"}
            </Button>
          </div>

          {loading ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading tokens…</p> : null}
          {loadError ? <p className="px-3 py-2 text-xs text-destructive">{loadError}</p> : null}
          {exportError ? <p className="px-3 py-2 text-xs text-destructive">{exportError}</p> : null}

          {view && !loading
            ? categoryNames
                // While searching, an empty group is not a result.
                .filter((category) => !searching || category in view.categories)
                .map((category) => (
                  <CategorySection
                    key={category}
                    category={category}
                    tokens={view.categories[category] ?? {}}
                    theme={shownTheme}
                    onSetValue={(key, value) => setTokenValue(category, key, value)}
                    onAdd={(key) => addToken(category, key)}
                    onRemove={(key) => removeToken(category, key)}
                    defaults={defaults && doc && !searching ? defaultRows(defaults, doc, category) : []}
                    onOverride={(key, value) => overrideDefault(category, key, value)}
                  />
                ))
            : null}

          {view && !loading && searching && !Object.keys(view.categories).length ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">No tokens match “{query.trim()}”.</p>
          ) : null}

          {errors?.length ? (
            <div className="mx-3 mb-2 rounded border border-destructive/40 bg-destructive/10 p-2">
              {errors.map((e, i) => (
                <p key={i} className="text-[11px] text-destructive">
                  {e.rule}: {e.message}
                </p>
              ))}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="css" className="overflow-y-visible">
          <TokenCssView projectId={projectId} epoch={cssEpoch} />
        </TabsContent>
      </Tabs>
    </div>
  )
```

   - Update the file's top doc comment: "Structured, typed editor over `styles/tokens.json`: a **Theme** tab that edits one theme at a time (theme strip + one value per token, #619) and a read-only **CSS variables** tab."

- [ ] **Step 5: Build, lint, tests**

Run: `cd /home/dalmas/E/projects/ltt-themes/v2_fe && npm run build` → Expected: exit 0.
Run: `npx eslint . 2>&1 | tail -2` → Expected: `27 errors, 1 warning`.
Run: `npx vitest run` → Expected: all pass.

- [ ] **Step 6: Manual check (backend from Tasks 1–9 running, built FE)**

Open a design project's Tokens tab: the strip shows `Light | Dark | +`; Dark ⋯ → Duplicate → `ocean` → Duplicate: the strip shows Ocean selected and every dark override is copied; change 3 colours; Save tokens; the canvas toolbar switcher becomes a dropdown with Ocean (acceptance 2–4); scroll the token list — the inner tabs and the strip stay pinned; CSS variables shows a `:root[data-theme="ocean"]` block.

- [ ] **Step 7: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git add v2_fe/src/pages/design/theme-strip.tsx v2_fe/src/pages/design/token-css-view.tsx && git commit -m "feat(design-fe): token panel edits one theme at a time with a pinned theme strip (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/pages/design/theme-strip.tsx v2_fe/src/pages/design/token-css-view.tsx v2_fe/src/pages/design/token-editor.tsx
```

---

### Task 14: MCP — theme names in screenshot, compare, write_tokens and get_tokens

**Files:**
- Modify: `mcp/src/client.ts` (`:41-62` types, `designScreenshot` `:732-760`)
- Modify: `mcp/src/server.ts` (`design_get_tokens` `:1072-1074`, `design_write_tokens` `:1615-1630`, `design_screenshot` `:1654-1740`, `design_compare` `:1743-1840`, plus shared schema consts before the first of them)
- Modify: `mcp/src/server.test.ts` (harness `:18-50`, `beforeEach` `:308-317`, FakeClient `:78-138`, new `describe` blocks)

**Interfaces:**
- Consumes: backend contracts of Tasks 4, 5, 7, 8 (`themes`, `themes_removed`, `shots`, any declared theme name).
- Produces: `DesignOverrideValue = string | Record<string, string>`; `DesignScreenshotOptions.theme?: string`; `DesignCompareInput.themes?: string[]`; `designScreenshot` result `png_base64?: string`, `shots?: { theme: string; image?: { width: number; height: number }; png_base64: string }[]`, timeout 180 000 ms for `theme: "all"`.

**Parallel-safe with:** Tasks 1–13

- [ ] **Step 1: Write the failing tests**

In `mcp/src/server.test.ts`:
1. In the `vi.hoisted` harness object add `payloads: [] as string[],` and in `beforeEach` add `harness.payloads.length = 0;`.
2. Add to `class FakeClient`:

```ts
    async writeDesignTokens(project: number, _reason: string, opts: unknown) {
      harness.calls.push(`writeDesignTokens:${project}`);
      harness.payloads.push(JSON.stringify(opts));
      return { ok: true, version: 3, themes: ["light", "dark", "ocean"] };
    }
    async designScreenshot(project: number, route: string, viewport: string, _state: string | undefined, opts: { theme?: string }) {
      harness.calls.push(`designScreenshot:${project}:${route}:${opts.theme ?? "light"}`);
      if (opts.theme === "all") {
        return {
          route, viewport, theme: "all", mime: "image/png", warnings: ["ocean: font did not load"],
          shots: [
            { theme: "light", png_base64: "AAAA" },
            { theme: "dark", png_base64: "BBBB" },
            { theme: "ocean", png_base64: "CCCC" },
          ],
        };
      }
      return { route, viewport, theme: opts.theme ?? "light", mime: "image/png", warnings: [], png_base64: "AAAA" };
    }
    async designCompare(project: number, input: { themes?: string[] }) {
      harness.calls.push(`designCompare:${project}:${(input.themes ?? []).join(",")}`);
      return {
        mime: "image/png",
        images: [{ routes: ["/"], png_base64: "AAAA" }],
        split: false,
        grid: { columns: ["Current"], rows: (input.themes ?? ["light"]).map((t) => ({ route: "/", theme: t })) },
        checks: [],
        warnings: [],
      };
    }
```

3. Append:

```ts
describe("named themes (#619)", () => {
  it("design_write_tokens passes per-theme keys and the themes list through intact", async () => {
    const client = await connectedClient();
    const patch = {
      themes: [{ name: "dark" }, { name: "ocean", label: "Ocean" }, { name: "sea", rename_from: "bay" }],
      colors: { primary: { ocean: "#0af", dark: null } },
    };
    const result = await client.callTool({
      name: "design_write_tokens",
      arguments: { profile: "main", reason: "Try an ocean palette", patch },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(harness.payloads[0]!)).toEqual({ patch });
  });

  it("design_screenshot takes any theme name and returns one image per theme for all", async () => {
    const client = await connectedClient();
    const one = await client.callTool({ name: "design_screenshot", arguments: { profile: "main", route: "/", theme: "ocean" } });
    expect(one.isError).toBeFalsy();
    expect(harness.calls).toContain("designScreenshot:2:/:ocean");
    const all = await client.callTool({ name: "design_screenshot", arguments: { profile: "main", route: "/", theme: "all" } });
    const content = all.content as Array<{ type: string; text?: string }>;
    expect(content.filter((c) => c.type === "image")).toHaveLength(3);
    expect(content.find((c) => c.type === "text")?.text ?? "").toMatch(/light, dark, ocean/);
    expect(content.find((c) => c.type === "text")?.text ?? "").toMatch(/ocean: font did not load/);
    const bad = await client.callTool({ name: "design_screenshot", arguments: { profile: "main", route: "/", theme: "Ocean" } });
    expect(bad.isError).toBe(true);
  });

  it("design_compare takes three themes with no cap of two", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_compare",
      arguments: { profile: "main", routes: ["/"], variants: [{ label: "Current" }], themes: ["light", "dark", "ocean"] },
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toContain("designCompare:2:light,dark,ocean");
  });

  it("descriptions teach themes", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const desc = (name: string) => tools.tools.find((t) => t.name === name)?.description ?? "";
    expect(desc("design_write_tokens")).toMatch(/Don't overwrite light/);
    expect(desc("design_write_tokens")).toMatch(/rename_from/);
    expect(desc("design_get_tokens")).toMatch(/`themes`/);
    expect(desc("design_screenshot")).toMatch(/'all'/);
    expect(desc("design_compare")).toMatch(/any theme the project declares/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/dalmas/E/projects/ltt-themes/mcp && npx vitest run src/server.test.ts -t "named themes"`
Expected: FAIL — the write payload loses `themes`/`ocean` (zod error on `themes` array → `isError`), `theme: "ocean"` is rejected by the enum, compare `themes` max 2, descriptions do not match.

- [ ] **Step 3: Implement `client.ts`**

Replace the `DesignScreenshotOptions` and `DesignCompareInput` types (`:41-73`) with:

```ts
/** An unsaved override: one value for every theme, or per theme `{light?, dark?, <theme>?}`. */
export type DesignOverrideValue = string | Record<string, string>;

/** Optional `design_screenshot` controls; see the tool's description. */
export type DesignScreenshotOptions = {
  width?: number;
  height?: number;
  dpr?: number;
  mobile?: boolean;
  full_page?: boolean;
  frame?: "none" | "classic" | "device";
  /** light | dark | both | all | any theme the project declares. */
  theme?: string;
  /** Unsaved overrides: `{"--name": value | {light?, dark?, <theme>?}}`. */
  tokens?: Record<string, DesignOverrideValue>;
  css?: string;
  max_px?: number;
};

/** `design_compare` request body (minus `project`). */
export type DesignCompareInput = {
  routes: (string | { route: string; state?: string; label?: string })[];
  variants: { label: string; tokens?: Record<string, DesignOverrideValue>; css?: string }[];
  /** Theme rows: any themes the project declares. */
  themes?: string[];
  viewport?: string;
  width?: number;
  height?: number;
  checks?: { fg: string; bg: string; label?: string }[];
  scale?: number;
  /** Overrides every variant starts from. */
  tokens?: Record<string, DesignOverrideValue>;
  /** CSS every variant gets. */
  css?: string;
  include_apply?: boolean;
  max_px?: number;
};
```

In `designScreenshot`'s return type change `png_base64: string` to `png_base64?: string` and add
```ts
    /** `theme: "all"`: one shot per declared theme, in order. */
    shots?: { theme: string; image?: { width: number; height: number }; png_base64: string }[]
```
and change `timeoutMs: 45_000,` to `timeoutMs: opts.theme === "all" ? 180_000 : 45_000,` (a shot per theme, sequentially).

- [ ] **Step 4: Implement `server.ts`**

Before `server.tool("design_guide", …)` add:

```ts
  // #619: a theme name (lowercase slug); light/dark/both/all are slugs too.
  const themeName = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, "a theme name: lowercase letters, digits and -");
  // An unsaved override: one value for every theme, or per theme.
  const overrideValue = z.union([z.string(), z.record(z.string(), z.string())]);
```

`design_get_tokens` description: append ` \`themes\` is the ordered theme list (light first) with each theme's label and swatch; tokens_json values are {light, <theme>?…} per token.`

`design_write_tokens`:
- In the description, replace `a token replaces only the themes it names; null removes it;` with `a token replaces only the themes it names ({\"colors\":{\"primary\":{\"ocean\":\"#0af\"}}}); {\"ocean\": null} drops that theme's value; a token: null removes it;` and append: ` THEMES: light is the base; add/rename/reorder/delete themes with patch.themes — the FULL ordered list besides light ([{\"name\":\"dark\"},{\"name\":\"ocean\",\"label\":\"Ocean\"}]; a theme left out is DELETED with its values; rename with {\"name\":\"sea\",\"rename_from\":\"ocean\"}). To try a palette, add a theme with design_write_tokens and compare themes. Don't overwrite light.`
- Replace the `patch` schema with:
```ts
      patch: z
        .object({
          themes: z
            .array(z.object({ name: themeName, label: z.string().min(1).max(40).optional(), rename_from: themeName.optional() }))
            .max(7)
            .optional()
            .describe("The FULL ordered theme list besides light; omitted themes are deleted. Omit to keep the list."),
        })
        .catchall(z.record(z.string(), z.union([z.record(z.string(), z.string().nullable()), z.null()])))
        .optional()
        .describe("Preferred for edits: {themes?, category: {key: {light?, <theme>?: value | null} | null}} — only these change."),
```
- `tokens` field description: `{version, themes?, categories: {…: {<key>: {light, <theme>?…}}}}`.

`design_screenshot`:
- Description line `` "`theme`: 'light' (default), 'dark', or 'both' (light and dark side by side in one image) — check dark whenever you touch colour. " + `` → `` "`theme`: 'light' (default), 'dark', any theme the project declares (design_get_tokens `themes`), 'both' (light and dark side by side in one image) or 'all' (one image per theme) — check every theme whenever you touch colour. " + ``
- `theme: z.enum(["light", "dark", "both"]).optional().describe(…)` → `theme: themeName.optional().describe("light (default), dark, a declared theme, both, or all."),`
- `tokens:` schema → `z.record(z.string(), overrideValue).optional().describe('UNSAVED token overrides, e.g. {"--primary": "#448502"} or {"--background": {"dark": "oklch(0.15 0 0)", "ocean": "oklch(0.2 0.05 230)"}}. Nothing is written.'),`
- In the handler replace from `if (!shot.png_base64) throw …` through the `return { content: [ … ] };` with:
```ts
        const images = shot.shots?.length
          ? shot.shots
          : shot.png_base64
            ? [{ theme: shot.theme ?? "light", png_base64: shot.png_base64 }]
            : [];
        if (!images.length) throw new Error("Renderer returned no image.");
        const size = shot.size
          ? ` (${shot.size.width}×${shot.size.height} @${shot.size.dpr}x${shot.size.mobile ? ", mobile" : ""})`
          : "";
        const dress = shot.frame && shot.frame !== "none" ? `, ${shot.frame} frame` : "";
        const shade =
          shot.theme === "both"
            ? ", light (left) and dark (right)"
            : shot.theme === "all"
              ? `, one image per theme in order: ${images.map((i) => i.theme).join(", ")}`
              : shot.theme && shot.theme !== "light"
                ? `, ${shot.theme}`
                : "";
        const warnings = shot.warnings?.length
          ? `\n\nWARNINGS — the picture differs from a real browser here:\n${shot.warnings.map((w) => `- ${w}`).join("\n")}`
          : "";
        return {
          content: [
            ...images.map((image) => ({ type: "image" as const, data: image.png_base64, mimeType: "image/png" })),
            {
              type: "text",
              text:
                `Screenshot of ${shot.route} at ${shot.viewport}${size}${shade}${shot.full_page ? ", full page" : ""}${dress}. ` +
                `Self-critique it against the tokens scale and your instruction before calling it done.${warnings}`,
            },
          ],
        };
```

`design_compare`:
- Description: `"Render several screens × several UNSAVED design variants × light/dark as ONE labelled image grid` → `× themes as ONE labelled image grid`; the per-theme example `{\"--background\": {\"light\": …, \"dark\": …}}` → `{\"--background\": {\"light\": …, \"dark\": …, \"ocean\": …}}`; append ` \`themes\`: any theme the project declares, e.g. ['light','dark','ocean'] (rows = route × theme). To try a palette, add a theme with design_write_tokens and compare themes.`; `Limits: 1–6 routes, 1–4 variants, at most 24 cells.` stays.
- `themes: z.array(z.enum(["light", "dark"])).min(1).max(2).optional().describe("Default ['light'].")` → `themes: z.array(themeName).min(1).max(8).optional().describe("Theme rows — any theme the project declares (default ['light']).")`
- Both `tokens:` schemas (variant and top-level) → `z.record(z.string(), overrideValue).optional()` (keep their `.describe` texts on the top-level one).

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd /home/dalmas/E/projects/ltt-themes/mcp && npx vitest run` → Expected: all pass.
Run: `npm run typecheck` → Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "feat(mcp): design tools take any declared theme; screenshot theme all (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- mcp/src/client.ts mcp/src/server.ts mcp/src/server.test.ts
```

---

### Task 15: Docs — named themes

**Files:**
- Modify: `documentation/docs/v2.0.0/about.mdx` (`:53`, `:64`, `:75-76`)
- Modify: `documentation/docs/v2.0.0/features.mdx:47`
- Modify: `documentation/docs/v2.0.0/api/index.mdx:67-68`, `:77-78`
- Modify: `v2_fe/public/llms.txt:3`

**Interfaces:**
- Consumes: the behaviour of Tasks 1–14.
- Produces: documentation only.

**Parallel-safe with:** none (run last)

- [ ] **Step 1: Edit**

- `about.mdx:64` append to the tokens bullet: ` A project can have any number of named themes besides light (dark, "ocean", …); each sets only the tokens it changes.`
- `about.mdx:75`: `render a page at a device viewport, light or dark, and look at it` → `render a page at a device viewport in any of the project's themes (or all of them) and look at it`; `:76`: `try token variants side by side, with contrast checks` → `try token variants side by side across themes, with contrast checks`.
- `features.mdx:47` append: ` Tokens support named themes: light is the base, and dark or any named theme (up to eight in all) overrides only what it changes. The token panel edits one theme at a time, the canvas switches between themes (a sun/moon toggle for light + dark, a dropdown with swatches beyond that), and agents add a theme with \`design_write_tokens\` and compare themes side by side.`
- `api/index.mdx:67`: append ` and \`themes\` (the ordered theme list with labels and swatches)`; `:68`: append `; \`patch.themes\` (the full ordered list besides light) adds, renames (\`rename_from\`), reorders and deletes themes, and \`{"<theme>": value}\` edits one theme`; `:77`: `light/dark/both` → `light, dark, any declared theme, both, or all (one image per theme)`; `:78`: `× light/dark` → `× themes (any the project declares)`.
- `llms.txt:3`: after `a design surface (` insert `named themes — light, dark and any number of custom palettes; `.

- [ ] **Step 2: Verify nothing else is stale**

Run: `cd /home/dalmas/E/projects/ltt-themes && grep -rn "light or dark\|light/dark/both\|light and/or dark" documentation/docs/v2.0.0 v2_fe/public/llms.txt` → Expected: no hits that describe the tools' theme options.

- [ ] **Step 3: Commit**

```bash
cd /home/dalmas/E/projects/ltt-themes && git commit -m "docs: named design themes (#619)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- documentation/docs/v2.0.0/about.mdx documentation/docs/v2.0.0/features.mdx documentation/docs/v2.0.0/api/index.mdx v2_fe/public/llms.txt
```

---

## Execution order and parallel groups

- **Backend chain (sequential, one crate):** Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9.
- **Frontend:** Task 10 → (Task 11 → Task 12) ∥ Task 13. All FE tasks may run alongside the backend chain (different directory).
- **MCP:** Task 14, alongside everything.
- **Docs:** Task 15 last.
- Final gate: `cargo test --workspace` (with the shared `CARGO_TARGET_DIR`), `cd v2_fe && npx vitest run && npm run build && npx eslint .` (27 errors / 1 warning), `cd mcp && npx vitest run && npm run typecheck`.
