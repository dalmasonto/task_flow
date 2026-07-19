/**
 * Serialize a tool payload for the `metadata_json` column.
 *
 * TWO RULES, learned the hard way:
 *
 * 1. NEVER slice the JSON string. A string cut mid-token does not parse, so the
 *    whole record becomes unreadable — not merely shortened. That is what left
 *    recorded AskUserQuestion rows ending `…"ans` with their options
 *    unrecoverable, despite most of the payload being present.
 *
 * 2. Do not budget the payload as a whole. A tool call is a structure, and
 *    clipping it globally means the fields that identify the call (file_path,
 *    description, flags) can be lost to make room for a body nobody needed in
 *    full. Instead, the ONE field that carries bulk is capped per tool — a
 *    Write's `content`, a Bash `command` — and everything else is recorded
 *    whole, however long the payload ends up.
 *
 * Kept dependency-free so the hook needs no build step.
 */

/**
 * The bulk-carrying field(s) of each tool we know the shape of.
 *
 * Only these are ever shortened. A tool that is not listed is recorded verbatim:
 * guessing which of its fields is "the big one" would be how the identifying
 * fields start disappearing again.
 */
const BULK_FIELDS = {
  Bash: ["command"],
  Write: ["content"],
  Edit: ["old_string", "new_string"],
  NotebookEdit: ["new_source"],
  Task: ["prompt"],
  Agent: ["prompt"],
  Workflow: ["script"],
  Artifact: ["content"],
};

/**
 * How much of a bulk field to keep. Generous on purpose — the point is to stop a
 * megabyte of file content landing in an activity row, not to make the record
 * terse. The content is already in the file; the command is not, so this is the
 * only copy of it, which argues for keeping plenty.
 */
export const BULK_FIELD_MAX_CHARS = 20_000;

/** Shorten one string, saying exactly how much went missing. */
function capString(text, cap) {
  if (typeof text !== "string" || text.length <= cap) return text;
  return `${text.slice(0, cap)}…[+${text.length - cap} chars]`;
}

/**
 * Cap the named fields wherever they appear in the payload, at any depth.
 *
 * Depth matters: MultiEdit nests its strings inside an `edits` array, and a
 * top-level-only pass would miss them entirely.
 */
function capFields(value, fields, cap, seen = new WeakSet()) {
  if (value && typeof value === "object") {
    // A cycle would recurse until the stack blows — and a crashed hook is a
    // crashed tool call. Mark it and move on instead.
    if (seen.has(value)) return "[circular]";
    seen.add(value);
  }
  if (Array.isArray(value)) return value.map((item) => capFields(item, fields, cap, seen));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        fields.includes(key) && typeof inner === "string"
          ? capString(inner, cap)
          : capFields(inner, fields, cap, seen);
    }
    return out;
  }
  return value;
}

/**
 * JSON for `metadata_json`. Always parses; never globally truncated.
 *
 * `toolName` selects the bulk-field policy. Omit it (session events,
 * notifications) and the value is recorded exactly as given.
 */
export function compactMetadata(value, toolName) {
  if (value == null) return undefined;

  const fields = toolName ? BULK_FIELDS[toolName] : undefined;
  const shaped = fields ? capFields(value, fields, BULK_FIELD_MAX_CHARS) : value;

  try {
    return JSON.stringify(shaped);
  } catch {
    // Circular or otherwise unserializable: record nothing rather than
    // something that will not parse.
    return undefined;
  }
}
