# Design spec: built-in UI primitives via server-side composer expansion

**Date:** 2026-09-21
**Author:** Claude (main) with dalmas
**Task:** #122
**Status:** approved-in-principle (mechanism, scope, set chosen 2026-09-21); pending spec review

## Problem

Agents author sandbox pages with Tailwind + CSS-variable tokens and a small set
of client-side custom-element components (`app-header`, `plan-card`, …). There is
no easy way to add interactive primitives — dialogs, sheets, accordions, tabs —
without hand-writing markup + JS every time. dalmas wants ergonomic primitives:

```html
<ui-accordion title="Shipping">Free over $50.</ui-accordion>
<ui-dialog>
  <ui-dialog-title>Delete project?</ui-dialog-title>
  <ui-dialog-body>This cannot be undone.</ui-dialog-body>
</ui-dialog>
```

Hard requirement: **when the HTML is copied or the page downloaded, the output is
real `<div>`s with Tailwind classes — never `<ui-*>` tags and no framework
runtime.** The result must be portable HTML anyone can paste into their own
project.

## Constraints discovered (see task #121 investigation)

- **No HTML copy/download exists today** — only `GET /api/design/{project}/tokens.css`.
- The sandbox iframe is a **separate origin** (`SANDBOX_ORIGIN`); the app cannot
  read its rendered DOM to serialize it.
- Components today are **client-side** custom elements; the served HTML keeps the
  raw `<tag>` and the browser upgrades it (light DOM). `compose_document`
  (`composer.rs:218`) injects one `<script>` per component and leaves the tag
  verbatim.
- The composer already hand-rolls quote-aware tag scanning (`rewrite_hrefs`,
  `annotate_sources`) with **no HTML-parser dependency** — expansion will match
  that style.
- Component/page validation bans arbitrary Tailwind values (must use
  `var(--token)`), bans raw `<header>/<nav>/<footer>/<aside>` in pages, and tells
  agents "compose from registered tags; do not invent new tags."

## Decision: server-side macros (chosen)

`<ui-*>` are **built-in platform primitives**, NOT user components. A new
expansion pass in the composer rewrites them into real Tailwind+token HTML using
**native elements / CSS for behavior (zero or near-zero JS)**:

- `ui-accordion` → native `<details>/<summary>`.
- `ui-dialog` / `ui-sheet` → native `<dialog>` (sheet = dialog pinned to an edge)
  opened by an invoker button; compatible with the existing screenshot
  `state=dialog:<name>` hook.
- `ui-tabs` → CSS-only radio-input + `:checked`/`peer` pattern (zero JS).

Because expansion is server-side, the **served/composed HTML is already real
divs** — the copy/download requirement is met at the single choke point, and
these primitives add no client JS.

Rejected alternative — *client-side custom elements*: fits the existing model but
the served HTML keeps `<ui-*>` wrappers, and clean export would need a
same-origin serializer + postMessage bridge + unwrap step across the cross-origin
iframe. More moving parts; export never as clean.

## Architecture

### 1. Expansion pass (`composer.rs` + new `primitives.rs`)

- `expand_primitives(fragment: &str) -> String` — a quote-aware scanner (same
  style as `annotate_sources`) that finds each top-level `<ui-*>` block, matches
  its close tag, parses attributes + named slot children (`<ui-dialog-title>`,
  `<ui-dialog-body>`, `<ui-tab>`, `<ui-tab-panel>`), and emits the expanded HTML
  from a fixed per-primitive template. Unknown `ui-*` tags are left untouched and
  flagged by validation (below), not silently dropped.
- **Pipeline order** in `compose_document`: annotate the ORIGINAL fragment for
  source mapping first, then expand, and have each expanded root **inherit the
  primitive's `data-src`** so the picker still lands edits on the `<ui-*>` source
  line. (Exact ordering finalized in the plan; the invariant is: expanded divs
  map back to the primitive's source line, and hrefs inside slots are still
  rewritten.)
