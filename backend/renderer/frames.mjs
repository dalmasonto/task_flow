/// frames.mjs — dress a captured screen the way the Design Surface's export
/// does: a real device frame, the classic bezel, or none (rounded corners and
/// a soft shadow). The drawing is a port of v2_fe's
/// `pages/design/export/export-run.ts` (`inDeviceFrame`, `inClassicChrome`,
/// `roundAndShadow`) and `lib/design-frames.ts` (`statusBarHtml`), run inside
/// a second, network-less page of the same headless Chromium, so an agent's
/// screenshot and an operator's export are the same picture. The tables live
/// in ./frame-data.json, which a v2_fe test compares against the UI's own.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const data = JSON.parse(readFileSync(new URL("./frame-data.json", import.meta.url), "utf8"));
const devicesCss = readFileSync(createRequire(import.meta.url).resolve("devices.css/dist/devices.min.css"), "utf8");

/// The devices.css frame a preset wears, with its measurements — or null.
export function deviceFrame(device) {
  const frame = data.frames[device];
  const metrics = frame ? data.metrics[frame] : undefined;
  return frame && metrics ? { frame, metrics } : null;
}

/// The viewport height to capture at for a device frame: the frame's screen
/// below its status bar, scaled to the device width — the UI's
/// `captureViewport` (commit 4543d25). At the preset's own height the frame's
/// cover-fit would crop the bottom of every page.
export function framedCaptureHeight(device, width, height) {
  const f = deviceFrame(device);
  return f ? Math.round(((f.metrics.screenH - f.metrics.statusBar) * width) / f.metrics.screenW) : height;
}

/// The classic chrome group: the preset's own, or a guess from the size for a
/// custom viewport (no frame for a Tailwind breakpoint, as in the UI).
function classicGroup(device, width, mobile) {
  const group = data.groups[device];
  if (group) return group === "breakpoint" ? null : group;
  if (mobile) return width < 600 ? "phone" : "tablet";
  return "laptop";
}

/// Width and height of a PNG from its IHDR chunk.
const pngSize = (png) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

