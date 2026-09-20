# Design page Phase 2 — tabs + component dialog + tokens-as-JSON — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right panel becomes tabs (Inspect/Components/Tokens/Pages); clicking a component opens a preview dialog; design tokens move to a single JSON source of truth that generates the served `tokens.css` and a clean swap-ready export.

**Architecture:** Tokens stored as `styles/tokens.json` (kind `Token`); the served `styles/tokens.css` is generated from it (`@theme` + `:root` + `.dark`) so the sandbox/Tailwind-CDN/validators are untouched. Frontend right panel is a Base UI tab bar over the existing panels; the Tokens tab hosts a structured typed editor; the Components tab opens a Base UI dialog.

**Tech Stack:** Rust (umbral ORM, axum) plugin `taskflow-design`; TypeScript MCP (`mcp/`); React + Vite + `@base-ui/react` + vitest (`v2_fe`).

**Spec:** `docs/superpowers/specs/2026-09-20-design-phase2-tabs-tokens-design.md` (read alongside).

## Global Constraints

- Backend tests: **always** `cargo test --workspace` from `backend/` (bare `cargo test` skips plugin crates). The design code is in `backend/plugins/taskflow-design/`.
- Frontend: finish FE changes with `npx tsc -b` (clean) **and** `npm run build` (succeeds) from `v2_fe/`; the built app is what the user views. Run `npx vitest run` too.
- The repo has **no RTL/jsdom** — component tests use pure exported helpers + vitest, not render tests.
- UI primitives: `@base-ui/react` is available; there is **no** `ui/tabs` or `ui/dialog` — build a minimal Tabs from `@base-ui/react`'s Tabs, and reuse the Base UI `Dialog` pattern already in `v2_fe/src/components/message-attachments.tsx` (`AttachmentPreviewDialog`).
- **Load-bearing invariant:** the generated `tokens.css` MUST preserve the exact `--<var>` custom-property names that pages/components already reference (`bg-[var(--accent)]` etc.), or their `var()` refs break. The migration derives names from the existing CSS.
- Tokens JSON is the source of truth; served `tokens.css` and the export are generated. Agents write JSON or CSS (JSON preferred); CSS is parsed to JSON on write.
- Do NOT touch page/component validation's arbitrary-value bans, the sandbox composer, or the Tailwind-CDN mechanism. No build step, ever.
- Follow existing idiom (`///` doc comments, the `Validation`/`ValidationError` types, umbral ORM patterns).

---

## Task 1: Tokens JSON model + codec (`tokens.rs`)

**Files:**
- Create: `backend/plugins/taskflow-design/src/tokens.rs`
- Modify: `backend/plugins/taskflow-design/src/lib.rs` (add `pub mod tokens;`)
- Test: `backend/plugins/taskflow-design/tests/tokens_codec.rs`

**Interfaces:**
- Produces:
  - `TokensDoc { version: u32, categories: IndexMap<String, IndexMap<String, TokenValue>> }` where `TokenValue { light: String, dark: Option<String> }` (use `serde` derive; preserve insertion order — use `indexmap::IndexMap` if already a dep, else `Vec<(String, ...)>` to keep order and `--var` name stability).
  - `tokens_json_to_css(&TokensDoc) -> String`
  - `css_to_tokens_json(&str) -> TokensDoc`
  - `KNOWN_CATEGORIES: &[&str] = ["colors","spacing","radius","typography","shadows","custom"]`

- [ ] **Step 1: Check ordering-map dependency**

Run: `grep -n "indexmap" backend/plugins/taskflow-design/Cargo.toml backend/Cargo.toml`
If `indexmap` is available, use `IndexMap<String, ...>`. If not, model categories/tokens as ordered `Vec<(String, TokenValue)>` inside a struct (do NOT add a new dependency without noting it). Insertion order matters so generated CSS is stable/diffable.

- [ ] **Step 2: Write the failing codec test**

`backend/plugins/taskflow-design/tests/tokens_codec.rs`:

