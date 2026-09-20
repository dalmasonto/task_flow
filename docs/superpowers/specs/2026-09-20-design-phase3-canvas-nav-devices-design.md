# Design page Phase 3 — top-nav tools, multi-page/multi-device canvas, device emulation

**Date:** 2026-09-20
**Status:** Approved for implementation planning
**Depends on:** Phases 1 & 2 (merged to main). This is the **final** phase — it closes the design-page rework end-to-end.

## Problem

The design canvas's chrome and layout are unfinished: the top nav has no pan/select tools and its zoom control uses text buttons; opening multiple pages produces one flat horizontal strip mixing routes and devices (no per-page rows); and small-device previews show the OS's ~16px desktop scrollbar inside the device frame, so they don't look like real devices.

## Goals (three workstreams)

1. **Top design-nav rework** — real icons + rounded bg buttons for zoom (+ Fit/100%); a **Pan** tool (hand) and a **Select** tool (arrow) as explicit pointer modes; de-emphasize the back button.
2. **Multi-page + per-page multi-device canvas** — group artboards into **rows by page**, each row showing the page across the selected device sizes (columns); a **multi-select page-open** selector; stack additional open pages as new rows.
3. **Realistic device emulation** — adopt a device-frame library (`react-device-frameset`) for bezels **and** fix the composer scrollbar so small-device iframes look native.

## Non-goals

No changes to the tokens pipeline (Phase 2), the chat rail (Phase 1), the backend design model (beyond the composer CSS tweak), or the element-inspector "Pick" flow (kept as-is, distinct from the new Select tool).

## Key decisions (from brainstorming)

1. **Device emulation = library + scrollbar fix.** Use `react-device-frameset` for bezels; also fix the composer scrollbar (root cause below). (User chose "add a device-frame library.")
2. **Multi-page = rows.** Group by route into rows; page-open selector is multi-select.
3. **Pan/Select tools** are new toolbar pointer-mode toggles layered on the existing gesture pan.

## Current-state anchors (from code map)

- Canvas `v2_fe/src/pages/design/design-canvas.tsx`: single transformed world div; pan via Space/middle-drag/trackpad; zoom via Ctrl+scroll or toolbar; `CanvasTransform {x,y,scale}` (`MIN_SCALE=0.25`,`MAX_SCALE=2`,`ZOOM_STEP=1.1`). Each artboard's **iframe is sized to true device px; canvas zoom is a CSS `transform: scale()` on the wrapper only** (breakpoints must stay correct — HARD CONSTRAINT). `DeviceChrome` (line ~323) already draws phone bezels+notch+safe-area vars. `LazyFrame` (line ~359) mounts iframes via IntersectionObserver; theme/picking via postMessage.
- Toolbar `DesignSurfacePage.tsx` `<header>` (line ~341): back button (hardcoded route), `PagePicker` (adds artboard at `deviceIds[0]`), `DevicePicker` (multi-select, drives routes×devices), `ZoomControl` (text ±, duplicated clamp), "Responsive review" (hardcoded 3 devices, route[0] only), theme toggle, "Pick" crosshair. lucide-react icons. **No pan/select tool buttons.**
- Devices `v2_fe/src/lib/design-devices.ts`: 16 `DEVICE_PRESETS` (groups phone/tablet/laptop/breakpoint), `Artboard {key:"route@device",route,deviceId,x,y}`. `artboards` is one flat array; `handleDevicesChange` maintains one artboard per (route×selected device) but with no row/page grouping. Positions are in an in-memory ref (NOT persisted).
- Scrollbar root cause: `composer.rs` (~line 265-280) includes a correct `<meta viewport>` but **no scrollbar CSS**, so overflow shows the desktop scrollbar inside the device frame.

## Architecture

### §A — Top design-nav rework (`DesignSurfacePage.tsx` toolbar + `design-canvas.tsx`)

