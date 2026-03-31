# Splash / Loading Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-layer loading screen (HTML splash + React gate) that eliminates the startup "popup" effect.

**Architecture:** Layer 1 is pure HTML/CSS inside `index.html`'s `#root` div — visible instantly before React boots. Layer 2 is a React `<LoadingScreen />` component gated on `useSync()` readiness — visible while data syncs. A 300ms fade-out transition connects them.

**Tech Stack:** React, CSS (inline for HTML layer, Tailwind for React layer), existing theme CSS variables.

---

### Task 1: Add HTML Splash Screen to index.html

**Files:**
- Modify: `index.html:36-38` (the `<body>` section)

- [ ] **Step 1: Add splash markup and inline styles inside `#root`**

Replace the empty `<div id="root"></div>` with splash content. The inline styles use the same CSS variable values from `src/index.css` so the splash matches the app theme. Since CSS variables aren't loaded yet at this point (they come from Tailwind/index.css), we use the raw hex values with a class-based toggle matching the existing theme script.

```html
<div id="root">
  <style>
    .splash-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      width: 100vw;
      margin: 0;
      padding: 0;
      background: #f5f5f5;
      color: #1a1a1a;
      font-family: 'Inter Variable', system-ui, sans-serif;
      transition: opacity 0.3s ease-out;
    }
    .dark .splash-screen {
      background: #0e0e0e;
      color: #ececec;
    }
    .splash-logo {
      width: 64px;
      height: 64px;
      margin-bottom: 24px;
    }
    .splash-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 24px;
      letter-spacing: -0.01em;
    }
    .splash-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(134, 59, 255, 0.2);
      border-top-color: #863bff;
      border-radius: 50%;
      animation: splash-spin 0.8s linear infinite;
    }
    @keyframes splash-spin {
      to { transform: rotate(360deg); }
    }
  </style>
  <div class="splash-screen">
    <img src="/favicon.svg" alt="TaskFlow" class="splash-logo" />
    <div class="splash-title">TaskFlow</div>
    <div class="splash-spinner"></div>
  </div>
</div>
```

- [ ] **Step 2: Verify the splash screen renders**

Run: `npm run dev`