```rust
use taskflow_design::tokens::{css_to_tokens_json, tokens_json_to_css, TokensDoc};

fn sample_json() -> &'static str {
    r#"{"version":1,"categories":{
        "colors":{"accent":{"light":"#6366f1","dark":"#818cf8"},"bg":{"light":"#ffffff","dark":"#0b0b10"}},
        "radius":{"md":{"light":"8px"}}
    }}"#
}

#[test]
fn json_generates_css_with_root_and_dark_preserving_var_names() {
    let doc: TokensDoc = serde_json::from_str(sample_json()).unwrap();
    let css = tokens_json_to_css(&doc);
    // The exact --var names must appear so page/component var() refs resolve.
    assert!(css.contains("--accent: #6366f1"), "css: {css}");
    assert!(css.contains("--bg: #ffffff"));
    assert!(css.contains("--radius-md: 8px") || css.contains("--md: 8px"));
    // Dark values go under .dark; light under :root.
    let root = css.split(".dark").next().unwrap();
    assert!(root.contains("--accent: #6366f1"));
    let dark = &css[css.find(".dark").expect("dark block")..];
    assert!(dark.contains("--accent: #818cf8"));
    assert!(dark.contains("--bg: #0b0b10"));
    // @theme block present (Tailwind scale container, matches existing contract).
    assert!(css.contains("@theme"));
}

#[test]
fn legacy_css_parses_into_json_round_trip() {
    let css = "@theme {\n  --accent: #6366f1;\n  --radius-md: 8px;\n}\n:root { --spacing-1: 4px; }";
    let doc = css_to_tokens_json(css);
    let regen = tokens_json_to_css(&doc);
    assert!(regen.contains("--accent: #6366f1"));
    assert!(regen.contains("--radius-md: 8px"));
    assert!(regen.contains("--spacing-1: 4px"));
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && cargo test --workspace -p taskflow-design --test tokens_codec`
Expected: FAIL — module/functions don't exist.

- [ ] **Step 4: Implement `tokens.rs`**

