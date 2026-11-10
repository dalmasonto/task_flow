/**
 * #1085: tool groups. A fresh session lists only the CORE tools; the design,
 * db, toolbox, agents-admin and terminal groups are registered but hidden until
 * the human (or the work) turns them on with `enable_tools`.
 *
 * Why: every tool's schema rides in the agent's context on every turn. The
 * design group alone is ~30 tools, and most sessions never draw a screen.
 *
 * Mechanism: the SDK's own `RegisteredTool.enable()/disable()`. A disabled tool
 * is left out of `tools/list`, and toggling one sends
 * `notifications/tools/list_changed`, so a client that honours it (Claude Code
 * does) shows the new tools without a restart. A client that doesn't still gets
 * them on its next start: `enable_tools` persists the pick per profile.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOOL_GROUPS = ["core", "design", "db", "toolbox", "agents-admin", "terminal"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];
/** The groups `enable_tools` can switch; core is always on. */
export const OPTIONAL_GROUPS = TOOL_GROUPS.filter((g) => g !== "core") as Exclude<ToolGroup, "core">[];

export const GROUP_DESCRIPTIONS: Record<ToolGroup, string> = {
  core: "identity, tasks, messages, channels, activity, reviews, decisions, wake-ups (always on)",
  design: "the design surface: pages, components, tokens, layout, screenshots, comments, versions",
  db: "the database designer: schema map, models, sample rows",
  toolbox: "the project's shared toolbox: list, get, save, install and report on tools",
  "agents-admin": "create and delete agents, set their role instructions (needs agents:manage)",
  terminal: "stream terminal output to the dashboard by hand (mirroring is automatic in tmux)",
};

/**
 * Learn-from entry points stay callable with their group off: an agent can read
 * how the design tools work before deciding to switch them on.
 */
const ALWAYS_ON = new Set(["design_guide", "db_guide"]);

const AGENTS_ADMIN = new Set(["create_agent", "delete_agent", "set_agent_instructions"]);
const TERMINAL = new Set(["capture_terminal"]);

/** Which group a tool belongs to, from its name. */
export function groupOf(name: string): ToolGroup {
  if (ALWAYS_ON.has(name)) return "core";
  if (name.startsWith("design_")) return "design";
  if (name.startsWith("db_")) return "db";
  if (name.startsWith("toolbox_")) return "toolbox";
  if (AGENTS_ADMIN.has(name)) return "agents-admin";
  if (TERMINAL.has(name)) return "terminal";
  return "core";
}

/** Keep only real optional group names (config and tool input are untrusted). */
export function cleanGroups(groups: readonly unknown[] | undefined): Exclude<ToolGroup, "core">[] {
  if (!groups) return [];
  const out = new Set<Exclude<ToolGroup, "core">>();
  for (const g of groups) {
    if ((OPTIONAL_GROUPS as readonly unknown[]).includes(g)) out.add(g as Exclude<ToolGroup, "core">);
  }
  return [...out];
}

// ---- persistence: `.taskflow/tool-groups.json`, keyed by profile ------------

function storePath(configPath: string): string {
  return join(dirname(configPath), ".taskflow", "tool-groups.json");
}

function readStore(configPath: string): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(configPath), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, string[]>;
  } catch {
    // Missing or corrupt: nothing remembered.
  }
  return {};
}

/** The groups this profile last enabled with `enable_tools`, if any. */
export function readRememberedGroups(configPath: string, profile: string): Exclude<ToolGroup, "core">[] | undefined {
  if (!configPath) return undefined;
  const entry = readStore(configPath)[profile];
  return Array.isArray(entry) ? cleanGroups(entry) : undefined;
}

/** Best-effort: failing to remember must never fail the tool call. */
export function writeRememberedGroups(configPath: string, profile: string, groups: readonly string[]): boolean {
  if (!configPath) return false;
  try {
    const store = readStore(configPath);
    store[profile] = cleanGroups(groups);
    const path = storePath(configPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The groups a session starts with. A remembered `enable_tools` pick wins (it
 * is the most recent human intent); then the profile's `tool_groups`, then the
 * file's; else core only.
 */
export function startingGroups(input: {
  remembered?: readonly string[];
  profile?: readonly string[];
  file?: readonly string[];
}): Exclude<ToolGroup, "core">[] {
  if (input.remembered) return cleanGroups(input.remembered);
  if (input.profile) return cleanGroups(input.profile);
  if (input.file) return cleanGroups(input.file);
  return [];
}

/** The hint a stale client gets when it calls a hidden tool. */
export function hiddenToolMessage(name: string): string {
  const group = groupOf(name);
  return `${name} is in the '${group}' tool group, which is off in this session. Call enable_tools({"groups":["${group}"]}) to turn it on, then call ${name} again.`;
}
