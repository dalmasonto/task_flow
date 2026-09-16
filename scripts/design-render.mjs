#!/usr/bin/env node
/// design-render.mjs — reference screenshot renderer for the Design Surface.
///
/// Contract (see backend/plugins/taskflow-design/src/screenshots.rs):
///   design-render.mjs --url <url> --width W --height H --dpr D --timeout-ms T --out <path>
///
/// Renders agent-authored HTML in a disposable headless Chromium and writes a
/// PNG to --out. This process IS the security boundary for egress: it renders
/// untrusted code with a full browser network stack, so every request is
/// intercepted and denied unless it targets the sandbox origin itself or the
/// Tailwind CDN named in the sandbox CSP. RFC1918 / link-local / localhost
/// targets other than the page's own origin are refused — that is what stops
/// a hostile page from fetching the operator's internal network.
///
/// Setup: `npm install puppeteer` somewhere on PATH-adjacent life, then point
/// TASKFLOW_DESIGN_RENDERER at this file (needs a `#!/usr/bin/env node` exec
/// bit) or at a wrapper script that runs `node design-render.mjs "$@"`.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
}
const url = args.url;
const width = parseInt(args.width ?? "1280", 10);
const height = parseInt(args.height ?? "800", 10);
const dpr = parseFloat(args.dpr ?? "1") || 1;
const timeoutMs = parseInt(args["timeout-ms"] ?? "20000", 10);
const out = args.out;

if (!url || !out) {
  console.error("usage: design-render.mjs --url <url> --width W --height H --dpr D --timeout-ms T --out <png>");
  process.exit(2);
}

// The only remote origin a composed page legitimately loads is Tailwind's
// browser build (the sandbox CSP names exactly this too).
const SANDBOX_ALLOWED_REMOTE = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\//;
const isPrivateHost = (host) =>
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host);

const puppeteerImport = await import("puppeteer").catch(() => null);
if (!puppeteerImport) {
  console.error("puppeteer is not installed; run `npm install puppeteer` for this script");
  process.exit(3);
}
const puppeteer = puppeteerImport.default;

const target = new URL(url);
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    // Disposable: fresh profile per shot, no shared state between renders.
    args: ["--no-first-run", "--no-default-browser-check", "--disable-features=Translate"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    let u;
    try {
      u = new URL(req.url());
    } catch {
      req.abort().catch(() => {});
      return;
    }
    const sameOrigin = u.origin === target.origin;
    if (!sameOrigin && !SANDBOX_ALLOWED_REMOTE.test(req.url())) {
      // Everything else dies silently — the page must not learn about,
      // or reach, anything beyond its own origin and the CDN allowlist.
      req.abort().catch(() => {});
      return;
    }
    if (!sameOrigin && isPrivateHost(u.hostname)) {
      req.abort().catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  });

  await page.goto(url, { waitUntil: "networkidle0", timeout: timeoutMs });
  // Give the Tailwind browser build one extra beat to apply styles after the
  // network settles — networkidle0 can fire before first paint of injected CSS.
  await new Promise((r) => setTimeout(r, 250));
  try { mkdirSync(dirname(resolve(out)), { recursive: true }); } catch {}
  await page.screenshot({ path: out, type: "png" });
  process.exit(0);
} catch (err) {
  console.error(String(err?.message ?? err).split("\n")[0]);
  process.exit(1);
} finally {
  await browser?.close().catch(() => {});
}

