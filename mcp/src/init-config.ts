/**
 * Pure config-file merges for `taskflow init`.
 *
 * Every function here takes the CURRENT text of a harness config file (or
 * `null` when it does not exist yet) and returns the text it should become,
 * plus whether anything changed. Three rules hold for all of them:
 *
 * - **Never clobber.** Other servers, other hooks and unrelated settings are
 *   carried through untouched. An existing `taskflow` entry is left exactly as
 *   it is, even when it differs from ours — the user may have customised it
 *   (a local build path, an env block), and overwriting that is not our call.
 * - **Idempotent.** Merging into already-merged output is a no-op, so running
 *   `taskflow init` twice changes nothing the second time.
 * - **Refuse what we cannot read.** A file that is not a plain JSON object
 *   (comments, JSONC, a syntax error) throws {@link MergeError}; the caller turns
 *   that into manual instructions instead of guessing a rewrite.
 *
 * No I/O happens here, so the whole module is unit-testable.
 */

/** The command every harness runs. Resolved from PATH (the global npm install). */
export const MCP_COMMAND = "taskflow-mcp";
/** The Claude Code lifecycle hook command. */
export const HOOK_COMMAND = "taskflow-hook";
/** The server's name in every harness config. */
export const SERVER_NAME = "taskflow";

/** A file we will not rewrite, with the reason. */
export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export interface MergeResult {
  /** The file's new text (equal to the input when `changed` is false). */
  text: string;
  changed: boolean;
  /** True when a `taskflow` entry was already present and left alone. */
  alreadyPresent: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a config file as a JSON object; empty/whitespace-only counts as `{}`. */
export function parseJsonObject(text: string | null, label: string): JsonObject {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MergeError(
      `${label} is not plain JSON (${(err as Error).message}). ` +
        "It may contain comments; edit it by hand instead.",
    );
  }
  if (!isObject(parsed)) {
    throw new MergeError(`${label} does not contain a JSON object at the top level.`);
  }
  return parsed;
}

function serialize(obj: JsonObject): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Add `entry` under `obj[section][SERVER_NAME]`, creating `section` if needed.
 * Shared by every `mcpServers`-shaped file (Claude `.mcp.json`, Gemini, Cursor)
 * and by opencode's `mcp` section.
 */
function mergeSection(
  text: string | null,
  section: string,
  entry: JsonObject,
  label: string,
  seed: JsonObject = {},
): MergeResult {
  const root = parseJsonObject(text, label);
  const existing = root[section];
  if (existing !== undefined && !isObject(existing)) {
    throw new MergeError(`${label}: "${section}" exists but is not an object.`);
  }
  if (isObject(existing) && SERVER_NAME in existing) {
    return { text: text ?? "", changed: false, alreadyPresent: true };
  }
  const base = text === null || text.trim() === "" ? { ...seed } : root;
  const next: JsonObject = {
    ...base,
    [section]: { ...(isObject(existing) ? existing : {}), [SERVER_NAME]: entry },
  };
  return { text: serialize(next), changed: true, alreadyPresent: false };
}

/** The stdio entry for `mcpServers`-shaped files. */
export function stdioEntry(): JsonObject {
  return { command: MCP_COMMAND, args: [] };
}

/**
 * Merge into a file with an `mcpServers` map: Claude Code's `.mcp.json`,
 * Gemini CLI's `settings.json`, Cursor's `mcp.json`.
 */
export function mergeMcpServersJson(text: string | null, label = "config"): MergeResult {
  return mergeSection(text, "mcpServers", stdioEntry(), label);
}

/**
 * Merge into an opencode config. opencode's schema differs from the others:
 * the section is `mcp`, and a local server's `command` is ONE array holding the
 * executable and its arguments, with an explicit `type: "local"`.
 */
export function mergeOpencodeJson(text: string | null, label = "opencode.json"): MergeResult {
  return mergeSection(
    text,
    "mcp",
    { type: "local", command: [MCP_COMMAND], enabled: true },
    label,
    { $schema: "https://opencode.ai/config.json" },
  );
}