Implement `TokensDoc`/`TokenValue` (serde), `tokens_json_to_css`, `css_to_tokens_json`. Rules for the generator:
- Emit, in order: an `@theme { ... }` block (all light values, so Tailwind's scale container is present and the existing `missing-theme`-era contract is honored), then `:root { ... }` (all light values as the runtime vars pages reference), then `.dark { ... }` (only tokens whose `dark` is `Some`).
- **Var-name derivation (preserve names):** the custom-property name for a token is derived by category so it matches existing usage: `colors` → `--<name>` (the fixtures use `--accent`, `--bg` — bare names, NOT `--color-accent`); `radius` → `--radius-<name>`; `spacing` → `--spacing-<name>`; `typography` → `--font-<name>`/`--text-<name>` (font vs text by name prefix); `shadows` → `--shadow-<name>`; `custom` → the key is used **verbatim** as the full `--…` name. (Confirm against `manifest.rs` `parse_token_groups` prefixes — Task 4 must read the SAME convention back. Keep the two in one place if practical: a shared `category_to_var_name`/`var_name_to_category` pair in `tokens.rs`.)
- `css_to_tokens_json`: scan `@theme` and `:root`/`.dark` blocks for `--name: value;` decls (reuse the scan approach from `manifest.rs:221` `parse_token_groups`), bucket each var into a category by reversing the name convention (prefix match; unknown → `custom` with the verbatim `--name`), and merge `.dark` values into the matching token's `dark`.

Wire `pub mod tokens;` into `lib.rs`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && cargo test --workspace -p taskflow-design --test tokens_codec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/plugins/taskflow-design/src/tokens.rs backend/plugins/taskflow-design/src/lib.rs backend/plugins/taskflow-design/tests/tokens_codec.rs backend/plugins/taskflow-design/Cargo.toml
git commit -m "feat(design): tokens JSON model + json<->css codec"
```

---

## Task 2: Validate `styles/tokens.json`

**Files:**
- Modify: `backend/plugins/taskflow-design/src/validation.rs` (`check_extension:171`, add `validate_tokens_json`, dispatch in `validate_write:730`)
- Test: `backend/plugins/taskflow-design/tests/` (add cases to the existing validation test file — find it: `grep -rln "validate_write\|validate_tokens" backend/plugins/taskflow-design/tests/`)

**Interfaces:**
- Consumes: `TokensDoc` (Task 1).
- Produces: `validate_write` accepts `styles/tokens.json` (kind Token) and validates it as JSON; legacy `styles/tokens.css` still validated by `validate_tokens` for reads/back-compat.

- [ ] **Step 1: Write failing tests**

Add (adapt to the real test harness/module found via grep):

```rust
#[test]
fn accepts_valid_tokens_json() {
    let json = r#"{"version":1,"categories":{"colors":{"accent":{"light":"#6366f1","dark":"#818cf8"}}}}"#;
    let v = validation::validate_write("styles/tokens.json", json, &[]);
    assert!(v.ok(), "errors: {:?}", v.errors());
}

#[test]
fn rejects_tokens_json_with_remote_url_value() {
    let json = r#"{"version":1,"categories":{"custom":{"--x":{"light":"url(https://evil.example/x.css)"}}}}"#;
    let v = validation::validate_write("styles/tokens.json", json, &[]);
    assert!(!v.ok());
}

#[test]
fn rejects_malformed_tokens_json() {
    let v = validation::validate_write("styles/tokens.json", "{not json", &[]);
    assert!(!v.ok());
}
```

(Use the same `Validation`/`.ok()`/`.errors()` accessors the existing tokens tests use — check the current test file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && cargo test --workspace -p taskflow-design <test-file>`
Expected: FAIL — `styles/tokens.json` currently rejected by `check_extension` (extension rule).

- [ ] **Step 3: Implement**

In `check_extension` (176), change the Token arm to accept both:
```rust
K::Token => path == "styles/tokens.css" || path == "styles/tokens.json",
```
Add `validate_tokens_json(content: &str) -> Validation`: parse as `TokensDoc` (fail `invalid-json` with a clear message + suggestion on parse error); reject a value containing `http://`/`https://` (rule `remote-url`); optionally check color/size value shapes (hex/oklch/rgb/hsl for colors, `<num>(px|rem|em|%)` for spacing/radius/text) — warnings/fails consistent with the existing rule/message/suggest shape.
In `validate_write` (730 dispatch), branch on path: `styles/tokens.json` → `validate_tokens_json`; `styles/tokens.css` → existing `validate_tokens`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && cargo test --workspace -p taskflow-design`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add backend/plugins/taskflow-design/src/validation.rs backend/plugins/taskflow-design/tests/
git commit -m "feat(design): validate styles/tokens.json"
```

---

## Task 3: Generate served `tokens.css` from JSON + export endpoint

**Files:**
- Modify: `backend/plugins/taskflow-design/src/views.rs` (`serve_file:730`; add export handler)
- Modify: `backend/plugins/taskflow-design/src/urls.rs` (route the export endpoint)
- Test: `backend/plugins/taskflow-design/tests/` (a serve/export test — check how existing tests exercise `serve_file` / chrome endpoints; e.g. `rest`/`phase*` design tests)

**Interfaces:**
- Consumes: `tokens_json_to_css` (Task 1).
- Produces: `GET /s/{token}/f/styles/tokens.css` returns generated CSS when a `styles/tokens.json` row exists; `GET /api/design/{project}/tokens.css` returns the generated CSS with a download header.

- [ ] **Step 1: Write failing test**

Seed a project with a `styles/tokens.json` row (use the design test harness's file-write helper), request the generated tokens.css via the serve path (or the export endpoint), assert the body contains the expected `--var: value` and a `.dark` block, and `Content-Type: text/css`. (Match the real serve URL/token mechanism — see `serve_file` uses a sandbox token; the export endpoint is chrome-facing `/api/design/{project}/tokens.css` and is simpler to assert.) Confirm the export response has `Content-Disposition: attachment`.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — export route 404; serve returns raw json-row content or 404.

- [ ] **Step 3: Implement**

In `serve_file` (744), when `path == "styles/tokens.css"`: try loading the `styles/tokens.json` row first; if present, `serde_json::from_str::<TokensDoc>` → `tokens_json_to_css` → return with `text/css`. If absent, fall back to loading the legacy `styles/tokens.css` row (current behavior). Add `export_tokens_css` handler: load tokens.json (or legacy css), produce the CSS, return with `text/css` + `Content-Disposition: attachment; filename="tokens.css"`. Route it in `urls.rs` under `/api/design/{project}/tokens.css` (chrome-facing, same auth/scope as the other `/api/design/{project}/...` reads).

- [ ] **Step 4: Run to verify it passes** — `cargo test --workspace -p taskflow-design`. PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/plugins/taskflow-design/src/views.rs backend/plugins/taskflow-design/src/urls.rs backend/plugins/taskflow-design/tests/
git commit -m "feat(design): generate tokens.css from JSON + export endpoint"
```

---

## Task 4: Manifest reads tokens.json (light/dark groups)

**Files:**
- Modify: `backend/plugins/taskflow-design/src/manifest.rs` (`TokenGroup:41`, `parse_token_groups:221`, tokens lookup:204)
- Test: `backend/plugins/taskflow-design/tests/` (manifest test — find existing)

**Interfaces:**
- Consumes: `TokensDoc` + name convention (Task 1).
- Produces: `manifest.tokens` reflects the tokens.json (groups carry light + optional dark). Falls back to legacy css parse when no json row.

- [ ] **Step 1: Write failing test** — build a manifest for a project with a `styles/tokens.json` row, assert `manifest.tokens` contains the expected group/variable with light and dark values.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — extend `TokenGroup`/its variable entries to carry `{ name, light, dark }` (keep back-compat for the frontend type — coordinate with Task 6's TS type). Change the tokens lookup (204) to prefer `styles/tokens.json` (parse via `TokensDoc` → groups using the shared name convention), else fall back to `parse_token_groups` on a legacy `styles/tokens.css`.

- [ ] **Step 4: Run to verify it passes** — `cargo test --workspace -p taskflow-design`. PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/plugins/taskflow-design/src/manifest.rs backend/plugins/taskflow-design/tests/
git commit -m "feat(design): manifest reads tokens.json with light/dark"
```

---

## Task 5: Agent write path accepts JSON or CSS + migration + MCP

**Files:**
- Modify: `backend/plugins/taskflow-design/src/agent_views.rs` (`write_tokens` ~215-249, `context` ~48-70)
- Modify: `mcp/src/server.ts` (`design_write_tokens` ~1141, `design_get_tokens` ~1019), `mcp/src/client.ts`
- Test: `backend/plugins/taskflow-design/tests/` (agent token write) + `mcp/src/client.test.ts`

**Interfaces:**
- Consumes: `css_to_tokens_json` / `TokensDoc` (Task 1).
- Produces: `design_write_tokens` accepts `{ tokens?: <json>, css?: string, reason }` (one required), stores `styles/tokens.json`; `design_get_tokens`/`context` return the json map + generated css. Legacy `styles/tokens.css` migrates to json on first write.

- [ ] **Step 1: Write failing tests** — agent write with a JSON `tokens` body stores a `styles/tokens.json` row and `design_get_tokens` returns it; agent write with `css` parses+stores json; a project with a legacy `styles/tokens.css` and no json, after a write, has a json row (migration).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — `write_tokens` input gains optional `tokens` (structured) alongside `css`; require exactly one + `reason` (keep the ≥8-char rule). If `tokens` → serialize to canonical JSON string; if `css` → `css_to_tokens_json` → JSON string. Store at `styles/tokens.json` via the shared `agent_write` (path `styles/tokens.json`). `context` returns both the parsed json and `tokens_json_to_css` output. MCP: `design_write_tokens` schema gains optional `tokens` object (describe JSON preferred, CSS still accepted); `design_get_tokens` returns json + css. `client.ts` forwards `tokens` when present.

- [ ] **Step 4: Run to verify it passes** — `cargo test --workspace -p taskflow-design` + `cd mcp && npm run build && npx vitest run`. PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/plugins/taskflow-design/src/agent_views.rs mcp/src/server.ts mcp/src/client.ts mcp/src/client.test.ts backend/plugins/taskflow-design/tests/
git commit -m "feat(design): agent tokens write accepts JSON or CSS (JSON preferred) + migration"
```

---

## Task 6: Frontend design-api — structured tokens + export

**Files:**
- Modify: `v2_fe/src/lib/design-api.ts`
- Test: `v2_fe/src/lib/design-api.test.ts` (if a pattern exists) OR fold verification into Task 7's helper tests

**Interfaces:**
- Consumes: the tokens.json file + manifest light/dark (Tasks 3–4).
- Produces:
  - `type DesignTokensDoc` (mirrors backend `TokensDoc`: `{ version, categories: Record<string, Record<string, { light: string; dark?: string }>> }`)
  - `fetchDesignTokens(projectId): Promise<{ doc: DesignTokensDoc; version: number }>` (GET the `styles/tokens.json` file; empty/default doc if absent)
  - `putDesignTokens(projectId, doc, baseVersion): Promise<PutResult>` (PUT `styles/tokens.json`, runs the same validator; 409 handling like `putDesignFile`)
  - `exportTokensCss(projectId): triggers download` (GET `/api/design/{project}/tokens.css`)

- [ ] **Step 1** — add the type + functions, reusing the existing `fetchDesignFile`/`putDesignFile` plumbing (they already handle `base_version` + validation-error results). `fetchDesignTokens` reads `styles/tokens.json` and `JSON.parse`s content (default `{version:1,categories:{}}` when the row is missing). `exportTokensCss` opens/downloads the export URL.
- [ ] **Step 2** — `cd v2_fe && npx tsc -b`. Clean (existing callers unaffected).
- [ ] **Step 3: Commit**

```bash
git add v2_fe/src/lib/design-api.ts
git commit -m "feat(design): frontend structured tokens api + export"
```

---

## Task 7: Structured `TokenEditor` (typed, light/dark)

**Files:**
- Create: `v2_fe/src/pages/design/token-editor.tsx` (extract + rework from `DesignSurfacePage.tsx:775-884`)
- Modify: `DesignSurfacePage.tsx` (remove the old inline `TokenEditor`, import the new one)
- Test: `v2_fe/src/pages/design/token-editor.test.ts` (pure helpers only — no RTL)

**Interfaces:**
- Consumes: `DesignTokensDoc`, `fetchDesignTokens`/`putDesignTokens`, `exportTokensCss` (Task 6).
- Produces: `TokenEditor({ projectId, onSaved })` — category-grouped, typed controls (color pickers showing light+dark swatches; numeric+unit fields for spacing/radius/text; text inputs for fonts/shadows; raw key/value for `custom`), editing the JSON doc and PUTting with optimistic `version`; plus an **Export CSS** button. Export a pure helper `parseSizeValue(v): { num: number; unit: string } | null` (and any color-normalize helper) for the numeric controls, and unit-test THAT.

- [ ] **Step 1: Write failing helper test** — real vitest assertions for `parseSizeValue("8px") === {num:8,unit:"px"}`, `parseSizeValue("nonsense") === null`, etc. (executable, not comments).
- [ ] **Step 2: Run to verify it fails** — `cd v2_fe && npx vitest run src/pages/design/token-editor.test.ts`. FAIL.
- [ ] **Step 3: Implement** the editor + helper. Reads `fetchDesignTokens`, renders grouped typed controls, mutates a local doc, `putDesignTokens(projectId, doc, version)` on save (surface validation errors + 409 like the old editor did). Export button calls `exportTokensCss`.
- [ ] **Step 4: Run to verify it passes + tsc + build** — `npx vitest run … && npx tsc -b && npm run build`. PASS/clean.
- [ ] **Step 5: Commit**

```bash
git add v2_fe/src/pages/design/token-editor.tsx v2_fe/src/pages/design/token-editor.test.ts v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): structured light/dark TokenEditor + CSS export"
```

---

## Task 8: Right-panel tabs

**Files:**
- Create: `v2_fe/src/components/ui/tabs.tsx` (thin wrapper over `@base-ui/react` Tabs, matching the `ui/` idiom) — only if no tabs primitive exists (Task confirms via grep first).
- Modify: `DesignSurfacePage.tsx` (right `<aside>` at ~421 — replace the DesignInspector+LeftPanel stack with a tabbed panel; reuse the Pages/Components/Tokens sections from `LeftPanel:672` and `DesignInspector`)
- Test: pure helper for tab selection (`nextDesignTab(selection, current)`) via vitest.

**Interfaces:**
- Consumes: `DesignInspector`, the existing Pages/Components section renderers (extract from `LeftPanel` as needed), the new `TokenEditor` (Task 7).
- Produces: a 4-tab right panel `[ Inspect | Components | Tokens | Pages ]`; active-tab state; auto-switches to **Inspect** when `selection` becomes non-null; default **Pages**.

- [ ] **Step 1** — confirm no tabs primitive: `grep -rn "@base-ui/react\".*[Tt]abs\|components/ui/tabs" v2_fe/src`. Build `ui/tabs.tsx` from `@base-ui/react` Tabs if absent (Tabs.Root/List/Tab/Panel), styled to match existing `ui/` components.
- [ ] **Step 2: Write failing helper test** — `nextDesignTab(prevSelection, currentTab, newSelection)` returns `"inspect"` when a selection newly appears, else keeps `currentTab`; default `"pages"` when no selection and no tab chosen. Real vitest assertions.
- [ ] **Step 3: Implement** — replace the right `<aside>` stack with the tab bar; move the Pages list, Components list (with per-component preview), Tokens (new `TokenEditor`), and Inspect (`DesignInspector`) into panels; wire the auto-focus effect using the helper. Remove the now-unused `leftSection` state if fully replaced (grep for other refs first).
- [ ] **Step 4** — `npx vitest run … && npx tsc -b && npm run build`. PASS/clean. Manual: tabs switch; picking an element on the canvas jumps to Inspect.
- [ ] **Step 5: Commit**

```bash
git add v2_fe/src/components/ui/tabs.tsx v2_fe/src/pages/design/DesignSurfacePage.tsx v2_fe/src/pages/design/*.test.ts
git commit -m "feat(design): right panel becomes Inspect/Components/Tokens/Pages tabs"
```

---

## Task 9: Component click → preview dialog

**Files:**
- Create: `v2_fe/src/pages/design/component-dialog.tsx`
- Modify: `DesignSurfacePage.tsx` (Components tab items open the dialog)
- Test: pure helper if any (else build + manual).

**Interfaces:**
- Consumes: the manifest component entries + the existing per-component sandbox iframe/render (from `LeftPanel`'s component preview, ~component sandbox iframe).
- Produces: clicking a component opens a Base UI `Dialog` (mirror `AttachmentPreviewDialog` in `message-attachments.tsx`) rendering the component large via the sandbox iframe, showing name/usage/attrs + a light/dark + viewport control.

- [ ] **Step 1** — read `message-attachments.tsx`'s `AttachmentPreviewDialog` for the Base UI Dialog portal/zoom pattern; build `ComponentDialog({ component, sandboxToken, open, onClose })` rendering the component sandbox iframe at a usable size.
- [ ] **Step 2: Implement** — Components tab list items get an onClick opening the dialog for that component.
- [ ] **Step 3** — `npx tsc -b && npm run build`. Clean. Manual: click a component → dialog shows it rendered; light/dark toggle works.
- [ ] **Step 4: Commit**

```bash
git add v2_fe/src/pages/design/component-dialog.tsx v2_fe/src/pages/design/DesignSurfacePage.tsx
git commit -m "feat(design): component click opens preview dialog"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §A tabs → Task 8; §B dialog → Task 9; §C tokens-JSON → Tasks 1 (codec), 2 (validation), 3 (serve+export), 4 (manifest), 5 (agent+MCP+migration), 6 (fe api), 7 (editor); §D back-compat → Tasks 3/4/5 fallbacks. All covered.
- **Load-bearing invariant** (preserve `--var` names): Task 1's generator derives names by the same convention Task 4 reads back; both anchored to `manifest.rs:221` prefixes and told to share one `category_to_var_name`/`var_name_to_category` pair — the single most important correctness point, called out in Task 1 Step 4.
- **Ordering:** 1→2,3,4→5 (backend, each builds on the codec); 6→7 (fe tokens); 8 hosts 7's editor and 9's dialog trigger, so 8 before/with 9. Tasks touch mostly disjoint files; `DesignSurfacePage.tsx` is edited by 7/8/9 sequentially (not in parallel).
- **Verify-before-code hooks:** Tasks 2/3/4/5 grep for the real design test harness/helpers before writing tests; Task 8 greps for an existing tabs primitive; Task 1 greps for `indexmap`.
- **No RTL:** Tasks 7/8 test pure exported helpers (parseSizeValue, nextDesignTab), not renders — matches the repo.
