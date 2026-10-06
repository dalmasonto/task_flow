# Design Safe Areas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Device-framed boards in the Design view draw the page under the status bar. The frame injects `--safe-top`/`--safe-bottom`, and the status-bar and home-indicator ink resolves from `data-status-bar`, then the theme's new `appearance`, then the page's top colour. Frameless boards, screenshots and exports stay pixel-identical.

**Architecture:**
- Every composed sandbox document declares `:root{--safe-top:0px;--safe-bottom:0px}` first and carries a new inline status runtime (`composer::status_bar_script`).
- The runtime applies `design:safe-area {top,bottom}` as inline style on `<html>`, sets `color-scheme` from `design:theme.appearance`, and posts `design:status-bar {mode, background, padsTop, padsBottom}` back.
- The canvas (`ArtboardCard` → `LazyFrame` → `FramedBoard`) sends the device's insets, listens for the report, and resolves the chrome with pure helpers in `status-bar.ts`. It then draws a full-height page with an overlaid strip and home indicator.
- Themes gain an optional `appearance` (backend `ThemeDecl`, manifest `ThemeInfo`, FE chip menu, MCP docs).

**Tech Stack:** Rust (umbral/axum plugin `taskflow-design`), React 19 + Vite + TS (`v2_fe`, vitest), MCP server (TS, zod, vitest).

**Spec:** `docs/superpowers/specs/2026-10-07-design-safe-areas-design.md`

## Global Constraints

- **Worktree:** work ONLY in `/home/dalmas/E/projects/ltt-safe` (branch `feat/design-safe-areas`). Never touch `/home/dalmas/E/projects/local_task_tracker` or other worktrees.
- **Rust tests:**
  - Always set `CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target`.
  - For a targeted run use `cargo test -p taskflow-design ...`. For the full gate use `cargo test --workspace`. Bare `cargo test` skips plugins.
  - If a field "doesn't exist" right after an edit, a stale shared-target artifact is the cause: `touch` the edited file and rerun.
- **vitest and `.tsx`:**
  - vitest collects only `src/**/*.test.ts`. Never add a `.test.tsx`.
  - A `.tsx` file exports components only. Helpers go in `.ts`.
- **ESLint:** counts must not grow.
  - Before your first edit to a `v2_fe`/`mcp` file, record `npx eslint <your files> 2>&1 | tail -2`.
  - After your edits, the count must be the same or lower.
- **Don't touch:**
  - `vendor/umbral-*`.
  - `backend/renderer/*`, `v2_fe/src/pages/design/export/export-run.ts` and the export capture code. Screenshots and exports must not change (spec D7).
- **Commits:**
  - `git add` new files only, then `git commit -m "..." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <paths>`.
  - Never `git add -A`, never amend, never commit `v2_fe/yarn.lock`.
- **Sequencing:**
  - Backend Tasks 1→2→3 touch one crate and run **sequentially**.
  - FE Tasks 4, 5 and 6, MCP Task 8 and docs Task 9 can run in parallel with the backend and with each other.
  - Task 7 needs 4, 5 and 6.
- **Release:** no MCP version bump and no deploy. The controller releases.

## Review Focus

1. **Frameless and exports are pixel-identical.** The composed sandbox page and `page.html` declare no `--safe-*` value other than `0px`, and an export carries no status runtime. Tested in Task 3 (`tests/safe_areas.rs::frameless_documents_declare_only_zero_safe_areas`, composer unit `every_composed_page_declares_zero_safe_areas_before_the_tokens`).
2. **`appearance` round-trips.** It can be set, is kept when a patch omits it, moves with `rename_from`, is cleared by `null`, and a bad value is refused. The manifest/context resolve light→`light`, undeclared dark→`dark`, others→`null`. Tested in Task 1 (`appearance_is_set_kept_moved_by_a_rename_and_cleared_by_null`, `appearance_is_light_or_dark`) and Task 2 (`appearance_reaches_the_manifest_and_get_tokens`).
3. **Ink order and luminance.** Page mode wins over appearance, appearance wins over luminance, and luminance handles rgb, hex and shadcn `oklch`. A hostile report is sanitised. Tested in Task 5 (`status-bar.test.ts`).
4. **Presets and scope of injection.** iPhone SE has a bottom inset of 0, notched iPhones 34, and laptops, breakpoints, landscape and unknown ids 0/0. Only a device-framed board gets insets (classic and outline get 0/0). Tested in Task 4 (`design-devices.test.ts` "safe areas (#626)").
5. **Frame geometry.** The framed iframe is full screen height from the top. The strip is filled when the page does not pad and transparent when it does. The home indicator appears only when `bottom > 0`. Tested in Task 4 (`framedViewportHeight`/`boardContentOrigin`) and Task 7 (`design-canvas.test.ts` "FramedBoard safe areas").

---

### Task 1: Theme `appearance` in the tokens document

**Files:**
- Modify: `backend/plugins/taskflow-design/src/tokens.rs`
- Modify: `backend/plugins/taskflow-design/tests/themes_validation.rs`

**Interfaces:**
```rust
pub const APPEARANCES: &[&str] = &["light", "dark"];
pub struct ThemeDecl { pub name: String, pub label: Option<String>, pub appearance: Option<String> }
impl TokensDoc { pub fn theme_appearance(&self, theme: &str) -> Option<String> }
// ThemePatchEntry gains: appearance: Option<Option<String>>  (absent = keep, null = clear)
```

**Parallel-safe with:** Task 4, 5, 6, 8, 9

- [ ] **Step 1: Write the failing tests.**

  Add these to the `patch_tests` module at the end of `src/tokens.rs` (after `a_three_cycle_of_renames_rotates_the_values`):

```rust
    #[test]
    fn appearance_is_set_kept_moved_by_a_rename_and_cleared_by_null() {
        let mut d = doc();
        apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "dark" }, { "name": "ocean", "appearance": "dark" }] })).expect("set");
        assert_eq!(d.theme_appearance("ocean").as_deref(), Some("dark"));
        // Omitted: the stored value is kept (a label edit must not reset it).
        apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "dark" }, { "name": "ocean", "label": "Ocean" }] })).expect("keep");
        assert_eq!(d.theme_appearance("ocean").as_deref(), Some("dark"));
        // A rename carries it to the new name.
        apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "dark" }, { "name": "sea", "rename_from": "ocean" }] })).expect("rename");
        assert_eq!(d.theme_appearance("sea").as_deref(), Some("dark"));
        // null clears it (Auto).
        apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "dark" }, { "name": "sea", "appearance": null }] })).expect("clear");
        assert_eq!(d.theme_appearance("sea"), None);
        assert_eq!(serde_json::to_value(&d).expect("json")["themes"], serde_json::json!([{ "name": "dark" }, { "name": "sea" }]));
        // Only light or dark.
        let err = apply_patch(&mut d, &serde_json::json!({ "themes": [{ "name": "dark", "appearance": "dim" }] })).unwrap_err();
        assert!(err.contains("appearance"), "{err}");
    }

    #[test]
    fn resolved_appearance_is_light_for_light_dark_for_an_undeclared_dark_else_declared() {
        let legacy = doc();
        assert_eq!(legacy.theme_appearance("light").as_deref(), Some("light"));
        assert_eq!(legacy.theme_appearance("dark").as_deref(), Some("dark"), "implicit dark");
        assert_eq!(legacy.theme_appearance("nope"), None, "not a theme here");
        let mut named = doc();
        apply_patch(&mut named, &serde_json::json!({ "themes": [{ "name": "dark", "appearance": "light" }, { "name": "ocean" }] })).expect("ok");
        assert_eq!(named.theme_appearance("dark").as_deref(), Some("light"), "a declared value wins");
        assert_eq!(named.theme_appearance("ocean"), None, "a named theme with none is automatic");
    }
```

  Add this to `tests/themes_validation.rs`:

```rust
#[test]
fn appearance_is_light_or_dark() {
    assert_eq!(
        rule(r#"{"version":1,"themes":[{"name":"dark","appearance":"dark"},{"name":"ocean","appearance":"light"}],"categories":{}}"#),
        None
    );
    assert_eq!(rule(r#"{"version":1,"themes":[{"name":"ocean"}],"categories":{}}"#), None, "absent = automatic");
    assert_eq!(rule(r#"{"version":1,"themes":[{"name":"ocean","appearance":"dim"}],"categories":{}}"#), Some("theme-name"));
    assert_eq!(rule(r#"{"version":1,"themes":[{"name":"ocean","appearance":"Dark"}],"categories":{}}"#), Some("theme-name"));
}
```

- [ ] **Step 2: Run the tests to confirm they fail.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design --lib appearance 2>&1 | tail -5`

  Expected: a compile error (`no method named theme_appearance`).

  Run: `... cargo test -p taskflow-design --test themes_validation 2>&1 | tail -5`

  Expected: `appearance_is_light_or_dark` FAILS (`dim` currently passes).

- [ ] **Step 3: Implement.**

  In `src/tokens.rs`, replace the `ThemeDecl` struct and impl (lines ~160-171) with:

```rust
/// What a theme LOOKS like, for the device frame's status-bar ink and the
/// page's `color-scheme` (#626). Absent on a decl means automatic.
pub const APPEARANCES: &[&str] = &["light", "dark"];

/// One declared theme besides light: `{"name": "ocean", "label"?: "Ocean", "appearance"?: "dark"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeDecl {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// #626: "light" | "dark". Absent = automatic (the frame reads the page).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<String>,
}

impl ThemeDecl {
    pub fn named(name: impl Into<String>) -> Self {
        ThemeDecl { name: name.into(), label: None, appearance: None }
    }
}
```

  In `impl TokensDoc`, after `theme_label`, add:

```rust
    /// #626: the theme's resolved appearance: `light` for light, the declared
    /// value, else `dark` for a theme named dark; None (automatic) otherwise,
    /// including for a name this document does not declare.
    pub fn theme_appearance(&self, theme: &str) -> Option<String> {
        if theme == LIGHT {
            return Some(LIGHT.to_string());
        }
        let decl = self.theme_decls().into_iter().find(|t| t.name == theme)?;
        decl.appearance.or_else(|| (theme == DARK).then(|| DARK.to_string()))
    }
```

  In `check_theme_list`, inside the loop right after the label check, add:

```rust
        if let Some(appearance) = &theme.appearance {
            if !APPEARANCES.contains(&appearance.as_str()) {
                return Err(format!(
                    "theme `{name}`: appearance is \"light\" or \"dark\" (leave it out for automatic), not `{appearance}`"
                ));
            }
        }
```

  Replace `ThemePatchEntry` with:

```rust
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThemePatchEntry {
    name: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    rename_from: Option<String>,
    /// #626: absent keeps the stored appearance (of `rename_from`'s theme,
    /// else of this name); `null` clears it; "light"/"dark" sets it.
    #[serde(default, deserialize_with = "present")]
    appearance: Option<Option<String>>,
}

