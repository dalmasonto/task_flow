# UI Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add built-in `<ui-*>` primitives (dialog, sheet, accordion, tabs) that the composer expands server-side into real Tailwind+token HTML, plus an agent-facing catalog and a page HTML copy/download.

**Architecture:** A new `primitives.rs` in the taskflow-design plugin exposes `expand_primitives(&str) -> String`, a quote-aware scanner (same style as `annotate_sources`) that rewrites each `<ui-*>` block into native `<details>`/`<dialog>`/CSS-radio HTML using only `var(--token)` classes. It runs inside `compose_document` after `annotate_sources`, carrying each primitive's `data-src` onto its expanded root. A static primitives catalog is surfaced via the design context; a `page.html` export + frontend button deliver copy/download.

**Tech Stack:** Rust (axum, umbral ORM), TypeScript (React, vitest), Tailwind v4 browser CDN.

**Spec:** `docs/superpowers/specs/2026-09-21-ui-primitives-design.md`

## Global Constraints

- Templates use ONLY `var(--token)` classes (no raw hex/px) — the validator bans arbitrary values.
- Expanded output contains NO `<ui-` substring and requires no JS runtime (native elements / CSS only; `<dialog>` opened via `command`/`commandfor` invokers).
- Light-DOM only; no `attachShadow`.
- No new crate dependency — match the hand-rolled scanning in `composer.rs`.
- `ui-dialog`/`ui-sheet` roots carry `data-state="<name>"` so the existing screenshot `state=dialog:<name>` hook (composer.rs state_script) can open them.
- `v2_fe` must be rebuilt (`npm run build`) — dalmas views the built app.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `primitives.rs` scaffold + `ui-accordion`

**Files:**
- Create: `backend/plugins/taskflow-design/src/primitives.rs`
- Modify: `backend/plugins/taskflow-design/src/lib.rs` (add `pub mod primitives;`)
- Test: inline `#[cfg(test)]` in `primitives.rs`