/// Dress `png` (captured at `width` CSS px and `dpr`) in `frame`, returning a
/// new PNG buffer. Anything that cannot be drawn as asked falls back one step
/// (device → classic → none) and says so through `warn`.
export async function frameCapture(browser, { png, frame, device, width, dpr, fullPage, mobile, warn }) {
  const size = pngSize(png);
  const shot = { dataUrl: `data:image/png;base64,${png.toString("base64")}`, width, height: size.h / dpr };

  let mode = frame;
  if (mode === "device" && fullPage) {
    warn("a device frame shows one screen, so this full-page capture uses the classic frame");
    mode = "classic";
  }
  if (mode === "device" && !deviceFrame(device)) {
    warn(`no device frame for '${device || `${width}px custom`}'; used the classic frame`);
    mode = "classic";
  }
  const group = mode === "classic" ? classicGroup(device, width, mobile) : null;
  if (mode === "classic" && !group) {
    warn(`'${device}' is a breakpoint width with no device, so it has no classic frame; drawn without one`);
    mode = "none";
  }

  const page = await browser.newPage();
  try {
    if (mode === "device") {
      const { frame: name, metrics } = deviceFrame(device);
      // Render the frame at its own CSS size with a device scale that keeps
      // the capture's resolution — `domToPng`'s `scale` in the UI export.
      const scale = Math.min(4, Math.max(1, size.w / metrics.screenW));
      await page.setViewport({ width: metrics.w + 48, height: metrics.h + 48, deviceScaleFactor: scale });
      await page.setContent(
        `<!doctype html><html><head><style>${devicesCss}${data.frameCss}html,body{margin:0;background:transparent}</style></head><body></body></html>`,
      );
      await page.evaluate(inDeviceFrame, {
        shot,
        frame: name,
        metrics,
        barStyle: data.statusStyles[name] ?? null,
        statusBarSource: statusBarHtml.toString(),
      });
      const holder = await page.$("#holder");
      return Buffer.from(await holder.screenshot({ type: "png", omitBackground: true }));
    }
    const dataUrl =
      mode === "classic"
        ? await page.evaluate(inClassicChrome, { shot, chrome: data.chrome[group] })
        : await page.evaluate(roundAndShadow, { shot, radiusCss: 8 });
    return Buffer.from(dataUrl.split(",")[1], "base64");
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// In-page drawing. Each function below is serialised into the page by
// `page.evaluate`, so it may use only browser globals and its own argument.
// ---------------------------------------------------------------------------

async function inDeviceFrame({ shot, frame, metrics, barStyle, statusBarSource }) {
  const statusBarHtml = new Function(`return (${statusBarSource})`)();
  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not read the captured image."));
      img.src = src;
    });
  const source = await loadImage(shot.dataUrl);
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const pctx = probe.getContext("2d");
  pctx.drawImage(source, 2, 2, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
  const top = `rgb(${r}, ${g}, ${b})`;
  const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;

  const holder = document.createElement("div");
  holder.id = "holder";
  Object.assign(holder.style, { display: "inline-block", padding: "24px", background: "transparent" });
  holder.innerHTML = `
    <div class="tf-frame device device-${frame}">
      <div class="device-frame"><img class="device-screen" alt="" /></div>
      <div class="device-stripe"></div><div class="device-header"></div>
      <div class="device-sensors"></div><div class="device-btns"></div>
      <div class="device-power"></div><div class="device-home"></div>
    </div>`;
  const img = holder.querySelector("img");
  Object.assign(img.style, {
    objectFit: "cover",
    objectPosition: "top",
    boxSizing: "border-box",
    paddingTop: `${metrics.statusBar}px`,
    background: top,
  });
  if (metrics.statusBar && barStyle) {
    const bar = document.createElement("div");
    bar.innerHTML = statusBarHtml(barStyle, metrics.screenW, metrics.statusBar, dark ? "#f5f5f5" : "#0a0a0a");
    Object.assign(bar.style, { position: "absolute", left: `${metrics.screenX}px`, top: `${metrics.screenY}px`, zIndex: "2" });
    holder.querySelector(".device").appendChild(bar);
  }
  img.src = shot.dataUrl;
  document.body.appendChild(holder);
  await img.decode();
  await document.fonts.ready;
}

async function inClassicChrome({ shot, chrome }) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not read the captured image."));
    i.src = shot.dataUrl;
  });
  const s = img.naturalWidth / shot.width;
  const { padding: p } = chrome;
  const border = 1;
  const margin = 24;
  const w = shot.width + p.left + p.right + border * 2;
  const h = shot.height + p.top + p.bottom + border * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((w + margin * 2) * s);
  canvas.height = Math.round((h + margin * 2) * s);
  const ctx = canvas.getContext("2d");
  ctx.scale(s, s);
  ctx.translate(margin, margin);

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, chrome.outerRadius);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(63, 63, 70, 0.8)";
  ctx.lineWidth = border;
  ctx.beginPath();
  ctx.roundRect(border / 2, border / 2, w - border, h - border, chrome.outerRadius);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(border + p.left, border + p.top, shot.width, shot.height, chrome.innerRadius);
  ctx.clip();
  ctx.drawImage(img, border + p.left, border + p.top, shot.width, shot.height);
  ctx.restore();

  const pill = (x, y, pw, ph, fill, ring) => {
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, ph / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (ring) {
      ctx.strokeStyle = ring;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  const cx = w / 2;
  if (chrome.notch) pill(cx - 48, border + 8, 96, 16, "#18181b", "#27272a");
  if (chrome.homeIndicator) pill(cx - 56, h - border - 6 - 4, 112, 4, "#3f3f46");
  if (chrome.cameraDot) pill(cx - 3, border + 6, 6, 6, "#27272a", "rgba(82, 82, 91, 0.6)");
  if (chrome.topBar) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(border, border, w - border * 2, 22, [chrome.outerRadius, chrome.outerRadius, 0, 0]);
    ctx.fillStyle = "#18181b";
    ctx.fill();
    ctx.restore();
    for (let i = 0; i < 3; i++) pill(border + 12 + i * 14, border + 7, 8, 8, "#3f3f46");
  }
  return canvas.toDataURL("image/png");
}

async function roundAndShadow({ shot, radiusCss }) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not read the captured image."));
    i.src = shot.dataUrl;
  });
  const scale = img.naturalWidth / shot.width;
  const r = Math.max(0, radiusCss) * scale;
  const pad = Math.round(24 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth + pad * 2;
  canvas.height = img.naturalHeight + pad * 2;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.shadowColor = "rgba(15, 23, 42, 0.18)";
  ctx.shadowBlur = 18 * scale;
  ctx.shadowOffsetY = 6 * scale;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(pad, pad, img.naturalWidth, img.naturalHeight, r);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(pad, pad, img.naturalWidth, img.naturalHeight, r);
  ctx.clip();
  ctx.drawImage(img, pad, pad);
  ctx.restore();
  ctx.strokeStyle = "rgba(15, 23, 42, 0.10)";
  ctx.lineWidth = Math.max(1, scale);
  ctx.beginPath();
  ctx.roundRect(pad, pad, img.naturalWidth, img.naturalHeight, r);
  ctx.stroke();
  return canvas.toDataURL("image/png");
}

