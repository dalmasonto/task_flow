# Design Agent Training Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents build designs in shadcn's vocabulary (`bg-primary`, `text-muted-foreground`, `rounded-lg`) that render in the sandbox and port to a shadcn app, and learn the design system on demand from one `design_guide` tool.

**Architecture:** A built-in shadcn neutral token set is merged *under* each project's tokens at serve time (nothing stored is rewritten). The generated token CSS takes shadcn's `globals.css` shape, and the page shell injects the same `@theme inline` bridge as `<style type="text/tailwindcss">` so the Tailwind browser build generates `bg-primary`. A validator rule rejects Tailwind's raw palette. Guidance moves from the always-returned `design_get_tokens` payload to a topic-indexed backend route surfaced by one MCP tool.

**Tech Stack:** Rust (Umbral, axum) in `backend/plugins/taskflow-design`; TypeScript MCP server in `mcp/` (zod, vitest); React 19 + Vite in `v2_fe/` (vitest, node environment, `.test.ts` only).

**Spec:** `docs/superpowers/specs/2026-10-06-design-agent-training-design.md` (TaskFlow #613)

## Global Constraints

- Stored `styles/tokens.json` / `styles/tokens.css` rows are **never rewritten** by this work; defaults apply at serve/compose time only.
- A project token **wins in full** (both themes) over a default with the same **emitted variable name**.
- Generated CSS order: `:root {…}` → `:root[data-theme="dark"], .dark {…}` (only if any dark values) → `@theme inline {…}`. **No raw `@theme {` block.**
- Radius bridge (exact): `--radius-sm: calc(var(--radius) * 0.6)`, `-md * 0.8`, `-lg var(--radius)`, `-xl * 1.4`, `-2xl * 1.8`, `-3xl * 2.2`, `-4xl * 2.6`.
- `--radius` lives at `custom.radius`, default `0.625rem`.
- Validator rule id: `palette-color`. Allowed colour words: `black white transparent current inherit`.
- Guide route: `GET /api/taskflow/agents/design/guide?topic=` (agent-authed). Topics exactly: `tokens`, `fonts`, `flow`, `primitives`, `pages`. Unknown topic → 400 listing them.
- MCP tool name: `design_guide`, arg `topic` optional.
- Backend tests run with `cargo test --workspace` (bare `cargo test` skips plugin crates).
- Frontend: `npx tsc -b` clean, `npx vitest run` green, ESLint error count must not grow (measure the touched files before and after).
- Commit with explicit paths (`git commit -- <paths>`), never `git add -A`; this worktree has unrelated uncommitted files.
- Deploy order: backend → frontend → MCP tag.

## Review Focus

1. **A legacy CSS-only project** (no `tokens.json`, only `--bg/--accent` in `styles/tokens.css`) must keep its own values and gain the defaults; its `--primary` must not be duplicated or overridden → pinned in Task 2 (`legacy_css_project_keeps_values_and_gains_defaults`).
2. **A project that already uses a shadcn name under `custom`** (`custom["--primary"]`, what a CSS import produces) must shadow the default `colors.primary` **and** still get `--color-primary` in the bridge, or `bg-primary` silently breaks for it → Task 1 (`custom_dash_name_shadows_default_and_stays_bridged`).
3. **Palette classes with variants and opacity** (`hover:bg-blue-500`, `dark:text-zinc-400/80`, `md:border-red-200`) must be rejected; **look-alikes must pass**: `bg-black/50`, `text-white`, `bg-primary`, `text-sky` (no shade), prose like "the blue-500 line" without a utility prefix → Task 3.
4. **The page export** (`page.html` download) must carry the bridge too, or a downloaded page renders `bg-primary` unstyled while the sandbox looks right → Task 2 (`export_document_carries_the_bridge`).
5. **An agent on an old MCP** calling `design_get_tokens` after the backend deploy must still get a usable answer (tokens + a pointer), not an error → Task 4 (`context_is_lean_and_points_at_the_guide`).

---

### Task 1: Defaults overlay, bridge and new CSS shape (pure token functions)

**Files:**
- Create: `backend/plugins/taskflow-design/src/defaults.rs`
- Modify: `backend/plugins/taskflow-design/src/lib.rs` (add `pub mod defaults;` after `pub mod dispatch;`)
- Modify: `backend/plugins/taskflow-design/src/tokens.rs:205-252` (`tokens_json_to_css`) and add `theme_bridge`
- Test: `backend/plugins/taskflow-design/tests/tokens_defaults.rs` (create), `backend/plugins/taskflow-design/tests/tokens_codec.rs` (update)

**Interfaces:**
- Produces:
  - `defaults::shadcn_defaults() -> TokensDoc`
  - `defaults::effective_tokens(project: &TokensDoc) -> TokensDoc` — project categories/tokens first in their order, then every default whose emitted var name the project lacks, appended into its category (category created at the end if absent).
  - `defaults::missing_defaults(project: &TokensDoc) -> TokensDoc` — exactly the defaults `effective_tokens` adds.
  - `tokens::theme_bridge(effective: &TokensDoc) -> String` — the `@theme inline { … }` block, newline-terminated.
  - `tokens::tokens_json_to_css(doc: &TokensDoc) -> String` — new shape (no raw `@theme`, dark under both selectors, bridge last).

- [ ] **Step 1: Write the failing tests** — create `tests/tokens_defaults.rs`:

```rust
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
```

- [ ] **Step 2: Update `tests/tokens_codec.rs`** for the new shape. In `json_generates_css_with_root_and_dark_preserving_var_names` replace the final two lines (`// @theme block present…` and `assert!(css.contains("@theme"));`) with:

```rust
    // shadcn globals.css shape: dark also under .dark; the bridge, not raw @theme.
    assert!(css.contains(":root[data-theme=\"dark\"], .dark {"));
    assert!(!css.contains("@theme {"));
    assert!(css.contains("@theme inline {"));
```

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && cargo test -p taskflow-design --test tokens_defaults --test tokens_codec`
Expected: compile error — `taskflow_design::defaults` and `theme_bridge` do not exist.

- [ ] **Step 4: Create `src/defaults.rs`**

```rust
//! The built-in shadcn **neutral** theme, merged UNDER every project's tokens at
//! serve/compose time (never written to storage). A project token wins in full;
//! a name the project lacks comes from here. Matching is by EMITTED variable
//! name, so a legacy import's `custom["--primary"]` shadows `colors.primary`.
//! Values: shadcn/ui neutral base colour (oklch), radius 0.625rem.

use crate::tokens::{category_to_var_name, OrderedMap, TokenValue, TokensDoc};
use std::collections::HashSet;

const COLORS: &[(&str, &str, &str)] = &[
    ("background", "oklch(1 0 0)", "oklch(0.145 0 0)"),
    ("foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("card", "oklch(1 0 0)", "oklch(0.205 0 0)"),
    ("card-foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("popover", "oklch(1 0 0)", "oklch(0.205 0 0)"),
    ("popover-foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("primary", "oklch(0.205 0 0)", "oklch(0.922 0 0)"),
    ("primary-foreground", "oklch(0.985 0 0)", "oklch(0.205 0 0)"),
    ("secondary", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("secondary-foreground", "oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    ("muted", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("muted-foreground", "oklch(0.556 0 0)", "oklch(0.708 0 0)"),
    ("accent", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("accent-foreground", "oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    ("destructive", "oklch(0.577 0.245 27.325)", "oklch(0.704 0.191 22.216)"),
    ("border", "oklch(0.922 0 0)", "oklch(1 0 0 / 10%)"),
    ("input", "oklch(0.922 0 0)", "oklch(1 0 0 / 15%)"),
    ("ring", "oklch(0.708 0 0)", "oklch(0.556 0 0)"),
    ("chart-1", "oklch(0.646 0.222 41.116)", "oklch(0.488 0.243 264.376)"),
    ("chart-2", "oklch(0.6 0.118 184.704)", "oklch(0.696 0.17 162.48)"),
    ("chart-3", "oklch(0.398 0.07 227.392)", "oklch(0.769 0.188 70.08)"),
    ("chart-4", "oklch(0.828 0.189 84.429)", "oklch(0.627 0.265 296.677)"),
    ("chart-5", "oklch(0.769 0.188 70.08)", "oklch(0.645 0.246 16.439)"),
    ("sidebar", "oklch(0.985 0 0)", "oklch(0.205 0 0)"),
    ("sidebar-foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("sidebar-primary", "oklch(0.205 0 0)", "oklch(0.488 0.243 264.376)"),
    ("sidebar-primary-foreground", "oklch(0.985 0 0)", "oklch(0.985 0 0)"),
    ("sidebar-accent", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("sidebar-accent-foreground", "oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    ("sidebar-border", "oklch(0.922 0 0)", "oklch(1 0 0 / 10%)"),
    ("sidebar-ring", "oklch(0.708 0 0)", "oklch(0.556 0 0)"),
];

/// The shadcn neutral theme as a token document.
pub fn shadcn_defaults() -> TokensDoc {
    let mut colors = OrderedMap::new();
    for (key, light, dark) in COLORS {
        colors.insert(*key, TokenValue { light: (*light).into(), dark: Some((*dark).into()) });
    }
    let mut custom = OrderedMap::new();
    custom.insert("radius", TokenValue { light: "0.625rem".into(), dark: None });
    let mut categories = OrderedMap::new();
    categories.insert("colors", colors);
    categories.insert("custom", custom);
    TokensDoc { version: 1, categories }
}

/// Every emitted `--var` name a document defines.
fn var_names(doc: &TokensDoc) -> HashSet<String> {
    doc.categories
        .iter()
        .flat_map(|(cat, toks)| toks.iter().map(move |(k, _)| category_to_var_name(cat, k)))
        .collect()
}

/// The defaults the project does not define (by emitted var name).
pub fn missing_defaults(project: &TokensDoc) -> TokensDoc {
    let have = var_names(project);
    let mut out = TokensDoc::default();
    for (cat, toks) in shadcn_defaults().categories.iter() {
        for (key, value) in toks.iter() {
            if !have.contains(&category_to_var_name(cat, key)) {
                out.categories
                    .entry_or_insert_with(cat, OrderedMap::new)
                    .insert(key.clone(), value.clone());
            }
        }
    }
    out
}

/// `project` with every missing default appended — what pages render with.
pub fn effective_tokens(project: &TokensDoc) -> TokensDoc {
    let mut out = project.clone();
    for (cat, toks) in missing_defaults(project).categories.iter() {
        let target = out.categories.entry_or_insert_with(cat, OrderedMap::new);
        for (key, value) in toks.iter() {
            target.insert(key.clone(), value.clone());
        }
    }
    out
}

/// The shadcn colour names, for the bridge: these vars always exist in an
/// effective doc (from the project under any category, or from the defaults).
pub fn default_color_names() -> impl Iterator<Item = &'static str> {
    COLORS.iter().map(|(k, _, _)| *k)
}
```

- [ ] **Step 5: Replace `tokens_json_to_css` and add `theme_bridge` in `src/tokens.rs`** (replace the whole function at :205-252 including its doc comment):

```rust
/// Generate the served CSS from a (normally EFFECTIVE) tokens document, in
/// shadcn's `globals.css` shape:
///
/// 1. `:root { <light values> }`
/// 2. `:root[data-theme="dark"], .dark { <dark values> }` — the sandbox toggles
///    `data-theme` (composer.rs); `.dark` makes the file drop into a shadcn app.
///    Emitted only when some token has a dark value.
/// 3. [`theme_bridge`] — `@theme inline`, mapping tokens into Tailwind's
///    namespaces. A plain stylesheet ignores it; the composer feeds the same
///    block to the Tailwind browser build as `text/tailwindcss`.
///
/// There is deliberately NO raw `@theme { values }` block any more: the browser
/// never compiled it, and in an app it would register `--primary` itself as a
/// theme variable.
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

    let mut out = String::from(":root {\n");
    for line in &light_lines {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("}\n");
    if !dark_lines.is_empty() {
        out.push_str("\n:root[data-theme=\"dark\"], .dark {\n");
        for line in &dark_lines {
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
pub fn theme_bridge(doc: &TokensDoc) -> String {
    let mut names: Vec<String> = Vec::new();
    let mut defined: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (category, tokens) in doc.categories.iter() {
        for (key, _) in tokens.iter() {
            defined.insert(category_to_var_name(category, key));
            if category == "colors" && !names.contains(key) {
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
            out.push_str(&format!("  --radius-{step}: {expr};\n"));
        }
    }
    out.push_str("}\n");
    out
}
```

Note: `theme_bridge` only adds a default colour name when the doc actually defines `--<name>` (`defined.contains`), which is what makes `no_radius_means_no_radius_scale` hold and keeps the bridge honest for non-effective docs.

- [ ] **Step 6: Add the module** — in `src/lib.rs` add `pub mod defaults;` after `pub mod dispatch;`.

- [ ] **Step 7: Run the tests**

Run: `cd backend && cargo test -p taskflow-design --test tokens_defaults --test tokens_codec`
Expected: PASS (7 + 3 tests). If `parses_dark_from_both_data_theme_and_dot_dark` fails, the importer is fine — check the regenerated assertion strings only.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(design): shadcn defaults overlay and globals.css-shaped token CSS with a Tailwind bridge (#613)" -- backend/plugins/taskflow-design/src/defaults.rs backend/plugins/taskflow-design/src/lib.rs backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/tests/tokens_defaults.rs backend/plugins/taskflow-design/tests/tokens_codec.rs
```

---

### Task 2: Serve, manifest and composer use the effective tokens + bridge

**Files:**
- Modify: `backend/plugins/taskflow-design/src/tokens.rs` (add `project_tokens_doc`)
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs:40-60` (delete `resolve_tokens_doc`, use `tokens::project_tokens_doc`)
- Modify: `backend/plugins/taskflow-design/src/views.rs:1261-1308` (`generated_tokens_css` → `effective_tokens_css`; callers at :1264, :1320, :1397)
- Modify: `backend/plugins/taskflow-design/src/manifest.rs:63-77, 222-250` (effective token groups + `tokens_bridge` field)
- Modify: `backend/plugins/taskflow-design/src/composer.rs:916-918` (sandbox shell) and `:993-1021` (`compose_export_document` gains `bridge: &str`)
- Test: `backend/plugins/taskflow-design/tests/tokens_css_generation.rs`

**Interfaces:**
- Consumes: `defaults::effective_tokens`, `tokens::{tokens_json_to_css, theme_bridge}` (Task 1).
- Produces:
  - `tokens::project_tokens_doc(files: &[crate::models::DesignFile]) -> TokensDoc` — the stored doc (json row, else legacy css imported, else empty). **Not** effective.
  - `DesignManifest.tokens_bridge: String` — `theme_bridge(&effective)`.
  - `views::effective_tokens_css(project_id: i64) -> String` (private is fine).
  - `composer::compose_export_document(page_path, fragment, theme, tokens_css, bridge: &str, components, resources)`.

- [ ] **Step 1: Write the failing tests** — append to `tests/tokens_css_generation.rs` (it already imports `json!`, `TestApp`, and defines `seed_project_with_accordion_page`; writes go through `PUT /api/design/{project}/file` → 201, sandbox tokens come from `taskflow_design::sandbox::mint(project_id)`):

```rust
#[tokio::test(flavor = "multi_thread")]
async fn sandbox_tokens_css_includes_defaults_and_bridge() {
    let app = TestApp::new().await;
    let (_user, project_id) = app.create_member_with_project().await;
    // No tokens written at all.
    let token = taskflow_design::sandbox::mint(project_id);
    let css = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css")).await.text();
    assert!(css.contains("  --background: oklch(1 0 0);"), "{css}");
    assert!(css.contains("@theme inline {"));
    assert!(css.contains("--color-primary: var(--primary);"));
}

#[tokio::test(flavor = "multi_thread")]
async fn sandbox_page_carries_the_tailwind_bridge() {
    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;
    let res = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "pages/index.html", "content": r#"<main class="bg-primary">x</main>"# }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed page failed: {}", res.text());
    let token = taskflow_design::sandbox::mint(project_id);
    let html = app.get_sandbox(&format!("/s/{token}/")).await.text();
    let style = html.find("<style type=\"text/tailwindcss\">").expect("bridge style tag");
    assert!(html[style..].contains("--color-primary: var(--primary);"));
    assert!(style < html.find("<body").unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn export_document_carries_the_bridge() {
    let app = TestApp::new().await;
    let (user_id, project_id) = seed_project_with_accordion_page(&app).await;
    let html = app.get_as(user_id, &format!("/api/design/{project_id}/page.html?route=/")).await.text();
    assert!(html.contains("<style type=\"text/tailwindcss\">"), "{html}");
    assert!(html.contains("--color-background: var(--background);"));
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_css_project_keeps_values_and_gains_defaults() {
    let app = TestApp::new().await;
    let (user, project_id) = app.create_member_with_project().await;
    let res = app
        .put_json_as(
            user.id,
            &format!("/api/design/{project_id}/file"),
            &json!({ "path": "styles/tokens.css", "content": ":root {\n  --bg: #ffffff;\n  --primary: #ff0000;\n}\n" }),
        )
        .await;
    assert_eq!(res.status(), 201, "seed legacy css failed: {}", res.text());
    let token = taskflow_design::sandbox::mint(project_id);
    let css = app.get_sandbox(&format!("/s/{token}/f/styles/tokens.css")).await.text();
    assert!(css.contains("--bg: #ffffff;"));
    assert_eq!(css.matches("  --primary: ").count(), 1, "{css}");
    assert!(css.contains("--primary: #ff0000;"));
    assert!(css.contains("  --muted-foreground: "));
}
```

The existing tests in this file keep passing unchanged: `sandbox_serve_falls_back_to_legacy_css_row_when_no_json` asserts only that `--accent: #111111` is present (the importer keeps it), and the export tests assert `[data-theme="dark"]`, which the new combined selector still contains. Update only the legacy test's failure message ("served verbatim") to "legacy values survive generation".

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && cargo test -p taskflow-design --test tokens_css_generation`
Expected: the four new tests FAIL (no defaults, no bridge tag).

- [ ] **Step 3: Add `project_tokens_doc` to `src/tokens.rs`** (end of file, before any `#[cfg(test)]`), moving the body of `agent_views::resolve_tokens_doc`:

```rust
/// The project's STORED token document: the `styles/tokens.json` row, else a
/// legacy `styles/tokens.css` row imported via [`css_to_tokens_json`], else
/// empty. This is what the project defines — NOT what renders; pass it through
/// `defaults::effective_tokens` for that.
pub fn project_tokens_doc(files: &[crate::models::DesignFile]) -> TokensDoc {
    use crate::models::DesignFileKind;
    files
        .iter()
        .find(|f| f.kind == DesignFileKind::Token && f.path == "styles/tokens.json")
        .and_then(|f| serde_json::from_str::<TokensDoc>(&f.content).ok())
        .or_else(|| {
            files
                .iter()
                .find(|f| f.kind == DesignFileKind::Token && f.path == "styles/tokens.css")
                .map(|f| css_to_tokens_json(&f.content))
        })
        .unwrap_or_default()
}
```

In `agent_views.rs` delete `resolve_tokens_doc` (:40-60) and replace its call in `context` with `crate::tokens::project_tokens_doc(&files)`.

- [ ] **Step 4: Serve the effective CSS** — in `views.rs` replace `generated_tokens_css` (:1297-1308) with:

```rust
/// The project's served `tokens.css`: its stored tokens (json row, else the
/// legacy css row imported) with the shadcn defaults filling every gap, in
/// globals.css shape. Always answers — an empty project renders the defaults.
async fn effective_tokens_css(project_id: i64) -> String {
    let files = store::list_files(project_id).await;
    let project = crate::tokens::project_tokens_doc(&files);
    tokens_json_to_css(&crate::defaults::effective_tokens(&project))
}
```

Then update the three callers:
- `:1264` (sandbox file serve): `if path == "styles/tokens.css" { let css = effective_tokens_css(project_id).await; …same response building… return Ok(response); }` (no `if let Some`).
- `:1320` (`export_tokens_css`): `let css = effective_tokens_css(project_id).await;` (drop the legacy-row match).
- `:1397` (`page.html` export): `let tokens_css = effective_tokens_css(project_id).await;` and pass `&bridge` (below) to `compose_export_document`. Compute the bridge from the same files already loaded in that handler: `let bridge = crate::tokens::theme_bridge(&crate::defaults::effective_tokens(&crate::tokens::project_tokens_doc(&files)));`.

- [ ] **Step 5: Manifest uses the effective doc and carries the bridge** — in `manifest.rs`:
  - add the field to `DesignManifest` (after `resources`): `/// The \`@theme inline\` bridge for this project's effective tokens; the composer feeds it to Tailwind. pub tokens_bridge: String,`
  - replace the `let tokens = files…` block (:229-241) with:

```rust
    let project_doc = crate::tokens::project_tokens_doc(files);
    let effective = crate::defaults::effective_tokens(&project_doc);
    let tokens = token_groups_from_doc(&effective);
    let tokens_bridge = crate::tokens::theme_bridge(&effective);
```

  - add `tokens_bridge,` to the `DesignManifest { … }` literal. Fix any other `DesignManifest { … }` literals the compiler reports (tests/compare) by adding `tokens_bridge: String::new()`.
  - `parse_token_groups` becomes unused if nothing else calls it: if the compiler warns, delete it.

- [ ] **Step 6: Composer injects the bridge** — in `compose_document`'s template (composer.rs:917-918) change the two lines to:

```text
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <style type="text/tailwindcss">{bridge}</style>
  {resources}<link rel="stylesheet" href="/s/{token}/f/styles/tokens.css?v={tokens_rev}">
```

and before the `format!` add `let bridge = escape_for_inline_style(&manifest.tokens_bridge);`. In `compose_export_document` add a `bridge: &str` parameter after `tokens_css`, and in its template insert `<style type="text/tailwindcss">{safe_bridge}</style>` right after the Tailwind `<script>` line, with `let safe_bridge = escape_for_inline_style(bridge);`. Update its caller in views.rs (Step 4) and any test caller the compiler reports.

- [ ] **Step 7: Run the design suite**

Run: `cd backend && cargo test -p taskflow-design`
Expected: PASS. A test that pinned the old exact CSS (`@theme {` or verbatim legacy output) is updated to the new shape, not deleted.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(design): pages render with shadcn defaults and bg-primary-style classes (#613)" -- backend/plugins/taskflow-design/src backend/plugins/taskflow-design/tests
```

---

### Task 3: `palette-color` validator rule and semantic suggestions

**Files:**
- Modify: `backend/plugins/taskflow-design/src/validation.rs` (page fragment checks after the `raw-color` block ~:455; component block ~:954; hint text at :449-454, :466-468, :699, :962-967)
- Test: `backend/plugins/taskflow-design/tests/palette_color.rs` (create)

**Interfaces:**
- Produces: `validation::find_palette_class(content: &str) -> Option<(String, usize)>` (pub for tests) and rule id `"palette-color"`.

- [ ] **Step 1: Write the failing tests** — `tests/palette_color.rs`:

```rust
use taskflow_design::validation::{find_palette_class, validate_component, validate_page_fragment};

#[test]
fn finds_palette_classes_with_variants_and_opacity() {
    for (html, want) in [
        (r#"<div class="p-4 bg-blue-500">"#, "bg-blue-500"),
        (r#"<a class="hover:bg-blue-600">"#, "hover:bg-blue-600"),
        (r#"<p class="dark:text-zinc-400/80">"#, "dark:text-zinc-400/80"),
        (r#"<div class="md:border-red-200">"#, "md:border-red-200"),
        (r#"<div class="ring-offset-slate-50">"#, "ring-offset-slate-50"),
        (r#"<div class="from-emerald-400 to-teal-500">"#, "from-emerald-400"),
    ] {
        assert_eq!(find_palette_class(html).map(|(c, _)| c), Some(want.to_string()), "{html}");
    }
}

#[test]
fn accepts_semantic_and_neutral_words() {
    for html in [
        r#"<div class="bg-primary text-primary-foreground border-border rounded-lg">"#,
        r#"<div class="bg-black/50 text-white bg-transparent text-current">"#,
        r#"<div class="bg-[var(--brand)] text-muted-foreground">"#,
        r#"<p>the blue-500 line and text-sky are words</p>"#,
        r#"<div class="text-sm font-medium p-4 gap-2">"#,
    ] {
        assert_eq!(find_palette_class(html), None, "{html}");
    }
}

#[test]
fn page_write_rejects_with_semantic_suggestion() {
    let v = validate_page_fragment("pages/index.html", r#"<main class="bg-blue-500 text-white">x</main>"#, &[]);
    let err = v.errors.first().expect("rejected");
    assert_eq!(err.rule, "palette-color");
    assert_eq!(err.found.as_deref(), Some("bg-blue-500"));
    assert!(err.suggest.as_deref().unwrap().contains("bg-primary"));
}

#[test]
fn component_write_rejects_too() {
    let js = "class X extends HTMLElement { connectedCallback(){ this.innerHTML = '<p class=\"text-zinc-500\">x</p>' } } customElements.define('x-y', X)";
    let v = validate_component("components/x-y.js", js);
    assert_eq!(v.errors.first().map(|e| e.rule), Some("palette-color"));
}
```

(`validate_page_fragment(path, content, registered_components: &[String]) -> Validation`; `Validation { ok, errors: Vec<ValidationError>, warnings }`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && cargo test -p taskflow-design --test palette_color`
Expected: compile error — `find_palette_class` not found.

- [ ] **Step 3: Implement** — add to `validation.rs` near `find_arbitrary_value`:

```rust
const PALETTE: &[&str] = &[
    "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green",
    "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const COLOR_UTILITIES: &[&str] = &[
    "ring-offset", "border-x", "border-y", "border-t", "border-r", "border-b", "border-l",
    "bg", "text", "border", "ring", "outline", "divide", "fill", "stroke", "from", "via", "to",
    "placeholder", "decoration", "caret", "accent", "shadow",
];
const SHADES: &[&str] = &["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

/// A Tailwind PALETTE colour class (`bg-blue-500`, `hover:text-zinc-400/80`):
/// returns the whole class and its byte offset. Semantic classes, `black`/
/// `white`/`transparent`/`current`/`inherit`, arbitrary `[var(--x)]` and plain
/// prose never match — a match needs utility prefix + palette name + shade.
pub fn find_palette_class(content: &str) -> Option<(String, usize)> {
    let is_sep = |c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '<' | '>' | '=');
    let mut offset = 0usize;
    for word in content.split(is_sep) {
        let start = offset;
        offset += word.len() + 1;
        if word.is_empty() {
            continue;
        }
        let base = word.rsplit(':').next().unwrap_or(word);
        let base = base.split('/').next().unwrap_or(base);
        for util in COLOR_UTILITIES {
            let Some(rest) = base.strip_prefix(util).and_then(|r| r.strip_prefix('-')) else { continue };
            let Some((name, shade)) = rest.rsplit_once('-') else { continue };
            if PALETTE.contains(&name) && SHADES.contains(&shade) {
                return Some((word.to_string(), start));
            }
        }
    }
    None
}

/// The semantic class to suggest for a palette class's utility.
fn semantic_suggestion(class: &str) -> &'static str {
    let base = class.rsplit(':').next().unwrap_or(class);
    if base.starts_with("text-") || base.starts_with("placeholder-") || base.starts_with("decoration-") {
        "text-foreground / text-muted-foreground / text-primary"
    } else if base.starts_with("border") || base.starts_with("divide-") || base.starts_with("ring") || base.starts_with("outline-") {
        "border-border / border-input / ring-ring"
    } else {
        "bg-primary / bg-secondary / bg-muted / bg-accent / bg-card"
    }
}

fn palette_error(content: &str, found: String, offset: usize) -> ValidationError {
    let suggest = semantic_suggestion(&found);
    ValidationError {
        line: line_of(content, offset),
        rule: "palette-color",
        message: format!(
            "{found} uses Tailwind's raw palette, which does not follow the project's theme and \
             does not port to a shadcn app. Use a semantic class instead: {suggest} (or \
             bg-[var(--your-token)] for a custom token). See design_guide topic \"tokens\"."
        ),
        found: Some(found),
        suggest: Some(suggest.to_string()),
    }
}
```

In `validate_page_fragment`, directly after the `raw-color` block, add:

```rust
    if let Some((found, offset)) = find_palette_class(content) {
        return v.fail(palette_error(content, found, offset));
    }
```

In `validate_write`'s component block, after its `raw-color` check (inside `if kind == DesignFileKind::Component {`), add:

```rust
        if let Some((found, offset)) = find_palette_class(content) {
            return base.fail(palette_error(content, found, offset));
        }
```

- [ ] **Step 4: Update the old hints to shadcn vocabulary** — in validation.rs:
  - both `raw-color` messages: `e.g. {prop}-[var(--accent)] — see design_get_tokens for the full scale.` → `a semantic class such as bg-primary or text-muted-foreground — see design_guide topic "tokens".`; their `suggest` → `Some("bg-primary".into())` for `bg`, `Some("text-foreground".into())` for `text`, else `Some(format!("{prop}-[var(--your-token)]"))`.
  - `style-hex` message: `(e.g. bg-[var(--surface)])` → `(e.g. bg-card)`; suggest → `class="bg-card"`.
  - :699 legacy CSS hint `@theme { --color-accent: … }` → `:root { --accent: … }` (bare names; the bridge adds `--color-*`).
  Then update `tests/phase3_agent_surface.rs:479` and `tests/phase1_storage_composer.rs:427` only if they assert the old suggestion text (they assert `rule == "raw-color"`, which is unchanged).

- [ ] **Step 5: Run**

Run: `cd backend && cargo test -p taskflow-design`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(design): reject Tailwind palette colours; hints speak shadcn (#613)" -- backend/plugins/taskflow-design/src/validation.rs backend/plugins/taskflow-design/tests
```

---

### Task 4: Guide route, lean `design_get_tokens`, defaults list for operators

**Files:**
- Create: `backend/plugins/taskflow-design/src/guide.rs`
- Modify: `backend/plugins/taskflow-design/src/lib.rs` (`pub mod guide;` after `pub mod dispatch;`)
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs:80-196` (delete `AUTHORING_GUIDE`; add `guide` handler; slim `context`)
- Modify: `backend/plugins/taskflow-design/src/urls.rs` (agent route after `/api/taskflow/agents/design/context`; operator route next to the `tokens.css` export route)
- Modify: `backend/plugins/taskflow-design/src/views.rs` (operator `token_defaults` handler next to `export_tokens_css`)
- Test: `backend/plugins/taskflow-design/tests/design_guide.rs` (create); update `tests/phase3_agent_surface.rs:110-124` and `:237-260`

**Interfaces:**
- Consumes: `defaults::missing_defaults`, `tokens::project_tokens_doc`, `defaults::effective_tokens`, `primitives::catalog()`.
- Produces:
  - `GET /api/taskflow/agents/design/guide?topic=<t>` → `200 {"topic": "<t>|index", "text": "<markdown>"}`; unknown → `400 {"error":"unknown_topic","topics":["tokens","fonts","flow","primitives","pages"]}`.
  - `context` response: drops `guide` and `primitives`; adds `"defaults": [<var names served from defaults>]`; `tokens_css` is the EFFECTIVE css; `note` points at `design_guide`.
  - `GET /api/design/{project}/tokens/defaults` (operator, member-gated like `export_tokens_css`) → `{"missing": TokensDoc}`.
  - `guide::TOPICS: &[&str]`, `guide::text(topic: Option<&str>) -> Result<String, ()>`.

- [ ] **Step 1: Write the failing tests** — `tests/design_guide.rs` (use `support::seed_agent` exactly as `phase3_agent_surface.rs:79-110` does to get a project + agent key):

```rust
mod support;
use support::TestApp;

async fn agent(app: &TestApp) -> (i64, String) {
    let (_user, project) = app.create_member_with_project().await;
    let (_id, key) = support::seed_agent(project, "Designer").await;
    (project, key)
}

#[tokio::test(flavor = "multi_thread")]
async fn index_lists_every_topic() {
    let app = TestApp::new().await;
    let (_p, key) = agent(&app).await;
    let r = app.get_as_agent(&key, "/api/taskflow/agents/design/guide").await;
    assert_eq!(r.status(), 200);
    let text = r.json()["text"].as_str().unwrap().to_string();
    for t in ["tokens", "fonts", "flow", "primitives", "pages"] {
        assert!(text.contains(t), "index lacks {t}");
    }
    assert!(text.len() < 1200, "index must stay short: {}", text.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn each_topic_answers_with_its_essentials() {
    let app = TestApp::new().await;
    let (_p, key) = agent(&app).await;
    for (topic, must) in [
        ("tokens", "bg-primary"), ("tokens", "muted-foreground"), ("tokens", "custom.radius"),
        ("fonts", "styles/resources.json"), ("flow", "design_arrange"),
        ("primitives", "ui-accordion"), ("pages", "history.back()"),
    ] {
        let r = app.get_as_agent(&key, &format!("/api/taskflow/agents/design/guide?topic={topic}")).await;
        assert_eq!(r.status(), 200, "{topic}");
        assert!(r.json()["text"].as_str().unwrap().contains(must), "{topic} lacks {must}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_topic_is_400_listing_topics() {
    let app = TestApp::new().await;
    let (_p, key) = agent(&app).await;
    let r = app.get_as_agent(&key, "/api/taskflow/agents/design/guide?topic=colours").await;
    assert_eq!(r.status(), 400);
    assert_eq!(r.json()["topics"].as_array().unwrap().len(), 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn context_is_lean_and_points_at_the_guide() {
    let app = TestApp::new().await;
    let (project, key) = agent(&app).await;
    let ctx = app.get_as_agent(&key, &format!("/api/taskflow/agents/design/context?project={project}")).await.json();
    assert!(ctx.get("guide").is_none() && ctx.get("primitives").is_none());
    assert!(ctx["note"].as_str().unwrap().contains("design_guide"));
    assert!(ctx["defaults"].as_array().unwrap().iter().any(|n| n == "--primary"));
    assert!(ctx["tokens_css"].as_str().unwrap().contains("--color-primary: var(--primary);"));
}
```

Also in `tests/phase3_agent_surface.rs`: in `agent_reads_context_and_registry` remove the `primitives` assertions (:120-130) and in `context_serves_the_link_back_and_media_guidance` (:237) point it at `/api/taskflow/agents/design/guide?topic=pages` and read `["text"]` instead of `["guide"]` — keep its content assertions.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && cargo test -p taskflow-design --test design_guide`
Expected: FAIL (404 on the route).

- [ ] **Step 3: Create `src/guide.rs`.** Move the three sections of `AUTHORING_GUIDE` (agent_views.rs:91-150) verbatim: the "links between pages" and "images, video and motion" sections into `PAGES`, the "web fonts" section into `FONTS`. Then write the rest:

```rust
//! The design guide agents read on demand through `design_guide(topic?)`.
//! Lives in the backend so a deploy updates it without waiting for every
//! machine's global MCP install (same reason the old AUTHORING_GUIDE lived here).

pub const TOPICS: &[&str] = &["tokens", "fonts", "flow", "primitives", "pages"];

const INDEX: &str = "Design guide — call design_guide with a topic:\n\
- tokens: the shadcn colour names, light/dark, radius, the classes to write (bg-primary…), what is rejected. Read before your first design write.\n\
- fonts: adding a webfont (a token plus styles/resources.json).\n\
- flow: groups, page order and links between screens; design_arrange vs single operations.\n\
- primitives: the built-in <ui-accordion|dialog|sheet|tabs> components with examples.\n\
- pages: page rules, links between pages, back buttons, images and motion.";

const TOKENS: &str = r#"# Tokens — shadcn vocabulary

Every project renders with shadcn's semantic colour tokens. Names the project does not define come from built-in defaults (shadcn neutral), so they ALWAYS exist; design_get_tokens lists which are defaults under `defaults`.

## Names (each has light + dark)
background / foreground — the page
card / card-foreground — raised surfaces
popover / popover-foreground — menus, dialogs, sheets
primary / primary-foreground — the main action
secondary / secondary-foreground — the quieter action
muted / muted-foreground — subdued surfaces and secondary text
accent / accent-foreground — hover and selected states
destructive — danger
border, input, ring — lines, field borders, focus rings
chart-1 … chart-5 — data series
sidebar, sidebar-foreground, sidebar-primary(-foreground), sidebar-accent(-foreground), sidebar-border, sidebar-ring
radius — ONE base radius, stored as custom.radius (e.g. 0.625rem); rounded-sm…rounded-4xl derive from it.

## Write classes exactly like a shadcn app
bg-background text-foreground · bg-card text-card-foreground · bg-primary text-primary-foreground hover:bg-primary/90 · bg-secondary · bg-muted text-muted-foreground · hover:bg-accent hover:text-accent-foreground · border border-border · border-input · ring-ring · text-destructive · rounded-md / rounded-lg / rounded-xl.
Opacity modifiers work: bg-primary/10, border-border/60.

## Rejected
Hex/rgb/hsl or px in brackets (bg-[#3b82f6], p-[13px]) and Tailwind's raw palette (bg-blue-500, text-zinc-400) — they ignore the theme and do not port to a shadcn app. bg-black/50 and text-white are fine (overlays).

## Changing the theme
Restyle with design_write_tokens and a patch — pages need no edits:
{"colors":{"primary":{"light":"oklch(0.55 0.2 250)","dark":"oklch(0.7 0.17 250)"}}}
{"custom":{"radius":{"light":"0.5rem"}}}
Prefer oklch values. A project-only colour (e.g. colors.brand) becomes bg-brand / text-brand automatically; use it sparingly — prefer the shadcn names.
Check dark mode: design_screenshot with theme "dark". Compare options with design_compare before writing.

## Porting
The served tokens.css IS a shadcn globals.css (:root, .dark, @theme inline): paste it into the app and the classes in these pages work unchanged."#;

const FLOW: &str = r#"# Flow — groups, order and links

Pages sit in named groups that read as the screens of one journey (e.g. "Onboarding", "Settings"). Order matters: groups left→right, pages top→bottom, numbered in the panel.

- design_read_layout — the current groups, order, labels and links. Read it first.
- design_arrange — the whole arrangement in ONE call (groups, membership, order, links). Use it when setting up or reorganising a flow.
- Single operations for small edits: design_create_group, design_update_group (rename), design_reorder_group, design_reorder_page, design_delete_group (pages move to Ungrouped), design_link_pages / design_unlink_pages (arrows between screens, with an optional label like "Sign in").
- Pass base_version from design_read_layout so a concurrent edit conflicts instead of being overwritten.
- Group names are unique (case-insensitive), at most 40 characters."#;

const PAGES_RULES: &str = r#"# Pages

A page is a BODY FRAGMENT: no <html>/<head>/<body>, no <style> blocks, no raw <header>/<nav>/<footer>/<aside> — register a component (design_write_component) and use it, so every page shares it. Repeat UI once as a component, not five times as markup. Use the ui-* primitives (topic "primitives") for accordions, dialogs, sheets and tabs.
"#;

/// The guide text for `topic`, or the index when `None`.
pub fn text(topic: Option<&str>) -> Result<String, ()> {
    match topic {
        None | Some("") => Ok(INDEX.to_string()),
        Some("tokens") => Ok(TOKENS.to_string()),
        Some("fonts") => Ok(FONTS.to_string()),
        Some("flow") => Ok(FLOW.to_string()),
        Some("pages") => Ok(format!("{PAGES_RULES}\n{PAGES}")),
        Some("primitives") => Ok(format!(
            "# Primitives\n\nBuilt-in components the server expands — use them instead of hand-building these widgets. They are styled with the shadcn tokens.\n\n{}",
            serde_json::to_string_pretty(&crate::primitives::catalog()).unwrap_or_default()
        )),
        Some(_) => Err(()),
    }
}
```

`FONTS` and `PAGES` are `const … : &str` holding the moved sections. In `FONTS`, keep the text but make sure it says the font is the `typography.font-sans` token and the stylesheet goes in `styles/resources.json` via `design_write_asset` (it already does).

- [ ] **Step 4: Handler + context slimming** — in `agent_views.rs` delete `AUTHORING_GUIDE` (:80-150) and add:

```rust
#[derive(Debug, Deserialize)]
pub struct GuideQuery {
    pub topic: Option<String>,
}

/// `GET /api/taskflow/agents/design/guide?topic=` — the design guide on demand.
pub async fn guide(
    RequireAgent(_agent): RequireAgent,
    Query(q): Query<GuideQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let topic = q.topic.as_deref().map(str::trim);
    crate::guide::text(topic)
        .map(|text| Json(json!({ "topic": topic.filter(|t| !t.is_empty()).unwrap_or("index"), "text": text })))
        .map_err(|_| {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": "unknown_topic", "topics": crate::guide::TOPICS })))
        })
}
```

In `context`: compute `let project_doc = crate::tokens::project_tokens_doc(&files); let effective = crate::defaults::effective_tokens(&project_doc);`, set `tokens_css` to `tokens_json_to_css(&effective)`, keep `tokens_json` as the PROJECT doc, and build `defaults`:

```rust
    let defaults: Vec<String> = crate::defaults::missing_defaults(&project_doc)
        .categories
        .iter()
        .flat_map(|(c, t)| t.iter().map(move |(k, _)| crate::tokens::category_to_var_name(c, k)))
        .collect();
```

Response: remove `"primitives"` and `"guide"`; add `"defaults": defaults`; `"note": "Colour, radius and type come from these tokens — write shadcn classes (bg-primary, text-muted-foreground, rounded-lg). Names in `defaults` are built-in shadcn values the project has not overridden. Read design_guide (topic \"tokens\") before your first design write."`.

- [ ] **Step 5: Operator defaults route** — in `views.rs` next to `export_tokens_css`, with the **same extractor and membership check that handler uses**:

```rust
/// `GET /api/design/{project}/tokens/defaults` — the shadcn defaults this
/// project does not override, for the token editor's "default" rows.
pub async fn token_defaults(/* same params as export_tokens_css */) -> Result<Json<serde_json::Value>, StatusCode> {
    // …same member check as export_tokens_css…
    let files = store::list_files(project_id).await;
    let missing = crate::defaults::missing_defaults(&crate::tokens::project_tokens_doc(&files));
    Ok(Json(serde_json::json!({ "missing": missing })))
}
```

Register both routes in `urls.rs`: `.route("/api/taskflow/agents/design/guide", get(agent_views::guide))` after the context route, and `.route("/api/design/{project}/tokens/defaults", get(views::token_defaults))` beside the `tokens.css` export route (copy its exact path style). Add an operator test to `design_guide.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn operator_defaults_list_is_member_only() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let r = app.get_as(user.id, &format!("/api/design/{project}/tokens/defaults")).await;
    assert_eq!(r.status(), 200);
    assert!(r.json()["missing"]["categories"]["colors"]["background"]["light"].is_string());
    let (other, _) = app.create_member_with_project().await;
    assert_eq!(app.get_as(other.id, &format!("/api/design/{project}/tokens/defaults")).await.status(), 403);
}
```

- [ ] **Step 6: Run**

Run: `cd backend && cargo test -p taskflow-design`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(design): design guide route by topic; design_get_tokens drops the 4-5k guide payload (#613)" -- backend/plugins/taskflow-design/src backend/plugins/taskflow-design/tests
```

---

### Task 5: Full backend verification and live render check

**Files:** none new.

- [ ] **Step 1: Workspace suite**

Run: `cd backend && cargo test --workspace 2>&1 | grep -E "^test result|FAILED|panicked"`
Expected: every `test result: ok`, no FAILED.

- [ ] **Step 2: Live render** — run the backend locally (`cd backend && cargo run`), create a page `<main class="p-6 bg-primary text-primary-foreground rounded-lg">Hello</main>` in a fresh local project through the dashboard or the MCP (`design_write_page`), then `design_screenshot` it with theme `light` and `dark`.
Expected: a near-black box with white text (light), a near-white box with dark text (dark), rounded corners. If the box is unstyled, the bridge `<style type="text/tailwindcss">` is not being compiled — check it sits after the Tailwind `<script>` in the composed HTML.

---

### Task 6: Token editor shows defaults

**Files:**
- Create: `v2_fe/src/pages/design/token-defaults.ts`, `v2_fe/src/pages/design/token-defaults.test.ts`
- Modify: `v2_fe/src/lib/design-api.ts` (add `fetchTokenDefaults` after `fetchDesignTokens` ~:336)
- Modify: `v2_fe/src/pages/design/token-editor.tsx` (`CategorySection` :178-256, `TokenEditor` :258-467)

**Interfaces:**
- Consumes: `GET /api/design/{project}/tokens/defaults` → `{ missing: DesignTokensDoc }` (Task 4).
- Produces: `fetchTokenDefaults(projectId: number): Promise<DesignTokensDoc>`; `defaultRows(missing: DesignTokensDoc, doc: DesignTokensDoc, category: string): [string, { light: string; dark?: string }][]`.

- [ ] **Step 1: Failing test** — `token-defaults.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { defaultRows } from "./token-defaults"

const missing = { version: 1, categories: { colors: { primary: { light: "a", dark: "b" }, ring: { light: "c" } } } }

describe("defaultRows", () => {
  it("lists the category's defaults the doc does not define", () => {
    const doc = { version: 1, categories: { colors: { ring: { light: "mine" } } } }
    expect(defaultRows(missing, doc, "colors")).toEqual([["primary", { light: "a", dark: "b" }]])
  })
  it("is empty for a category with no defaults", () => {
    expect(defaultRows(missing, { version: 1, categories: {} }, "spacing")).toEqual([])
  })
})
```

Run: `cd v2_fe && npx vitest run src/pages/design/token-defaults.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `token-defaults.ts`**

```ts
import type { DesignTokensDoc } from "@/lib/design-api"

type TokenValue = { light: string; dark?: string }

/// The built-in shadcn defaults to show (muted, "default") under `category`:
/// the server's `missing` list minus anything the user has since added locally
/// in this unsaved editor session.
export function defaultRows(
  missing: DesignTokensDoc,
  doc: DesignTokensDoc,
  category: string
): [string, TokenValue][] {
  const own = doc.categories[category] ?? {}
  return Object.entries(missing.categories[category] ?? {}).filter(([key]) => own[key] === undefined)
}
```

Export `DesignTokensDoc` from `design-api.ts` if it is not already exported (it is declared `export type` at :95). Add to `design-api.ts`:

```ts
/// The shadcn defaults this project does not override (shown as "default"
/// rows in the token editor). Fails soft to none: the editor still works.
export async function fetchTokenDefaults(projectId: number): Promise<DesignTokensDoc> {
  try {
    const res = await designFetch(`/api/design/${projectId}/tokens/defaults`)
    if (!res.ok) return DEFAULT_TOKENS_DOC
    const body = await readJson<{ missing: DesignTokensDoc }>(res)
    return body.missing
  } catch {
    return DEFAULT_TOKENS_DOC
  }
}
```

`designFetch` and `readJson<T>` are the helpers `fetchDesignFile` (design-api.ts:303) and `:284` already use.

- [ ] **Step 3: Wire the editor** — in `TokenEditor`: `const [defaults, setDefaults] = useState<DesignTokensDoc | null>(null)`; in the load effect that calls `fetchDesignTokens` (:279) also `setDefaults(await fetchTokenDefaults(projectId))`. Add:

```ts
  const overrideDefault = (category: string, key: string, value: { light: string; dark?: string }) =>
    setDoc((prev) =>
      prev ? { ...prev, categories: { ...prev.categories, [category]: { ...(prev.categories[category] ?? {}), [key]: { ...value } } } } : prev
    )
```

Pass `defaults={defaults && doc && !searching ? defaultRows(defaults, doc, category) : []}` and `onOverride={(key, value) => overrideDefault(category, key, value)}` to `CategorySection`. In `CategorySection` add those two props and render, after the `entries.map(…)`:

```tsx
        {defaults.map(([key, value]) => (
          <div key={`default:${key}`} className="flex items-center gap-1.5 opacity-70">
            <span className="min-w-0 flex-1 truncate text-[11px]" title={`${key}: ${value.light}${value.dark ? ` / ${value.dark}` : ""}`}>
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
```

and change the empty-state condition to `!entries.length && !defaults.length`. Override copies the default into the doc; Save persists it like any token.

- [ ] **Step 4: Verify**

Run: `cd v2_fe && npx vitest run && npx tsc -b && npx eslint src/pages/design/token-editor.tsx src/pages/design/token-defaults.ts src/lib/design-api.ts`
Expected: tests green, tsc clean, eslint count for these files not higher than before the change (measure first with the same eslint command on `git stash`-free HEAD copies, or compare against `git show HEAD:<file>` run through eslint).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(design): token editor shows shadcn defaults with an Override action (#613)" -- v2_fe/src/pages/design/token-defaults.ts v2_fe/src/pages/design/token-defaults.test.ts v2_fe/src/pages/design/token-editor.tsx v2_fe/src/lib/design-api.ts
```

---

### Task 7: Rename a group in the pages panel

**Files:**
- Modify: `v2_fe/src/lib/design-layout.ts` (add `renameGroup` after `createGroup` ~:216; adjust `groupNameProblem` use)
- Modify: `v2_fe/src/lib/design-layout.test.ts`
- Modify: `v2_fe/src/pages/design/pages-panel.tsx:500-504` (group header)

**Interfaces:**
- Produces: `renameGroup(doc: LayoutDoc, id: string, name: string): LayoutDoc` — returns `doc` itself when unchanged or invalid; `renameProblem(doc: LayoutDoc, id: string, name: string): string | null`.

- [ ] **Step 1: Failing tests** — append to `design-layout.test.ts`:

```ts
describe("renameGroup", () => {
  const base = withGroups("Auth", "Settings")
  const g1 = base.groups[0].id
  it("renames, trimming", () => {
    expect(renameGroup(base, g1, "  Sign in  ").groups[0].name).toBe("Sign in")
  })
  it("returns the doc itself for the same name (case changes allowed)", () => {
    expect(renameGroup(base, g1, "Auth")).toBe(base)
    expect(renameGroup(base, g1, "auth").groups[0].name).toBe("auth")
  })
  it("refuses a name another group has, blank, or over 40 chars", () => {
    expect(renameGroup(base, g1, "settings")).toBe(base)
    expect(renameGroup(base, g1, "   ")).toBe(base)
    expect(renameGroup(base, g1, "x".repeat(41))).toBe(base)
    expect(renameProblem(base, g1, "settings")).toMatch(/already/)
  })
  it("ignores an unknown id", () => {
    expect(renameGroup(base, "nope", "X")).toBe(base)
  })
  it("is allowed at the group cap (renaming adds nothing)", () => {
    const full = fullLayout()
    expect(renameGroup(full, full.groups[0].id, "Renamed").groups[0].name).toBe("Renamed")
  })
})
```

`withGroups` (:204) and `fullLayout` (:212) are the file's existing builders; add `renameGroup, renameProblem` to its `import { … } from "./design-layout"`.

Run: `cd v2_fe && npx vitest run src/lib/design-layout.test.ts` → FAIL.

- [ ] **Step 2: Implement** in `design-layout.ts`:

```ts
/// Why `name` cannot be `id`'s new name, or null. `groupNameProblem` minus the
/// group itself (so "Auth" → "auth" is a valid rename) and minus the count cap
/// (renaming does not add a group).
export function renameProblem(doc: LayoutDoc, id: string, name: string): string | null {
  const others = { ...doc, groups: doc.groups.filter((g) => g.id !== id) }
  const problem = groupNameProblem(others, name)
  return problem?.startsWith("At most") ? null : problem
}

/// `id` renamed to `name` (trimmed), or the document ITSELF when the name is
/// unchanged, refused by `renameProblem`, or `id` is unknown — so a caller can
/// skip the save by identity, as with `moveGroup`.
export function renameGroup(doc: LayoutDoc, id: string, name: string): LayoutDoc {
  const group = doc.groups.find((g) => g.id === id)
  const trimmed = name.trim()
  if (!group || group.name === trimmed || renameProblem(doc, id, trimmed) !== null) return doc
  return { ...doc, groups: doc.groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)) }
}
```

Run the test → PASS.

- [ ] **Step 3: Panel UI** — in `pages-panel.tsx`, add state `const [renamingGroup, setRenamingGroup] = useState<string | null>(null)` in the component that renders the group list, and replace the header `<h4>` (:502-504) with:

```tsx
          {renamingGroup === section.id ? (
            <GroupNameInput
              name={section.name}
              problem={(value) => renameProblem(layout, section.id, value)}
              onCommit={(value) => {
                const next = renameGroup(layout, section.id, value)
                if (next !== layout) onLayoutChange(next)
                setRenamingGroup(null)
              }}
              onCancel={() => setRenamingGroup(null)}
            />
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded px-1 text-left text-xs font-medium hover:bg-accent"
              title="Rename group"
              onClick={() => setRenamingGroup(section.id)}
            >
              {index + 1}. {section.name}
            </button>
          )}
```

and add, next to `LabelInput`:

```tsx
/// The group rename box: Enter or blur commits, Escape cancels. A refused name
/// shows its reason under the box and is not committed.
function GroupNameInput({
  name,
  problem,
  onCommit,
  onCancel,
}: {
  name: string
  problem: (value: string) => string | null
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(name)
  const reason = draft.trim() === name ? null : problem(draft)
  const commit = () => (reason ? onCancel() : onCommit(draft))
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Input
        autoFocus
        className="h-7 min-w-0 px-1.5"
        aria-label={`Rename group ${name}`}
        value={draft}
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          if (e.key === "Escape") onCancel()
        }}
      />
      {reason ? <span className="px-1 text-[10px] text-destructive">{reason}</span> : null}
    </div>
  )
}
```

Import `renameGroup, renameProblem` from `@/lib/design-layout` alongside the existing imports.

- [ ] **Step 4: Verify** — `cd v2_fe && npx vitest run && npx tsc -b && npx eslint src/pages/design/pages-panel.tsx src/lib/design-layout.ts` (count not higher than before).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(design): rename a group from the pages panel (#613)" -- v2_fe/src/lib/design-layout.ts v2_fe/src/lib/design-layout.test.ts v2_fe/src/pages/design/pages-panel.tsx
```

---

### Task 8: MCP — `design_guide`, instructions paragraph, shadcn descriptions

**Files:**
- Modify: `mcp/src/client.ts` (add `designGuide` after `designContext` ~:572)
- Modify: `mcp/src/server.ts` (register `design_guide` before `design_get_tokens` ~:1052; edit descriptions at :1056, :1072, :1480, :1504, :1599, :1663, :1729, :1753)
- Modify: `mcp/src/instructions.ts` (new section before `## Etiquette`)
- Test: `mcp/src/instructions.test.ts`, `mcp/src/server.test.ts`

**Interfaces:**
- Consumes: `GET /api/taskflow/agents/design/guide?topic=` (Task 4).
- Produces: `TaskflowClient.designGuide(topic?: string): Promise<unknown>`; tool `design_guide`.

- [ ] **Step 1: Failing tests** — in `instructions.test.ts` add:

```ts
  it("points agents at design_guide without carrying the design rules", () => {
    expect(AGENT_INSTRUCTIONS).toContain("design_guide")
    expect(AGENT_INSTRUCTIONS).not.toContain("muted-foreground")
  })
```

In `server.test.ts` (it builds clients with `connectedClient()` and reads `client.listTools()`, e.g. :490-503), add:

```ts
describe("design_guide", () => {
  it("is registered with an optional topic, and page writes teach shadcn classes", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const guide = tools.find((t) => t.name === "design_guide");
    expect(guide).toBeDefined();
    expect((guide?.inputSchema.required ?? []) as string[]).not.toContain("topic");
    const page = tools.find((t) => t.name === "design_write_page");
    expect(page?.description).toContain("bg-primary");
    expect(page?.description).not.toContain("bg-[var(--accent)]");
  });
});
```

Run: `cd mcp && npm test` → those FAIL.

- [ ] **Step 2: Client** — in `client.ts` after `designContext`:

```ts
  /** `GET /agents/design/guide` — the design guide index, or one topic. */
  designGuide(topic?: string): Promise<unknown> {
    return this.request("GET", `${API_PREFIX}/agents/design/guide`, {
      query: topic ? { topic } : {},
      idempotent: true,
    });
  }
```

- [ ] **Step 3: Tool** — in `server.ts`, before `design_get_tokens`:

```ts
  server.tool(
    "design_guide",
    "How to design in this project, on demand. No topic → a short index. Topics: tokens (shadcn colour names, light/dark, radius, the classes to write, what is rejected — read before your first design write), fonts, flow (groups, order, links), primitives (ui-* components), pages (page rules, links, media).",
    {
      topic: z.enum(["tokens", "fonts", "flow", "primitives", "pages"]).optional().describe("Omit for the index."),
      ...profileArg,
    },
    async ({ topic, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        return ok(await picked.client.designGuide(topic));
      } catch (err) {
        return fail(err);
      }
    },
  );
```

- [ ] **Step 4: Descriptions** (exact replacements):
  - `design_get_tokens` (:1056) → `"Read the project's design tokens: \`tokens_json\` (what the project defines), \`tokens_css\` (what renders — a shadcn globals.css: :root, .dark, @theme inline), and \`defaults\` (shadcn names served from built-in values because the project has not set them). Write shadcn classes (bg-primary text-primary-foreground, text-muted-foreground, border-border, rounded-lg); hex/px and Tailwind's raw palette (bg-blue-500) are rejected. Call design_guide (topic \"tokens\") before your first design write. \`resources\` is styles/resources.json (webfonts)."`
  - `design_list_components` (:1072) → replace the sentence starting `Also see the response's \`primitives\` array…` with `Built-in <ui-*> primitives (accordion/dialog/sheet/tabs) are documented in design_guide topic "primitives".`
  - `design_write_page` (:1480): replace `Styling via Tailwind classes on the TOKEN scale only: bg-[#3b82f6] is rejected; bg-[var(--accent)] is not.` with `Style with shadcn classes on the project's tokens (bg-primary text-primary-foreground, bg-card, text-muted-foreground, border-border, rounded-lg); hex/px brackets and Tailwind's raw palette (bg-blue-500) are rejected — see design_guide topic "tokens".` and replace `see design_get_tokens's \`primitives\` field for their names, attrs, and usage examples` with `see design_guide topic "primitives"`.
  - `design_write_component` (:1504): `light DOM, Tailwind + tokens` → `light DOM, shadcn classes on the tokens (bg-card, text-muted-foreground…)`.
  - `design_write_tokens` (:1599): replace the example `{\"colors\":{\"accent\":{\"light\":\"#6366f1\",\"dark\":\"#818cf8\"}}}` with `{\"colors\":{\"primary\":{\"light\":\"oklch(0.55 0.2 250)\",\"dark\":\"oklch(0.7 0.17 250)\"}}}`, and append `Use the shadcn names (primary, muted-foreground…; radius is custom.radius) — design_guide topic "tokens" lists them.`
  - `design_compare` (:1663, :1729): `{"--bg": {"dark": "#0b0b0c"}}` → `{"--background": {"dark": "oklch(0.15 0 0)"}}`; `--bg` in the :1729 sentence → `--background`.

- [ ] **Step 5: Instructions** — in `instructions.ts`, before `## Etiquette`, insert:

```text
## Design
Projects have a Design surface (the \`design_*\` tools): screens built from shadcn
classes on the project's tokens. Before your first design write in a session,
call **design_guide** for the index and read the topics you need (start with
\`tokens\`).
```

- [ ] **Step 6: Verify** — `cd mcp && npm test && npx tsc --noEmit -p .` → all green.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(mcp): design_guide tool; design tool descriptions speak shadcn (#613)" -- mcp/src/client.ts mcp/src/server.ts mcp/src/instructions.ts mcp/src/instructions.test.ts mcp/src/server.test.ts
```

---

### Task 9: Docs, release and deploy

**Files:**
- Modify: `documentation/docs/v2.0.0/about.mdx` (Design surface section), `documentation/docs/v2.0.0/features.mdx` (`#design-surface`), `documentation/docs/v2.0.0/api/index.mdx` (`#design-surface` tool table), `v2_fe/public/llms.txt` (design part)
- Modify: `mcp/package.json`, `mcp/package-lock.json` (version)

- [ ] **Step 1: Docs** — in each file: replace `bg-[var(--accent)]`-style examples with shadcn classes; add one paragraph: "Every project renders with shadcn's semantic tokens (built-in neutral defaults fill any the project has not set). Write `bg-primary text-primary-foreground`, `text-muted-foreground`, `border-border`, `rounded-lg`; hex/px and Tailwind's raw palette are rejected. The served `tokens.css` is a shadcn `globals.css`."; add `design_guide` to the tool tables (in `api/index.mdx` and the about page's loop: put `design_guide` first). Build: `cd documentation && npx vite build` → `✔ done`.

- [ ] **Step 2: Commit docs**

```bash
git commit -m "docs(design): shadcn vocabulary and design_guide (#613)" -- documentation/docs/v2.0.0 v2_fe/public/llms.txt
```

- [ ] **Step 3: MCP version** — `cd mcp && npm version 2.11.0 --no-git-tag-version && npm run build`; commit `-- mcp/package.json mcp/package-lock.json` as `chore(mcp): release 2.11.0`.

- [ ] **Step 4: Frontend build** — `cd v2_fe && npm run build`; confirm `grep -l "Override" dist/assets/*.js`.

- [ ] **Step 5: Deploy in order** (needs dalmas's go-ahead to publish):
  1. Push only the backend commits first: `git push origin <last-backend-commit>:main`, then `gh workflow run deploy-backend.yml --ref main` and wait for `success`.
  2. Verify live: `curl -s -H "Authorization: Agent <key>" "https://api.taskflow.supercodehive.com/api/taskflow/agents/design/guide"` → 200 index (or via the `design_guide` tool once the MCP is updated).
  3. `git push origin main` (fires deploy_frontend + deploy_docs); `git tag mcp-v2.11.0 && git push origin mcp-v2.11.0` (publish_mcp). Wait for all three: `gh run list -L 5`.
  4. `npm view @dalmasonto/taskflow-mcp version` → `2.11.0` (may lag a few minutes).

- [ ] **Step 6: Close out** — log activity on #613 with commit range and what shipped; tell dalmas that agents need `npm i -g @dalmasonto/taskflow-mcp` + an MCP restart for `design_guide`, and that palette-class page writes are now refused.
