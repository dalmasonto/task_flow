// server.mjs — the `renderer` sidecar's HTTP front for design-render.mjs.
//
// The backend never runs Chromium itself: its TASKFLOW_DESIGN_RENDERER is
// ./client.sh, which POSTs the shot here and writes back the PNG. This box
// holds no secrets and no database access, so a page that escapes the
// browser lands somewhere with nothing to steal.
//
//   POST /render   form fields: url, width, height, dpr, timeout_ms → image/png
//   GET  /health   → 200 "ok"
//
// Every shot is a fresh `node design-render.mjs` child — disposable browser,
// fresh profile, the egress policy that script enforces — exactly the
// per-shot contract screenshots.rs documents.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
// Only sandbox pages on this origin are rendered, so nothing else that can
// reach this port gets a free "screenshot any URL" service.
const ALLOWED_ORIGIN = new URL(process.env.RENDER_ALLOWED_ORIGIN ?? "http://invalid").origin;
// Each Chromium costs a few hundred MB on a shared 8GB box.
const MAX_CONCURRENT = parseInt(process.env.RENDER_MAX_CONCURRENT ?? "2", 10);
const MAX_QUEUED = parseInt(process.env.RENDER_MAX_QUEUED ?? "8", 10);
const MAX_BODY = 8 * 1024;
const SCRIPT = new URL("./design-render.mjs", import.meta.url).pathname;

let running = 0;
const waiting = [];
const acquire = () =>
  running < MAX_CONCURRENT
    ? (running++, Promise.resolve())
    : new Promise((ok) => waiting.push(ok));
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else running--;
};

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
  return { url: url.href, width, height, dpr, timeoutMs };
}

// Resolves to { png } or { error }. The child is killed if it outlives its
// budget or the caller hangs up.
function renderOnce(shot, signal) {
  const out = join(tmpdir(), `shot-${randomUUID()}.png`);
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        SCRIPT,
        "--url", shot.url,
        "--width", String(shot.width),
        "--height", String(shot.height),
        "--dpr", String(shot.dpr),
        "--timeout-ms", String(shot.timeoutMs),
        "--out", out,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, shot.timeoutMs + 1500);
    signal.addEventListener("abort", kill, { once: true });
    child.on("close", async (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (code !== 0) {
        await rm(out, { force: true });
        const last = stderr.trim().split("\n").pop();
        return done({ error: last || `renderer exited ${code ?? "on a signal"}` });
      }
      try {
        done({ png: await readFile(out) });
      } catch (e) {
        done({ error: `no screenshot written (${e.message})` });
      } finally {
        await rm(out, { force: true });
      }
    });
  });
}

const send = (res, status, body, type = "text/plain; charset=utf-8") => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
};

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, "ok");
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
  const hangup = new AbortController();
  res.on("close", () => hangup.abort());

  await acquire();
  try {
    if (hangup.signal.aborted) return;
    const result = await renderOnce(shot, hangup.signal);
    if (result.error) return send(res, 502, result.error);
    send(res, 200, result.png, "image/png");
  } finally {
    release();
  }
}).listen(PORT, () => {
  console.log(`renderer listening on :${PORT}, rendering ${ALLOWED_ORIGIN}/s/… only`);
});
