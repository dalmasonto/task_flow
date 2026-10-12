#!/usr/bin/env node
/// #665's browser benchmark: does a 500-board canvas stay usable, and does one
/// write remount only the boards it changed?
///
/// WHAT IT DOES, in order:
///   1. Logs in as an existing dev user (BENCH_USER/BENCH_PASS) so the design
///      routes have their session cookie, and seeds the project up to 500
///      design files (a no-op if it is already there).
///   2. Loads /dashboard/design and records time-to-first-board.
///   3. Counts LIVE IFRAMES — the bound #665 exists to hold — and the heap.
///   4. Edits ONE page over REST and counts the iframes the canvas remounts.
///      The whole point of the scoped invalidation: this must be the changed
///      route's boards, not every board on the canvas.
///   5. Zooms out past the live threshold: live iframes must drop to ZERO and
///      snapshot images must start appearing (captured from the boards that
///      were live, cached for the next visit).
///   6. Repeats (2)'s load with CPU throttled 4x, the "weak machine" case.
///
/// NOT part of the app's test suite: it needs a real Chrome, a running stack
/// and a seeded project, and it measures rather than asserts (the numbers go in
/// the task; the bound itself is unit-tested in `canvas-live.test.ts`).
///
/// USAGE (see the module header of the task for the stack recipe):
///   BENCH_USER=leakprobe BENCH_PASS=… node scripts/design-scale-bench.mjs
///   APP_URL defaults to http://localhost:18621 (vite), PROJECT to 2.

import { createRequire } from "node:module"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const APP = process.env.APP_URL ?? "http://localhost:18621"
const PROJECT = Number(process.env.PROJECT ?? 2)
const USER = process.env.BENCH_USER
const PASS = process.env.BENCH_PASS
const TARGET_FILES = Number(process.env.TARGET_FILES ?? 500)
const DESIGN_PATH = process.env.DESIGN_PATH ?? "/dashboard/design"

if (!USER || !PASS) {
  console.error("BENCH_USER and BENCH_PASS must be set (an existing dev login).")
  process.exit(2)
}

/// playwright-core is deliberately not a dependency of v2_fe; resolve it from
/// wherever it lives — the local install if present, else the npx cache.
function loadPlaywright() {
  const candidates = [import.meta.url]
  const npxRoot = join(homedir(), ".npm", "_npx")
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      candidates.push(join(npxRoot, dir, "node_modules", "x.js"))
    }
  }
  for (const base of candidates) {
    try {
      const require = createRequire(base)
      return require("playwright-core")
    } catch {
      // try the next candidate
    }
  }
  throw new Error("playwright-core not found (install it, or warm the npx cache)")
}
const { chromium } = loadPlaywright()

const results = {}
const record = (key, value) => {
  results[key] = value
  console.log(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function seedToTarget(request) {
  const files = await request.get(`${APP}/api/design/${PROJECT}/files`)
  if (!files.ok()) throw new Error(`files list failed: ${files.status()} ${await files.text()}`)
  const existing = (await files.json()).files ?? []
  const need = Math.max(0, TARGET_FILES - existing.length)
  console.log(`seeding: ${existing.length} files present, adding ${need}…`)
  const started = Date.now()
  for (let i = 0; i < need; i++) {
    const path = `pages/bench-${String(i).padStart(3, "0")}.html`
    const body = `<main class="p-4"><h1>Bench ${i}</h1>${"<p>Lorem ipsum dolor sit amet.</p>".repeat(40)}</main>`
    const res = await request.put(`${APP}/api/design/${PROJECT}/file`, {
      data: { path, content: body },
    })
    if (!res.ok() && res.status() !== 422) {
      throw new Error(`seed ${path} failed: ${res.status()} ${await res.text()}`)
    }
    if (res.status() === 422) {
      console.log(`seed hit the cap at file ${i}: ${(await res.json()).errors?.[0]?.rule}`)
      break
    }
  }
  return Date.now() - started
}

/// What the canvas looks like right now, read from the DOM.
const readCanvas = () =>
  ({
    boards: document.querySelectorAll("[data-artboard-key]").length,
    iframes: document.querySelectorAll("iframe[data-design-frame]").length,
    snapshots: document.querySelectorAll('img[alt$="snapshot"]').length,
    skeletons: document.querySelectorAll('[data-artboard-key] svg.lucide-maximize').length,
    scale: (() => {
      const viewport = document.querySelector(".react-flow__viewport")
      const transform = viewport?.style.transform ?? ""
      const match = /scale\(([\d.]+)\)/.exec(transform)
      return match ? Number(match[1]) : null
    })(),
    heapBytes: performance.memory?.usedJSHeapSize ?? null,
  })

async function measureColdLoad(ctx, { throttleRate, freshViewport }) {
  const page = await ctx.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 300))
  })
  const cdp = await ctx.newCDPSession(page)
  if (throttleRate) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttleRate })
  if (freshViewport) {
    // The canvas remembers pan/zoom per user+project in IndexedDB, and a
    // stored 25%-zoom canvas is a very different load from a first visit at
    // 100%. Both runs must start from the SAME state, so it is dropped first.
    await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" })
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.deleteDatabase("taskflow_design_ui")
          request.onsuccess = request.onerror = request.onblocked = () => resolve(null)
        }),
    )
  }
  const started = Date.now()
  await page.goto(`${APP}${DESIGN_PATH}`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-artboard-key]", { timeout: 120_000 })
  const firstBoardMs = Date.now() - started
  // Give the live window a beat to mount and the manifest to land.
  await sleep(6_000)
  const canvas = await page.evaluate(readCanvas)
  return { page, firstBoardMs, canvas, errors }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--enable-precise-memory-info"],
})
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })

