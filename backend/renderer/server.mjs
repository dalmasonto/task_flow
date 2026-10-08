// server.mjs — the `renderer` sidecar: Design Surface screenshots over HTTP.
//
// The backend never runs Chromium itself: its TASKFLOW_DESIGN_RENDERER is
// ./client.sh, which POSTs the shot here and writes back the PNG. This box
// holds no secrets and no database access, so a page that escapes the
// browser lands somewhere with nothing to steal.
//
//   POST /render   form fields: url, width, height, dpr, timeout_ms, and
//                  optionally mobile (0|1), full_page (0|1),
//                  frame (none|classic|device), device (preset id),
//                  theme (light|dark|both|<theme name>), max_px (0 = as captured)
//                  → image/png, with X-Render-Warnings: a base64 JSON array
//                    of what did not load (fonts, images…), and
//                    X-Render-Data: base64 JSON of what the page reported
//                    (`window.__tfResult`), or null
//   GET  /health   → 200 "ok"
//   GET  /status   → JSON: the browser's state, the shots in flight, the queue
//
// ONE BROWSER, A CONTEXT PER SHOT. Chromium is launched on the first shot and
// kept while shots keep coming. Each shot gets its own browser context (its own
// cookies, storage and cache, like a private window), closed when the shot ends
// however it ends — done, timed out or the caller hung up — so no page outlives
// its request. The browser is closed after IDLE_CLOSE_MS with nothing to do,
// replaced after RECYCLE_AFTER shots (a long-lived Chromium slowly grows), and
// relaunched by the next shot if it crashed.
//
// This replaced a `node design-render.mjs` child per shot. A child killed on
// timeout never closed its Chromium (Puppeteer starts it detached), and those
// orphans filled the memory limit and /tmp until no browser could launch
// (#656). Here the browser belongs to this long-lived process, and its profile
// is reaped by path whenever it goes away.
import { createServer } from "node:http";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import puppeteer from "puppeteer";

import { LAUNCH_ARGS, renderShot } from "./render.mjs";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
// Only sandbox pages on this origin are rendered, so nothing else that can
// reach this port gets a free "screenshot any URL" service.
const ALLOWED_ORIGIN = new URL(process.env.RENDER_ALLOWED_ORIGIN ?? "http://invalid").origin;
// Shots rendering at once. A DPR-3 or full-page shot can take 100–300MB of the
// container's 1g, so this is bounded by memory, not by what Chromium allows;
// the rest wait in the queue.
const MAX_CONCURRENT = parseInt(process.env.RENDER_MAX_CONCURRENT ?? "4", 10);
const MAX_QUEUED = parseInt(process.env.RENDER_MAX_QUEUED ?? "50", 10);
const IDLE_CLOSE_MS = parseInt(process.env.RENDER_IDLE_CLOSE_MS ?? "60000", 10);
const RECYCLE_AFTER = parseInt(process.env.RENDER_RECYCLE_AFTER ?? "200", 10);
// Past the shot's own timeout before the server gives up on it. render.mjs
// spends at most timeout_ms waiting on the page; this covers framing and the
// screenshot itself.
const GRACE_MS = 1500;
// How long a browser or context gets to close before it is killed outright.
const CLOSE_MS = 5000;
const MAX_BODY = 8 * 1024;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];
const within = (promise, ms) =>
  Promise.race([promise, new Promise((ok) => setTimeout(() => ok("timeout"), ms).unref())]);

// --- the queue --------------------------------------------------------------

let running = 0;
const waiting = [];
// Resolves to true once a slot is held, or false when the caller hung up while
// queued (its place is given up at once, not when it reaches the front).
const acquire = (signal) => {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve(true);
  }
  return new Promise((ok) => {
    const entry = { ok, signal };
    waiting.push(entry);
    signal.addEventListener(
      "abort",
      () => {
        const i = waiting.indexOf(entry);
        if (i !== -1) waiting.splice(i, 1);
        ok(false);
      },
      { once: true },
    );
  });
};
const release = () => {
  const next = waiting.shift();
  if (next) next.ok(true);
  else running--;
};

