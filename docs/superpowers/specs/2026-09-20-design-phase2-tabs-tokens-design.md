# Design page Phase 2 — right-panel tabs, component dialog, tokens-as-JSON

**Date:** 2026-09-20
**Status:** Approved for implementation planning
**Depends on:** Phase 1 (design-chat unification, merged to main) — the design page's left rail is the chat; the right column currently holds an interim stack of Inspector + Pages/Components/Tokens.
**Follows:** Phase 3 (top-nav pan/select/zoom, multi-page/multi-device canvas, device emulation) — OUT OF SCOPE here.

## Problem

The design page's right side is a flat interim stack (Phase 1) and its **tokens** are hand-authored CSS text (`styles/tokens.css`, one `DesignFile` row) edited by fragile regex-on-CSS surgery in the frontend, with no structured schema, no light/dark model, and no export. The user wants: (1) the right panel as navigable **tabs**, (2) clicking a component to **preview it in a dialog**, and (3) tokens reworked so the DB holds a **single JSON** source of truth that generates **proper Tailwind CSS variables** and exports as a **clean, swap-ready CSS** file.

## Goals

1. Right panel = tab bar `[ Inspect | Components | Tokens | Pages ]`.
2. Component list item → dialog rendering the component large.
3. Tokens: single JSON source of truth → generated `styles/tokens.css` (`@theme` + `:root` + `.dark`) → clean export. Light + dark per token. Structured, typed editor. Agents write JSON or CSS.

## Non-goals (Phase 3)

Top design-nav rework (pan/select/zoom tools, real icons, rounded buttons); multi-page-open canvas + per-page multi-device rows; realistic device emulation. The **Pages** tab here only lists/opens routes (single) — multi-select open is Phase 3.

## Key decisions (from brainstorming)

1. **Tokens source of truth = one JSON** at `DesignFile` path `styles/tokens.json` (kind `Token`). The served `styles/tokens.css` is **generated** from it, keeping the sandbox/Tailwind-CDN/validator contract unchanged.
2. **Light + dark per token** — schema holds `{ light, dark? }`; generated/exported CSS emits `:root { light } .dark { dark }`, matching the sandbox theme toggle and the v2_fe app's `:root`/`.dark` pattern.
3. **Standard Tailwind-ish categories**: Colors, Spacing, Radius, Typography (font family + sizes), Shadows, + free-form "custom" bucket.
4. **Agents write either JSON or CSS (JSON preferred)** — `design_write_tokens` auto-detects; CSS is parsed to JSON (reusing the migration parser); storage is always JSON.

## Architecture

```
                         SOURCE (DB)                 GENERATED (on serve/export)
  TokenEditor  ─┐                                   ┌─ /s/{tok}/f/styles/tokens.css  → sandbox (unchanged)
  (structured)  ├──►  styles/tokens.json  ──gen──►  ├─ GET …/tokens.css (download)   → "Export CSS"
  agents (JSON/ ┘     (kind=Token, one row)         └─ manifest.tokens (light/dark groups) → editor UI
   CSS→parsed)
```

### §A — Right-panel tabs