/// Distinguishes a PRESENT `null` (`Some(None)`) from an absent key (`None`,
/// via `#[serde(default)]`).
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
```

  In `apply_theme_list`, replace the `let next: Vec<ThemeDecl> = entries ... .collect();` block with:

```rust
    let before = doc.theme_decls();
    let next: Vec<ThemeDecl> = entries
        .iter()
        .map(|e| {
            let source = e.rename_from.as_deref().unwrap_or(e.name.as_str());
            let stored = before.iter().find(|t| t.name == source).and_then(|t| t.appearance.clone());
            ThemeDecl {
                name: e.name.clone(),
                label: e.label.clone(),
                appearance: match &e.appearance {
                    Some(value) => value.clone(),
                    None => stored,
                },
            }
        })
        .collect();
```

- [ ] **Step 4: Run the tests to confirm they pass.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design --lib patch_tests 2>&1 | tail -3`

  Expected: `test result: ok.` and 0 failed.

  Run: `... cargo test -p taskflow-design --test themes_validation --test tokens_codec --test named_themes 2>&1 | grep "test result"`

  Expected: every line reads `ok`.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git commit -m "feat(design): themes carry an optional appearance (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/tests/themes_validation.rs
```

---

### Task 2: Resolved appearance in the manifest and get_tokens, plus guide lines

**Files:**
- Modify: `backend/plugins/taskflow-design/src/manifest.rs`
- Modify: `backend/plugins/taskflow-design/src/guide.rs`
- Modify: `backend/plugins/taskflow-design/tests/named_themes.rs`
- Modify: `backend/plugins/taskflow-design/tests/design_guide.rs`

**Interfaces:**
```rust
pub struct ThemeInfo { pub name: String, pub label: String, pub appearance: Option<String>, pub swatch: ThemeSwatch }
// serialises "appearance": "light" | "dark" | null  (null is NOT skipped)
```

**Parallel-safe with:** Task 4, 5, 6, 8, 9 (runs after Task 1, same crate)

- [ ] **Step 1: Write the failing tests.**

  In `tests/named_themes.rs`, update the two whole-object assertions in `the_manifest_and_context_list_themes_with_swatches`:

```rust
    assert_eq!(themes[1], json!({ "name": "dark", "label": "Dark", "appearance": "dark", "swatch": { "primary": "#22C55E", "background": "oklch(0.145 0 0)" } }));
```
```rust
    assert_eq!(themes[2], json!({ "name": "ocean", "label": "Ocean", "appearance": null, "swatch": { "primary": "#0af", "background": "oklch(1 0 0)" } }));
```

  Append this test to the same file:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn appearance_reaches_the_manifest_and_get_tokens() {
    let app = TestApp::new().await;
    let (user, project, key) = seeded(&app).await;
    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "dark" }, { "name": "forest", "appearance": "dark" }] })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(stored(project).await["themes"], json!([{ "name": "dark" }, { "name": "forest", "appearance": "dark" }]));

    let themes = app.get_as(user, &format!("/api/design/{project}/manifest")).await.json()["themes"].clone();
    let appearances: Vec<serde_json::Value> = themes.as_array().expect("themes").iter().map(|t| t["appearance"].clone()).collect();
    assert_eq!(appearances, vec![json!("light"), json!("dark"), json!("dark")]);

    // design_get_tokens reads the agent context.
    let ctx = app
        .get_as_agent(&key, &format!("/api/taskflow/agents/design/context?project={project}"))
        .await
        .json();
    assert_eq!(ctx["themes"][2]["appearance"], "dark");

    // A rename keeps it; a bad value is refused and stores nothing.
    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "dark" }, { "name": "woods", "rename_from": "forest" }] })).await;
    assert_eq!(res.status(), 201, "{}", res.text());
    assert_eq!(stored(project).await["themes"][1], json!({ "name": "woods", "appearance": "dark" }));
    let before = stored(project).await;
    let res = patch(&app, &key, project, json!({ "themes": [{ "name": "dark", "appearance": "dim" }, { "name": "woods" }] })).await;
    assert_eq!(res.status(), 422, "{}", res.text());
    assert_eq!(stored(project).await, before);
}
```

  In `tests/design_guide.rs`, `each_topic_answers_with_its_essentials`, add these three entries to the array:

```rust
        ("tokens", "pt-[var(--safe-top)]"), ("tokens", "data-status-bar"), ("tokens", "\"appearance\":\"dark\""),
```

- [ ] **Step 2: Run the tests to confirm they fail.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design --test named_themes --test design_guide 2>&1 | grep -E "FAILED|panicked|test result"`

  Expected:
  - `the_manifest_and_context_list_themes_with_swatches` and `appearance_reaches_the_manifest_and_get_tokens` FAIL (no `appearance` key).
  - `each_topic_answers_with_its_essentials` FAILS (`tokens lacks pt-[var(--safe-top)]`).

- [ ] **Step 3: Implement.**

  In `src/manifest.rs`, replace `ThemeInfo` and `theme_infos`:

```rust
/// #619: one of the project's themes, for the canvas theme switcher.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ThemeInfo {
    pub name: String,
    pub label: String,
    /// #626: `light` | `dark` | null (automatic) — `TokensDoc::theme_appearance`.
    /// Serialised as null rather than omitted, so a reader can tell
    /// "automatic" from "a backend that predates appearance".
    pub appearance: Option<String>,
    /// What the switcher's swatch shows: the theme's resolved primary and background.
    pub swatch: ThemeSwatch,
}
```
```rust
pub fn theme_infos(effective: &TokensDoc) -> Vec<ThemeInfo> {
    effective
        .declared_themes()
        .into_iter()
        .map(|name| ThemeInfo {
            label: effective.theme_label(&name),
            appearance: effective.theme_appearance(&name),
            swatch: ThemeSwatch {
                primary: effective.resolve_var("--primary", &name).map(str::to_string),
                background: effective.resolve_var("--background", &name).map(str::to_string),
            },
            name,
        })
        .collect()
}
```

  In `src/guide.rs`, insert directly before the line `## Porting` (inside the tokens topic string):

```text
## Device safe areas
In the Design view's phone frames the page draws under the status bar. Pad the top bar with pt-[var(--safe-top)] and the tab bar or sticky footer with pb-[calc(0.75rem+var(--safe-bottom))]; both are 0px in screenshots and exports, so nothing shifts there.
Status-bar icons: data-status-bar="light" (white icons) or "dark" on the page's top element wins; else the theme's appearance ({"themes":[{"name":"dark"},{"name":"forest","appearance":"dark"}]}, "light"|"dark", null = automatic); else the colour at the top of the page decides.

```

  (Keep the blank line before `## Porting`.)

- [ ] **Step 4: Run the tests to confirm they pass.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design --test named_themes --test design_guide --lib 2>&1 | grep "test result"`

  Expected: every line reads `ok`. (`manifest.rs:607`'s key list is unaffected: that test lists manifest keys, not theme keys.)

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git commit -m "feat(design): manifest and get_tokens resolve each theme's appearance; guide teaches safe areas (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/manifest.rs backend/plugins/taskflow-design/src/guide.rs backend/plugins/taskflow-design/tests/named_themes.rs backend/plugins/taskflow-design/tests/design_guide.rs
```

---

### Task 3: Safe-area defaults and the status runtime in the composer

**Files:**
- Modify: `backend/plugins/taskflow-design/src/composer.rs`
- Create: `backend/plugins/taskflow-design/tests/safe_areas.rs`

**Interfaces:**
```rust
pub const SAFE_AREA_DEFAULTS: &str = ":root { --safe-top: 0px; --safe-bottom: 0px; }";
pub fn status_bar_script() -> String; // escaped inline JS, injected after nav_guard in compose_document only
```

**Wire protocol (runtime side):**
- In: `design:safe-area {top, bottom}`.
- In: `design:theme {theme, appearance?}`.
- Out: `design:status-bar {mode: "light"|"dark"|null, background: "rgb(r, g, b)"|null, padsTop: bool, padsBottom: bool}`.

**Parallel-safe with:** Task 4, 5, 6, 8, 9 (runs after Task 2, same crate)

- [ ] **Step 1: Write the failing tests.**

  Add to the `#[cfg(test)] mod tests` in `src/composer.rs`:

```rust
    fn empty_manifest() -> crate::manifest::DesignManifest {
        crate::manifest::DesignManifest {
            project: 1,
            routes: vec![],
            components: vec![],
            tokens: vec![],
            revision: 1,
            resources: vec![],
            tokens_bridge: String::new(),
            themes: vec![],
        }
    }

    #[test]
    fn every_composed_page_declares_zero_safe_areas_before_the_tokens() {
        let html = compose_document("tok", &empty_manifest(), "/", "pages/index.html", "<p>x</p>", &[], "light", None);
        let defaults = html.find(SAFE_AREA_DEFAULTS).expect("the defaults are declared");
        assert!(defaults < html.find("@tailwindcss/browser").expect("tailwind"), "before Tailwind");
        assert!(defaults < html.find("/f/styles/tokens.css").expect("tokens"), "before the tokens");
        assert!(html.contains("type: 'design:status-bar'"), "the sandbox page carries the status runtime");
        let export = compose_export_document("pages/index.html", "<p>x</p>", "light", ":root{}", "", &[], &[]);
        let defaults = export.find(SAFE_AREA_DEFAULTS).expect("the export declares them too");
        assert!(defaults < export.find("<style>:root{}</style>").expect("inlined tokens"));
        assert!(!export.contains("design:status-bar"), "an export carries no runtime");
    }

    #[test]
    fn the_status_bar_runtime_applies_safe_areas_and_reports_back() {
        let js = status_bar_script();
        // In: the device's insets, clamped, as inline style on <html>.
        assert!(js.contains("m.type === 'design:safe-area'"));
        assert!(js.contains("Math.min(Math.max(Math.round(n), 0), 200)"));
        assert!(js.contains("root.style.setProperty('--safe-top', safeTop + 'px')"));
        assert!(js.contains("root.style.setProperty('--safe-bottom', safeBottom + 'px')"));
        // In: the theme's appearance drives color-scheme; anything else clears it.
        assert!(js.contains("m.type === 'design:theme'"));
        assert!(js.contains("root.style.colorScheme = m.appearance === 'light' || m.appearance === 'dark' ? m.appearance : ''"));
        // Out: the report, and when it is sent.
        assert!(js.contains("type: 'design:status-bar'"));
        assert!(js.contains("closest('[data-status-bar]')"));
        assert!(js.contains("getImageData(0, 0, 1, 1)"), "backgrounds are normalised to rgb() through a canvas");
        assert!(js.contains("addEventListener('load', report)"));
        assert!(js.contains("addEventListener('resize', report)"));
        assert!(js.contains("setTimeout("), "coalesced with a timer, not rAF (throttled off-screen)");
        assert!(!js.contains("requestAnimationFrame"));
        assert!(!js.to_ascii_lowercase().contains("</script"));
    }
```

  Create `tests/safe_areas.rs`:

