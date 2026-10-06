# Design view: device-frame safe areas (#626)

Status: approved by the controller (dalmas delegated decisions). Branch `feat/design-safe-areas` from main `38201bf`.

## Goal

The Design view's device frame stops guessing the status-bar colour. Instead the page draws under the status bar like an app on a real phone:

- On a device-framed board the iframe covers the whole screen from the top.
- The frame injects `--safe-top` and `--safe-bottom` (the device preset's insets) on the page's `<html>`. The page's own top bar pads with `pt-[var(--safe-top)]` and its tab bar with `pb-[calc(0.75rem+var(--safe-bottom))]`, so the page's own colours fill the strip.
- The status-bar icons and the home indicator get their colour from, in order: a page override (`data-status-bar`), a new theme field `appearance`, then the luminance of whatever the page paints at the top.

Frameless boards, screenshots and exports must not change by a single pixel.

## Facts verified in code (main 38201bf)

### How the frame paints today

- `v2_fe/src/pages/design/design-canvas.tsx:1081-1133` `FramedBoard`:
  - `const dark = theme === "dark"` (1093), so **every named theme falls into the light branch**. This is the reported bug.
  - The screen background is `dark ? "#0a0a0a" : "#ffffff"` (1103).
  - The status bar is drawn at the top in frame px, height `m.statusBar` (1108).
  - The page wrapper sits **below** the strip: `top: m.statusBar` (1112), height `framedViewportHeight(device)` (1115).
- `design-canvas.tsx:1138-1147` `StatusBar` picks its ink from the same boolean: `dark ? "#f5f5f5" : "#0a0a0a"`.
- `v2_fe/src/lib/design-frames.ts`:
  - `:45-53` `FRAME_METRICS` gives each frame a `statusBar` strip in frame px (iphone-14-pro 44, iphone-8 20, pixel-6-pro 26, galaxy-s8 20, ipad/macbook/imac 0).
  - `:90-94` `framedViewportHeight = (screenH - statusBar) * scale`.
  - `:126-138` `statusBarHtml(style, width, height, ink)` is the shared static markup.
  - `:103-108` `STATUS_STYLE` gives a style to the four phone frames only.
- `v2_fe/src/lib/design-devices.ts`:
  - `:21-42` presets: iphone-se 375×667, iphone-16-pro ("iPhone 15/16") 393×852, iphone-16-pro-max 440×956, pixel-8 412×915, galaxy-s24 360×780, ipad-mini, ipad-pro-11, ipad-pro-13, laptop, laptop-l, desktop, and `bp-*` breakpoints.
  - `:137-140` landscape variants are appended for phones and tablets. They have **no device frame** (`frameFor` keys are portrait ids only, `design-frames.ts:13-25`).
  - `:211-220` `boardContentOrigin` puts a framed page's origin at `(screenY + statusBar) * scale`, and `design-devices.test.ts:104` pins that.
- `design-canvas.tsx:1154-1206` `ClassicBoard` draws its notch pill inside the bezel padding, above the page, and `OutlineBoard` draws no device. Neither covers the page.
- `v2_fe/src/pages/design/component-dialog.tsx:144-196` `ComponentSandboxFrame` is a plain iframe with no device frame, so it gets no safe area.

### The postMessage protocol

- Frame to chrome:
  - `design:ready` (composer.rs:297, sent from `<head>` before the body parses).
  - `design:size` (126).
  - `design:select`, `design:deselect`.
  - `design:route` (311).
  - `design:missing-route` (nav guard, 689).
  - Capture/font/image messages.
- Chrome to frame:
  - `design:mode` and `design:theme {theme}`. The runtime handler is composer.rs:229-232, and `design:theme` only sets `dataset.theme`.
  - `design:capture`, `design:flash`, `design:font-css`, `design:image-data`.
- Senders:
  - `DesignCanvas` broadcasts mode/theme to every mounted frame (design-canvas.tsx:365-370).
  - `LazyFrame` pushes the same pair when its epoch changes and on any `design:ready` (1253-1270).
  - Frame identity comes from `boardKeyForSource(frameSources(), event.source)` (design-frame-source.ts:30), which compares WindowProxy identity and never reads properties off it.

### The composed document (`backend/plugins/taskflow-design/src/composer.rs`)

- `compose_document` head order (959-993):
  1. `<meta charset>`, viewport meta
  2. scrollbar `<style>`
  3. Tailwind browser CDN
  4. `<style type="text/tailwindcss">` bridge
  5. resources
  6. `tokens.css` link
  7. component scripts
  8. `<script>{PICKER_RUNTIME}</script>`
  9. `<script>{nav_guard}</script>`
  10. state script

  The body carries `bg-[var(--background)]`, so every page has a solid background at the root unless the tokens lack `--background`.
- `compose_export_document` (1059-1101) inlines tokens and components and has **no runtime**. It is what `page.html` downloads.
- The sandbox page (`views.rs:1062`) and the component preview (`views.rs:1171`) both use `compose_document`. The renderer loads the same sandbox URL.

### The renderer and client exports (unchanged by this work)

- `backend/renderer/frames.mjs`:
  - `:23-28` `framedCaptureHeight` duplicates the old `(screenH - statusBar)` rule.
  - `:101-140` `inDeviceFrame` pads the screenshot below a strip and picks ink from the screenshot's top pixel.
- `v2_fe/src/pages/design/export/export-run.ts:230-290` (client export) and `export-plan.ts:87-92` `captureViewport` do the same on the client.
- `frame-data.json` is drift-tested against `FRAME_METRICS`/`STATUS_STYLE` (`lib/renderer-frame-data.test.ts`). This work changes neither table.

### Themes

- `backend/plugins/taskflow-design/src/tokens.rs`:
  - `:161-171` `ThemeDecl {name, label?}` has **no `deny_unknown_fields`**, so stored docs with extra keys already parse.
  - `:286-289` `theme_decls()` returns implicit `[dark]` for legacy docs.
  - `:328-357` `check_theme_list`.
  - `:755-762` `ThemePatchEntry` **is** `deny_unknown_fields`, so today `appearance` in a patch is refused.
  - `:767-838` `apply_theme_list` rebuilds every decl from the entry, which means a label is **not** carried across a patch when omitted.
- `validation.rs:899-909`: `validate_tokens_json` runs `check_theme_list` (rule `theme-name`).
- `manifest.rs:60-91`:
  - `ThemeInfo {name, label, swatch}` is built by `theme_infos(effective)`.
  - `design_get_tokens` reads `/api/taskflow/agents/design/context`, whose `themes` is `manifest::to_json(&m)["themes"]` (agent_views.rs:100).
  - `tests/named_themes.rs:125,130` assert those objects with whole-value equality.
- `v2_fe/src/lib/design-api.ts:98,112-116`: `DesignThemeDecl`, `DesignThemeInfo`.
- `theme-options.ts:11-14` LEGACY light/dark list.
- `token-themes.ts`: pure theme edits.
- `theme-strip.tsx:100-141`: the chip ⋯ menu.

### Validation already allows the page side

`validation.rs:476-520` `find_arbitrary_value` only refuses `[#…`, `[rgb(`, `[rgba(`, `[hsl(` and `[Npx]`. So `pt-[var(--safe-top)]` and `pb-[calc(0.75rem+var(--safe-bottom))]` pass, and `data-status-bar` is an ordinary attribute.

## Decisions (binding rulings)

1. **Scope.** Top and bottom are built together, by one mechanism.
   - Only **device-framed** canvas boards inject (`canvasFrame(device)` non-null).
   - Classic and outline boards, landscape variants (no frame), breakpoints, the component dialog, screenshots/renderer and exports get no injection. Their `--safe-*` stay `0px`, so they are pixel-identical.
   - A test asserts the composed HTML declares no `--safe-*` value but `0px`.
2. **Injection.**
   - Every composed document declares `<style>:root { --safe-top: 0px; --safe-bottom: 0px; }</style>` right after the viewport meta, before Tailwind, the bridge, the tokens and the page.
   - The canvas sends `design:safe-area {top, bottom}`. The runtime clamps each value to an integer 0..200 and sets it as inline style on `<html>` (`style.setProperty`).
   - The canvas sends it on `design:ready` and whenever the device or frame changes. It is idempotent, and `{0,0}` resets it.
3. **Report back.** The runtime posts `design:status-bar {mode, background, padsTop, padsBottom}`:
   - after `load`;
   - on `resize`;
   - after `design:safe-area`;
   - after `design:theme`.
4. **Ink order.**
   1. The page `mode`.
   2. The active theme's `appearance` (`dark` gives light icons, `light` gives dark icons).
   3. The luminance of the reported `background`, then of the theme's `--background` swatch.

   This logic lives in pure, tested `.ts` helpers. When `padsTop` is false the strip is filled with the reported background (else the theme background, else a neutral). The strip overlays a full-height iframe.
5. **Theme `appearance`.**
   - `ThemeDecl.appearance?: "light"|"dark"` is validated in `check_theme_list` and round-trips through `patch.themes`.
   - The manifest and `design_get_tokens` `ThemeInfo.appearance` is resolved: light gives `"light"`, an undeclared `dark` gives `"dark"`, a declared value is used as is, and anything else is `null` (serialised as `null`, not omitted).
   - The FE token panel chip menu offers "Appearance: Light / Dark / Auto".
   - The MCP `design_write_tokens` docs and the `design_guide` tokens topic mention it.
6. **Presets.** Values with sources are in "Preset values" below. Unknown ids give 0/0.
7. **`color-scheme`.**
   - The frame chrome sets `color-scheme` on the iframe element and the device screen from the resolved appearance.
   - The runtime sets `document.documentElement.style.colorScheme` from `design:theme`'s new `appearance` field (`''` when absent, so old chromes and the renderer change nothing).
8. **Release.** No MCP version bump or deploy in this plan. A final docs task covers features.mdx, the API table and llms.txt.

## Further decisions (mine)

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| D1 | The status runtime is a **separate** inline script (`composer::status_bar_script()`) after the nav guard. `PICKER_RUNTIME` is untouched. | Testable like `nav_guard_script`. The picker's long-pinned assertions stay unchanged. A second `message` listener registered later runs after the picker's `dataset.theme` write. | One more listener per page. Negligible. |
| D2 | The runtime **normalises every background to `rgb(r, g, b)` via a 1×1 canvas** (`fillStyle` then `getImageData`). It counts alpha ≥ 128 as solid and walks up otherwise. | Chrome returns computed `oklch(...)` for shadcn oklch tokens, and ruling 3 only allows rgb/rgba strings. The canvas converts any CSS colour and can never emit anything but digits. | A semi-transparent header (alpha < 0.5) reports its parent's colour. That is acceptable for a status bar. |
| D3 | **`padsTop` heuristic.** At `x = innerWidth/2`, take `elementsFromPoint` at `y = 1` and at `y = safeTop + 1`, plus every ancestor. It is true if any element touches the top (`rect.top ≤ 1`) with `paddingTop ≥ safeTop − 1`, **or** is `fixed`/`sticky` with `top ≥ safeTop − 1` and its rect top within 1px of `safeTop`. `padsBottom` mirrors this at the bottom edge. Both are false when the inset is 0. | It catches `pt-[var(--safe-top)]` on a header, a wrapper or body, and `sticky top-[var(--safe-top)]`, with no stylesheet access. Cross-origin CDN sheets are unreadable anyway. | A bar that happens to have padding ≥ the inset (e.g. `py-16` on a 59px device) reads as opted in, so its strip is transparent. That is harmless because the bar's own colour shows. |
| D4 | Reports are coalesced with `setTimeout(0)`, **not rAF**. | Chrome throttles rAF in off-screen cross-origin iframes, and lazy-mounted boards start off-screen. | One extra measure per burst. |
| D5 | **Pro Max = 62/34, not 59/34.** | The `iphone-16-pro-max` preset is 440×956, which is the iPhone 16 Pro Max. Apple's per-model insets (useyourloaf, iPhone 16 sizes) give 16 Pro/Pro Max a top of 62. The ruling asked for well-sourced values, and 62 is the sourced one. | 3px of extra padding. |
| D6 | The strip and home indicator are drawn **in page px inside the 1/k page wrapper**, overlaying the iframe (`z-10`, `pointer-events-none`). The strip height is `safeTop`, not `metrics.statusBar`. | The painted strip and the page's padding are then the same region by construction. Frame px and page px differ by k (1.0–1.13). | The strip on the Pixel/Galaxy frames is taller than the frame's own `statusBar` metric. That is cosmetic. |
| D7 | `framedViewportHeight` becomes `screenH * scale`, and `boardContentOrigin` drops `statusBar`. **`export-plan.captureViewport`, `export-run.inDeviceFrame` and `renderer/frames.mjs` are not touched.** | Ruling 1: screenshots and exports are unchanged. The export comment that claims parity with the canvas gets a one-line note. | Framed exports keep the old "page below the strip" look until a follow-up. |
| D8 | Home indicator: a pill `min(134, 36% width) × 5`, `bottom = round(0.25 × safeBottom)`, in the resolved ink. It is drawn whenever `safeBottom > 0`, iPads included. The indicator uses the **same** ink as the status bar. | It follows the ruling's "same order". A separate bottom-background report would need another field the ruling fixed. | A page with a dark top and a light tab bar gets a light indicator on light. Follow-up: add `bottomBackground`. |
| D9 | `appearance` in a **patch entry** is tri-state: absent keeps the stored value (from `rename_from`'s theme, else the same name), `null` clears it (Auto), and `"light"`/`"dark"` sets it. A bad value is refused by `check_theme_list`. | Ruling: "rename_from keeps it". Clearing needs a spelling, and `null` matches the token-patch `null` idiom. Labels keep today's rebuild behaviour, which this work does not change. | An agent that wants Auto must send `null`, which the docs say. |
| D10 | The FE chip menu's Appearance radio is shown for **non-light** themes only. Light is always `light`. `duplicateTheme` copies the source's *resolved* appearance. | Light's appearance is fixed by definition, and a dark copy should stay dark. | None. |
| D11 | The theme `--background` swatch is painted only through `safeSwatchColor` (the existing allowlist + `CSS.supports`). Luminance parsing accepts hex, rgb/rgba and `oklch(L C H)` (L as a number or %). | Agent-authored token values must not reach a CSS `background` unchecked, and shadcn tokens are oklch. | A theme using `hsl()`/`lab()` for `--background` falls back to the next rule. The runtime-reported rgb usually exists anyway. |
| D12 | **Before any report arrives the strip is filled** (treated as not opted in). It flips to transparent once `padsTop` arrives. | Never show a white gap. Ruling 4 fills when not padding. | A one-frame colour flash on load for opted-in pages. |
| D13 | The status report is held per board in `ArtboardCard` state, filtered by `boardKeyForSource`. It is **not** reset on remount, and the next report (sent on `load`) replaces it. | Resetting would need setState-in-effect or a render-time ref write, which would grow the ESLint count. | Up to one load of a stale colour after a reload. |
| D14 | Android insets are estimates: **pixel-8 40/24, galaxy-s24 32/24**. | The AOSP default status bar is 24dp, and cutout devices size it to the cutout (the AOSP display-cutouts doc's example is 48dp portrait). Android 13+ gesture navigation is 24dp. The ruling's band is 24–40. | A few px of padding difference. Easy to retune in one table. |
| D15 | iPads get 24/20 and the strip fill, but **no icons**. No iPad `StatusBarStyle` exists, and adding one would change `frame-data.json`, so the renderer drift test would force a renderer change, which ruling 1 forbids. | Scope. | iPad strips show colour without a clock. Follow-up. |

**Risk to flag (ruling-driven):** a page that has not yet adopted `pt-[var(--safe-top)]` now draws its first `safeTop` px **under** an opaque strip in the framed canvas (44–62px on iPhones). That is how a native app that ignores safe areas looks, and the project-side padding is the design agent's job. Until it lands, existing designs' headers are partly hidden in device-frame mode only; Classic and Outline modes are unchanged. If this proves too disruptive, the cheap alternative is to offset the iframe by `safeTop` while `padsTop` is false. That is not built here.

## Preset values

| Preset id | Model | Top | Bottom | Source |
|---|---|---|---|---|
| iphone-se | iPhone SE 2/3 | 20 | 0 | Apple HIG layout: home-button iPhones have a 20pt status bar and no home indicator |
| iphone-16-pro ("iPhone 15/16", 393×852) | iPhone 15/16 | 59 | 34 | useyourloaf "iPhone 16 Screen Sizes": iPhone 16/16 Plus portrait top 59, bottom 34 |
| iphone-16-pro-max (440×956) | iPhone 16 Pro Max | 62 | 34 | same source: 16 Pro/Pro Max top 62, bottom 34 (D5) |
| pixel-8 | Pixel 8 | 40 | 24 | AOSP: status bar ≥ 24dp, cutout-sized (display-cutouts doc); gesture nav 24dp on Android 13+ (D14) |
| galaxy-s24 | Galaxy S24 | 32 | 24 | as above, estimate (D14) |
| ipad-mini, ipad-pro-11, ipad-pro-13 | Face ID iPads | 24 | 20 | Apple safe-area insets for home-indicator iPads (24pt status bar, 20pt home indicator) |
| laptop, laptop-l, desktop, bp-*, `*:landscape`, unknown | — | 0 | 0 | No status bar; landscape variants have no device frame |

## Architecture

```
DesignSurfacePage ──appearance, themeBackground──▶ DesignCanvas ──node data──▶ ArtboardCard
                                                     │ design:theme {theme, appearance}
ArtboardCard: safe = boardSafeArea(device)           ▼
   LazyFrame ──design:safe-area {top,bottom}──▶ sandbox page (status_bar_script)
                                               sets --safe-*, colorScheme; measures
   ◀──────────── design:status-bar {mode, background, padsTop, padsBottom}
   frameChrome(report, appearance, themeBackground) → {ink, stripFill, screenBackground, colorScheme}
   FramedBoard draws: full-height page, strip (fill or transparent) + statusBarHtml(ink), home indicator
```

Backend: `ThemeDecl.appearance`, `TokensDoc::theme_appearance`, `ThemeInfo.appearance`, `SAFE_AREA_DEFAULTS`, `status_bar_script()`, and guide lines.

## Testing

- **Rust unit tests:**
  - tokens.rs patch tests: set, keep, rename-carry, null-clear, bad value, resolved values.
  - composer tests: the runtime string pins, and that defaults come before Tailwind and the tokens.
- **Rust integration tests:**
  - `tests/themes_validation.rs`: `appearance` must be light/dark.
  - `tests/named_themes.rs`: manifest and context `appearance`, rename keeps it, 422 on a bad value; the two existing whole-object assertions are updated.
  - `tests/safe_areas.rs` (new): the served sandbox page and `page.html` declare only `0px`; the export has no runtime; a page using the safe-area classes validates.
  - `tests/design_guide.rs`: the tokens topic mentions `pt-[var(--safe-top)]`, `data-status-bar` and `appearance`.
- **vitest (pure `.ts`):**
  - `status-bar.test.ts` (report parsing, luminance incl. oklch, ink order, chrome fill).
  - `design-devices.test.ts` (presets, `boardSafeArea`, origin).
  - `design-frames` viewport, in `design-devices.test.ts`.
  - `theme-options.test.ts`.
  - `token-themes.test.ts`.
  - `design-canvas.test.ts` renders `FramedBoard` with `renderToStaticMarkup`.
- **MCP:** `server.test.ts` checks that the patch passes `appearance` through, that a bad value is an error, and the description.
- **Manual (controller), after `npm run build`:**
  - On iPhone 15/16, switch light → dark → a named theme with `appearance: dark`: the strip matches the top bar and the icons are readable.
  - A `data-status-bar="light"` green hero shows a green strip with white icons.
  - iPhone SE has no bottom shift.
  - On iPhone 16 Pro Max, a `pb-[calc(0.75rem+var(--safe-bottom))]` tab bar clears the indicator.
  - `design_screenshot` (frame none) of a page is byte-identical before and after.

## Rollout

1. Backend tasks (one crate, sequential).
2. FE and MCP tasks in parallel.
3. Canvas wiring.
4. Docs.
5. The controller merges and releases (MCP bump, `npm i -g`, backend deploy, `npm run build` for v2_fe).
6. Then the design agent adopts `pt-[var(--safe-top)]` / `pb-[calc(0.75rem+var(--safe-bottom))]` / `data-status-bar` in the project's components.

No data migration is needed: `appearance` is optional, and old stored docs parse unchanged.