- Replace the interim right-column stack in `v2_fe/src/pages/design/DesignSurfacePage.tsx` with a tab bar using the repo's existing tabs primitive (locate it — likely a Base UI / shadcn `Tabs` under `v2_fe/src/components/ui/`; if none exists, add a minimal one following the existing `ui/` component idiom).
- Tabs: **Inspect** (`DesignInspector`), **Components** (component list + per-component sandbox preview, from the old `LeftPanel`), **Tokens** (new editor §C), **Pages** (route list, opens an artboard on click — today's `PagePicker` behavior).
- Active-tab state; **auto-switch to Inspect** when `selection` becomes non-null (element picked on canvas). Default tab = **Pages** when no selection.
- The Phase-1 interim `LeftPanel` mount in the right column is removed; its Pages/Components/Tokens sections move into their tabs.

### §B — Component click → dialog

- In the Components tab, clicking a component opens a Base UI `Dialog` (same primitive family as `AttachmentPreviewDialog`) rendering that component large through the existing component sandbox iframe, showing name, usage count, attrs, and a light/dark + viewport control. Reuse the existing component render/sandbox path; no new render engine.

### §C — Tokens as JSON

**JSON schema** (stored at `styles/tokens.json`):
```json
{
  "version": 1,
  "categories": {
    "colors":     { "bg": { "light": "#ffffff", "dark": "#0b0b10" }, "accent": { "light": "#6366f1", "dark": "#818cf8" } },
    "spacing":    { "1": { "light": "4px" }, "2": { "light": "8px" } },
    "radius":     { "md": { "light": "8px" } },
    "typography": { "font-sans": { "light": "Inter, sans-serif" }, "text-base": { "light": "16px" } },
    "shadows":    { "card": { "light": "0 1px 2px rgba(0,0,0,.1)" } },
    "custom":     { "--whatever": { "light": "..." } }
  }
}
```
- Each token → a CSS custom property name (colors → `--<name>` or `--color-<name>` per the existing convention seen in fixtures — keep the exact `--` names the manifest/pages already reference; the generator MUST preserve them). `dark` optional (non-color tokens usually omit it).

**Backend (`backend/plugins/taskflow-design/`):**
- **`models.rs`**: no new table. Tokens stored in the existing `design_file` row, path `styles/tokens.json`, kind `Token`.
- **`validation.rs`**: `check_extension` accepts `styles/tokens.json` for kind `Token` (in addition to reading a legacy `styles/tokens.css`). Replace the "@theme present" check with **JSON-schema validation** of tokens.json (well-formed JSON; known category keys; each value a `{light, dark?}` of strings; color values match hex/oklch/rgb/hsl; size values match `<num>(px|rem|em|%)`; no remote URLs in any value). Page/component arbitrary-value bans are **unchanged**.
- **New module `tokens.rs`** (json ↔ css): `tokens_json_to_css(&TokensDoc) -> String` producing `@theme { <static scale> } :root { <light> } .dark { <dark> }`; and `css_to_tokens_json(&str) -> TokensDoc` (reuses today's `@theme`/`:root` parse from `manifest.rs`) for the CSS-input + migration paths.
- **`views.rs` `serve_file`**: when the requested path is `styles/tokens.css`, load the `styles/tokens.json` row and return `tokens_json_to_css(...)` with `Content-Type: text/css` (unchanged headers). If only a legacy `styles/tokens.css` row exists (pre-migration), serve it as-is.
- **New export endpoint** `GET /api/design/{project}/tokens.css` (chrome-facing) returning the generated CSS with `Content-Disposition: attachment; filename="tokens.css"`.
- **`manifest.rs` `parse_token_groups`**: read `styles/tokens.json` → `TokenGroup[]` carrying light/dark. Fall back to parsing a legacy `styles/tokens.css` when no json row exists.
- **`agent_views.rs`**: `write_tokens` accepts `{ project, tokens?: <json>, css?: string, reason }` — JSON preferred; if only `css`, parse via `css_to_tokens_json`; store the JSON at `styles/tokens.json`. `context`/`design_get_tokens` returns the JSON token map **and** the generated `tokens_css`.
- **Migration**: a helper that, on first read/write for a project with a legacy `styles/tokens.css` and no `styles/tokens.json`, converts and writes the json row. Low-stakes (no seed data ships).

**Frontend (`v2_fe/`):**
- **`design-api.ts`**: fetch/put the structured tokens (new `fetchDesignTokens`/`putDesignTokens` hitting the json file, or extend manifest.tokens to carry light/dark); an `exportTokensCss(projectId)` for the download.
- **`TokenEditor`** (in `DesignSurfacePage.tsx`, or extracted to its own file — extract, since it grows): category-grouped, typed controls (color pickers showing light+dark swatches; numeric+unit fields for spacing/radius/text; text inputs for fonts/shadows; raw key/value for custom). Edits mutate the JSON and `putDesignTokens` with optimistic `version`; no regex-on-CSS.
- **Export CSS** button in the Tokens tab → downloads the generated CSS.

**MCP (`mcp/src/server.ts`, `client.ts`):**
- `design_write_tokens` schema gains an optional structured `tokens` (JSON) alongside `css` (one required); description explains JSON is preferred, CSS still accepted (parsed). `design_get_tokens` returns the json map + generated css.

### §D — Backward compatibility

Sandbox render, Tailwind CDN, `/s/{token}/f/styles/tokens.css`, and page/component validation are unchanged because the served CSS still exists (generated). Legacy `tokens.css` projects migrate on first touch. Agents that still send CSS keep working (parsed to JSON).

## Data flow (token edit round-trip)

1. Editor loads tokens.json → typed controls (light/dark).
2. User edits a color's dark value → structured `putDesignTokens` (json) with `version`.
3. Server validates the JSON, stores the `styles/tokens.json` row (version++).
4. Sandbox iframe reloads `styles/tokens.css` → server generates it fresh from the json → the artboard reflects the new dark value under `.dark`.
5. "Export CSS" downloads the same generated `:root`+`.dark` CSS for use elsewhere.

## Error handling / edge cases

- **Malformed tokens.json**: validation rejects with a clear rule (like today's rule/message/suggestion shape); the editor never PUTs invalid JSON (client validates first).
- **Legacy css present, json absent**: serve/parse the css; migrate on first write.
- **Optimistic conflict (409)**: the editor surfaces it as today (reload + retry).
- **Agent sends unparseable CSS**: 422 with a rule explaining JSON is preferred.
- **Missing dark value**: generated `.dark` simply omits that var (inherits `:root`).
- **Preserve `--var` names**: the generator MUST keep the exact custom-property names pages/components already reference, or their `var(--x)` breaks. Migration derives names from the existing css.

## Testing

- **Backend `cargo test --workspace`** (never bare `cargo test`): tokens.json schema validation (accept/reject cases); `tokens_json_to_css` emits `@theme`+`:root`+`.dark` with correct names/values; `serve_file` for `styles/tokens.css` returns generated CSS; export endpoint returns CSS + attachment header; `parse_token_groups` reads json (light/dark); `css_to_tokens_json` round-trips a legacy fixture; migration converts legacy css → json.
- **MCP**: `design_write_tokens` with json stores json; with css parses+stores json; `design_get_tokens` returns both.
- **Frontend** `npx tsc -b` + `npm run build` + `npx vitest run`: editor↔json mapping, any client-side css generation/format helpers, tab switching + auto-focus-on-select logic (pure helpers where the component can't be rendered — repo has no RTL/jsdom), component-dialog open state.

## Affected files (reference)

Backend: `plugins/taskflow-design/src/{models.rs (path const), validation.rs, manifest.rs, agent_views.rs, views.rs, tokens.rs (new), store.rs}`; a migration if the schema needs it (likely none — same table/columns).
Frontend: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (tabs + wiring), a new `TokenEditor` file, a component-dialog component, `v2_fe/src/lib/design-api.ts`, possibly `v2_fe/src/components/ui/tabs.*` (if absent).
MCP: `mcp/src/server.ts`, `mcp/src/client.ts` (+ `client.test.ts`).
