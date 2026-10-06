# Named design themes (#619) — design spec

Date: 2026-10-06 · Branch: `feat/themes-619` (from main `add2a82`) · Owner: dalmas (away; planner decides within the controller's rulings)

## Goal

A project's design tokens support any number of named themes — `light` (the base), `dark`, and names like `ocean` — instead of the fixed light/dark pair. Humans edit one theme at a time in the Tokens panel, switch the canvas between themes, and agents write, screenshot and compare saved themes. Existing light/dark projects load, render and serialise exactly as before.

Out of scope: per-theme fonts beyond tokens, theme version history, a `base` other than light for a theme.

## Facts verified in code (main `add2a82`)

Backend — `backend/plugins/taskflow-design`:

- `src/tokens.rs:110-116` — `TokenValue { light: String, dark: Option<String> }` (derive serde; `dark` skipped when `None`). `:119-123` — `TokensDoc { version, categories: OrderedMap<OrderedMap<TokenValue>> }`. `OrderedMap` is hand-rolled (`:35-108`, no `indexmap`); it has `iter/is_empty/get_mut/insert/entry_or_insert_with` but no `get`/`remove`.
- `src/tokens.rs:219-249` — `tokens_json_to_css`: `:root {…}`, then `:root[data-theme="dark"], .dark {…}` only when some token has a dark value, then `theme_bridge` (`@theme inline`). `:389-450` — `css_to_tokens_json`: light from `@theme`/`:root`, dark from `extract_selector_block("[data-theme=\"dark\"]")` (requires `{` directly after) and `.dark`; dark-only vars kept from a `HashMap` (unordered).
- `src/tokens.rs:460-509` — `apply_patch`: per token only `light`/`dark` fields (`:478` rejects anything else), `"dark": null` drops dark, a new token needs light. Returns `Result<(), String>`. Callers: `agent_views.rs:830` (write_tokens) and `compare.rs` tests.
- `src/tokens.rs:528-532` — `project_tokens_doc_from`: json row wins, else legacy css import, else default. `:535` `load_project_tokens_doc`.
- `src/defaults.rs:45-56` — shadcn defaults built with `TokenValue { light, dark: Some(..) }`; `:67` `missing_defaults` and `:83` `effective_tokens` match by emitted var name; `effective_tokens` clones the project doc (so it would carry a `themes` field).
- `src/validation.rs:862-921` — `validate_tokens_json`: parse → `invalid-json`; key → `token-key`; value with `http(s)://` → `remote-url` (iterates `[light, dark]` at `:901`). Dispatched for `styles/tokens.json` at `:1079` on every write path (operator `PUT /api/design/{project}/file` and agent `PUT /api/taskflow/agents/design/tokens`).
- `src/manifest.rs:62-78` — `DesignManifest` (`rename_all = "camelCase"`), built at `:175-246` from the EFFECTIVE doc; `:283-306` `token_groups_from_doc` reads `value.dark` into `variables_dark`.
- `src/views.rs:1136-1142` — sandbox `?theme=`: `Some("dark") => "dark", _ => "light"`; the theme becomes `<html data-theme="{theme}">` via `composer::compose_document` (`composer.rs:897`). The canvas switches theme at runtime with `postMessage({type:"design:theme", theme})` (`composer.rs:232`), which already accepts any string.
- `src/screenshots.rs:101-118` — `enum Theme { Light, Dark, Both }` (Copy, serde lowercase), passed to the renderer as `--theme`. `:381` gives `Both` a 40 s budget. Used by `agent_views.rs:1501` (agent screenshot query) and `views.rs:177` (operator screenshot body).
- `backend/renderer/design-render.mjs:52` — `theme = ["dark","both"].includes(args.theme) ? args.theme : "light"` (any other name silently renders light); `:154` sets `?theme=` on the page URL; `:329` `both` = light+dark side by side. `backend/renderer/server.mjs:79` refuses anything but light|dark|both. The renderer ships in the backend payload (`.github/workflows/deploy-backend.yml:180`).
- `src/compare.rs:31-41` — `OverrideValue::{Both(String), PerTheme{light?, dark?}}`; `:129-155` `style_block` puts `Both` in `:root{}` and `:root[data-theme="dark"]{}`; `:193-231` `apply_to` (Both also replaces an existing dark). `:384-394` `validate_spec`: `themes` must be light/dark, max 2; `MAX_CELLS = 24` (`:336`). `:447-485` `grid_html` rows = route × theme with `?theme={theme}` per cell.
- `src/agent_views.rs:57-107` — `context` (what `design_get_tokens` returns): `tokens_css`, `tokens_json`, `tokens`, `defaults`, … no theme list. `:774-904` `write_tokens`. `:1522-1610` `screenshot`. `:1777-1925` `compare` (no declared-theme check; default `["light"]`). `:1931-1950` `compare_apply` diffs against the effective doc.
- `src/guide.rs:14-47` — `TOKENS` topic (a `r#"…"#` string: text must not contain `"#`).
- Tests harness `tests/support/mod.rs`: `TestApp::new`, `create_member_with_project`, `put_json_as`, `get_as`, `get_as_agent`, `put_as_agent`, `post_json_as_agent`, `get_sandbox`, `seed_agent`; `taskflow_design::sandbox::mint`. In tests the renderer is unconfigured, so a valid screenshot/compare answers 503.

Frontend — `v2_fe/src`:

- `lib/design-api.ts:95-98` — `DesignTokensDoc { version, categories: Record<…, {light, dark?}> }`; `:109-122` `DesignManifest` (no themes); `fetchDesignTokens`/`putDesignTokens` read/write the whole doc through `PUT /api/design/{project}/file`; `exportTokensCss` downloads `/api/design/{project}/tokens.css`.
- `pages/design/token-editor.tsx` (497 lines) — two value rows per token (light, dark with "(same as light)" placeholder), "default" rows with Override, search filter (`token-filter.ts`, whose `valueMatches` reads only `light`/`dark` at `:65`). Mounted in the right panel's Tokens tab (`DesignSurfacePage.tsx:1249-1265`), inside `TabsContent` which is the `overflow-y-auto` scroll container (`components/ui/tabs.tsx:42`).
- `DesignSurfacePage.tsx:204` `theme` state (string); `:507` hydrated from `design-ui-state.ts`; `:535` persisted (`DesignUIState.theme: string`, `parseUIState` keeps any string — persistence of a named theme already works). Toolbar toggle `:1063-1071` (sun/moon); `:666` and `:1304` coerce to `"light"|"dark"` for the export. `component-dialog.tsx:37` its own `"light"|"dark"` state and toggle `:96-106`; frames get the theme by `postMessage` (any name works). `design-canvas.tsx:1093` device status bar dark only for `"dark"`.
- `components/ui/select.tsx` is Base UI (needs an `items` value→label map for `SelectValue`); `components/ui/dropdown-menu.tsx` has `DropdownMenuItem variant="destructive"`.
- Lint baseline on this branch: `npx eslint .` → 27 errors, 1 warning.

MCP — `mcp/src`:

- `server.ts:1616-1651` `design_write_tokens`: `patch` schema is `record(record(z.object({light, dark})|null))` — zod object STRIPS unknown keys, so `{"primary":{"ocean":"#0af"}}` would be silently emptied, and a top-level `themes` array is rejected. `:1654-1740` `design_screenshot` `theme: z.enum(["light","dark","both"])`. `:1743-1840` `design_compare` `themes: z.array(z.enum(["light","dark"])).max(2)`; override values `string | {light?, dark?}`. `:1072-1085` `design_get_tokens` returns `designContext`. `client.ts:41-62` types; `designScreenshot` timeout 45 s.

## Decisions

Rulings from the controller (binding), restated:

1. **JSON shape.** `TokenValue` serialises flat: `{"light": "...", "<theme>": "...", ...}`. The legacy `{"light","dark"}` IS the new shape for dark — no data rewrite, no migration (tokens live in a `design_file` row). Internally `light: String` + an ordered map of overrides. `TokensDoc` gains `themes: [{"name","label"?}]` (serde default, omitted when absent). `light` always exists; `dark` is implicitly declared when the doc has no `themes` list, so legacy docs behave exactly as today. Once `themes` is present it is the source of truth for order and declared names.
2. **Inheritance.** Every non-light theme inherits light. Duplicate copies the source's overrides at copy time.
3. **Defaults overlay.** Built-in shadcn defaults provide light + dark only; a custom theme inherits the LIGHT default for a token it does not override. `effective_tokens` keeps its name-matching rule (a project token wins in full).
4. **Emitter.** Dark keeps `:root[data-theme="dark"], .dark {…}` byte-identically; every other theme gets `:root[data-theme="<name>"] {…}` with only its overrides; a theme without overrides emits no block; the bridge is unchanged.
5. **Names.** Slug `^[a-z][a-z0-9-]{0,31}$`; `light` reserved; at most 8 themes including light. Validated in `validate_tokens_json` (rules `theme-name`, `theme-unknown`).
6. **Management** through `design_write_tokens` patch: `themes` = the FULL new ordered list; omitted themes are deleted with their overrides; rename = `{"name":"new","rename_from":"old"}`. No new endpoint. The FE edits the whole doc with pure helpers and saves with its existing PUT.
7. **Sandbox/screenshot/compare.** `?theme=<name>` honoured when declared (else light). `design_screenshot` `"all"` = every declared theme. `design_compare` takes any declared names, capped only by the 24-cell limit. Unknown theme → clear 400 naming the declared list.
8. `design_guide` `tokens` topic gains a short Themes section.
9. No MCP version bump, no deploy; one final docs task.

Further decisions (planner):

10. **`themes` never lists `light`.** It holds the themes besides light; listing `light` is a `theme-name` error with a message showing the right shape. `both` and `all` are also reserved (they are `design_screenshot` values). *Why:* one unambiguous shape; `light` cannot be reordered or renamed anyway. *Cost if wrong:* agents that include light get a clear error and retry; making it lenient later is additive.
11. **Rust `TokenValue` = `{ light: String, themes: OrderedMap<String> }` with hand-written serde.** Serialises `light` first then overrides in order (byte-identical for legacy docs). On read a `null` override is treated as absent (old clients may send `"dark": null`); a missing `light` is an error; any other key becomes an override, and validation (`theme-unknown`) refuses one that is not declared. Helpers: `new/with/get/resolve/set/remove/values`. *Why:* keeps every `value.light` reader working and makes "dark" just another theme. *Cost if wrong:* contained in `tokens.rs`.
12. **The theme list reaches the FE through the manifest.** `DesignManifest.themes: [{name, label, swatch:{primary, background}}]`, light first, swatches resolved from the EFFECTIVE doc (so a custom theme with no background shows the light default). `design_get_tokens` (agent `context`) returns the same list as `themes`. The FE falls back to light+dark when the field is missing (older backend). *Why:* the manifest is already loaded and refreshed on every file event, so the canvas dropdown updates live after a token save with no new endpoint. *Cost if wrong:* one extra field.
13. **Unsaved variant overrides (`?ov=`)** — `OverrideValue::PerTheme` becomes a map theme→value (wire shape `{light?, dark?, <theme>?}` unchanged for old callers). A single (`Both`) value is emitted in `:root{}` AND `:root[data-theme]{}` so it beats any theme block (specificity 0,2,0, later in the document); a per-theme value goes in `:root[data-theme="<name>"]{}`. In `apply_to`/`apply_diff` a single value replaces light and every override the token has. Per-theme override keys must be valid names and (in the agent handlers) declared. *Why:* "variant overrides still apply on top of the selected theme" for every theme, not just dark. *Cost if wrong:* the exact `style_block` string changed (one unit test), nothing stored.
14. **`design_screenshot` `"all"` is handled in the backend.** The agent endpoint validates the theme, then calls the renderer once per declared theme (sequentially, each with its normal budget) and answers `{…, "theme":"all", "warnings":[…prefixed "<theme>: "], "shots":[{theme, image, png_base64}]}`; single-theme replies keep their shape. The MCP client uses a 180 s timeout for `"all"`. The operator `POST /api/design/{project}/screenshots` refuses `"all"` (one PNG per call). *Why:* validation lives in one place and the reply is one call. *Cost if wrong:* a project with 8 themes takes up to ~8 × 20 s worst case; the cap is the theme limit.
15. **Renderer contract:** `--theme` accepts `both` or any theme slug; `prefers-color-scheme: dark` is emulated only for `dark`; `server.mjs` validates the same. **An old renderer renders an unknown name as light silently**, so the renderer must ship with the backend (it does — same deploy payload).
16. **`dark`/`both` when `dark` is not declared** (a project that deleted dark) → 400, not a silent light render.
17. **CSS import ordering:** imported theme blocks are kept in order of appearance with `dark` moved first; a `[data-theme="dark"]` value beats a `.dark` value for the same var (unchanged rule). Generated CSS round-trips.
18. **Device chrome / Tailwind `dark:`**: the canvas device status bar is dark only for `dark`; `dark:` utilities follow `prefers-color-scheme`, which the renderer emulates only for `dark`. Named themes restyle through tokens only. *Cost if wrong:* cosmetic.
19. **Write reply** (`design_write_tokens`) adds `themes` (declared, light first) and, when a theme disappeared (not renamed), `themes_removed` plus a sentence in `note` — the guard against an agent deleting `dark` by sending only the new theme.
20. **`themes` is a reserved top-level patch key**, never a category.
21. **FE edits are local until "Save tokens"** (as today). The CSS variables tab shows the SAVED generated CSS (read-only) and refetches after a save. Theme chip menu: Duplicate (all chips), Rename / Move left / Move right / Delete (non-light). Duplicating `light` creates a theme with no overrides (it already renders identically). Rename keeps an explicit label; labels are optional and default to the title-cased slug.
22. **Switcher modes:** exactly `[light, dark]` → sun/moon toggle; 1 theme → no control; anything else (including `[light, ocean]`) → dropdown with a two-tone swatch (background | primary). The persisted canvas theme is kept as-is in UI state but RESOLVED against the declared list on render (a deleted/renamed theme shows light, and comes back if the theme is restored).

## Design

### Backend data model (`tokens.rs`)

```text
TokensDoc { version: u32, themes: Option<Vec<ThemeDecl>>, categories }
ThemeDecl { name, label: Option<String> }
TokenValue { light: String, themes: OrderedMap<String> }       // flat JSON
TokensDoc::theme_decls()      -> themes or [dark]
TokensDoc::declared_themes()  -> ["light", ...]
TokensDoc::declares(name), theme_label(name), resolve_var(var, theme)
is_theme_name(name), check_theme_list(&[ThemeDecl]), MAX_THEMES = 8, LIGHT, DARK, RESERVED_THEME_NAMES
apply_patch(doc, patch) -> Result<ThemeChanges{removed, renamed}, String>
```

Patch semantics: `themes` (if present) is applied first — validated, renames move values, omitted themes lose their values — then token entries; each token entry's keys must be `light` or a declared theme (after the list change); a string sets, `null` removes that theme's override (`light: null` is an error; null the token to delete it).

### Emitter / parser

`:root{light}` → per declared non-light theme in order, a block with only its overrides (`dark` keeps the `, .dark` selector) → bridge. Undeclared or invalid names never reach the CSS. The parser reads every `[data-theme="<slug>"] … {` block whose selector list contains no `;`/`}` (so `@custom-variant dark (&:where([data-theme="dark"] *));` is ignored), plus `.dark {`; a CSS with only dark yields a legacy doc (`themes: None`).

### Surfaces

- Sandbox page: `?theme=<declared>` → `data-theme` on first paint.
- Manifest/context: `themes` list with swatches.
- Compare: `themes` any declared slugs (dedupe, ≥1), cells ≤ 24; declared check in the handler; variants' per-theme keys declared.
- Screenshot: `Theme { Light, Dark, Both, All, Named(String) }` (string serde); `check_theme`, `theme_shots`.
- Guide: Themes section in `tokens`.

### Frontend

- `lib/design-api.ts`: `DesignTokenValue`, `DesignThemeDecl`, `DesignTokensDoc.themes?`, `DesignThemeInfo`, `DesignManifest.themes?`, `fetchTokensCss`.
- `pages/design/token-themes.ts` (pure, tested): declared list, labels, name validation, add/duplicate/rename/delete/move, per-theme value get/set.
- `pages/design/theme-options.ts` (pure, tested): manifest list with fallback, switcher mode, active-theme resolution, Select items.
- `pages/design/theme-switcher.tsx`: toggle or Base UI Select with swatches; used by the canvas toolbar and the component dialog.
- Token editor: inner tabs **Theme** | **CSS variables**; sticky header (inner tab list + theme strip `Light | Dark | … | +`, chip menus); one value per token for the active theme; non-light empty value shows the light value as placeholder with a reset button; `pages/design/theme-strip.tsx`, `pages/design/token-css-view.tsx`.
- Export dialog / board download take the active theme name.

### MCP

Schemas accept slugs (`theme`, `themes`, per-theme override keys, patch `themes` + per-theme keys via `catchall`); `design_screenshot` returns one image per shot for `"all"`; descriptions name themes and the guide sentence.

## Testing

- Rust: legacy pin (CSS for a light/dark doc + defaults is byte-identical to a fixture captured on the pre-change code; legacy JSON round-trips byte-identically); model serde; emitter per-theme blocks; N-theme parser round-trip and pasted-CSS import; validation rules; per-theme patch, rename, delete, unknown theme, `themes_removed`; manifest/context themes + swatches; sandbox `?theme=`; compare spec + handler; screenshot theme parsing/validation; guide text.
- FE (vitest, `.test.ts` only): `token-themes.test.ts`, `theme-options.test.ts`, `token-filter.test.ts` (value search over any theme), `design-ui-state.test.ts` (named theme persists). `npm run build` and the eslint count (27 errors / 1 warning) after each FE task.
- MCP: end-to-end through the in-memory transport with the FakeClient — per-theme patch keys and `themes` survive zod, `theme:"ocean"`/`"all"`, three compare themes.

## Rollout

1. **Backend + renderer first** (one deploy; the renderer is in the backend payload). Until the renderer is updated, a named theme screenshot would silently render light — they must ship together.
2. **Frontend after the backend.** A new FE against an old backend would save `themes`/override keys that the old serde silently drops. An old FE against the new backend is safe: it spreads existing token values, so `themes` and named overrides survive its saves.
3. **MCP release later** (controller). Old MCP clients keep working: `theme` light/dark/both, compare `themes` light/dark, light/dark patches are all still valid; they simply cannot reach named themes (their zod strips them).
4. No migration; no stored document changes until someone adds a theme.