// --- the browser -------------------------------------------------------------

// The browser new shots go to: { ready, profile, active, served, idle, closed },
// or null when none is running.
let current = null;
// Shots by request id, for /status and the logs.
const inflight = new Map();

// Kills every process still using `profile` and deletes it. browser.close()
// normally does both; this covers a Chromium that crashed or would not close.
// Every Chromium process (browser, zygote, gpu, renderer, utility) carries
// --user-data-dir on its command line, which is what finds them.
async function reap(profile) {
  const flag = `--user-data-dir=${profile}`;
  for (const pid of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (cmdline.split("\0").includes(flag)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch {}
    }
  }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

function launch() {
  const b = { profile: join(tmpdir(), `profile-${randomUUID()}`), active: 0, served: 0, idle: null, closed: false };
  const started = Date.now();
  b.ready = puppeteer.launch({ headless: true, userDataDir: b.profile, args: LAUNCH_ARGS });
  b.ready.then(
    (browser) => {
      log(`browser up in ${Date.now() - started}ms`);
      browser.on("disconnected", () => {
        if (!b.closed) shut(b, "crashed");
      });
    },
    (err) => shut(b, `failed to launch: ${firstLine(err)}`),
  );
  // A failed launch rejects every shot waiting on it; each handles that itself.
  b.ready.catch(() => {});
  return b;
}

async function shut(b, why) {
  if (b.closed) return;
  b.closed = true;
  clearTimeout(b.idle);
  if (current === b) current = null;
  log(`browser closing (${why}) after ${b.served} shot(s)`);
  await within(b.ready.then((browser) => browser.close()).catch(() => {}), CLOSE_MS);
  await reap(b.profile);
}

// The browser for one more shot: the running one, or a new one when there is
// none or the running one is due for replacement (it finishes its own shots
// first, then closes).
function lease() {
  if (current && current.served >= RECYCLE_AFTER) {
    const old = current;
    current = null;
    if (old.active === 0) shut(old, "recycled");
  }
  current ??= launch();
  const b = current;
  clearTimeout(b.idle);
  b.active++;
  b.served++;
  return b;
}

function unlease(b) {
  b.active--;
  if (b.active > 0 || b.closed) return;
  if (b !== current) return void shut(b, "recycled");
  b.idle = setTimeout(() => {
    if (b.active === 0) shut(b, "idle");
  }, IDLE_CLOSE_MS);
  b.idle.unref();
}

// --- one shot ----------------------------------------------------------------

// Resolves to { png, warnings, data } or { error }. The shot's context is
// closed on every path, so whatever the page was doing stops with it.
async function renderOnce(shot, signal) {
  const b = lease();
  let context;
  let timer;
  try {
    const browser = await b.ready;
    context = await browser.createBrowserContext();
    const work = renderShot(context, shot);
    // Once the deadline wins, closing the context fails the work; nobody is
    // listening by then.
    work.catch(() => {});
    const deadline = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`render timed out after ${shot.timeoutMs}ms`)), shot.timeoutMs + GRACE_MS);
      signal.addEventListener("abort", () => fail(new Error("caller hung up")), { once: true });
    });
    return await Promise.race([work, deadline]);
  } catch (err) {
    return { error: firstLine(err) };
  } finally {
    clearTimeout(timer);
    // A context that will not close means the browser is wedged: replace it.
    if (context && (await within(context.close().catch(() => {}), CLOSE_MS)) === "timeout") {
      shut(b, "a context would not close");
    }
    unlease(b);
  }
}

const intIn = (raw, lo, hi) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