/** Matches a `[mcp_servers.taskflow]` table header, quoted or bare. */
const CODEX_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:taskflow|"taskflow"|'taskflow')\s*\]\s*(?:#.*)?$/m;

/**
 * Merge into Codex's `config.toml`. Codex's MCP servers are `[mcp_servers.<name>]`
 * tables. Appending a new table at the end of a TOML file is always valid
 * (tables may appear in any order), so this needs no TOML parser: it only has to
 * detect an existing `taskflow` table, and otherwise append one.
 */
export function mergeCodexToml(text: string | null): MergeResult {
  const current = text ?? "";
  if (CODEX_TABLE.test(current)) {
    return { text: current, changed: false, alreadyPresent: true };
  }
  const block = `[mcp_servers.${SERVER_NAME}]\ncommand = "${MCP_COMMAND}"\nargs = []\n`;
  let prefix = current;
  if (prefix.length > 0) {
    if (!prefix.endsWith("\n")) prefix += "\n";
    prefix += "\n";
  }
  return { text: `${prefix}${block}`, changed: true, alreadyPresent: false };
}

/** The Claude Code events the hook handles, and whether each takes a matcher. */
export const CLAUDE_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: "SessionStart" },
  { event: "PreToolUse", matcher: "*" },
  { event: "PostToolUse", matcher: "*" },
  { event: "Stop" },
  { event: "Notification" },
];

/** True when a hook command already runs our hook (bare, via a path, or via node). */
export function isTaskflowHookCommand(command: unknown): boolean {
  return typeof command === "string" && /(^|[\s/\\])taskflow-hook(\.mjs)?(\s|"|'|$)/.test(command);
}

function eventHasTaskflowHook(groups: unknown[]): boolean {
  return groups.some(
    (g) =>
      isObject(g) &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => isObject(h) && isTaskflowHookCommand(h.command)),
  );
}

export interface HooksMergeResult extends MergeResult {
  /** Events a hook group was added to. */
  added: string[];
}

/**
 * Merge the TaskFlow hook into a Claude Code `settings.json`. Per event: if any
 * existing group already runs `taskflow-hook`, the event is left alone;
 * otherwise one group is APPENDED, so the user's own hooks keep running first.
 */
export function mergeClaudeHooks(text: string | null, label = "settings.json"): HooksMergeResult {
  const root = parseJsonObject(text, label);
  const hooks = root.hooks;
  if (hooks !== undefined && !isObject(hooks)) {
    throw new MergeError(`${label}: "hooks" exists but is not an object.`);
  }
  const nextHooks: JsonObject = { ...(isObject(hooks) ? hooks : {}) };
  const added: string[] = [];
  for (const { event, matcher } of CLAUDE_HOOK_EVENTS) {
    const groups = nextHooks[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      throw new MergeError(`${label}: hooks.${event} exists but is not an array.`);
    }
    if (Array.isArray(groups) && eventHasTaskflowHook(groups)) continue;
    const group: JsonObject = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: HOOK_COMMAND }],
    };
    nextHooks[event] = [...(Array.isArray(groups) ? groups : []), group];
    added.push(event);
  }
  if (added.length === 0) {
    return { text: text ?? "", changed: false, alreadyPresent: true, added };
  }
  return {
    text: serialize({ ...root, hooks: nextHooks }),
    changed: true,
    alreadyPresent: false,
    added,
  };
}

/** Whether a JSON config already names a `taskflow` server under `section`. */
export function jsonHasServer(text: string | null, section = "mcpServers"): boolean {
  try {
    const root = parseJsonObject(text, "config");
    const s = root[section];
    return isObject(s) && SERVER_NAME in s;
  } catch {
    return false;
  }
}

/** Whether a Codex config.toml already has the taskflow table. */
export function tomlHasServer(text: string | null): boolean {
  return text !== null && CODEX_TABLE.test(text);
}

/** Append `.taskflow.json` to a `.gitignore` text unless an entry already covers it. */
export function mergeGitignore(text: string | null): MergeResult {
  const current = text ?? "";
  const covered = current
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === ".taskflow.json" || l === "/.taskflow.json" || l === ".taskflow*" || l === ".taskflow.*");
  if (covered) return { text: current, changed: false, alreadyPresent: true };
  const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
  return {
    text: `${prefix}# TaskFlow agent credentials (secret keys)\n.taskflow.json\n`,
    changed: true,
    alreadyPresent: false,
  };
}

/**
 * A minimal line diff for `--dry-run`: the lines removed (`-`) and added (`+`),
 * with the unchanged common prefix/suffix collapsed. Config merges only ever
 * append or insert one block, so this stays readable without an LCS.
 */
export function simpleDiff(before: string | null, after: string): string[] {
  const a = before === null || before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  if (start > 0) out.push(`  … ${start} unchanged line${start === 1 ? "" : "s"}`);
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  const tail = a.length - 1 - endA;
  if (tail > 0) out.push(`  … ${tail} unchanged line${tail === 1 ? "" : "s"}`);
  return out;
}
