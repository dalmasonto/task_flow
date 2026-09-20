# Design page Phase 3 — top-nav tools, multi-page/multi-device canvas, device emulation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the design canvas end-to-end: pan/select/zoom toolbar tools with real icons; artboards grouped into per-page rows across selected devices (multi-select page open); realistic device emulation via `react-device-frameset` bezels + a composer scrollbar fix.

**Architecture:** Canvas stays a single CSS-transformed world; iframes stay at TRUE preset px (breakpoints must not change — zoom is wrapper `transform: scale()` only). New pure helpers (`layoutRows`, `nextCanvasTool`, `fitTransform`, `presetToFrameset`) hold the logic and are unit-tested; components wire them. Device bezels come from a library with a fallback to the existing `DeviceChrome`.

**Tech Stack:** React + Vite + `@base-ui/react` + `react-device-frameset` + vitest (`v2_fe`); Rust (`taskflow-design` composer).

**Spec:** `docs/superpowers/specs/2026-09-20-design-phase3-canvas-nav-devices-design.md` (read alongside).

## Global Constraints

- Frontend: finish with `npx tsc -b` (clean) + `npm run build` (succeeds) + `npx vitest run` from `v2_fe/`.
- Backend: `cargo test --workspace` from `backend/` (bare `cargo test` skips plugins).
- **HARD:** the artboard iframe must stay sized to the preset's true `width×height`; canvas zoom stays a wrapper `transform: scale()`. Do not scale the iframe itself (breakpoints depend on it).
- Repo has **no RTL/jsdom** — test pure exported helpers, not component renders.
- Do NOT touch the tokens pipeline (Phase 2), the chat rail (Phase 1), or the element-inspector "Pick" flow (it stays a separate toggle from the new Select tool).
- lucide-react is the icon set. Existing constants: `MIN_SCALE=0.25`, `MAX_SCALE=2`, `ZOOM_STEP=1.1` in `design-canvas.tsx` (export/import them; stop duplicating the clamp in the toolbar).
- Follow existing idiom; keep diffs scoped.

---

## Task 1: Composer scrollbar CSS (realistic small-device scroll)

**Files:**
- Modify: `backend/plugins/taskflow-design/src/composer.rs` (the composed `<head>`, ~line 265-280)
- Test: the composer test file (find: `grep -rln "compose_document\|<head>\|viewport" backend/plugins/taskflow-design/tests/ backend/plugins/taskflow-design/src/composer.rs`)

**Interfaces:** Produces: composed sandbox HTML whose `<head>` carries thin/overlay scrollbar CSS, scoped to the sandbox document.

- [ ] **Step 1: Write the failing test** — assert the composed output (from `compose_document`/the composer entry the tests already use) contains the scrollbar rule (e.g. `::-webkit-scrollbar` and `scrollbar-width`). Reuse the existing composer test harness/helper (grep first).
- [ ] **Step 2: Run to verify it fails** — `cd backend && cargo test --workspace -p taskflow-design <composer test>`. FAIL.
- [ ] **Step 3: Implement** — in `composer.rs`, inject into the composed `<head>` (near the existing `<meta viewport>` / style block) a `<style>` with:
  ```css
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(0,0,0,.25); border-radius: 3px; }
  html { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,.25) transparent; }
  ```
  Only in the composed sandbox document (not the app). Keep it minimal and self-contained.
