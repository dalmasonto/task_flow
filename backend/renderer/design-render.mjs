#!/usr/bin/env node
/// design-render.mjs — the screenshot renderer for the Design Surface, as a CLI.
///
/// Contract (see backend/plugins/taskflow-design/src/screenshots.rs):
///   design-render.mjs --url <url> --width W --height H --dpr D --timeout-ms T --out <png>
///                     [--mobile 1] [--full-page 1] [--frame none|classic|device]
///                     [--device <preset id>] [--theme light|dark|both|<theme name>] [--max-px N]
///
/// Renders agent-authored HTML in a disposable headless Chromium, writes a PNG
/// to --out, and writes `<out>.json` = { warnings: [...], data }: every font,
/// image or stylesheet that did not load, so a fallback is reported instead of
/// silently photographed. The rendering and its egress policy live in
/// ./render.mjs.
///
/// In production the backend does not run this: it runs ./client.sh, which
/// asks the `renderer` sidecar (./server.mjs), and that renders every shot in
/// one shared browser. That host's kernel forbids the unprivileged user
/// namespaces Chromium's own sandbox needs, so the sidecar sets
/// DESIGN_RENDER_NO_SANDBOX=1 and the secretless container is the boundary.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LAUNCH_ARGS, renderShot } from "./render.mjs";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
}
const out = args.out;
if (!args.url || !out) {
  console.error("usage: design-render.mjs --url <url> --width W --height H --dpr D --timeout-ms T --out <png>");
  process.exit(2);
}

const puppeteerImport = await import("puppeteer").catch(() => null);
if (!puppeteerImport) {
  console.error("puppeteer is not installed; run `npm install puppeteer` for this script");
  process.exit(3);
}
const puppeteer = puppeteerImport.default;

let browser;
try {
  // Disposable: fresh profile per shot, no shared state between renders.
  browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  const { png, warnings, data } = await renderShot(browser, {
    url: args.url,
    width: parseInt(args.width ?? "1280", 10),
    height: parseInt(args.height ?? "800", 10),
    dpr: parseFloat(args.dpr ?? "1") || 1,
    timeoutMs: parseInt(args["timeout-ms"] ?? "20000", 10),
    mobile: args.mobile === "1",
    fullPage: args["full-page"] === "1",
    frame: args.frame ?? "none",
    device: args.device ?? "",
    theme: args.theme,
    /// Longest side of the returned PNG (0 = as captured).
    maxPx: parseInt(args["max-px"] ?? "0", 10) || 0,
  });
  try { mkdirSync(dirname(resolve(out)), { recursive: true }); } catch {}
  writeFileSync(out, png);
  writeFileSync(`${out}.json`, JSON.stringify({ warnings, data }));
  process.exitCode = 0;
} catch (err) {
  console.error(String(err?.message ?? err).split("\n")[0]);
  process.exitCode = 1;
} finally {
  // exitCode, not process.exit(): exiting inside try/catch skipped this
  // block and orphaned Chromium on every shot.
  await browser?.close().catch(() => {});
  process.exit();
}