```rust
//! #626: device safe areas. The composed page declares `--safe-top` and
//! `--safe-bottom` as 0px and nothing else: only the canvas's device frame
//! raises them, at runtime, by postMessage. So a frameless board, a
//! screenshot and a downloaded page.html render exactly as before.

mod support;

use serde_json::json;
use support::TestApp;
use taskflow_design::validation::validate_page_fragment;

/// Every value a `--safe-top:` / `--safe-bottom:` declaration in `html` sets.
fn safe_values(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    for name in ["--safe-top", "--safe-bottom"] {
        let mut rest = html;
        while let Some(i) = rest.find(name) {
            rest = &rest[i + name.len()..];
            if let Some(value) = rest.trim_start().strip_prefix(':') {
                out.push(value.split([';', '}']).next().unwrap_or("").trim().to_string());
            }
        }
    }
    out
}

const PAGE: &str = r#"<main><header class="bg-primary pt-[var(--safe-top)]" data-status-bar="light"><h1>Hi</h1></header><nav class="fixed bottom-0 pb-[calc(0.75rem+var(--safe-bottom))]">Tabs</nav></main>"#;

#[tokio::test(flavor = "multi_thread")]
async fn frameless_documents_declare_only_zero_safe_areas() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let res = app
        .put_json_as(user.id, &format!("/api/design/{project}/file"), &json!({ "path": "pages/index.html", "content": PAGE }))
        .await;
    assert_eq!(res.status(), 201, "{}", res.text());
    let token = taskflow_design::sandbox::mint(project);

    for query in ["", "?theme=dark"] {
        let html = app.get_sandbox(&format!("/s/{token}/{query}")).await.text();
        let values = safe_values(&html);
        assert_eq!(values, vec!["0px".to_string(), "0px".to_string()], "sandbox{query}: {values:?}");
        assert!(html.contains("design:status-bar"), "the sandbox page reports to the frame");
    }

    let export = app.get_as(user.id, &format!("/api/design/{project}/page.html?route=/")).await.text();
    assert_eq!(safe_values(&export), vec!["0px".to_string(), "0px".to_string()], "page.html");
    assert!(!export.contains("design:status-bar"), "page.html carries no runtime");
}

#[test]
fn a_page_padding_by_the_safe_areas_validates() {
    let v = validate_page_fragment("pages/index.html", PAGE, &[]);
    assert!(v.ok, "{:?}", v.errors);
}
```

- [ ] **Step 2: Run the tests to confirm they fail.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design --lib composer 2>&1 | tail -5`

  Expected: a compile error (`cannot find value SAFE_AREA_DEFAULTS` / `status_bar_script`).

  Run: `... cargo test -p taskflow-design --test safe_areas 2>&1 | grep -E "panicked|test result"`

  Expected: `frameless_documents_declare_only_zero_safe_areas` FAILS (`values` is empty). The validation test passes already, which pins that the page side needs no validator change.

- [ ] **Step 3: Implement.**

  In `src/composer.rs`, after the `PICKER_RUNTIME` constant (after its closing `"#;`), add:

```rust
/// #626: what every composed page declares before Tailwind, the tokens and the
/// page, so `var(--safe-top)` / `calc(0.75rem + var(--safe-bottom))` always
/// resolve. Only the canvas's device frame raises them, at runtime, by
/// `design:safe-area` — a frameless board, a screenshot or an export renders
/// with 0px and so exactly as before.
pub const SAFE_AREA_DEFAULTS: &str = ":root { --safe-top: 0px; --safe-bottom: 0px; }";

/// #626: the device frame's half of the safe-area protocol, SYSTEM-owned like
/// the picker. It applies `design:safe-area {top, bottom}` as inline style on
/// `<html>`, sets `color-scheme` from `design:theme`'s `appearance`, and
/// reports what the frame needs to colour its status bar:
/// `design:status-bar {mode, background, padsTop, padsBottom}`.
/// * `mode` — `data-status-bar` on the element at the top centre or an
///   ancestor (`light` = white icons), else null.
/// * `background` — the first solid (alpha >= 0.5) background walking up from
///   that element, normalised to `rgb(r, g, b)` through a 1×1 canvas: Chrome
///   computes oklch tokens as `oklch(...)`, and the chrome accepts rgb only.
/// * `padsTop` / `padsBottom` — whether something at that edge pads by the
///   inset (padding >= inset, or fixed/sticky offset by it). False at 0.
/// Reports are coalesced with a timer: rAF is throttled in off-screen
/// cross-origin frames, which is where lazily mounted boards start.
const STATUS_BAR_RUNTIME: &str = r#"(() => {
  const root = document.documentElement;
  let safeTop = 0, safeBottom = 0, pending = false;
  const clampPx = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 200) : 0;
  };
  const probe = document.createElement('canvas');
  probe.width = 1; probe.height = 1;
  const paint = probe.getContext('2d', { willReadFrequently: true });
  const solidRgb = (colour) => {
    if (!paint || !colour) return null;
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = 'rgba(0, 0, 0, 0)';
    paint.fillStyle = colour;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return a >= 128 ? 'rgb(' + r + ', ' + g + ', ' + b + ')' : null;
  };
  const padsEdge = (edge) => {
    const inset = edge === 'top' ? safeTop : safeBottom;
    if (!inset) return false;
    const h = innerHeight, x = Math.floor(innerWidth / 2);
    const ys = edge === 'top' ? [1, inset + 1] : [h - 1, h - inset - 1];
    const seen = new Set();
    for (const y of ys) {
      for (const hit of document.elementsFromPoint(x, y)) {
        for (let el = hit; el && el.nodeType === 1 && !seen.has(el); el = el.parentElement) {
          seen.add(el);
          const cs = getComputedStyle(el), r = el.getBoundingClientRect();
          const pad = parseFloat(edge === 'top' ? cs.paddingTop : cs.paddingBottom) || 0;
          const atEdge = edge === 'top' ? r.top <= 1 : r.bottom >= h - 1;
          if (atEdge && pad >= inset - 1) return true;
          const pinned = cs.position === 'fixed' || cs.position === 'sticky';
          const offset = parseFloat(edge === 'top' ? cs.top : cs.bottom) || 0;
          const gap = edge === 'top' ? r.top : h - r.bottom;
          if (pinned && Math.abs(gap - inset) <= 1 && offset >= inset - 1) return true;
        }
      }
    }
    return false;
  };
  const measure = () => {
    const top = document.elementFromPoint(Math.floor(innerWidth / 2), 1);
    const marked = top && top.closest ? top.closest('[data-status-bar]') : null;
    const declared = marked ? String(marked.getAttribute('data-status-bar')).toLowerCase() : '';
    const mode = declared === 'light' || declared === 'dark' ? declared : null;
    let background = null;
    for (let el = top || root; el && el.nodeType === 1 && !background; el = el.parentElement) {
      background = solidRgb(getComputedStyle(el).backgroundColor);
    }
    if (!background) background = solidRgb(getComputedStyle(root).backgroundColor);
    return { mode, background, padsTop: padsEdge('top'), padsBottom: padsEdge('bottom') };
  };
  const report = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try {
        const m = measure();
        parent.postMessage({ type: 'design:status-bar', mode: m.mode, background: m.background,
          padsTop: m.padsTop, padsBottom: m.padsBottom }, '*');
      } catch (_) {}
    }, 0);
  };
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'design:safe-area') {
      safeTop = clampPx(m.top);
      safeBottom = clampPx(m.bottom);
      root.style.setProperty('--safe-top', safeTop + 'px');
      root.style.setProperty('--safe-bottom', safeBottom + 'px');
      report();
    }
    if (m.type === 'design:theme') {
      root.style.colorScheme = m.appearance === 'light' || m.appearance === 'dark' ? m.appearance : '';
      report();
    }
  });
  addEventListener('load', report);
  addEventListener('resize', report);
})();"#;

/// The status runtime, escaped for an inline `<script>` (see [`STATUS_BAR_RUNTIME`]).
pub fn status_bar_script() -> String {
    escape_for_inline_script(STATUS_BAR_RUNTIME)
}
```

  In `compose_document`, after `let nav_guard = nav_guard_script(token, &routes);` add:

```rust
    let status_runtime = status_bar_script();
```

  In `compose_document`'s `format!` template, make two changes:
  - Directly after the line `  <meta name="viewport" content="width=device-width, initial-scale=1">` insert the line `  <style>{SAFE_AREA_DEFAULTS}</style>`.
  - Directly after the line `  <script>{nav_guard}</script>` insert the line `  <script>{status_runtime}</script>`.

  In `compose_export_document`'s `format!` template, directly after its viewport meta line, insert `  <style>{SAFE_AREA_DEFAULTS}</style>`. Do not add a runtime there.

- [ ] **Step 4: Run the tests to confirm they pass, then the full gate.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/backend && CARGO_TARGET_DIR=/home/dalmas/E/projects/local_task_tracker/backend/target cargo test -p taskflow-design --lib composer --test safe_areas 2>&1 | grep "test result"`

  Expected: every line reads `ok`.

  Run: `... cargo test --workspace 2>&1 | grep -E "test result|FAILED" | sort | uniq -c`

  Expected: no `FAILED` and every `test result: ok`. In particular `resources.rs`'s "resource tags BEFORE the inlined tokens" test and `sandbox_caching.rs` stay green. If a test pins the head byte-for-byte, read it and add the new `<style>` line to its expectation. Do not reorder.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git add backend/plugins/taskflow-design/tests/safe_areas.rs
git commit -m "feat(design): composed pages declare zero safe areas and report their status bar to the frame (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/plugins/taskflow-design/src/composer.rs backend/plugins/taskflow-design/tests/safe_areas.rs
```

---

### Task 4: Safe-area presets and a full-height framed viewport

**Files:**
- Modify: `v2_fe/src/lib/design-devices.ts`
- Modify: `v2_fe/src/lib/design-frames.ts`
- Modify: `v2_fe/src/lib/design-devices.test.ts`
- Modify: `v2_fe/src/pages/design/export/export-plan.ts` (comment only)

**Interfaces:**
```ts
export type SafeArea = { top: number; bottom: number }
export const NO_SAFE_AREA: SafeArea
export function safeAreaFor(deviceId: string): SafeArea
export function boardSafeArea(device: DevicePreset): SafeArea   // insets only for a device-framed board
// changed: framedViewportHeight(device) = round(screenH * scale); boardContentOrigin drops statusBar
```

**Parallel-safe with:** Task 1, 2, 3, 5, 6, 8, 9

- [ ] **Step 1: Record the lint baseline and write the failing tests.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx eslint src/lib/design-devices.ts src/lib/design-frames.ts src/lib/design-devices.test.ts src/pages/design/export/export-plan.ts 2>&1 | tail -2`

  Note the count.

  In `src/lib/design-devices.test.ts`:
  - Add `boardSafeArea, safeAreaFor,` to the `./design-devices` import.
  - Change the frames import to `import { framedViewportHeight, setCanvasFrameMode } from "./design-frames"`.
  - Replace the line `expect(boardContentOrigin(deviceById("iphone-16-pro"))).toEqual({ x: 20 * k, y: HEADER_H + (20 + 44) * k })` and the comment above it with:

```ts
    // The page's origin inside the board: under the header, at the TOP of the
    // screen — #626: the page draws under the status bar, which overlays it.
    expect(boardContentOrigin(deviceById("iphone-16-pro"))).toEqual({ x: 20 * k, y: HEADER_H + 20 * k })