- **Zoom control:** replace text ± with lucide `ZoomOutIcon`/readout/`ZoomInIcon`, rounded buttons with a subtle bg (`variant`/classes matching the app's icon-button idiom); add a **Fit** (`MaximizeIcon`/`ScanIcon`) button that fits all artboards in view and a **100%** reset. Import `MIN_SCALE`/`MAX_SCALE`/`ZOOM_STEP` from `design-canvas.tsx` (stop duplicating the clamp).
- **Pointer-mode tools:** add a toolbar toggle group — **Select** (`MousePointer2Icon`, default) and **Pan** (`HandIcon`). A `canvasTool: "select" | "pan"` state lifted in `DesignSurfacePage`, passed to `DesignCanvas`.
  - `pan` mode: plain left-drag pans (in addition to the existing Space/middle-drag, which keep working in any mode); cursor `grab`/`grabbing`.
  - `select` mode: current behavior (click/pick, selection overlay). The element-inspector **Pick** crosshair stays a separate toggle (it's element-level picking, orthogonal to canvas pan/select).
- **Back button:** keep but de-emphasize (ghost, icon-only or smaller) — not removed.
- Keyboard: `v` = Select, `h` = Pan (in addition to existing `c` pick, `+`/`-` zoom); Space-drag still pans regardless.

### §B — Multi-page + per-page multi-device rows (`DesignSurfacePage.tsx` + `design-devices.ts`)

- **Row model:** artboards are laid out as **one row per open page (route)**, columns = the selected devices in `deviceIds` order. Introduce a layout function `layoutRows(openRoutes: string[], deviceIds: string[]): Artboard[]` in `design-devices.ts` that assigns each (route,device) an `x` (cumulative device width + gutter within the row) and `y` (cumulative row height + gutter per route). Replace the current append-to-the-right math in `addArtboard`/`handleDevicesChange`/the seed/`responsiveReview` with this row layout, recomputed when open routes or `deviceIds` change.
- **Multi-select page-open:** `PagePicker` becomes a multi-select (checkbox) of `manifest.routes` → an `openRoutes: string[]` state (default: all routes, matching today's seed). Opening/closing a page adds/removes its row. A per-row header shows the page name with a close (remove row) affordance.
- **Devices are the columns:** `DevicePicker` continues to drive `deviceIds`; changing it re-lays-out every row's columns. "Responsive review" sets `deviceIds` to a sensible set (`RESPONSIVE_REVIEW_DEVICES` from design-devices.ts — currently unused; wire it) applied to the currently-open pages (not just route[0]).
- Keep the flat `artboards` array as the render list (derived from `openRoutes × deviceIds` via `layoutRows`), so `DesignCanvas` rendering, selection attribution (`route@device` keys), and postMessage all keep working unchanged.

### §C — Realistic device emulation (`react-device-frameset` + composer scrollbar fix)

- **Scrollbar fix (root cause, do this regardless):** inject scrollbar CSS into the composed sandbox `<head>` in `backend/plugins/taskflow-design/src/composer.rs` — a thin/overlay scrollbar (`::-webkit-scrollbar { width: 6px }` + track/thumb styling, and `scrollbar-width: thin`) so overflow inside a small device looks native, not a 16px desktop widget. Scope it to the sandbox document only (composer output), not the app.
- **Device frames via library:** add `react-device-frameset` (`v2_fe`); wrap the artboard iframe in a device bezel.
  - **Integration constraint (HARD):** the iframe must stay at the preset's TRUE `width×height` (correct breakpoints) and canvas zoom must remain a wrapper `transform: scale()`. `react-device-frameset`'s framesets have fixed screen sizes from a fixed catalog, which will NOT match all 16 custom presets.
  - **Approach:** add a `frameset?: string` (the library device name) + optional `color`/`landscape` to each `DevicePreset`, mapping each preset to the nearest library frame **for the bezel visual only**; render `<DeviceFrameset device={preset.frameset} ...>` as decorative chrome with the existing true-sized sandbox iframe as the screen content, overriding the frameset `.screen` sizing to the preset's real dims where needed. Presets with no good library match (Tailwind breakpoints, desktop, unusual sizes) **fall back to the existing `DeviceChrome`** (kept) or a plain bordered rect.
  - **Fallback / risk:** if `react-device-frameset`'s fixed-size frames cannot cleanly wrap our custom-sized iframes (visual distortion), the implementer evaluates `react-responsive-iframe-viewer` (built for live iframes) OR falls back to enhancing the existing hand-rolled `DeviceChrome` (which already sizes to arbitrary content) — flagged here because it may surface only at implementation time. The scrollbar fix + existing bezels already deliver the core "looks like a device" outcome, so a library that fights the architecture must not be forced.

## Data flow / edge cases

- Tool mode is pure UI state; pan in `pan` mode reuses the existing transform math. Select mode = today's path.
- Row layout is derived state — reordering `deviceIds` or `openRoutes` recomputes positions; existing per-artboard drag-to-reposition (if any) is superseded by the row layout (note: positions weren't persisted anyway).
- A page with zero selected devices can't happen (DevicePicker refuses to empty). A canvas with zero open pages shows the existing empty state.
- Device-frame library must be tree-shaken/CSS-imported once; its CSS must not leak into the app's global styles (scope/import carefully).

## Testing

- **Frontend** `npx tsc -b` + `npm run build` + `npx vitest run`: pure helpers unit-tested (repo has no RTL/jsdom) — `layoutRows` (rows×columns positions), `nextCanvasTool`/tool-keyboard mapping, preset→frameset mapping (+ fallback selection). Manual smoke: pan/select tools, zoom icons + Fit, multi-page rows across devices, small-device scrollbar looks native, device bezels render.
- **Backend** `cargo test --workspace`: a composer test asserting the injected scrollbar CSS is present in composed output (and scoped to the sandbox doc).
- **Build size:** confirm `react-device-frameset` doesn't balloon the bundle unreasonably (note in report).

## Affected files (reference)

Frontend: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (toolbar tools + zoom icons + multi-select PagePicker + row wiring), `v2_fe/src/pages/design/design-canvas.tsx` (canvasTool prop + pan mode + frameset wrapper), `v2_fe/src/lib/design-devices.ts` (`layoutRows`, `frameset` on presets, wire `RESPONSIVE_REVIEW_DEVICES`), `v2_fe/package.json` (+ `react-device-frameset`), a small `canvas-tools.ts`/`design-layout.ts` for the pure helpers + tests.
Backend: `backend/plugins/taskflow-design/src/composer.rs` (scrollbar CSS) + a composer test.