- Templates use only `var(--token)` classes (background/foreground/card/popover/
  border/muted-foreground/primary/ring/radius) so output matches shadcn exactly
  and passes the arbitrary-value ban.
- Escaping: attribute values (e.g. `title`) are HTML-escaped via the existing
  `esc`. Slot *content* is passed through (it is already page HTML).
- Unique-id generation for `ui-tabs` (radio `name`/`id` per group) is derived
  deterministically from a per-document counter so re-renders are stable.

### 2. Page validation (`validation.rs`)

- Add `ui-dialog`, `ui-dialog-title`, `ui-dialog-body`, `ui-accordion`,
  `ui-tabs`, `ui-tab`, `ui-tab-panel`, `ui-sheet` to the known-tag allowlist so
  pages using them are not rejected as "invented tags."
- A malformed primitive (e.g. `ui-tab` without a matching `ui-tab-panel`, unknown
  `ui-*`) yields a clear validation **error** message that teaches the correct
  shape — consistent with existing validator UX.

### 3. Agent exposure (`manifest.rs`, `agent_views.rs` context, `mcp/src/server.ts`)

- Add a **`primitives` catalog** to the design context response (the endpoint
  behind `design_get_tokens` / `design_list_components`): a static list of
  `{ name, attrs, slots, usage }` where `usage` is a copy-pasteable example.
  Static (compiled-in), since these are platform built-ins, not DB rows.
- Update the MCP tool descriptions (`design_write_page`, `design_list_components`)
  and the context `note` to mention the primitives and point at the catalog.
- Keep the existing `components` (DB) catalog unchanged; primitives are a
  separate, clearly-labeled section.

### 4. Copy HTML / Download page (`urls.rs`, `views.rs`, `design-api.ts`, design UI)

- New endpoint `GET /api/design/{project}/page.html?route=<route>` returning the
  **composed, expanded** document (real divs) with
  `Content-Disposition: attachment; filename="<route>.html"`. Member-gated like
  the CSS export.
- Also expose the **expanded body fragment** (the divs alone, for pasting) — via
  the same endpoint with a `?fragment=1` flag or a sibling — so "Copy HTML"
  yields portable markup, not a full standalone doc. (Which one "Copy" uses is a
  small UX call finalized in the plan; default: Copy = body fragment, Download =
  full standalone doc.)
- Frontend: a "Copy HTML" + "Download" action in the design canvas/toolbar
  (mirrors the existing "Export CSS" button in `token-editor.tsx`).

## Testing

- **Rust unit tests** (`primitives.rs` / composer tests): each primitive expands
  to the expected real-div HTML; nested slots; attribute escaping; malformed
  input is rejected with the teaching message; unknown `ui-*` left intact;
  `data-src` source-mapping preserved; output contains **no `<ui-`** substring.
- **Validation tests**: a page using each primitive passes; a malformed primitive
  is rejected.
- **Context/manifest test**: the `primitives` catalog appears with usage examples.
- **Export test**: `page.html` downloads with the attachment header and contains
  real divs / no `<ui-` tags (sibling to `export_endpoint_downloads_generated_css`).
- **Frontend**: a vitest for the copy/download API helper; build (`tsc -b`) green.

## Out of scope (this pass)

- Additional primitives (`ui-menu`, `ui-tooltip`, `ui-popover`, …) — the
  expansion table and catalog are built to extend; these come later.
- Open/close animations tuned to shadcn's `tw-animate` (native defaults now;
  v4 transitions can be layered later).
- Full keyboard/ARIA parity for `ui-tabs` beyond what the radio pattern +
  roles provide.

## Rollout / safety

- Additive: existing pages/components are untouched; expansion only fires on
  `ui-*` tags, which no current page uses.
- `v2_fe` rebuild required (dalmas views the built app).
- Land behind the normal test gate; demo page + screenshots for review once
  `TASKFLOW_DESIGN_BASE_URL` is available (else visual check by dalmas).