```

  Append to the file:

```ts
describe("safe areas (#626)", () => {
  it("iPhone SE has a 20px status bar and NO bottom inset, so nothing shifts at the bottom", () => {
    expect(safeAreaFor("iphone-se")).toEqual({ top: 20, bottom: 0 })
  })

  it("notched iPhones leave 34px for the home indicator", () => {
    expect(safeAreaFor("iphone-16-pro")).toEqual({ top: 59, bottom: 34 })
    expect(safeAreaFor("iphone-16-pro-max")).toEqual({ top: 62, bottom: 34 })
  })

  it("Android phones and Face ID iPads have both insets", () => {
    expect(safeAreaFor("pixel-8")).toEqual({ top: 40, bottom: 24 })
    expect(safeAreaFor("galaxy-s24")).toEqual({ top: 32, bottom: 24 })
    for (const id of ["ipad-mini", "ipad-pro-11", "ipad-pro-13"]) expect(safeAreaFor(id)).toEqual({ top: 24, bottom: 20 })
  })

  it("laptops, breakpoints, landscape variants and unknown ids have none", () => {
    for (const id of ["laptop", "laptop-l", "desktop", "bp-sm", "bp-2xl", "iphone-16-pro:landscape", "nope"]) {
      expect(safeAreaFor(id)).toEqual({ top: 0, bottom: 0 })
    }
  })

  it("only a device-framed board gets insets; classic and outline get 0/0", () => {
    const phone = deviceById("iphone-16-pro")
    expect(boardSafeArea(phone)).toEqual({ top: 59, bottom: 34 })
    for (const mode of ["classic", "outline"] as const) {
      setCanvasFrameMode(mode)
      try {
        expect(boardSafeArea(phone)).toEqual({ top: 0, bottom: 0 })
      } finally {
        setCanvasFrameMode("device")
      }
    }
    expect(boardSafeArea(deviceById("bp-md"))).toEqual({ top: 0, bottom: 0 })
  })

  it("a framed page is the whole screen tall: it draws under the status bar", () => {
    // iPhone 14 Pro frame: 830px screen at 393/390.
    expect(framedViewportHeight(deviceById("iphone-16-pro"))).toBe(Math.round(830 * (393 / 390)))
    // iPhone 8 frame (SE): 667px screen at 1:1 — exactly the preset.
    expect(framedViewportHeight(deviceById("iphone-se"))).toBe(667)
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run src/lib/design-devices.test.ts 2>&1 | tail -8`

  Expected: FAIL. `safeAreaFor` and `boardSafeArea` are not exported, and the origin and height expectations differ.

- [ ] **Step 3: Implement.**

  In `src/lib/design-frames.ts`, replace `framedViewportHeight` and its comment:

```ts
/// The page's viewport height inside a framed board: the frame's WHOLE screen,
/// at the canvas scale. #626: the page draws under the status bar (which the
/// board overlays, see `FramedBoard`) and pads itself by `--safe-top`, as an
/// app does on a real phone. Exports keep their own capture rule
/// (`export-plan.captureViewport`), which is deliberately unchanged.
export function framedViewportHeight(device: DevicePreset): number {
  const f = canvasFrame(device)
  if (!f) return device.height
  return Math.round(f.metrics.screenH * f.scale)
}
```

  In `src/lib/design-devices.ts`, in `boardContentOrigin`, replace `return { x: metrics.screenX * scale, y: HEADER_H + (metrics.screenY + metrics.statusBar) * scale }` with:

```ts
    return { x: metrics.screenX * scale, y: HEADER_H + metrics.screenY * scale }
```

  In the same file, after `boardContentOrigin`, add:

```ts
/// #626: a device's safe-area insets in CSS px — what the canvas injects as
/// `--safe-top` / `--safe-bottom` into a device-framed board. Sources are in
/// docs/superpowers/specs/2026-10-07-design-safe-areas-design.md ("Preset
/// values"); the Android pair are estimates. A landscape variant, a laptop, a
/// breakpoint and any unknown id have none.
export type SafeArea = { top: number; bottom: number }

export const NO_SAFE_AREA: SafeArea = { top: 0, bottom: 0 }

const SAFE_AREAS: Record<string, SafeArea> = {
  "iphone-se": { top: 20, bottom: 0 },
  "iphone-16-pro": { top: 59, bottom: 34 },
  "iphone-16-pro-max": { top: 62, bottom: 34 },
  "pixel-8": { top: 40, bottom: 24 },
  "galaxy-s24": { top: 32, bottom: 24 },
  "ipad-mini": { top: 24, bottom: 20 },
  "ipad-pro-11": { top: 24, bottom: 20 },
  "ipad-pro-13": { top: 24, bottom: 20 },
}

export function safeAreaFor(deviceId: string): SafeArea {
  return SAFE_AREAS[deviceId] ?? NO_SAFE_AREA
}

/// The insets a BOARD injects: the device's own only when it wears a real
/// device frame. Classic and outline boards draw nothing over the page, so
/// they inject 0/0 and render exactly as before.
export function boardSafeArea(device: DevicePreset): SafeArea {
  return canvasFrame(device) ? safeAreaFor(device.id) : NO_SAFE_AREA
}
```

  In `src/pages/design/export/export-plan.ts`, replace the comment line `/// screen below its status bar, at the device's width — the same viewport the` and the next line `/// canvas gives a framed board (\`framedViewportHeight\`), and exactly the area` with:

```ts
/// screen below its status bar, at the device's width — what the canvas gave a
/// framed board before #626 (the canvas now draws the page under the strip;
/// exports deliberately keep this rule), and exactly the area
```

- [ ] **Step 4: Run the tests and lint to confirm they pass.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run src/lib 2>&1 | tail -4`

  Expected: all pass (including `renderer-frame-data.test.ts`, which is untouched).

  Run: `npx eslint src/lib/design-devices.ts src/lib/design-frames.ts src/lib/design-devices.test.ts src/pages/design/export/export-plan.ts 2>&1 | tail -2`

  Expected: count ≤ baseline.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git commit -m "feat(design-fe): device safe-area presets; a framed page is the whole screen tall (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/lib/design-devices.ts v2_fe/src/lib/design-frames.ts v2_fe/src/lib/design-devices.test.ts v2_fe/src/pages/design/export/export-plan.ts
```

---

### Task 5: Status-bar resolution helpers (pure)

**Files:**
- Create: `v2_fe/src/pages/design/status-bar.ts`
- Create: `v2_fe/src/pages/design/status-bar.test.ts`

**Interfaces:**
```ts
export type StatusInk = "light" | "dark"           // the ICON colour: "light" = white icons
export type ThemeAppearance = "light" | "dark"
export type StatusBarReport = { mode: StatusInk | null; background: string | null; padsTop: boolean; padsBottom: boolean }
export type FrameChrome = { ink: StatusInk; stripFill: string | null; screenBackground: string; colorScheme: "light" | "dark" | "normal" }
export const LIGHT_INK: string, DARK_INK: string
export function parseStatusBarReport(data: unknown): StatusBarReport | null
export function sameStatusBarReport(current: StatusBarReport | null, next: StatusBarReport): boolean
export function relativeLuminance(colour: string): number | null
export function inkForBackground(colour: string | null | undefined): StatusInk | null
export function resolveStatusInk(input: { mode: StatusInk | null; appearance: ThemeAppearance | null; background: string | null; themeBackground: string | null }): StatusInk
export function inkColour(ink: StatusInk): string
export function frameChrome(input: { report: StatusBarReport | null; appearance: ThemeAppearance | null; themeBackground: string | null }, safeColour?: (v: string | null | undefined) => string | undefined): FrameChrome
```

**Parallel-safe with:** Task 1, 2, 3, 4, 6, 8, 9

- [ ] **Step 1: Write the failing test.**

  Create `src/pages/design/status-bar.test.ts`:

```ts
import { describe, expect, it } from "vitest"

import {
  DARK_INK,
  LIGHT_INK,
  frameChrome,
  inkColour,
  inkForBackground,
  parseStatusBarReport,
  relativeLuminance,
  resolveStatusInk,
  sameStatusBarReport,
  type StatusBarReport,
} from "./status-bar"

const report = (over: Partial<StatusBarReport> = {}): StatusBarReport => ({
  mode: null,
  background: null,
  padsTop: false,
  padsBottom: false,
  ...over,
})

/// vitest runs in node (no `CSS.supports`), so the painter's colour guard is
/// injected: pass plain strings through.
const passThrough = (v: string | null | undefined) => v ?? undefined

describe("parseStatusBarReport", () => {
  it("reads a well-formed report", () => {
    expect(
      parseStatusBarReport({ type: "design:status-bar", mode: "light", background: "rgb(21, 128, 61)", padsTop: true, padsBottom: false }),
    ).toEqual(report({ mode: "light", background: "rgb(21, 128, 61)", padsTop: true }))
  })

  it("ignores other messages and non-objects", () => {
    expect(parseStatusBarReport({ type: "design:route", path: "/s/x" })).toBeNull()
    expect(parseStatusBarReport("design:status-bar")).toBeNull()
    expect(parseStatusBarReport(null)).toBeNull()
  })

  it("sanitises hostile fields: only rgb() backgrounds, only light/dark modes, only true booleans", () => {
    const parsed = parseStatusBarReport({
      type: "design:status-bar",
      mode: "purple",
      background: "url(https://evil.example/x.png)",
      padsTop: "yes",
      padsBottom: 1,
    })
    expect(parsed).toEqual(report())
    expect(parseStatusBarReport({ type: "design:status-bar", background: "oklch(0.2 0 0)" })?.background).toBeNull()
  })
})

describe("sameStatusBarReport", () => {
  it("is true only for an equal report", () => {
    expect(sameStatusBarReport(report({ padsTop: true }), report({ padsTop: true }))).toBe(true)
    expect(sameStatusBarReport(report(), report({ background: "rgb(0, 0, 0)" }))).toBe(false)
    expect(sameStatusBarReport(null, report())).toBe(false)
  })
})

describe("relativeLuminance", () => {
  it("reads rgb, rgba and hex", () => {
    expect(relativeLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 5)
    expect(relativeLuminance("rgba(0, 0, 0, 1)")).toBeCloseTo(0, 5)
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5)
    expect(relativeLuminance("#15803D")).toBeCloseTo(0.16, 2)
  })

  it("reads shadcn oklch values, L as a number or a percentage", () => {
    expect(relativeLuminance("oklch(1 0 0)")).toBeCloseTo(1, 2)
    expect(relativeLuminance("oklch(0.145 0 0)")!).toBeLessThan(0.01)
    expect(relativeLuminance("oklch(14.5% 0 0)")!).toBeLessThan(0.01)
    expect(relativeLuminance("oklch(0.62 0.14 220 / 0.9)")).not.toBeNull()
  })

  it("is null for anything it cannot read", () => {
    expect(relativeLuminance("var(--background)")).toBeNull()
    expect(relativeLuminance("rgb(300, 0, 0)")).toBeNull()
    expect(relativeLuminance("hsl(0 0% 0%)")).toBeNull()
  })
})

describe("inkForBackground", () => {
  it("puts white icons on dark colours and black on light ones (higher contrast wins)", () => {
    expect(inkForBackground("rgb(10, 10, 10)")).toBe("light")
    expect(inkForBackground("rgb(255, 255, 255)")).toBe("dark")
    // A brand green (green-700, L≈0.16) is under the ≈0.179 line: white icons.
    expect(inkForBackground("rgb(21, 128, 61)")).toBe("light")
  })
  it("draws the light/dark line at L≈0.179, where both inks have equal contrast", () => {
    expect(inkForBackground("rgb(70, 70, 70)")).toBe("light") // L≈0.061
    expect(inkForBackground("rgb(128, 128, 128)")).toBe("dark") // L≈0.216
    expect(inkForBackground(null)).toBeNull()
    expect(inkForBackground("var(--x)")).toBeNull()
  })
})

describe("resolveStatusInk — the order", () => {
  const base = { mode: null, appearance: null, background: null, themeBackground: null } as const

  it("1. the page's data-status-bar wins over everything", () => {
    expect(resolveStatusInk({ ...base, mode: "light", appearance: "light", background: "rgb(255, 255, 255)" })).toBe("light")
    expect(resolveStatusInk({ ...base, mode: "dark", appearance: "dark", background: "rgb(0, 0, 0)" })).toBe("dark")
  })

  it("2. then the theme's appearance: dark → white icons, light → black", () => {
    expect(resolveStatusInk({ ...base, appearance: "dark", background: "rgb(255, 255, 255)" })).toBe("light")
    expect(resolveStatusInk({ ...base, appearance: "light", background: "rgb(0, 0, 0)" })).toBe("dark")
  })

  it("3. then the page's top colour, then the theme's --background, else black icons", () => {
    expect(resolveStatusInk({ ...base, background: "rgb(15, 23, 42)" })).toBe("light")
    expect(resolveStatusInk({ ...base, themeBackground: "oklch(0.145 0 0)" })).toBe("light")
    expect(resolveStatusInk({ ...base, background: "rgb(250, 250, 250)", themeBackground: "oklch(0.145 0 0)" })).toBe("dark")
    expect(resolveStatusInk(base)).toBe("dark")
  })
})

describe("inkColour", () => {
  it("keeps today's two inks", () => {
    expect(inkColour("light")).toBe(LIGHT_INK)
    expect(inkColour("dark")).toBe(DARK_INK)
    expect([LIGHT_INK, DARK_INK]).toEqual(["#f5f5f5", "#0a0a0a"])
  })
})

describe("frameChrome", () => {
  it("a page that pads under the bar gets a transparent strip: its own bar shows through", () => {
    const chrome = frameChrome(
      { report: report({ mode: "light", background: "rgb(21, 128, 61)", padsTop: true }), appearance: "light", themeBackground: "#fff" },
      passThrough,
    )
    expect(chrome).toEqual({ ink: "light", stripFill: null, screenBackground: "rgb(21, 128, 61)", colorScheme: "light" })
  })

  it("a page that does not pad gets the strip filled with its own top colour, never white by default", () => {
    const chrome = frameChrome(
      { report: report({ background: "rgb(15, 23, 42)" }), appearance: null, themeBackground: "oklch(1 0 0)" },
      passThrough,
    )
    expect(chrome.stripFill).toBe("rgb(15, 23, 42)")
    expect(chrome.ink).toBe("light")
    expect(chrome.colorScheme).toBe("normal")
  })

  it("before any report, the strip is filled with the theme's background and inked by appearance", () => {
    const chrome = frameChrome({ report: null, appearance: "dark", themeBackground: "oklch(0.145 0 0)" }, passThrough)
    expect(chrome).toEqual({ ink: "light", stripFill: "oklch(0.145 0 0)", screenBackground: "oklch(0.145 0 0)", colorScheme: "dark" })
  })

  it("a theme background the colour guard refuses is never painted; the fallback follows the ink", () => {
    const refuse = () => undefined
    expect(frameChrome({ report: null, appearance: "dark", themeBackground: "url(//x)" }, refuse).stripFill).toBe("#0a0a0a")
    expect(frameChrome({ report: null, appearance: null, themeBackground: null }, refuse).stripFill).toBe("#ffffff")
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run src/pages/design/status-bar.test.ts 2>&1 | tail -4`

  Expected: FAIL (`Cannot find module './status-bar'`).

- [ ] **Step 3: Implement.**

  Create `src/pages/design/status-bar.ts`:

```ts
/// #626: the device frame's status bar and home indicator — what colour the
/// icons are, and whether the frame fills the strip — decided from what the
/// page reports (`design:status-bar`, sent by the composer's status runtime),
/// the active theme's `appearance` and its `--background`. Pure, so it is
/// tested; `FramedBoard` only draws the answer.

import { safeSwatchColor } from "./theme-options"

/** The ICON colour: "light" = white icons (iOS lightContent), "dark" = black. */
export type StatusInk = "light" | "dark"
export type ThemeAppearance = "light" | "dark"

export type StatusBarReport = {
  /** The page's `data-status-bar` at the top, if any. */
  mode: StatusInk | null
  /** The solid colour at the top of the page, as `rgb(r, g, b)`. */
  background: string | null
  /** Something at the top pads by `--safe-top` (the page draws the strip). */
  padsTop: boolean
  padsBottom: boolean
}

export type FrameChrome = {
  ink: StatusInk
  /** What fills the status strip, or null for transparent (the page pads). */
  stripFill: string | null
  /** The device screen behind the page (seen while it loads). */
  screenBackground: string
  colorScheme: "light" | "dark" | "normal"
}

/** Today's two inks, unchanged. */
export const LIGHT_INK = "#f5f5f5"
export const DARK_INK = "#0a0a0a"

const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i

/// A frame's report, validated: the frame is untrusted, so only an `rgb()`
/// background (the runtime always normalises to one), a light/dark mode and
/// literal `true` booleans survive. Anything else is not this message.
export function parseStatusBarReport(data: unknown): StatusBarReport | null {
  if (!data || typeof data !== "object") return null
  const m = data as Record<string, unknown>
  if (m.type !== "design:status-bar") return null
  const mode = m.mode === "light" || m.mode === "dark" ? m.mode : null
  const background =
    typeof m.background === "string" && m.background.length <= 40 && RGB.test(m.background) ? m.background : null
  return { mode, background, padsTop: m.padsTop === true, padsBottom: m.padsBottom === true }
}

export function sameStatusBarReport(current: StatusBarReport | null, next: StatusBarReport): boolean {
  return (
    !!current &&
    current.mode === next.mode &&
    current.background === next.background &&
    current.padsTop === next.padsTop &&
    current.padsBottom === next.padsBottom
  )
}

const toLinear = (channel: number) => {
  const s = channel / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const weigh = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function fromBytes(r: number, g: number, b: number): number | null {
  if ([r, g, b].some((c) => !(c >= 0 && c <= 255))) return null
  return weigh(toLinear(r), toLinear(g), toLinear(b))
}

/// WCAG relative luminance (0 black … 1 white) of an rgb()/rgba(), #hex or
/// oklch() colour — the forms a computed style or a shadcn token takes. Null
/// for anything else (the caller falls through to its next rule).
export function relativeLuminance(colour: string): number | null {
  const v = colour.trim()
  let m = RGB.exec(v)
  if (m) return fromBytes(Number(m[1]), Number(m[2]), Number(m[3]))
  m = HEX6.exec(v)
  if (m) return fromBytes(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16))
  m = HEX3.exec(v)
  if (m) return fromBytes(parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16))
  m = OKLCH.exec(v)
  if (m) {
    // OKLab → linear sRGB (Björn Ottosson's reference matrices).
    const L = Number(m[1]) / (m[2] ? 100 : 1)
    const C = Number(m[3])
    const h = (Number(m[4]) * Math.PI) / 180
    const a = C * Math.cos(h)
    const b = C * Math.sin(h)
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
    const r = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s
    const g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s
    const bl = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s
    return weigh(clamp01(r), clamp01(g), clamp01(bl))
  }
  return null
}

/// White icons when white has more contrast against `colour` than black:
/// 1.05/(L+0.05) > (L+0.05)/0.05  ⇔  (L+0.05)² < 0.0525  ⇔  L < ≈0.179.
export function inkForBackground(colour: string | null | undefined): StatusInk | null {
  if (!colour) return null
  const L = relativeLuminance(colour)
  if (L === null) return null
  return (L + 0.05) ** 2 < 0.0525 ? "light" : "dark"
}

/// The ruling's order: the page's `data-status-bar`, then the theme's
/// `appearance`, then the colour at the top of the page, then the theme's
/// `--background`; black icons when nothing is known.
export function resolveStatusInk(input: {
  mode: StatusInk | null
  appearance: ThemeAppearance | null
  background: string | null
  themeBackground: string | null
}): StatusInk {
  if (input.mode) return input.mode
  if (input.appearance) return input.appearance === "dark" ? "light" : "dark"
  return inkForBackground(input.background) ?? inkForBackground(input.themeBackground) ?? "dark"
}

export function inkColour(ink: StatusInk): string {
  return ink === "light" ? LIGHT_INK : DARK_INK
}

/// Everything `FramedBoard` paints around the page. The report's background is
/// already a validated `rgb()`; the theme's swatch is agent-authored, so it is
/// painted only through `safeColour` (the switcher's allowlist). Until the
/// page has reported, the strip is FILLED (never a white gap); once it says it
/// pads under the bar, the strip is transparent and the page's own bar shows.
export function frameChrome(
  input: { report: StatusBarReport | null; appearance: ThemeAppearance | null; themeBackground: string | null },
  safeColour: (v: string | null | undefined) => string | undefined = (v) => safeSwatchColor(v),
): FrameChrome {
  const { report, appearance, themeBackground } = input
  const ink = resolveStatusInk({
    mode: report?.mode ?? null,
    appearance,
    background: report?.background ?? null,
    themeBackground,
  })
  const background = report?.background ?? safeColour(themeBackground) ?? null
  const fallback = ink === "light" ? DARK_INK : "#ffffff"
  return {
    ink,
    stripFill: report?.padsTop ? null : (background ?? fallback),
    screenBackground: background ?? fallback,
    colorScheme: appearance ?? "normal",
  }
}
```

- [ ] **Step 4: Run the test and lint to confirm they pass.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run src/pages/design/status-bar.test.ts 2>&1 | tail -4`

  Expected: all pass. If a threshold row fails, fix the code, not the expectation. The rule is WCAG equal contrast.

  Run: `npx eslint src/pages/design/status-bar.ts src/pages/design/status-bar.test.ts 2>&1 | tail -2`

  Expected: no problems.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git add v2_fe/src/pages/design/status-bar.ts v2_fe/src/pages/design/status-bar.test.ts
git commit -m "feat(design-fe): pure status-bar ink and strip resolution (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/pages/design/status-bar.ts v2_fe/src/pages/design/status-bar.test.ts
```

---

### Task 6: Appearance in the theme types, the switcher options and the token panel

**Files:**
- Modify: `v2_fe/src/lib/design-api.ts`
- Modify: `v2_fe/src/pages/design/theme-options.ts`
- Modify: `v2_fe/src/pages/design/theme-options.test.ts`
- Modify: `v2_fe/src/pages/design/token-themes.ts`
- Modify: `v2_fe/src/pages/design/token-themes.test.ts`
- Modify: `v2_fe/src/pages/design/theme-strip.tsx`

**Interfaces:**
```ts
export type DesignThemeDecl = { name: string; label?: string; appearance?: "light" | "dark" }
export type DesignThemeInfo = { name: string; label: string; appearance?: "light" | "dark" | null; swatch: {...} }
// theme-options.ts
export function themeAppearance(themes: ThemeOption[], name: string): "light" | "dark" | null
export function themeBackground(themes: ThemeOption[], name: string): string | null
// token-themes.ts
export function themeAppearanceSetting(doc: DesignTokensDoc, name: string): "light" | "dark" | null   // the STORED value (light → "light")
export function resolvedThemeAppearance(doc: DesignTokensDoc, name: string): "light" | "dark" | null // + implicit dark
export function setThemeAppearance(doc: DesignTokensDoc, name: string, appearance: "light" | "dark" | null): DesignTokensDoc
```

**Parallel-safe with:** Task 1, 2, 3, 4, 5, 8, 9

- [ ] **Step 1: Record the lint baseline and write the failing tests.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx eslint src/lib/design-api.ts src/pages/design/theme-options.ts src/pages/design/theme-options.test.ts src/pages/design/token-themes.ts src/pages/design/token-themes.test.ts src/pages/design/theme-strip.tsx 2>&1 | tail -2`

  Note the count.

  In `theme-options.test.ts`, add `themeAppearance, themeBackground,` to the import and append:

```ts
describe("themeAppearance / themeBackground (#626)", () => {
  const withAppearance = (name: string, appearance: "light" | "dark" | null, background: string | null = null): ThemeOption => ({
    name,
    label: name,
    appearance,
    swatch: { primary: null, background },
  })

  it("reads the manifest's resolved appearance", () => {
    const themes = [withAppearance("light", "light"), withAppearance("dark", "dark"), withAppearance("forest", "dark"), withAppearance("ocean", null)]
    expect(themeAppearance(themes, "forest")).toBe("dark")
    expect(themeAppearance(themes, "ocean")).toBeNull()
  })

  it("falls back to the names light and dark for a backend that predates appearance", () => {
    expect(themeAppearance([opt("light"), opt("dark"), opt("ocean")], "light")).toBe("light")
    expect(themeAppearance([opt("light"), opt("dark"), opt("ocean")], "dark")).toBe("dark")
    expect(themeAppearance([opt("light"), opt("dark"), opt("ocean")], "ocean")).toBeNull()
    expect(themeAppearance(manifestThemes(null), "dark")).toBe("dark")
  })

  it("themeBackground is the theme's swatch background, or null", () => {
    expect(themeBackground([withAppearance("ocean", null, "oklch(0.2 0 0)")], "ocean")).toBe("oklch(0.2 0 0)")
    expect(themeBackground([opt("light")], "light")).toBeNull()
    expect(themeBackground([], "nope")).toBeNull()
  })
})
```

  In `token-themes.test.ts`, add `resolvedThemeAppearance, setThemeAppearance, themeAppearanceSetting,` to the import and append:

```ts
describe("theme appearance (#626)", () => {
  it("sets, clears and never touches light", () => {
    const set = setThemeAppearance(legacy(), "dark", "dark")
    expect(set.themes).toEqual([{ name: "dark", appearance: "dark" }])
    expect(themeAppearanceSetting(set, "dark")).toBe("dark")
    const cleared = setThemeAppearance(set, "dark", null)
    expect(cleared.themes).toEqual([{ name: "dark" }])
    expect(themeAppearanceSetting(cleared, "dark")).toBeNull()
    expect(setThemeAppearance(legacy(), "light", "dark")).toEqual(legacy())
    expect(themeAppearanceSetting(legacy(), "light")).toBe("light")
  })

  it("resolves an undeclared dark as dark and keeps the input untouched", () => {
    const doc = legacy()
    expect(resolvedThemeAppearance(doc, "dark")).toBe("dark")
    expect(resolvedThemeAppearance(addTheme(doc, "ocean"), "ocean")).toBeNull()
    setThemeAppearance(doc, "dark", "light")
    expect(doc.themes).toBeUndefined()
  })

  it("a rename keeps it and a duplicate copies the source's resolved appearance", () => {
    const forest = setThemeAppearance(addTheme(legacy(), "forest"), "forest", "dark")
    expect(themeAppearanceSetting(renameTheme(forest, "forest", "woods"), "woods")).toBe("dark")
    expect(themeAppearanceSetting(duplicateTheme(legacy(), "dark", "night"), "night")).toBe("dark")
    expect(themeAppearanceSetting(duplicateTheme(legacy(), "light", "paper"), "paper")).toBe("light")
    expect(themeAppearanceSetting(duplicateTheme(addTheme(legacy(), "ocean"), "ocean", "sea"), "sea")).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run src/pages/design/theme-options.test.ts src/pages/design/token-themes.test.ts 2>&1 | tail -6`

  Expected: FAIL (the new exports are missing).

- [ ] **Step 3: Implement.**

  In `src/lib/design-api.ts`, replace `export type DesignThemeDecl = { name: string; label?: string }` with:

```ts
/// #626: `appearance` sets the device frame's status-bar ink and the page's
/// `color-scheme`; absent = automatic (the frame reads the page).
export type DesignThemeDecl = { name: string; label?: string; appearance?: "light" | "dark" }
```

  Then replace the `DesignThemeInfo` type with:

```ts
export type DesignThemeInfo = {
  name: string
  label: string
  /// #626: resolved by the server (light → light, an undeclared dark → dark,
  /// else the declared value or null). Absent from an older backend — read it
  /// through `themeAppearance`.
  appearance?: "light" | "dark" | null
  swatch: { primary: string | null; background: string | null }
}
```

  In `theme-options.ts`, replace `LEGACY` with:

```ts
const LEGACY: ThemeOption[] = [
  { name: "light", label: "Light", appearance: "light", swatch: { primary: null, background: null } },
  { name: "dark", label: "Dark", appearance: "dark", swatch: { primary: null, background: null } },
]
```

  After `resolveActiveTheme` add:

```ts
/// #626: the theme's appearance as the server resolved it; for a backend that
/// predates the field, the names light and dark still answer for themselves.
export function themeAppearance(themes: ThemeOption[], name: string): "light" | "dark" | null {
  const theme = themes.find((t) => t.name === name)
  if (theme?.appearance === "light" || theme?.appearance === "dark") return theme.appearance
  if (theme?.appearance === undefined && (name === "light" || name === "dark")) return name
  return null
}

/// #626: the theme's resolved `--background` (its swatch) — the frame's last
/// fallback for the status strip. Agent-authored: paint it only through
/// `safeSwatchColor`.
export function themeBackground(themes: ThemeOption[], name: string): string | null {
  return themes.find((t) => t.name === name)?.swatch.background ?? null
}
```

  In `token-themes.ts`, after `themeLabel` add:

```ts
/// #626: the appearance the document STORES for a theme (light is always
/// light); null = automatic.
export function themeAppearanceSetting(doc: DesignTokensDoc, name: string): "light" | "dark" | null {
  if (name === LIGHT) return "light"
  return themeDecls(doc).find((t) => t.name === name)?.appearance ?? null
}

/// What the theme resolves to, as the server does: the stored value, else
/// dark for a theme named dark.
export function resolvedThemeAppearance(doc: DesignTokensDoc, name: string): "light" | "dark" | null {
  return themeAppearanceSetting(doc, name) ?? (name === "dark" && declaredThemes(doc).includes("dark") ? "dark" : null)
}

/// Set (or with null, clear) a theme's appearance. Light's is fixed.
export function setThemeAppearance(
  doc: DesignTokensDoc,
  name: string,
  appearance: "light" | "dark" | null,
): DesignTokensDoc {
  if (name === LIGHT) return doc
  const themes = themeDecls(doc).map((t) => {
    if (t.name !== name) return t
    const next: DesignThemeDecl = { ...t }
    if (appearance) next.appearance = appearance
    else delete next.appearance
    return next
  })
  return { ...doc, themes }
}
```

  Replace `duplicateTheme` with:

```ts
/// A new theme starting as a copy of `source`'s overrides — the fastest way to
/// start a palette. Duplicating light adds a theme with no overrides (it
/// already renders exactly like light). The copy keeps the source's resolved
/// appearance (#626), so a copy of dark stays dark.
export function duplicateTheme(doc: DesignTokensDoc, source: string, name: string): DesignTokensDoc {
  const withTheme = setThemeAppearance(addTheme(doc, name), name, resolvedThemeAppearance(doc, source))
  if (source === LIGHT) return withTheme
  return mapTokens(withTheme, (value) => (value[source] !== undefined ? { ...value, [name]: value[source] } : value))
}
```

  (`renameTheme` already spreads `...t`, so it keeps `appearance`.)

  In `theme-strip.tsx`:
  - Extend the dropdown import to `DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,`.
  - Add `setThemeAppearance,` and `themeAppearanceSetting,` to the `./token-themes` import.
  - Change `<DropdownMenuContent className="w-40" align="start">` to `className="w-44"`.
  - Inside the `name !== LIGHT` fragment, directly **before** the existing `<DropdownMenuSeparator />` that precedes Delete, insert:

```tsx
                    <DropdownMenuSeparator />
                    {/* #626: what the device frame's status bar and the page's
                        color-scheme follow. Auto = the frame reads the page. */}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Appearance</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={themeAppearanceSetting(doc, name) ?? "auto"}
                        onValueChange={(value) =>
                          onDocChange(setThemeAppearance(doc, name, value === "light" || value === "dark" ? value : null))
                        }
                      >
                        <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
```

- [ ] **Step 4: Run the tests, type check and lint.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run src/pages/design 2>&1 | tail -4`

  Expected: all pass.

  Run: `npx tsc -p tsconfig.app.json --noEmit 2>&1 | tail -5`

  Expected: no errors. (If `onValueChange`'s `value` is typed `unknown`, the `=== "light" || === "dark"` narrowing already makes it a literal union.)

  Run the Step 1 eslint command again.

  Expected: count ≤ baseline.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git commit -m "feat(design-fe): theme appearance in the types, switcher options and the token panel menu (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/lib/design-api.ts v2_fe/src/pages/design/theme-options.ts v2_fe/src/pages/design/theme-options.test.ts v2_fe/src/pages/design/token-themes.ts v2_fe/src/pages/design/token-themes.test.ts v2_fe/src/pages/design/theme-strip.tsx
```

---

### Task 7: Canvas wiring: inject, listen and draw

**Files:**
- Modify: `v2_fe/src/pages/design/design-canvas.tsx`
- Modify: `v2_fe/src/pages/design/design-canvas.test.ts`
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx`
- Modify: `v2_fe/src/pages/design/component-dialog.tsx`

**Interfaces:**
```ts
// DesignCanvasProps gains:
appearance?: ThemeAppearance | null
themeBackground?: string | null
// FramedBoard (exported component):
export function FramedBoard(props: { device: DevicePreset; chrome: FrameChrome; safeArea: SafeArea; children: React.ReactNode }): JSX.Element
// LazyFrame gains props: appearance: ThemeAppearance | null; safeTop: number; safeBottom: number
// messages sent: design:theme {theme, appearance}; design:safe-area {top, bottom}
```

**Parallel-safe with:** Task 8, 9 (needs Task 4, 5, 6)

- [ ] **Step 1: Record the lint baseline and write the failing test.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx eslint src/pages/design/design-canvas.tsx src/pages/design/design-canvas.test.ts src/pages/design/DesignSurfacePage.tsx src/pages/design/component-dialog.tsx 2>&1 | tail -2`

  Note the count.

  In `design-canvas.test.ts`, change the import line to `import { ArtboardHeader, FramedBoard } from "./design-canvas"` and append:

```ts
/** A framed board for `deviceId` wrapping a stand-in page, as `ArtboardCard` draws it. */
function framed(deviceId: string, chrome: Parameters<typeof FramedBoard>[0]["chrome"], safeArea: { top: number; bottom: number }) {
  return renderToStaticMarkup(
    createElement(FramedBoard, { device: deviceById(deviceId), chrome, safeArea }, createElement("div", { id: "page" })),
  )
}

describe("FramedBoard safe areas (#626)", () => {
  const padded = { ink: "light", stripFill: null, screenBackground: "rgb(21, 128, 61)", colorScheme: "light" } as const
  const unpadded = { ink: "light", stripFill: "rgb(15, 23, 42)", screenBackground: "rgb(15, 23, 42)", colorScheme: "dark" } as const

  it("the page starts at the top of the screen, under the strip", () => {
    const html = framed("iphone-16-pro", padded, { top: 59, bottom: 34 })
    expect(html).toMatch(/top:0;left:0;width:393px;height:836px/)
    expect(html).toContain('id="page"')
  })

  it("a page that pads under the bar gets a transparent strip with white icons", () => {
    const html = framed("iphone-16-pro", padded, { top: 59, bottom: 34 })
    expect(html).toMatch(/width:393px;height:59px;background:transparent/)
    expect(html).toContain("color:#f5f5f5")
  })

  it("a page that does not pad gets the strip filled with its own colour", () => {
    const html = framed("iphone-16-pro", unpadded, { top: 59, bottom: 34 })
    expect(html).toMatch(/height:59px;background:rgb\(15, 23, 42\)/)
    expect(html).toContain("color-scheme:dark")
  })

  it("draws the home indicator only when there is a bottom inset", () => {
    expect(framed("iphone-16-pro", padded, { top: 59, bottom: 34 })).toContain('data-home-indicator=""')
    expect(framed("iphone-se", padded, { top: 20, bottom: 0 })).not.toContain("data-home-indicator")
  })
})
```

  (`836` = `Math.round(830 * 393 / 390)`. React's static markup spells inline styles `top:0;left:0;…` in prop order, which is why the order below is fixed.)

- [ ] **Step 2: Run the test to confirm it fails.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run src/pages/design/design-canvas.test.ts 2>&1 | tail -6`

  Expected: FAIL. `FramedBoard` still takes `theme` and draws the page at `top:44…`.

- [ ] **Step 3: Implement in `design-canvas.tsx`.**

  Imports:
  - Change the design-frames import to `import { canvasFrame, framedViewportHeight, statusBarHtml, statusBarStyle } from "@/lib/design-frames"`. This keeps the same names; `StatusBar` goes away below.
  - In the `@/lib/design-devices` import list add `boardSafeArea,` and `type SafeArea,`.
  - After the `./design-frame-source` import add:

```ts
import {
  frameChrome,
  inkColour,
  parseStatusBarReport,
  sameStatusBarReport,
  type FrameChrome,
  type StatusBarReport,
  type ThemeAppearance,
} from "./status-bar"
```

  `DesignCanvasProps`: after `theme: string` add:

```ts
  /** #626: the active theme's appearance (`themeAppearance`). Sent with
   *  `design:theme` so a frame sets its `color-scheme`, and the frame chrome's
   *  second rule for the status-bar ink. */
  appearance?: ThemeAppearance | null
  /** #626: the active theme's `--background` swatch — the strip's last fallback. */
  themeBackground?: string | null
```

  Make these changes in `DesignCanvas`:
  - In the destructuring, after `theme,` add `appearance = null,` and `themeBackground = null,`.
  - Replace the broadcast effect with:

```ts
  // Broadcast picking/theme state to every mounted frame. `appearance` rides
  // along on `design:theme` (#626); a frame from before it ignores the field.
  useEffect(() => {
    for (const frame of mountedFrames()) {
      frame.contentWindow?.postMessage({ type: "design:mode", picking }, "*")
      frame.contentWindow?.postMessage({ type: "design:theme", theme, appearance }, "*")
    }
  }, [picking, theme, appearance])
```

  - In the `nodes` memo `data` object, after `theme,` add `appearance,` and `themeBackground,`. In its dependency list, after `theme,` add `appearance, themeBackground,`.

  `BoardNodeData`: after `theme: string` add `appearance: ThemeAppearance | null` and `themeBackground: string | null`.

  `ArtboardCard`:
  - Destructure `appearance,` and `themeBackground,` after `theme,`.
  - In its props type, after `theme: string`, add:

```ts
  /** #626: see `DesignCanvasProps.appearance`. */
  appearance: ThemeAppearance | null
  /** #626: see `DesignCanvasProps.themeBackground`. */
  themeBackground: string | null
```

  - After the `const strayRoute = …` line add:

```ts
  // #626: the insets this board injects (a device frame only — classic and
  // outline boards draw nothing over the page, so they send 0/0), and what the
  // frame last said about its top. Accepted by WindowProxy IDENTITY, exactly
  // like a route report; the payload is validated by `parseStatusBarReport`.
  // Held across a remount on purpose: the new document reports on `load`.
  const safeArea = boardSafeArea(device)
  const [statusReport, setStatusReport] = useState<StatusBarReport | null>(null)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = parseStatusBarReport(event.data)
      if (!next) return
      if (boardKeyForSource(frameSources(), event.source as Window | null) !== board.key) return
      setStatusReport((current) => (sameStatusBarReport(current, next) ? current : next))
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [board.key])
  const chrome = frameChrome({ report: statusReport, appearance, themeBackground })
```

  - In the `LazyFrame` element add `appearance={appearance}`, `safeTop={safeArea.top}` and `safeBottom={safeArea.bottom}`.
  - Replace `<FramedBoard device={device} theme={theme}>` with `<FramedBoard device={device} chrome={chrome} safeArea={safeArea}>`.

  Replace the whole `FramedBoard` function, its doc comment, and the `StatusBar` function plus its doc comment with:

```tsx
/// A board in its REAL device frame (devices.css, MIT). The frame is scaled so
/// its screen is exactly `device.width` wide, and the page inside is scaled
/// back so it renders 1:1 — its breakpoints honest, its text the usual size,
/// and a position it reports needing only `boardContentOrigin`'s offset.
///
/// #626: the page fills the WHOLE screen and draws under the status bar, which
/// is overlaid on it in page px, `safeArea.top` tall — exactly the region the
/// page pads by `--safe-top`. `chrome` (`status-bar.ts`, tested) decides the
/// ink, and whether the strip is filled (the page does not pad) or transparent
/// (its own bar shows). The home indicator sits over the bottom inset.
export function FramedBoard({
  device,
  chrome,
  safeArea,
  children,
}: {
  device: DevicePreset
  chrome: FrameChrome
  safeArea: SafeArea
  children: React.ReactNode
}) {
  const framed = canvasFrame(device)
  if (!framed) return <>{children}</>
  const { frame, metrics: m, scale: k } = framed
  const ink = inkColour(chrome.ink)
  const barStyle = statusBarStyle(frame)
  return (
    <div className="relative" style={{ width: Math.round(m.w * k), height: Math.round(m.h * k) }}>
      <div
        className={`tf-frame device device-${frame}`}
        style={{ position: "absolute", top: 0, left: 0, transform: `scale(${k})`, transformOrigin: "top left" }}
      >
        <div className="device-frame">
          <div
            className="device-screen"
            style={{ position: "relative", overflow: "hidden", background: chrome.screenBackground, colorScheme: chrome.colorScheme }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: device.width,
                height: framedViewportHeight(device),
                transform: `scale(${1 / k})`,
                transformOrigin: "top left",
              }}
            >
              {children}
              {safeArea.top ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-10"
                  style={{ top: 0, left: 0, width: device.width, height: safeArea.top, background: chrome.stripFill ?? "transparent" }}
                  // Static, trusted markup from `lib/design-frames`; the ink is
                  // one of two constants.
                  dangerouslySetInnerHTML={
                    barStyle ? { __html: statusBarHtml(barStyle, device.width, safeArea.top, ink) } : undefined
                  }
                />
              ) : null}
              {safeArea.bottom ? (
                <div
                  aria-hidden
                  data-home-indicator=""
                  className="pointer-events-none absolute z-10 rounded-full"
                  style={{
                    left: "50%",
                    bottom: Math.round(safeArea.bottom * 0.25),
                    width: Math.min(134, Math.round(device.width * 0.36)),
                    height: 5,
                    transform: "translateX(-50%)",
                    background: ink,
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>
        <div className="device-stripe" />
        <div className="device-header" />
        <div className="device-sensors" />
        <div className="device-btns" />
        <div className="device-power" />
        <div className="device-home" />
      </div>
    </div>
  )
}
```

  `LazyFrame`:
  - Add `appearance,`, `safeTop,` and `safeBottom,` to its destructuring.
  - Add these to its props type after `theme: string`:

```ts
  /** #626: sent with `design:theme`; also this iframe's own `color-scheme`. */
  appearance: ThemeAppearance | null
  /** #626: the board's insets, sent as `design:safe-area` (0/0 resets). */
  safeTop: number
  safeBottom: number
```

  - Replace the push effect with:

```ts
  // Push mode/theme/safe area into the frame when it announces readiness, and
  // whenever the state changes for frames already up. Every message is
  // idempotent, so the unfiltered `design:ready` re-push is harmless.
  const pushRef = useRef<() => void>(() => {})
  useEffect(() => {
    pushRef.current = () => {
      const win = hostRef.current?.querySelector("iframe")?.contentWindow
      win?.postMessage({ type: "design:mode", picking }, "*")
      win?.postMessage({ type: "design:theme", theme, appearance }, "*")
      win?.postMessage({ type: "design:safe-area", top: safeTop, bottom: safeBottom }, "*")
    }
    pushRef.current()
  }, [picking, theme, appearance, safeTop, safeBottom, epoch])
```

  - On the `<iframe>` add `style={{ colorScheme: appearance ?? "normal" }}`. When the iframe element's `color-scheme` matches the document's, Chrome keeps the frame's backdrop transparent.

  **`DesignSurfacePage.tsx`:**
  - Change the theme-options import to `import { manifestThemes, resolveActiveTheme, themeAppearance, themeBackground } from "./theme-options"`.
  - After `const activeTheme = resolveActiveTheme(theme, themeOptions)` add:

```ts
  // #626: what the device frames colour their status bar and color-scheme by.
  const activeAppearance = themeAppearance(themeOptions, activeTheme)
  const activeThemeBackground = themeBackground(themeOptions, activeTheme)
```

  - On `<DesignCanvas`, after `theme={activeTheme}` add `appearance={activeAppearance}` and `themeBackground={activeThemeBackground}`. Both are primitives, so `DesignCanvas`'s memo still holds.

  **`component-dialog.tsx`:**
  - Change the theme-options import to `import { resolveActiveTheme, themeAppearance, type ThemeOption } from "./theme-options"`.
  - After `const activeTheme = resolveActiveTheme(theme, themes)` add `const appearance = themeAppearance(themes, activeTheme)`.
  - On `<ComponentSandboxFrame` add `appearance={appearance}`.
  - In `ComponentSandboxFrame`, add `appearance` to the destructuring and `appearance: "light" | "dark" | null` to its props type. Change the push to `postMessage({ type: "design:theme", theme, appearance }, "*")` with `useCallback` deps `[theme, appearance]`.

  This dialog frames no device, so it sends no safe area (0px defaults).

- [ ] **Step 4: Run the tests, type check, lint and build.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/v2_fe && npx vitest run 2>&1 | tail -4`

  Expected: all pass.

  Run: `npx tsc -p tsconfig.app.json --noEmit 2>&1 | tail -5`

  Expected: no errors.

  Run the Step 1 eslint command again.

  Expected: count ≤ baseline. Removing `StatusBar` must not leave an unused import: `statusBarHtml` and `statusBarStyle` are still used.

  Run: `npm run build 2>&1 | tail -3`

  Expected: `built in …`. dalmas views the built app, so the build is the deploy.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git commit -m "feat(design-fe): framed boards inject safe areas and colour the status bar from the page (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- v2_fe/src/pages/design/design-canvas.tsx v2_fe/src/pages/design/design-canvas.test.ts v2_fe/src/pages/design/DesignSurfacePage.tsx v2_fe/src/pages/design/component-dialog.tsx
```

---

### Task 8: MCP: `appearance` in `design_write_tokens`

**Files:**
- Modify: `mcp/src/server.ts`
- Modify: `mcp/src/server.test.ts`

**Interfaces:** `patch.themes[]` items gain `appearance?: "light" | "dark" | null`. The `design_write_tokens` and `design_get_tokens` descriptions mention `appearance`.

**Parallel-safe with:** Task 1, 2, 3, 4, 5, 6, 7, 9

- [ ] **Step 1: Record the lint baseline and write the failing test.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/mcp && npx eslint src/server.ts src/server.test.ts 2>&1 | tail -2`

  Note the count.

  In `src/server.test.ts`, inside `describe("named themes (#619)"`, append:

```ts
  it("design_write_tokens passes a theme's appearance through, null included (#626)", async () => {
    const client = await connectedClient();
    const patch = { themes: [{ name: "dark", appearance: "dark" }, { name: "ocean", appearance: null }] };
    const result = await client.callTool({
      name: "design_write_tokens",
      arguments: { profile: "main", reason: "Mark ocean automatic again", patch },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(harness.payloads[0]!)).toEqual({ patch });
    const bad = await client.callTool({
      name: "design_write_tokens",
      arguments: { profile: "main", reason: "A bad appearance value", patch: { themes: [{ name: "ocean", appearance: "dim" }] } },
    });
    expect(bad.isError).toBe(true);
  });

  it("descriptions teach appearance and safe areas (#626)", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const desc = (name: string) => tools.tools.find((t) => t.name === name)?.description ?? "";
    expect(desc("design_write_tokens")).toMatch(/"appearance":"dark"/);
    expect(desc("design_write_tokens")).toMatch(/--safe-top/);
    expect(desc("design_get_tokens")).toMatch(/appearance/);
  });
```

- [ ] **Step 2: Run the test to confirm it fails.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/mcp && npx vitest run src/server.test.ts -t "#626" 2>&1 | tail -6`

  Expected: FAIL. The first test fails because zod's object strips `appearance` from the forwarded patch. The second fails because the descriptions lack the text.

- [ ] **Step 3: Implement.**

  In `src/server.ts`, in `design_write_tokens`'s schema, replace the `.array(z.object({ name: themeName, label: …, rename_from: themeName.optional() }))` line with:

```ts
            .array(
              z.object({
                name: themeName,
                label: z.string().min(1).max(40).optional(),
                rename_from: themeName.optional(),
                appearance: z.enum(["light", "dark"]).nullable().optional(),
              }),
            )
```

  In the `design_write_tokens` description string, replace `rename with {\"name\":\"sea\",\"rename_from\":\"ocean\"}).` with:

```text
rename with {\"name\":\"sea\",\"rename_from\":\"ocean\"}; {\"name\":\"forest\",\"appearance\":\"dark\"} tells the Design view's phone frames the theme is dark (white status-bar icons, dark color-scheme) — \"light\"|\"dark\", omit to keep, null for automatic). Pages pad their top bar with pt-[var(--safe-top)] and tab bar with pb-[calc(0.75rem+var(--safe-bottom))] (0px outside the device frame); data-status-bar=\"light\" on the top element forces white icons.
```

  In the `design_get_tokens` description, replace `with each theme's label and swatch;` with `with each theme's label, appearance (light|dark|null = automatic) and swatch;`.

- [ ] **Step 4: Run the tests and lint.**

  Run: `cd /home/dalmas/E/projects/ltt-safe/mcp && npx vitest run 2>&1 | tail -4`

  Expected: all pass, including the older `rename_from` and `Don't overwrite light` description checks.

  Run: `npx eslint src/server.ts src/server.test.ts 2>&1 | tail -2`

  Expected: count ≤ baseline.

  Run: `npx tsc --noEmit -p . 2>&1 | tail -3`

  Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git commit -m "feat(mcp): design_write_tokens takes a theme's appearance; docs teach safe areas (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- mcp/src/server.ts mcp/src/server.test.ts
```

---

### Task 9: Docs: safe areas, `data-status-bar` and `appearance`

**Files:**
- Modify: `documentation/docs/v2.0.0/features.mdx`
- Modify: `documentation/docs/v2.0.0/api/index.mdx`
- Modify: `v2_fe/public/llms.txt`

**Interfaces:** none (prose).

**Parallel-safe with:** Task 1, 2, 3, 4, 5, 6, 7, 8

- [ ] **Step 1: Write the check that fails.**

  Run: `cd /home/dalmas/E/projects/ltt-safe && grep -c "safe-top" documentation/docs/v2.0.0/features.mdx documentation/docs/v2.0.0/api/index.mdx v2_fe/public/llms.txt`

  Expected: `0` for each file.

- [ ] **Step 2: Edit `features.mdx`.** In the `### Named themes` section, after the `- **Agents**:` bullet, add:

```mdx
- **Appearance**: each theme can declare `appearance: "light"` or `"dark"` (the token panel's chip menu: Appearance → Light / Dark / Auto; agents: `{"themes":[{"name":"forest","appearance":"dark"}]}`). It colours the device frame's status bar and sets the page's `color-scheme`, so scrollbars and form controls match. Auto leaves it to the page; light is always light, and `dark` is dark unless it says otherwise.

### Device safe areas

In device-frame mode the page draws under the phone's status bar, as an app does. The frame sets two CSS variables on the page: `--safe-top` (the status bar: 20px on iPhone SE, 59px on iPhone 15/16, 62px on 16 Pro Max, about 32–40px on Android, 24px on iPad) and `--safe-bottom` (the home indicator: 34px on notched iPhones, 24px on Android, 20px on iPad, 0 on iPhone SE). Everywhere else — frameless boards, Classic and Outline frames, screenshots, exports and `page.html` — both are `0px`, so nothing shifts.

- Pad the top bar with `pt-[var(--safe-top)]`; its own background then fills the status-bar strip.
- Pad a tab bar or sticky footer with `pb-[calc(0.75rem+var(--safe-bottom))]` so its labels clear the home indicator.
- Status-bar icon colour: `data-status-bar="light"` (white icons) or `"dark"` on the page's top element wins; then the theme's `appearance`; then the colour at the top of the page. A page that does not pad yet gets the strip filled with its own top colour.
```

- [ ] **Step 3: Edit `api/index.mdx` and `llms.txt`.**

  In `api/index.mdx`, in the `design_write_tokens` row, replace `and \`{"<theme>": value}\` edits one theme |` with:

```mdx
and `{"<theme>": value}` edits one theme; a theme entry's `appearance` (`"light"`/`"dark"`, `null` = automatic) colours the device frame's status bar. Pages pad with `pt-[var(--safe-top)]` / `pb-[calc(0.75rem+var(--safe-bottom))]` (0px outside the device frame) |
```

  In the `design_get_tokens` row, replace `(the ordered theme list with labels and swatches)` with `(the ordered theme list with labels, appearance and swatches)`.

  In `v2_fe/public/llms.txt`, line 3, replace `agents call \`design_guide\` first)` with:

```text
agents call `design_guide` first; device frames draw pages under the status bar — pad with `pt-[var(--safe-top)]` / `pb-[calc(0.75rem+var(--safe-bottom))]`, force white icons with `data-status-bar="light"`, and set a theme's `appearance` to light or dark)
```

- [ ] **Step 4: Verify the check now passes.**

  Run: `cd /home/dalmas/E/projects/ltt-safe && grep -c "safe-top" documentation/docs/v2.0.0/features.mdx documentation/docs/v2.0.0/api/index.mdx v2_fe/public/llms.txt`

  Expected: each ≥ 1.

  Run: `grep -c "data-status-bar" documentation/docs/v2.0.0/features.mdx v2_fe/public/llms.txt`

  Expected: each ≥ 1.

- [ ] **Step 5: Commit.**

```bash
cd /home/dalmas/E/projects/ltt-safe
git commit -m "docs(design): device safe areas, data-status-bar and theme appearance (#626)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- documentation/docs/v2.0.0/features.mdx documentation/docs/v2.0.0/api/index.mdx v2_fe/public/llms.txt
```