Open the browser. You should see the TaskFlow logo, title, and a purple spinning ring centered on screen. The background should match the theme (dark or light based on localStorage). When React mounts, it replaces this content automatically.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add HTML splash screen for instant startup visibility"
```

---

### Task 2: Expose `synced` State from useSync Hook

**Files:**
- Modify: `src/hooks/use-sync.ts:196-256` (the `useSync` function and `initialSync`)

- [ ] **Step 1: Add synced state and return it from `useSync()`**

Modify the `useSync` hook to track whether the initial sync has completed. Add a `synced` state via `useState`, set it to `true` after `initialSync()` resolves (whether it succeeded or failed — we don't want to block the app forever if the server is down), and return it.

Change the `useSync` function from:

```ts
export function useSync() {
  const sourceRef = useRef<EventSource | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const port = useSetting('serverPort')

  useEffect(() => {
    let killed = false
    let delay = RECONNECT_DELAY

    function connect() {
```

To:

```ts
export function useSync() {
  const [synced, setSynced] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const port = useSetting('serverPort')

  useEffect(() => {
    let killed = false
    let delay = RECONNECT_DELAY

    function connect() {
```

Add `useState` to the React import at line 1:

```ts
import { useEffect, useRef, useState } from 'react'
```

- [ ] **Step 2: Set synced to true after initialSync completes**

Change the effect's initialSync call from:

```ts
    // Initial sync then connect
    initialSync(port).then(connect)
```

To:

```ts
    // Initial sync then connect
    initialSync(port).finally(() => setSynced(true)).then(connect)
```

- [ ] **Step 3: Return synced from the hook**

Change the end of the hook. Currently `useSync()` returns `void` (no return statement). Add a return:

After the closing `}, [port])` of the useEffect, add:

```ts
  return { synced }
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-sync.ts
git commit -m "feat: expose synced state from useSync hook"
```

---

### Task 3: Create LoadingScreen React Component

**Files:**
- Create: `src/components/loading-screen.tsx`

- [ ] **Step 1: Create the LoadingScreen component**

This component mirrors the HTML splash visually (logo + title + spinner) but lives in React-land. It accepts an `onFadeOut` callback that fires after the fade-out animation completes, so the parent can unmount it cleanly.

Create `src/components/loading-screen.tsx`:

```tsx
import { useEffect, useState } from 'react'

interface LoadingScreenProps {
  visible: boolean
  onFadeOut: () => void
}

export function LoadingScreen({ visible, onFadeOut }: LoadingScreenProps) {
  const [opacity, setOpacity] = useState(1)

  useEffect(() => {
    if (!visible) {
      setOpacity(0)
      const timer = setTimeout(onFadeOut, 300)
      return () => clearTimeout(timer)
    }
  }, [visible, onFadeOut])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#f5f5f5] dark:bg-[#0e0e0e]"
      style={{ opacity, transition: 'opacity 0.3s ease-out' }}
    >
      <img src="/favicon.svg" alt="TaskFlow" className="mb-6 h-16 w-16" />
      <div className="mb-6 text-xl font-semibold tracking-tight text-[#1a1a1a] dark:text-[#ececec]">
        TaskFlow
      </div>
      <div className="h-8 w-8 animate-spin rounded-full border-3 border-[rgba(134,59,255,0.2)] border-t-[#863bff]" />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/loading-screen.tsx
git commit -m "feat: add LoadingScreen component with fade-out transition"
```

---

### Task 4: Gate App Rendering on Sync State

**Files:**
- Modify: `src/App.tsx:1-49`

- [ ] **Step 1: Wire up the loading gate in App.tsx**

Update `App.tsx` to use the `synced` return value from `useSync()`, and show `<LoadingScreen />` while sync is in progress.

Change the imports at the top of the file — add the `LoadingScreen` import and `useState`/`useCallback`:

```tsx
import { useState, useCallback } from 'react'
import { Routes, Route, Navigate } from 'react-router'
import { useServer } from '@/hooks/use-server'
import { useSync } from '@/hooks/use-sync'
import { useFont } from '@/hooks/use-font'
import { LoadingScreen } from '@/components/loading-screen'
import { RootLayout } from '@/components/root-layout'
```

Then update the component body. Change from:

```tsx
export default function App() {
  useServer()
  useSync()
  useFont()

  return (
    <Routes>
```

To:

```tsx
export default function App() {
  useServer()
  const { synced } = useSync()
  useFont()

  const [showLoader, setShowLoader] = useState(true)
  const handleFadeOut = useCallback(() => setShowLoader(false), [])

  if (showLoader) {
    return <LoadingScreen visible={synced === false ? true : false} onFadeOut={handleFadeOut} />
  }

  return (
    <Routes>
```

Note: The flow is:
1. `showLoader` starts `true`, `synced` starts `false` → `<LoadingScreen visible={true} />` shows (spinner visible)
2. Sync completes → `synced` becomes `true` → `<LoadingScreen visible={false} />` triggers fade-out
3. After 300ms fade → `handleFadeOut` fires → `showLoader` becomes `false` → Routes render

- [ ] **Step 2: Simplify the visible prop expression**

The expression `synced === false ? true : false` can be simplified to `!synced`:

```tsx
    return <LoadingScreen visible={!synced} onFadeOut={handleFadeOut} />
```

- [ ] **Step 3: Verify the full flow**

Run: `npm run dev`

Test the following:
1. On page load, the HTML splash shows instantly (logo + spinner + "TaskFlow")
2. React mounts and replaces with the identical-looking `<LoadingScreen />` (seamless)
3. Once data sync completes, the loading screen fades out over 300ms
4. The app UI (sidebar, dashboard, etc.) appears smoothly
5. Toggle theme in localStorage and reload — splash should match theme

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: gate app rendering on sync state with loading screen"
```

---

### Task 5: Final Verification and Cleanup

**Files:**
- Review: `index.html`, `src/App.tsx`, `src/hooks/use-sync.ts`, `src/components/loading-screen.tsx`

- [ ] **Step 1: Test dark mode splash**

1. Open browser devtools → Application → Local Storage
2. Set `theme` to `dark`, reload → splash should have dark background (#0e0e0e)
3. Set `theme` to `light`, reload → splash should have light background (#f5f5f5)

- [ ] **Step 2: Test with slow/unavailable server**

1. Stop the MCP server (if running)
2. Reload the app
3. The splash should show for the full retry period (~7.5s), then fade out
4. The app should still render (with empty data) — never stuck on loader forever

- [ ] **Step 3: Test Tauri build (if available)**

Run: `npm run tauri dev` (if Tauri is set up)

Verify the splash shows in the Tauri window before the app loads.

- [ ] **Step 4: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: splash screen cleanup and polish"
```
