/// status-chrome.mjs — #632: the device frame's status strip for a renderer
/// shot (`design_screenshot`, `--frame device`): what colour its icons are and
/// what fills it. A line-for-line port of v2_fe's
/// `src/pages/design/status-bar.ts` (`resolveStatusInk`, `frameChrome`) — the
/// rules the canvas and the FE export paint by — kept dependency-free so the
/// v2_fe test `src/lib/renderer-status-chrome.test.ts` can import it and pin
/// the two to the same answers. Change both together.
///
/// Input is what the composed page's status runtime returns from
/// `window.__tfStatusBar()`: `{ mode, background, appearance, themeBackground }`
/// (colours as `rgb(r, g, b)`), or null for a page that predates it.

export const LIGHT_INK = "#f5f5f5";
export const DARK_INK = "#0a0a0a";

const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i;

const toLinear = (channel) => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const weigh = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function fromBytes(r, g, b) {
  if ([r, g, b].some((c) => !(c >= 0 && c <= 255))) return null;
  return weigh(toLinear(r), toLinear(g), toLinear(b));
}

export function relativeLuminance(colour) {
  const v = colour.trim();
  let m = RGB.exec(v);
  if (m) return fromBytes(Number(m[1]), Number(m[2]), Number(m[3]));
  m = HEX6.exec(v);
  if (m) return fromBytes(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
  m = HEX3.exec(v);
  if (m) return fromBytes(parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16));
  m = OKLCH.exec(v);
  if (m) {
    const L = Number(m[1]) / (m[2] ? 100 : 1);
    const C = Number(m[3]);
    const h = (Number(m[4]) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s;
    const bl = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s;
    return weigh(clamp01(r), clamp01(g), clamp01(bl));
  }
  return null;
}

export function inkForBackground(colour) {
  if (!colour) return null;
  const L = relativeLuminance(colour);
  if (L === null) return null;
  return (L + 0.05) ** 2 < 0.0525 ? "light" : "dark";
}

export function contrastRatio(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const MIN_INK_CONTRAST = 3;

export function inkColour(ink) {
  return ink === "light" ? LIGHT_INK : DARK_INK;
}

/// `data-status-bar`, then the theme's appearance (yielding to the top colour
/// under 3:1), then the top colour, then the theme's background; else black.
export function resolveStatusInk({ mode, appearance, background, themeBackground }) {
  if (mode) return mode;
  if (appearance) {
    const ink = appearance === "dark" ? "light" : "dark";
    const top = background ? relativeLuminance(background) : null;
    if (top !== null) {
      const inkL = relativeLuminance(inkColour(ink));
      if (inkL !== null && contrastRatio(inkL, top) < MIN_INK_CONTRAST) {
        return inkForBackground(background) ?? ink;
      }
    }
    return ink;
  }
  return inkForBackground(background) ?? inkForBackground(themeBackground) ?? "dark";
}

/// Only an `rgb()` colour is ever painted: the page is untrusted, and its
/// runtime always normalises to rgb().
export const rgbOnly = (v) => (typeof v === "string" && v.length <= 40 && RGB.test(v) ? v : undefined);

/// The strip's ink and fill — `frameChrome` in status-bar.ts. `report` is the
/// page's `{ mode, background }` (null before/without one).
export function frameChrome({ report, appearance, themeBackground }, safeColour = rgbOnly) {
  const ink = resolveStatusInk({
    mode: report?.mode ?? null,
    appearance,
    background: report?.background ?? null,
    themeBackground,
  });
  const background = report?.background ?? safeColour(themeBackground) ?? null;
  const fallback = ink === "light" ? DARK_INK : "#ffffff";
  return {
    ink,
    stripFill: background ?? fallback,
    screenBackground: background ?? fallback,
    colorScheme: appearance ?? "normal",
  };
}

/// What `window.__tfStatusBar()` returned, validated (the page is untrusted),
/// as `frameChrome`'s input — or null when it returned nothing usable.
export function statusFromPage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (v) => (v === "light" || v === "dark" ? v : null);
  return {
    report: { mode: pick(raw.mode), background: rgbOnly(raw.background) ?? null },
    appearance: pick(raw.appearance),
    themeBackground: rgbOnly(raw.themeBackground) ?? null,
  };
}
