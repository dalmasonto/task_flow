/**
 * Serialize a tool payload for the `metadata_json` column.
 *
 * The old version sliced the JSON string at 1500 chars. That is worse than
 * losing the tail: a string cut mid-token is not valid JSON, so a consumer
 * cannot read ANY of it — the recorded AskUserQuestion rows ended `…"ans` and
 * their options were unrecoverable, even though most of the payload was there.
 *
 * So truncation here is STRUCTURAL. The object shape is always preserved and the
 * output always parses; when a payload is too big, individual oversized string
 * leaves are shortened and marked, so you can still see what the tool was called
 * with and exactly what was elided.
 *
 * Kept as a plain module with no dependencies so the hook needs no build step.
 */

/** The backend's `metadata_json` column limit. Use all of it. */
export const META_MAX_CHARS = 32_000;

/** Longest a single string leaf may be before shortening is even considered. */
const FIRST_STRING_CAP = 8_000;
/** Below this, shortening strings further stops helping. */
const MIN_STRING_CAP = 40;

/** Shorten one string, saying how much went missing. */
function capString(text, cap) {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…[+${text.length - cap} chars]`;
}

/** Deep copy with every string leaf capped. Structure is never altered. */
function capStrings(value, cap) {
  if (typeof value === "string") return capString(value, cap);
  if (Array.isArray(value)) return value.map((item) => capStrings(item, cap));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = capStrings(inner, cap);
    return out;
  }
  return value;
}

/**
 * Last resort for a payload that is enormous even with tiny strings (a huge
 * array, say): keep the keys and describe the values. Still valid JSON, and it
 * says what was there rather than pretending it was empty.
 */
function outline(value) {
  if (typeof value === "string") return `[string: ${value.length} chars]`;
  if (Array.isArray(value)) return [`[array: ${value.length} items]`];
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = outline(inner);
    return out;
  }
  return value;
}

/**
 * JSON for `metadata_json`, guaranteed to parse and to fit `budget`.
 * Returns undefined for nothing worth recording.
 */
export function compactMetadata(value, budget = META_MAX_CHARS) {
  if (value == null) return undefined;

  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined; // circular or unserializable — nothing honest to record
  }
  if (text === undefined) return undefined;
  if (text.length <= budget) return text;

  // Halve the per-string cap until the whole thing fits.
  for (let cap = FIRST_STRING_CAP; cap >= MIN_STRING_CAP; cap = Math.floor(cap / 2)) {
    const candidate = JSON.stringify(capStrings(value, cap));
    if (candidate !== undefined && candidate.length <= budget) return candidate;
  }

  const outlined = JSON.stringify(outline(value));
  if (outlined !== undefined && outlined.length <= budget) return outlined;
  // Even the outline is too big: record that fact rather than invalid JSON.
  return JSON.stringify({ note: "metadata too large to record" });
}