**Interfaces:**
- Produces: `pub fn expand_primitives(fragment: &str) -> String` — expands all known `<ui-*>` blocks; leaves other markup byte-identical; leaves unknown `<ui-foo>` untouched.
- Internal: `fn get_attr(open_tag: &str, name: &str) -> Option<String>` (quote-aware), `fn esc_attr(&str) -> String` (reuse composer's escaping rules), a `Counter` for unique ids.

Accordion mapping — `<ui-accordion title="T">BODY</ui-accordion>` →
```html
<details class="group border-b border-[var(--border)]"{data_src}>
  <summary class="flex cursor-pointer list-none items-center justify-between py-4 font-medium text-[var(--foreground)] marker:content-['']">T<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="size-4 shrink-0 text-[var(--muted-foreground)] transition-transform group-open:rotate-180"><path d="m6 9 6 6 6-6"/></svg></summary>
  <div class="pb-4 text-[var(--muted-foreground)]">BODY</div>
</details>
```
`title` is attr-escaped; `BODY` is the raw inner content (already page HTML). `{data_src}` = the ` data-src="..."` copied from the source `<ui-accordion>` tag if present, else empty.

- [ ] **Step 1: Failing test**
```rust
#[test]
fn accordion_expands_to_details() {
    let out = expand_primitives(r#"<ui-accordion title="Ship &amp; pay">Free.</ui-accordion>"#);
    assert!(out.contains("<details"), "{out}");
    assert!(out.contains("<summary"));
    assert!(out.contains("Ship &amp; pay"));
    assert!(out.contains(">Free.</div>") || out.contains("Free."));
    assert!(!out.contains("<ui-"), "no primitive tags survive: {out}");
}
#[test]
fn non_primitive_markup_is_untouched() {
    let src = r#"<section class="p-4"><p>hi</p></section>"#;
    assert_eq!(expand_primitives(src), src);
}
#[test]
fn unknown_ui_tag_left_intact() {
    let src = "<ui-nope>x</ui-nope>";
    assert_eq!(expand_primitives(src), src);
}
```
- [ ] **Step 2: Run** `cargo test -p taskflow-design primitives` → FAIL (no `expand_primitives`).
- [ ] **Step 3: Implement** the scanner + accordion arm. Scanner walks bytes for `<ui-`, identifies the tag name, finds the quote-aware end of the open tag, finds the matching `</ui-name>` (primitives do not self-nest, so a first-match close is correct for v1), dispatches by name, copies `data-src` from the open tag onto the root. Unknown names: copy through unchanged.
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Commit** `feat(design): ui-accordion server-side expansion`.

---

### Task 2: `ui-dialog` + `ui-sheet`

**Files:** Modify `backend/plugins/taskflow-design/src/primitives.rs` (+ tests).

**Interfaces:** Consumes Task 1 scanner/helpers. Slots parsed from inner content: `<ui-dialog-title>…</ui-dialog-title>`, `<ui-dialog-body>…</ui-dialog-body>` (reuse `ui-sheet-title`/`ui-sheet-body`). Attrs: `trigger` (button label, default "Open"), `name` (state name; default `dialog-{n}`); sheet adds `side` (`right`|`left`, default `right`).

Dialog mapping →
```html
<button type="button" command="show-modal" commandfor="{id}" class="inline-flex items-center rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)]">{trigger}</button>
<dialog id="{id}" data-state="{name}" class="m-auto w-full max-w-lg rounded-[var(--radius)] border border-[var(--border)] bg-[var(--popover)] p-6 text-[var(--popover-foreground)] shadow-lg backdrop:bg-black/50"{data_src}>
  <h2 class="text-lg font-semibold">{TITLE}</h2>
  <div class="mt-2 text-sm text-[var(--muted-foreground)]">{BODY}</div>
  <form method="dialog" class="mt-6 flex justify-end"><button class="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm font-medium">Close</button></form>
</dialog>
```
Sheet mapping = same, but the `<dialog>` classes become (right):
`fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-full max-w-sm rounded-none border-l border-[var(--border)] bg-[var(--popover)] p-6 text-[var(--popover-foreground)] shadow-lg backdrop:bg-black/50` (left → `left-0 right-auto border-r border-l-0`).

- [ ] **Step 1: Failing test**
```rust
#[test]
fn dialog_expands_with_native_dialog_and_invoker() {
    let out = expand_primitives(r#"<ui-dialog trigger="Delete" name="confirm"><ui-dialog-title>Sure?</ui-dialog-title><ui-dialog-body>No undo.</ui-dialog-body></ui-dialog>"#);
    assert!(out.contains(r#"command="show-modal""#) && out.contains("commandfor="));
    assert!(out.contains("<dialog") && out.contains(r#"data-state="confirm""#));
    assert!(out.contains("Sure?") && out.contains("No undo.") && out.contains(">Delete<"));
    assert!(!out.contains("<ui-"));
}
#[test]
fn sheet_pins_to_side() {
    let out = expand_primitives(r#"<ui-sheet side="left"><ui-sheet-title>Menu</ui-sheet-title><ui-sheet-body>x</ui-sheet-body></ui-sheet>"#);
    assert!(out.contains("<dialog") && out.contains("left-0"));
    assert!(!out.contains("<ui-"));
}
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** both arms + slot extraction. **Step 4: Run** → PASS. **Step 5: Commit** `feat(design): ui-dialog and ui-sheet expansion`.

---

### Task 3: `ui-tabs` (CSS-only)

**Files:** Modify `primitives.rs` (+ tests).

**Interfaces:** `<ui-tabs>` contains N `<ui-tab label="A">PANEL</ui-tab>`. Emits radios + labels + panels, unique group id `{g}` from the counter, first tab `checked`.

Mapping (per tab index K, group g) →
```html
<div class="w-full">
  <!-- one <input> per tab, all first (peer sources) -->
  <input type="radio" name="tabs-{g}" id="{g}-t{K}" class="peer/t{K} sr-only"{checked_if_0}>
  ...
  <div role="tablist" class="flex gap-1 border-b border-[var(--border)]">
    <label for="{g}-t{K}" class="cursor-pointer px-4 py-2 text-sm font-medium text-[var(--muted-foreground)] peer-checked/t{K}:border-b-2 peer-checked/t{K}:border-[var(--primary)] peer-checked/t{K}:text-[var(--foreground)]">{label}</label>
    ...
  </div>
  <div class="py-4">
    <div class="hidden peer-checked/t{K}:block text-[var(--foreground)]">{PANEL}</div>
    ...
  </div>
</div>
```
All radios precede labels and panels so the named-peer variants resolve. `{checked_if_0}` = ` checked` for K==0.

- [ ] **Step 1: Failing test**
```rust
#[test]
fn tabs_expand_css_only() {
    let out = expand_primitives(r#"<ui-tabs><ui-tab label="One">first</ui-tab><ui-tab label="Two">second</ui-tab></ui-tabs>"#);
    assert!(out.matches("type=\"radio\"").count() == 2);
    assert!(out.contains("peer-checked/t0:block") && out.contains("peer-checked/t1:block"));
    assert!(out.contains(" checked")); // first tab
    assert!(out.contains("One") && out.contains("second"));
    assert!(!out.contains("<ui-") && !out.contains("<script"));
}
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(design): ui-tabs css-only expansion`.

---

### Task 4: Wire into `compose_document`

**Files:** Modify `backend/plugins/taskflow-design/src/composer.rs:228` and its tests (`tests/phase1_storage_composer.rs`).

**Interfaces:** Consumes `primitives::expand_primitives`.

Change the body build so expansion runs AFTER annotation (so slot content keeps correct `data-src` line numbers and each primitive block inherits the primitive tag's `data-src`):
```rust
let annotated = annotate_sources(&rewrite_hrefs(fragment, &base), page_path);
let annotated = crate::primitives::expand_primitives(&annotated);
```

- [ ] **Step 1: Failing test** (add to `phase1_storage_composer.rs`): seed a page whose fragment contains `<ui-accordion title="Q">A</ui-accordion>`, GET `/s/{token}/`, assert the served HTML `contains("<details")` and does NOT `contain("<ui-accordion")`.
- [ ] **Step 2: Run** `cargo test -p taskflow-design --test phase1_storage_composer` → FAIL.
- [ ] **Step 3: Implement** the two-line change (+ import).
- [ ] **Step 4: Run** the full crate `cargo test -p taskflow-design` → PASS (existing composer/scrollbar tests still green).
- [ ] **Step 5: Commit** `feat(design): expand ui-* primitives during compose`.

---

### Task 5: Page validation allowlist

**Files:** Modify `backend/plugins/taskflow-design/src/validation.rs` (the page tag check that rejects unregistered/raw tags) + tests.

First locate the page-tag validation (the code producing the "use registered components / no raw header-nav-footer" errors). Add the primitive tags to its known-good set: `ui-dialog, ui-dialog-title, ui-dialog-body, ui-accordion, ui-tabs, ui-tab, ui-sheet, ui-sheet-title, ui-sheet-body`.

- [ ] **Step 1: Failing test**: a page fragment using `<ui-accordion title="x">y</ui-accordion>` validates OK (no rejection); a page using `<ui-tab label="x">y</ui-tab>` OUTSIDE a `<ui-tabs>` (or an unknown `<ui-bogus>`) returns a clear validation error naming the primitive. (Write against the existing page-validation entry point used by other validation tests.)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** allowlist + one teaching error for a stray/unknown `ui-*`. **Step 4: Run** → PASS. **Step 5: Commit** `feat(design): allow ui-* primitive tags in page validation`.

---

### Task 6: Primitives catalog for agents

**Files:** Modify `backend/plugins/taskflow-design/src/primitives.rs` (add `pub fn catalog() -> serde_json::Value`), `src/views.rs` context handler (`agent_views.rs` ~:72-94) to add `"primitives": primitives::catalog()`, and MCP `mcp/src/server.ts` tool descriptions for `design_get_tokens`/`design_list_components`/`design_write_page` to mention the primitives + that their usage is in the `primitives` field.

`catalog()` returns a static array, one entry per primitive:
```json
{ "name": "ui-accordion", "attrs": ["title"], "slots": [],
  "usage": "<ui-accordion title=\"Shipping\">Free over $50.</ui-accordion>" }
```
(+ `ui-dialog` with attrs `trigger`,`name` and slots `ui-dialog-title`,`ui-dialog-body`; `ui-sheet` with `trigger`,`name`,`side` + slots; `ui-tabs` with child `ui-tab` label + example.)

- [ ] **Step 1: Failing test** (Rust): `catalog()` contains an entry whose `name == "ui-dialog"` with a non-empty `usage`. Add/extend a context handler test asserting the response JSON has a `primitives` array with `ui-tabs`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `catalog()` + wire into context; edit the 3 tool descriptions in `server.ts`. **Step 4: Run** `cargo test -p taskflow-design` → PASS; `cd mcp && npm run build` (or tsc) green. **Step 5: Commit** `feat(design): expose ui-* primitives catalog to agents`.

---

### Task 7: `page.html` export endpoint

**Files:** Modify `backend/plugins/taskflow-design/src/urls.rs` (add route near tokens.css at :33), `src/views.rs` (add `export_page_html`, sibling to `export_tokens_css` :794), tests (`tests/tokens_css_generation.rs` or a new `export_html.rs`).

`GET /api/design/{project}/page.html?route=<route>&fragment=<0|1>` — member-gated. `fragment=1` returns just the expanded body markup (`text/html`, inline); default returns the full composed standalone doc with `Content-Disposition: attachment; filename="<safe-route>.html"`. Reuse the manifest+compose path from `serve_sandbox_page`.

- [ ] **Step 1: Failing test**: seed a page with `<ui-accordion title="Q">A</ui-accordion>`; a member GET of `page.html?route=/` returns 200, has the attachment header, contains `<details`, and NOT `<ui-`; a non-member gets 403 (mirror `export_endpoint_rejects_non_member`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** route + handler. **Step 4: Run** → PASS. **Step 5: Commit** `feat(design): page.html export with expanded real-div HTML`.

---

### Task 8: Frontend copy / download

**Files:** Modify `v2_fe/src/lib/design-api.ts` (add `downloadPageHtml(projectId, route)` + `fetchPageHtmlFragment(projectId, route)` mirroring `exportTokensCss` :241), the design canvas/toolbar (`v2_fe/src/pages/design/design-canvas.tsx` — reuse the existing action-button pattern) to add "Copy HTML" (writes `fetchPageHtmlFragment` result via `navigator.clipboard.writeText`) and "Download" (Blob + `<a download>`), and a vitest.

- [ ] **Step 1: Failing test** (vitest): `downloadPageHtml` builds the correct URL `/api/design/{id}/page.html?route=...`; `fetchPageHtmlFragment` requests `fragment=1`. Mock fetch.
- [ ] **Step 2: Run** `npx vitest run design-api` → FAIL. **Step 3: Implement** the two helpers + wire the buttons. **Step 4: Run** vitest → PASS; `npm run build` (`tsc -b && vite build`) green. **Step 5: Commit** `feat(design): Copy HTML / Download page action`.

---

### Task 9: Demo page + end-to-end check

**Files:** none in-repo — write a demo page + confirm catalog via the MCP against the live project (or a test-seeded page if MCP unavailable).

- [ ] **Step 1:** Via MCP `design_write_page` create `/components-demo` using all four primitives; `design_get_tokens` and confirm the `primitives` catalog is present.
- [ ] **Step 2:** GET the `page.html` export for that route; confirm real divs, no `<ui-`.
- [ ] **Step 3:** If `TASKFLOW_DESIGN_BASE_URL` is set, `design_screenshot` the demo (light+dark, laptop+phone) and self-review; else hand off to dalmas for a visual check.
- [ ] **Step 4:** Rebuild `v2_fe` (`npm run build`), mark task #122 done, report on the design channel.

---

## Self-review

- **Spec coverage:** expansion (T1-4) ✓, validation (T5) ✓, agent catalog (T6) ✓, page.html export + copy/download (T7-8) ✓, demo/verify (T9) ✓, screenshot-state compat (T2 `data-state`) ✓, extensibility (dispatch table + catalog) ✓.
- **Placeholders:** none — templates and tests are concrete.
- **Type consistency:** `expand_primitives(&str)->String` used identically in T4; `catalog()->Value` used in T6.