function parseShot(body) {
  const f = new URLSearchParams(body);
  let url;
  try {
    url = new URL(f.get("url") ?? "");
  } catch {
    return { error: "url is not a valid URL" };
  }
  if (url.origin !== ALLOWED_ORIGIN || !url.pathname.startsWith("/s/")) {
    return { error: `only ${ALLOWED_ORIGIN}/s/… sandbox pages are rendered` };
  }
  const width = intIn(f.get("width"), 200, 4000);
  const height = intIn(f.get("height"), 200, 4000);
  const dpr = intIn(f.get("dpr"), 1, 4);
  const timeoutMs = intIn(f.get("timeout_ms"), 1000, 60000);
  if (width === null || height === null || dpr === null || timeoutMs === null) {
    return { error: "width/height/dpr/timeout_ms out of range" };
  }
  const frame = f.get("frame") || "none";
  if (!["none", "classic", "device"].includes(frame)) return { error: "frame must be none, classic or device" };
  const device = f.get("device") ?? "";
  const theme = f.get("theme") || "light";
  const maxPx = intIn(f.get("max_px") || "0", 0, 8000);
  if (maxPx === null) return { error: "max_px must be 0–8000" };
  if (theme !== "both" && !/^[a-z][a-z0-9-]{0,31}$/.test(theme)) return { error: "theme must be both or a theme name" };
  if (!/^[a-z0-9-]{0,40}$/.test(device)) return { error: "device must be a preset id" };
  return {
    url: url.href,
    width,
    height,
    dpr,
    timeoutMs,
    mobile: f.get("mobile") === "1",
    fullPage: f.get("full_page") === "1",
    frame,
    device,
    theme,
    maxPx,
  };
}

const send = (res, status, body, type = "text/plain; charset=utf-8", extra = {}) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
};

function status() {
  const now = Date.now();
  return {
    browser: current ? (current.closed ? "closing" : "up") : "down",
    served_by_browser: current?.served ?? 0,
    rendering: running,
    queued: waiting.length,
    max_concurrent: MAX_CONCURRENT,
    max_queued: MAX_QUEUED,
    inflight: [...inflight].map(([id, s]) => ({ id, path: s.path, state: s.state, ms: now - s.since })),
  };
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, "ok");
  if (req.method === "GET" && req.url === "/status") {
    return send(res, 200, JSON.stringify(status()), "application/json");
  }
  if (req.method !== "POST" || req.url !== "/render") return send(res, 404, "not found");

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return send(res, 413, "request too large");
  }
  const shot = parseShot(body);
  if (shot.error) return send(res, 400, shot.error);

  if (running >= MAX_CONCURRENT && waiting.length >= MAX_QUEUED) {
    return send(res, 503, "renderer busy, try again shortly");
  }
  const id = randomUUID().slice(0, 8);
  const hangup = new AbortController();
  res.on("close", () => hangup.abort());
  const entry = { path: new URL(shot.url).pathname, state: "queued", since: Date.now() };
  inflight.set(id, entry);

  try {
    if (!(await acquire(hangup.signal))) return log(`shot ${id} dropped: caller hung up while queued`);
    try {
      entry.state = "rendering";
      const queuedMs = Date.now() - entry.since;
      const started = Date.now();
      const result = await renderOnce(shot, hangup.signal);
      const took = `${Date.now() - started}ms (queued ${queuedMs}ms)`;
      if (result.error) {
        log(`shot ${id} failed in ${took}: ${result.error}`);
        return send(res, 502, result.error);
      }
      log(`shot ${id} ok in ${took}${result.warnings.length ? `, ${result.warnings.length} warning(s)` : ""}`);
      send(res, 200, result.png, "image/png", {
        "x-render-warnings": Buffer.from(JSON.stringify(result.warnings)).toString("base64"),
        // The page's own findings (the comparison grid's contrast checks).
        "x-render-data": Buffer.from(JSON.stringify(result.data)).toString("base64"),
      });
    } finally {
      release();
    }
  } finally {
    inflight.delete(id);
  }
}).listen(PORT, () => {
  log(`renderer listening on :${PORT}, rendering ${ALLOWED_ORIGIN}/s/… only, ${MAX_CONCURRENT} at a time`);
});
