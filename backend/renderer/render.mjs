/// render.mjs — one Design Surface screenshot, against any browser or browser
/// context. design-render.mjs (one disposable browser per shot, the CLI the
/// backend can run directly) and server.mjs (the sidecar's one shared browser,
/// a fresh context per shot) both call `renderShot`.
///
/// EGRESS. This renders untrusted code with a full browser network stack.
/// Chromium enforces the sandbox CSP itself (`composer::sandbox_csp`: scripts,
/// styles, images, media and fonts from any https origin; fetch/XHR only to
/// self + the Tailwind CDN), so the renderer matches it rather than being
/// stricter than the page — which is what used to drop webfonts and external
/// images. What the renderer adds is the part CSP cannot express:
///   * a cross-origin request must be https (or data:/blob:);
///   * its host must not RESOLVE to a private, loopback or link-local address,
///     checked after DNS so a public name pointing inward is refused too.
/// In production the sidecar also sits on its own compose network, so even a
/// request that slipped past this check has no internal service to reach.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { fitWithin, frameCapture, framedCaptureHeight, sideBySide } from "./frames.mjs";

/// Chromium flags for every renderer browser, shared or disposable.
export const LAUNCH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate",
  // Docker's default /dev/shm is 64MB; a DPR-3 phone shot can exhaust it.
  "--disable-dev-shm-usage",
  ...(process.env.DESIGN_RENDER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
];