try {
  console.log(`stack: ${APP} · project ${PROJECT}`)
  const login = await ctx.request.post(`${APP}/api/auth/login`, {
    data: { username: USER, password: PASS },
  })
  if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`)
  const session = await login.json()
  await ctx.addInitScript(
    ([token, user]) => {
      try {
        localStorage.setItem("taskflow.auth.token", token)
        localStorage.setItem("taskflow.auth.user", user)
      } catch {
        /* the cookie still carries the session */
      }
    },
    [session.token, JSON.stringify(session.user)],
  )

  console.log("seed")
  record("seedMs", await seedToTarget(ctx.request))

  console.log("cold load (unthrottled)")
  const cold = await measureColdLoad(ctx, { freshViewport: true })
  record("firstBoardMs", cold.firstBoardMs)
  record("canvas", cold.canvas)
  record("consoleErrors", cold.errors.length)

  console.log("one page write")
  const beforeWrite = await cold.page.evaluate(readCanvas)
  // Write to a board that IS LIVE — the only way the scoped invalidation has
  // something to scope. A cold board's write remounts nothing by design, which
  // would make "0 remounts" ambiguous between "scoped correctly" and "did it
  // do anything at all". Every board is open on this canvas, so the route read
  // off a live frame names a page file.
  const liveRoute = await cold.page.evaluate(() => {
    const frame = document.querySelector("iframe[data-design-frame]")
    const key = frame?.getAttribute("data-board-key") ?? ""
    return key.split("@")[0] || null
  })
  record("liveRoute", liveRoute)
  const writePath = liveRoute ? (liveRoute === "/" ? "pages/index.html" : `pages${liveRoute}.html`) : "pages/bench-001.html"
  await cold.page.evaluate(() => {
    window.__benchRemounts = 0
    const target = document.querySelector('[data-testid="design-canvas-surface"]') ?? document.body
    window.__benchObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue
          if (node.matches?.("iframe[data-design-frame]") || node.querySelector?.("iframe[data-design-frame]")) {
            window.__benchRemounts += 1
          }
        }
      }
    })
    window.__benchObserver.observe(target, { childList: true, subtree: true })
  })
  const writeStarted = Date.now()
  const write = await ctx.request.put(`${APP}/api/design/${PROJECT}/file`, {
    data: {
      path: writePath,
      content: `<main class="p-4"><h1>Edited by the bench</h1>${"<p>Lorem ipsum dolor sit amet.</p>".repeat(40)}</main>`,
    },
  })
  if (!write.ok()) throw new Error(`bench write failed: ${write.status()} ${await write.text()}`)
  await sleep(4_000)
  const remounts = await cold.page.evaluate(() => {
    window.__benchObserver?.disconnect()
    return window.__benchRemounts
  })
  record("writeRoundTripMs", Date.now() - writeStarted)
  record("iframesRemounted", remounts)
  record("liveBeforeWrite", beforeWrite.iframes)

  console.log("zoom out past the live threshold")
  for (let i = 0; i < 9; i++) {
    await cold.page.click(".react-flow__controls-zoomout").catch(() => null)
    await sleep(200)
  }
  await cold.page
    .waitForFunction(() => document.querySelectorAll("iframe[data-design-frame]").length === 0, { timeout: 30_000 })
    .catch(() => null)
  await sleep(2_000)
  record("zoomedOut", await cold.page.evaluate(readCanvas))
  // Snapshots are captured one at a time through a hidden page load; allow a
  // generous window and report how many actually landed.
  const snapshotWait = Date.now()
  await cold.page
    .waitForFunction(() => document.querySelectorAll('img[alt$="snapshot"]').length >= 3, { timeout: 180_000 })
    .catch(() => null)
  record("snapshotWaitMs", Date.now() - snapshotWait)
  record("afterSnapshots", await cold.page.evaluate(readCanvas))

  console.log("pan tour (the 'all boards visited' memory case)")
  // The old design accumulated one live document per board ever seen; the
  // point of the live window is that this walk is BOUNDED. Zoom back toward
  // readable, then wheel-pan through the canvas sampling the live count.
  for (let i = 0; i < 5; i++) {
    await cold.page.click(".react-flow__controls-zoomin").catch(() => null)
    await sleep(200)
  }
  let maxLiveDuringPan = 0
  const panStarted = Date.now()
  for (let step = 0; step < 16; step++) {
    await cold.page.mouse.move(800, 500)
    await cold.page.mouse.wheel(0, 1400)
    await sleep(900)
    const live = await cold.page.evaluate(() => document.querySelectorAll("iframe[data-design-frame]").length)
    maxLiveDuringPan = Math.max(maxLiveDuringPan, live)
  }
  const panned = await cold.page.evaluate(readCanvas)
  record("panTourMs", Date.now() - panStarted)
  record("maxLiveDuringPan", maxLiveDuringPan)
  record("afterPanTour", panned)
  await cold.page.close()

  console.log("cold load (CPU throttled 4x)")
  const throttled = await measureColdLoad(ctx, { throttleRate: 4, freshViewport: true })
  record("firstBoardMs4x", throttled.firstBoardMs)
  record("canvas4x", throttled.canvas)
  record("consoleErrors4x", throttled.errors.length)
  await throttled.page.close()
} finally {
  await browser.close()
}

const out = process.env.BENCH_OUT ?? "/tmp/design-scale-bench.json"
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), app: APP, project: PROJECT, ...results }, null, 2))
console.log(`\nrecorded → ${out}`)
