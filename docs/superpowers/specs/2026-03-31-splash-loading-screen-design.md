# Splash / Loading Screen Design

**Date**: 2026-03-31
**Project**: TaskFlow
**Task**: #298

## Problem

The app currently renders the full UI shell immediately on startup while data sync happens in the background (up to ~7.5s with retries). This causes a jarring "popup" effect where content appears abruptly.

## Solution

A two-layer loading screen that covers the entire startup timeline:

1. **HTML splash** — visible instantly, before React boots
2. **React loading gate** — visible while data sync completes

### Layer 1: HTML Splash

An inline splash screen inside `index.html`'s `#root` div:

- **Content**: TaskFlow logo (text-based or SVG) + CSS spinner (rotating ring)
- **Styling**: Inline `<style>` block — no external CSS, no FOUC
- **Theme-aware**: Uses CSS variables from the existing theme detection script in `index.html` that sets `dark`/`light` class on `<html>` before any rendering. Splash styles reference `--background` and `--foreground` (or equivalent) to match the user's theme
- **Lifecycle**: Naturally replaced when React calls `createRoot().render()` on the `#root` div — no manual cleanup needed

### Layer 2: React Loading Gate

A React-level loading state gated on data sync completion:

- **Hook change**: `useSync()` exposes a `synced` boolean — starts `false`, flips to `true` after initial data sync completes
- **App gate**: `App.tsx` checks `synced`:
  - `false` → renders `<LoadingScreen />` component
  - `true` → renders normal `<RootLayout />` with routes
- **Visual continuity**: `<LoadingScreen />` mirrors the HTML splash's appearance (same logo, same spinner, same positioning) so the handoff from HTML splash to React loading is invisible

### Transition

When `synced` flips to `true`:
- `<LoadingScreen />` fades out over ~300ms (CSS opacity transition)
- App content fades in
- Eliminates the abrupt "pop" of content appearing

## Files to Change

| File | Change |
|------|--------|
| `index.html` | Add splash markup (logo + spinner) and inline styles inside `#root` |
| `src/hooks/use-sync.ts` | Expose `synced` boolean from the hook return value |
| `src/App.tsx` | Gate rendering on `synced` — show `<LoadingScreen />` or app |
| `src/components/loading-screen.tsx` | **New file** — logo + spinner component with fade-out animation |

## Design Decisions

- **CSS-only spinner**: No JS animation library needed. CSS `@keyframes` rotation is smooth and lightweight
- **Inline styles in HTML**: Ensures the splash is visible immediately without waiting for any CSS file to load
- **Theme-aware from the start**: Piggybacks on the existing theme detection script — no duplicate logic
- **No Tauri-specific splash**: Keeps it working in both Tauri and browser dev mode
- **React gate on sync, not on mount**: The HTML splash covers the React boot time; the React gate covers the data sync time. Together they cover the full startup window