/// light, dark, `both` (light + dark side by side) or any declared theme slug
/// (#619) — the backend has already checked it is declared.
const THEME_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/// Mobile user agents for mobile emulation. The page sees a phone/tablet the
/// way a real one reports itself, so UA-sniffing code and `pointer: coarse` /
/// `hover: none` media queries behave as they will on the device.
const UA_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const isPrivateAddress = (ip) => {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

/// Only resource kinds that change what the picture shows are worth a warning;
/// a failed analytics beacon is not the agent's problem.
const VISUAL = new Set(["image", "font", "stylesheet", "media"]);

/// Renders one shot. `target` is anything with `newPage()`: a Browser, or a
/// BrowserContext (cookies, storage and cache isolated from other shots).
/// Every page it opens is its own and closed before it returns, but a caller
/// that abandons the shot (timeout, hang-up) should close the context too —
/// that is what unblocks a page stuck mid-load.
///
/// `shot`: { url, width, height, dpr, timeoutMs, mobile, fullPage, frame,
/// device, theme, maxPx }. Resolves to { png, warnings, data }.
export async function renderShot(target, shot) {
  const { url, width, dpr, timeoutMs, mobile, fullPage } = shot;
  const frame = shot.frame ?? "none";
  const device = shot.device ?? "";
  const theme = shot.theme === "both" || THEME_NAME.test(shot.theme ?? "") ? shot.theme : "light";
  const maxPx = Math.max(0, shot.maxPx || 0);
  /// A device-framed screen is captured at the frame screen's own proportions
  /// (the UI export's `captureViewport`), so its cover fit crops nothing.
  const height = frame === "device" && !fullPage ? framedCaptureHeight(device, width, shot.height) : shot.height;
  /// A full-page capture stops here, in CSS px: 16,000 DEVICE px (Chromium's
  /// practical ceiling for one capture) at this DPR, and never over 12,000 CSS
  /// px, so a runaway page cannot become a PNG over the backend's cap. The cut
  /// is reported as a warning.
  const MAX_FULL_PAGE_HEIGHT = Math.min(12_000, Math.floor(16_000 / dpr));
  const mobileUserAgent = () =>
    device.startsWith("ipad") ? UA_IPAD : device.startsWith("pixel") || device.startsWith("galaxy") ? UA_ANDROID : UA_IOS;

  /// Resolved once per host per shot: a page with 40 images from one CDN costs
  /// one lookup, not 40.
  const hostVerdicts = new Map();
  const hostIsPublic = (host) => {
    if (!hostVerdicts.has(host)) {
      const bare = host.replace(/^\[|\]$/g, "");
      hostVerdicts.set(
        host,
        (isIP(bare) ? Promise.resolve([{ address: bare }]) : lookup(bare, { all: true }))
          .then((addrs) => addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address)))
          .catch(() => false),
      );
    }
    return hostVerdicts.get(host);
  };

  const origin = new URL(url).origin;
  const warnings = [];
  const warn = (message) => {
    if (!warnings.includes(message) && warnings.length < 20) warnings.push(message);
  };
  /// One warning per URL: the first, most specific reason (a blocked request
  /// also fails and then renders empty, which says nothing new).
  const reportedUrls = new Set();
  const warnUrl = (url, message) => {
    if (reportedUrls.has(url)) return;
    reportedUrls.add(url);
    warn(`${message}: ${url}`);
  };

  /// What the page reported through `window.__tfResult`, if anything.
  let pageData = null;

  /// One capture of the page in one theme: load, wait for the ready signal,
  /// capture (the whole page, if asked), then dress it in the frame.
  async function shoot(pageTheme, remaining) {
    const page = await target.newPage();
    try {
      if (mobile) await page.setUserAgent(mobileUserAgent());
      await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
      // The composer renders `data-theme` from `?theme=` (so the first paint is
      // already in the theme); the media query is for anything that listens to
      // `prefers-color-scheme` instead. Only dark asks for a dark colour scheme;
      // a named theme restyles through its tokens.
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: pageTheme === "dark" ? "dark" : "light" }]);
      const pageUrl = new URL(url);
      if (pageUrl.origin === origin) pageUrl.searchParams.set("theme", pageTheme);

      await page.setRequestInterception(true);
      page.on("request", async (req) => {
        let u;
        try {
          u = new URL(req.url());
        } catch {
          return req.abort().catch(() => {});
        }
        if (u.protocol === "data:" || u.protocol === "blob:" || u.origin === origin) {
          return req.continue().catch(() => {});
        }
        const kind = req.resourceType();
        if (u.protocol !== "https:") {
          if (VISUAL.has(kind)) warnUrl(req.url(), "blocked (not https)");
          return req.abort().catch(() => {});
        }
        if (!(await hostIsPublic(u.hostname))) {
          if (VISUAL.has(kind)) warnUrl(req.url(), "blocked (private or unresolvable host)");
          return req.abort().catch(() => {});
        }
        req.continue().catch(() => {});
      });
      page.on("requestfailed", (req) => {
        if (VISUAL.has(req.resourceType()) && !req.url().startsWith("data:")) {
          warnUrl(req.url(), `${req.resourceType()} failed to load (${req.failure()?.errorText ?? "failed"})`);
        }
      });
      page.on("response", (res) => {
        const kind = res.request().resourceType();
        if (VISUAL.has(kind) && res.status() >= 400) warnUrl(res.url(), `${kind} returned HTTP ${res.status()}`);
      });

      try {
        await page.goto(pageUrl.href, { waitUntil: "networkidle0", timeout: remaining() });
      } catch (err) {
        // A page that never went network-idle (a polling script, a slow CDN) is
        // still worth a picture: capture what is there and say so.
        if (!String(err?.message).includes("timeout")) throw err;
        warn(`page did not finish loading in time; captured what had rendered`);
      }

      // The ready signal: webfonts settled, every image loaded or failed, every
      // custom element upgraded, then two frames so layout and paint have caught
      // up. Anything still pending at the deadline becomes a warning, not a hang.
      const pending = await page
        .evaluate(async (budget) => {
          const late = [];
          const within = (p, label) =>
            Promise.race([p.then(() => null), new Promise((r) => setTimeout(() => r(label), budget))]);
          const waits = [within(document.fonts.ready, "webfonts")];
          for (const img of document.images) {
            if (!img.complete) {
              waits.push(
                within(
                  new Promise((r) => {
                    img.addEventListener("load", r, { once: true });
                    img.addEventListener("error", r, { once: true });
                  }),
                  `image ${img.currentSrc || img.src}`,
                ),
              );
            }
          }
          const undefinedTags = new Set([...document.querySelectorAll(":not(:defined)")].map((el) => el.localName));
          for (const tag of undefinedTags) waits.push(within(customElements.whenDefined(tag), `<${tag}> never upgraded`));
          for (const r of await Promise.all(waits)) if (r) late.push(r);
          const broken = [...document.images]
            .filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src))
            .map((img) => ({ url: img.currentSrc || img.src, message: "image did not render" }));
          const fonts = [...document.fonts]
            .filter((f) => f.status === "error")
            .map((f) => `webfont failed: ${f.family}`);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return { late: [...late.map((l) => `still loading at capture: ${l}`), ...fonts], broken };
        }, remaining())
        .catch(() => ({ late: [], broken: [] }));
      pending.late.forEach(warn);
      for (const { url: src, message } of pending.broken) warnUrl(src, message);

      // `?state=` overlays open on their own schedule (a sheet may build its
      // dialog after DOMContentLoaded); wait for the composer's verdict, and say
      // so when the state matched nothing rather than show the closed page.
      const stateResult = await page
        .evaluate(async (budget) => {
          if (!window.__tfStateReady) return null;
          return Promise.race([window.__tfStateReady, new Promise((r) => setTimeout(() => r(null), budget))]);
        }, Math.min(3000, remaining()))
        .catch(() => null);
      if (stateResult && !stateResult.matched) {
        warn(`state "${stateResult.state}" matched no element; rendered without it`);
      }

      // A page that knows when it is done says so: the comparison grid exposes
      // `window.__tfReady` (every cell loaded and measured) and its findings as
      // `window.__tfResult`, which go back to the caller as `data`.
      const result = await page
        .evaluate(async (budget) => {
          if (!window.__tfReady) return null;
          const finished = await Promise.race([
            window.__tfReady.then(() => true),
            new Promise((r) => setTimeout(() => r(false), budget)),
          ]);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return { finished, result: window.__tfResult ?? null };
        }, remaining())
        .catch(() => null);
      if (result) {
        if (!result.finished) warn("the page did not report ready in time; captured what had rendered");
        if (result.result) pageData = result.result;
      }

      if (fullPage) await growToPage(page);
      // #632: what a device frame's status strip is filled and inked by — the
      // page's own top colour and `data-status-bar`, the theme's appearance and
      // `--background` — read by the composer's status runtime in THIS viewport
      // (the frame's screen below the bar), as the canvas and the export read it.
      const status =
        frame === "device"
          ? await page.evaluate(() => (typeof window.__tfStatusBar === "function" ? window.__tfStatusBar() : null)).catch(() => null)
          : null;
      let png = Buffer.from(await page.screenshot({ type: "png" }));
      if (frame !== "none") {
        png = await frameCapture(target, { png, frame, device, width, dpr, fullPage, mobile, warn, status });
      }
      return png;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /// Full page: make the VIEWPORT as tall as the page, then take a normal
  /// screenshot. Capturing beyond a screen-sized viewport (Puppeteer's
  /// `fullPage`) leaves the layout thinking the screen is one screen tall, so a
  /// `sticky bottom-0` footer is drawn mid-page over the content and
  /// `min-h-screen` is sized against the first screen. Resizing can itself grow
  /// the page (anything sized in `vh`), so re-measure after each resize, up to
  /// three passes.
  async function growToPage(page) {
    const measure = () =>
      page.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return Math.ceil((document.scrollingElement ?? document.documentElement).scrollHeight);
      });
    let viewportHeight = height;
    let pageHeight = await measure();
    for (let pass = 0; pass < 3 && pageHeight > viewportHeight && viewportHeight < MAX_FULL_PAGE_HEIGHT; pass++) {
      viewportHeight = Math.min(pageHeight, MAX_FULL_PAGE_HEIGHT);
      await page.setViewport({
        width,
        height: viewportHeight,
        deviceScaleFactor: dpr,
        isMobile: mobile,
        hasTouch: mobile,
      });
      pageHeight = await measure();
    }
    if (pageHeight > viewportHeight) {
      warn(
        viewportHeight >= MAX_FULL_PAGE_HEIGHT
          ? `full page cut at ${MAX_FULL_PAGE_HEIGHT}px of ${pageHeight}px`
          : `page grows with the screen height (sized in vh?); captured ${viewportHeight}px of ${pageHeight}px`,
      );
    }
  }

  const started = Date.now();
  const remaining = () => Math.max(1000, timeoutMs - (Date.now() - started));
  const themes = theme === "both" ? ["light", "dark"] : [theme];
  const shots = [];
  for (const t of themes) shots.push(await shoot(t, remaining));
  const joined = shots.length === 1 ? shots[0] : await sideBySide(target, shots, dpr);
  const png = await fitWithin(target, joined, maxPx);
  return { png, warnings, data: pageData };
}