/// Port of `statusBarHtml` in v2_fe/src/lib/design-frames.ts. Self-contained
/// (it is shipped into the page as source), so its icons are inlined.
export function statusBarHtml(style, width, height, ink) {
  const signal = (i) =>
    `<svg width="18" height="12" viewBox="0 0 18 12" fill="${i}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>`;
  const wifi = (i) =>
    `<svg width="16" height="12" viewBox="0 0 16 12" fill="${i}"><path d="M8 11.5 10.4 9a3.4 3.4 0 0 0-4.8 0Z"/><path d="M8 5.2a6.6 6.6 0 0 1 4.6 1.9l1.3-1.3a8.4 8.4 0 0 0-11.8 0l1.3 1.3A6.6 6.6 0 0 1 8 5.2Z"/><path d="M8 1.6c2.8 0 5.3 1.1 7.2 2.9L16 3.6A12 12 0 0 0 0 3.6l.8.9A10.2 10.2 0 0 1 8 1.6Z"/></svg>`;
  const iosBattery = (i) =>
    `<svg width="26" height="12" viewBox="0 0 26 12" fill="none"><rect x="0.5" y="0.5" width="22" height="11" rx="3" stroke="${i}" opacity="0.4"/><rect x="2" y="2" width="17" height="8" rx="1.6" fill="${i}"/><rect x="24" y="4" width="1.5" height="4" rx="0.7" fill="${i}" opacity="0.5"/></svg>`;
  const androidBattery = (i) =>
    `<svg width="9" height="14" viewBox="0 0 9 14" fill="${i}"><rect x="2.5" y="0" width="4" height="1.6" rx="0.5"/><rect x="0" y="1.4" width="9" height="12.6" rx="1.4"/></svg>`;
  const row = "display:flex;align-items:center";
  const base = `${row};justify-content:space-between;box-sizing:border-box;width:${width}px;height:${height}px;color:${ink};font-family:'Inter Variable',Inter,system-ui,sans-serif;font-weight:600;letter-spacing:-0.01em;white-space:nowrap`;
  switch (style) {
    case "ios-island":
      return `<div style="${base};padding:0 30px 0 36px;font-size:15px"><span>9:41</span><span style="${row};gap:6px">${signal(ink)}${wifi(ink)}${iosBattery(ink)}</span></div>`;
    case "ios-classic":
      return `<div style="${base};padding:0 6px;font-size:12px"><span style="${row};gap:4px;flex:1">${signal(ink)}${wifi(ink)}</span><span>9:41</span><span style="${row};justify-content:flex-end;gap:4px;flex:1">100%${iosBattery(ink)}</span></div>`;
    case "android":
      return `<div style="${base};padding:0 18px;font-size:13px;font-weight:500"><span>9:41</span><span style="${row};gap:6px">${wifi(ink)}${signal(ink)}<span style="${row};gap:3px">100%${androidBattery(ink)}</span></span></div>`;
  }
  return "";
}

/// Two or more captures in one image, left to right with a gap (24 CSS px at
/// the capture's DPR), top-aligned, on a transparent background — theme
/// "both": light on the left, dark on the right.
export async function sideBySide(browser, pngs, dpr) {
  const page = await browser.newPage();
  try {
    const shots = pngs.map((png) => `data:image/png;base64,${png.toString("base64")}`);
    const dataUrl = await page.evaluate(
      async ({ shots, gap }) => {
        const images = await Promise.all(
          shots.map(
            (src) =>
              new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error("Could not read a captured image."));
                img.src = src;
              }),
          ),
        );
        const canvas = document.createElement("canvas");
        canvas.width = images.reduce((w, img) => w + img.naturalWidth, 0) + gap * (images.length - 1);
        canvas.height = Math.max(...images.map((img) => img.naturalHeight));
        const ctx = canvas.getContext("2d");
        let x = 0;
        for (const img of images) {
          ctx.drawImage(img, x, 0);
          x += img.naturalWidth + gap;
        }
        return canvas.toDataURL("image/png");
      },
      { shots, gap: Math.round(24 * dpr) },
    );
    return Buffer.from(dataUrl.split(",")[1], "base64");
  } finally {
    await page.close().catch(() => {});
  }
}