- [ ] **Step 4: Run to verify it passes** — `cargo test --workspace -p taskflow-design`. PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add backend/plugins/taskflow-design/src/composer.rs backend/plugins/taskflow-design/tests/
  git commit -m "feat(design): thin/overlay scrollbar in composed sandbox (native small-device scroll)"
  ```

---

## Task 2: Zoom control — real icons, Fit, 100%, shared clamp

**Files:**
- Modify: `v2_fe/src/pages/design/design-canvas.tsx` (export `MIN_SCALE`/`MAX_SCALE` if not already; they exist as consts)
- Modify: `v2_fe/src/pages/design/DesignSurfacePage.tsx` (`ZoomControl` 677-705; toolbar usage ~358)
- Create: `v2_fe/src/pages/design/canvas-view.ts` (pure `fitTransform`) + `v2_fe/src/pages/design/canvas-view.test.ts`

**Interfaces:**
- Produces: `fitTransform(boards: {x:number;y:number;deviceId:string}[], viewport: {w:number;h:number}, opts?): CanvasTransform` — computes an `{x,y,scale}` that fits all boards' bounding box in the viewport (clamped to MIN/MAX_SCALE); `ZoomControl` gains Fit + 100% buttons and lucide icons.

- [ ] **Step 1: Write the failing test** for `fitTransform`: given two boards forming a known bounding box and a viewport, returns a scale that fits (≤ MAX, ≥ MIN) and centers (assert scale value + that both boards fall within viewport after transform). Real assertions.
- [ ] **Step 2: Run to verify it fails** — `cd v2_fe && npx vitest run src/pages/design/canvas-view.test.ts`. FAIL.
- [ ] **Step 3: Implement** — `fitTransform` (pure; uses `deviceById` for board w/h + `MIN_SCALE`/`MAX_SCALE`/a gutter). Export `MIN_SCALE`/`MAX_SCALE` from design-canvas.tsx. Rewrite `ZoomControl` to: `ZoomOutIcon` / `%` readout / `ZoomInIcon` (rounded buttons w/ subtle bg matching the app's icon-button idiom), plus a **Fit** button (`ScanIcon`/`MaximizeIcon`) calling `onChange(fitTransform(...))` and a **100%** reset (`onChange({...transform, scale:1})`). Use imported `MIN_SCALE`/`MAX_SCALE` (drop the `0.25`/`2` literals). Pass the boards + viewport needed by Fit from `DesignSurfacePage`.
- [ ] **Step 4: Verify** — `npx vitest run … && npx tsc -b && npm run build`. PASS/clean.
- [ ] **Step 5: Commit**
  ```bash
  git add v2_fe/src/pages/design/design-canvas.tsx v2_fe/src/pages/design/DesignSurfacePage.tsx v2_fe/src/pages/design/canvas-view.ts v2_fe/src/pages/design/canvas-view.test.ts
  git commit -m "feat(design): zoom control real icons + Fit/100%, shared scale clamp"
  ```

---

## Task 3: Pan / Select pointer-mode tools

**Files:**
- Create: `v2_fe/src/pages/design/canvas-tools.ts` (pure `nextCanvasTool`/`toolForKey`) + `.test.ts`
- Modify: `DesignSurfacePage.tsx` (toolbar toggle group + `canvasTool` state + keyboard `v`/`h`), `design-canvas.tsx` (accept `canvasTool` prop; pan on plain drag in pan mode)

**Interfaces:**
- Consumes: nothing new.
- Produces: `type CanvasTool = "select" | "pan"`; `toolForKey(key: string): CanvasTool | null` (`v`→select, `h`→pan); `DesignCanvas` gains `canvasTool` prop; in `pan` mode a plain left-drag pans.

- [ ] **Step 1: Write the failing test** — `toolForKey("v")==="select"`, `toolForKey("h")==="pan"`, `toolForKey("x")===null`. Real assertions.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/pages/design/canvas-tools.test.ts`. FAIL.
- [ ] **Step 3: Implement**
  - `canvas-tools.ts` helper.
  - `DesignSurfacePage`: `const [canvasTool, setCanvasTool] = useState<CanvasTool>("select")`; a toolbar toggle group (two `Button`s: `MousePointer2Icon` Select, `HandIcon` Pan; active = `variant="default"`); keyboard effect maps `v`/`h` via `toolForKey` (guard against typing in inputs, matching the existing `c` shortcut's guards); pass `canvasTool` to `DesignCanvas`.
  - `design-canvas.tsx`: accept `canvasTool` prop; in `onPointerDown` (line 106-112) change the guard to also start panning on a plain primary-button drag when `canvasTool === "pan"`: `if (!(spaceDown || e.button === 1 || (canvasTool === "pan" && e.button === 0))) return`. Set cursor `grab`/`grabbing` when in pan mode (extend the existing space-cursor logic ~line 185). Space/middle-drag still pan in any mode.
- [ ] **Step 4: Verify** — `npx vitest run … && npx tsc -b && npm run build`. Manual: Pan tool → drag pans; Select tool → click selects; Space-drag still pans in both.
- [ ] **Step 5: Commit**
  ```bash
  git add v2_fe/src/pages/design/canvas-tools.ts v2_fe/src/pages/design/canvas-tools.test.ts v2_fe/src/pages/design/DesignSurfacePage.tsx v2_fe/src/pages/design/design-canvas.tsx
  git commit -m "feat(design): pan/select canvas tools with keyboard shortcuts"
  ```

---

## Task 4: Multi-page rows + multi-select page open

**Files:**
- Modify: `v2_fe/src/lib/design-devices.ts` (`layoutRows`; wire `RESPONSIVE_REVIEW_DEVICES`) + `v2_fe/src/lib/design-devices.test.ts`
- Modify: `DesignSurfacePage.tsx` (`openRoutes` state; `PagePicker` → multi-select; replace append-math with `layoutRows`; per-row header; `handleDevicesChange`/`responsiveReview`/seed rework)

**Interfaces:**
- Produces: `layoutRows(openRoutes: string[], deviceIds: string[], gutter?: number): Artboard[]` — one row per route (y stacked by cumulative row height + gutter), columns per device (x by cumulative device width + gutter), key `route@device`. Deterministic, order-stable.

- [ ] **Step 1: Write the failing test** — `layoutRows(["/","/about"], ["iphone-16-pro","laptop"])` returns 4 artboards; assert: row 0 (`/`) both have `y===0`; the laptop column `x` = iphone width + gutter; row 1 (`/about`) `y` = row-0 height (max of the row's device heights) + gutter; keys are `"/@iphone-16-pro"` etc. Real assertions using `deviceById`.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/design-devices.test.ts`. FAIL.
- [ ] **Step 3: Implement**
  - `layoutRows` in design-devices.ts (uses `deviceById` for sizes). Export `RESPONSIVE_REVIEW_DEVICES` usage.
  - `DesignSurfacePage`: introduce `const [openRoutes, setOpenRoutes] = useState<string[]>([])` (seed = all `manifest.routes` on manifest load, replacing the current per-route seed loop ~140-150). Derive `artboards = useMemo(() => layoutRows(openRoutes, deviceIds), [openRoutes, deviceIds])` — replacing the flat `artboards` state + `addArtboard`/`handleDevicesChange` append math (200-243). `PagePicker` (577-608) → multi-select checkbox list toggling `openRoutes`. `PagesPanel.onOpenRoute` → toggles `openRoutes` (and focuses the row). `responsiveReview` (212-219) → set `deviceIds = RESPONSIVE_REVIEW_DEVICES` (keep current openRoutes) + fit. Add a small per-row page header (route name + a close button removing it from `openRoutes`) rendered in the canvas world at each row's origin (or as an overlay) — keep it simple.
  - Remove now-dead `boardsByProject` ref / `focusBoard` append logic if superseded (grep for refs first; keep focus-on-open by computing the new row's position from `layoutRows`).
- [ ] **Step 4: Verify** — `npx vitest run … && npx tsc -b && npm run build`. Manual: open 2+ pages → rows stack; each row spans the selected devices; DevicePicker change re-lays-out columns; close a page removes its row.
- [ ] **Step 5: Commit**
  ```bash
  git add v2_fe/src/lib/design-devices.ts v2_fe/src/lib/design-devices.test.ts v2_fe/src/pages/design/DesignSurfacePage.tsx
  git commit -m "feat(design): per-page rows across devices + multi-select page open"
  ```

---

## Task 5: Device frames via react-device-frameset (+ preset mapping + fallback)

**Files:**
- Modify: `v2_fe/package.json` (add `react-device-frameset`), `v2_fe/src/lib/design-devices.ts` (`frameset` on presets + `presetToFrameset` mapping) + test, `v2_fe/src/pages/design/design-canvas.tsx` (`DeviceChrome`/`ArtboardCard` → frame wrapper)

**Interfaces:**
- Produces: optional `frameset?: string` on `DevicePreset`; `presetToFrameset(preset): { device: string; landscape?: boolean } | null` (null → use existing `DeviceChrome`/plain rect fallback).

- [ ] **Step 1: Add the dependency** — `cd v2_fe && npm install react-device-frameset` (check its peer-deps/React version compat; note bundle impact). Import its CSS once (per its README) in a scoped way that does NOT leak global styles (e.g. import in the design-canvas module; verify no global bleed in `npm run build`).
- [ ] **Step 2: Write the failing test** for `presetToFrameset`: maps phone/tablet presets to a library device name (e.g. iPhone-class → an available frameset device), returns `null` for Tailwind `breakpoint`-group and desktop presets (which fall back). Real assertions against the library's actual device-name list (check `react-device-frameset`'s exported device names first and pin the mapping to real names).
- [ ] **Step 3: Run to verify it fails** — `npx vitest run src/lib/design-devices.test.ts`. FAIL.
- [ ] **Step 4: Implement**
  - `presetToFrameset` + `frameset` on presets (only where a real library device is a reasonable visual match).
  - In `design-canvas.tsx`, wrap the artboard: when `presetToFrameset(preset)` is non-null, render `<DeviceFrameset device={...} landscape={...}>` as the bezel with the existing true-sized sandbox iframe as the screen content — **the iframe keeps `width=preset.width height=preset.height`**; make the frameset decorative (override its `.screen` sizing to the preset dims via a scoped class if needed). When null, render the existing `DeviceChrome`/plain rect (unchanged).
  - **Fallback (per spec risk):** if `react-device-frameset`'s fixed-size frames visibly distort the true-sized iframe and can't be made to wrap cleanly, STOP and report DONE_WITH_CONCERNS describing the distortion — the controller will decide between (a) `react-responsive-iframe-viewer`, or (b) enhancing the existing `DeviceChrome` (which already sizes to arbitrary content). Do NOT ship a visibly broken frame.
- [ ] **Step 5: Verify** — `npx vitest run … && npx tsc -b && npm run build` (note bundle-size delta). Manual: phones/tablets show library bezels sized to the real preset; breakpoints/desktop keep the plain/DeviceChrome look; canvas zoom still scales the wrapper (breakpoints unaffected); small-device scroll uses the new thin scrollbar (Task 1).
- [ ] **Step 6: Commit**
  ```bash
  git add v2_fe/package.json v2_fe/package-lock.json v2_fe/src/lib/design-devices.ts v2_fe/src/lib/design-devices.test.ts v2_fe/src/pages/design/design-canvas.tsx
  git commit -m "feat(design): device-frame bezels via react-device-frameset (mapped presets + fallback)"
  ```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §A zoom → Task 2; §A pan/select → Task 3; §B rows + multi-page → Task 4; §C scrollbar → Task 1, §C frames → Task 5. All covered.
- **HARD constraint (true-size iframe / wrapper-only zoom):** called out in Global Constraints and re-stated in Tasks 3 & 5 (the two that touch the canvas). Task 5's frame must not resize the iframe.
- **Ordering:** Task 1 backend-independent; Tasks 2→3→4→5 all edit `DesignSurfacePage.tsx` and/or `design-canvas.tsx` sequentially (never parallel). Task 4 replaces the artboards-state model, so Task 5 (frames) builds on the row-derived artboards.
- **No RTL:** every frontend task tests a pure helper (`fitTransform`, `toolForKey`, `layoutRows`, `presetToFrameset`); component behavior is build + manual.
- **Library risk:** Task 5 carries an explicit escalation path (don't ship a broken frame; controller chooses the alternative), matching the spec's flagged risk.
- **Verify-before-code hooks:** Task 1 greps the composer test harness; Task 5 pins the mapping to the library's real device-name list.
