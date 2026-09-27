/**
 * `taskflow init` (also `taskflow-mcp init`) — the post-install walkthrough.
 *
 * Asks which coding agent(s) ("harnesses") to wire up and at what scope, then:
 *   1. registers the `taskflow-mcp` server with each harness — through the
 *      harness's own CLI when it is on PATH, else by merging its config file;
 *   2. for Claude Code, offers the lifecycle hooks;
 *   3. finds `.taskflow.json`, or creates one by minting an agent when given a
 *      user token (reusing `--mint`'s request), or explains the manual step;
 *   4. runs the `--doctor` check;
 *   5. prints the next steps, ending at the web app.
 *
 * Everything that touches the outside world — files, PATH, child processes,
 * the network, the terminal — comes in through {@link InitDeps}, so the plan
 * and the merges are tested against fake paths and never the real home dir.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { findConfigPath, CONFIG_FILENAME, type TaskflowConfig } from "./config.js";
import { requestMint, type FetchLike } from "./mint.js";
import { runDoctor } from "./doctor.js";
import {
  HOOK_COMMAND,
  MCP_COMMAND,
  MergeError,
  SERVER_NAME,
  jsonHasServer,
  mergeClaudeHooks,
  mergeCodexToml,
  mergeGitignore,
  mergeMcpServersJson,
  mergeOpencodeJson,
  simpleDiff,
  tomlHasServer,
  type MergeResult,
} from "./init-config.js";

/** The hosted app. A self-hosted install passes `--app-url`. */
export const DEFAULT_APP_URL = "https://taskflow.supercodehive.com";
/** The hosted API — what `.taskflow.json`'s `server` points at. */
export const DEFAULT_SERVER_URL = "https://api.taskflow.supercodehive.com";

export const HARNESSES = ["claude", "codex", "gemini", "cursor", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];
export type Scope = "user" | "project";

export const HARNESS_LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  opencode: "opencode",
};

/** Accepted spellings on the command line. */
const HARNESS_ALIASES: Record<string, Harness> = {
  claude: "claude",
  "claude-code": "claude",
  claudecode: "claude",
  codex: "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
  cursor: "cursor",
  opencode: "opencode",
  "open-code": "opencode",
};

/** A clear, user-facing failure. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface InitArgs {
  harnesses: Harness[];
  scope: Scope | undefined;
  yes: boolean;
  dryRun: boolean;
  /** undefined = ask (interactive) / yes (with --yes). */
  hooks: boolean | undefined;
  dir: string | undefined;
  server: string | undefined;
  project: number | undefined;
  token: string | undefined;
  profile: string;
  displayName: string | undefined;
  appUrl: string | undefined;
  doctor: boolean;
  help: boolean;
}

export const INIT_USAGE = `taskflow init — connect your coding agent to TaskFlow

  taskflow init                      Interactive walkthrough.
  taskflow init --harness claude --scope user --yes
                                     Non-interactive (scripts / CI).

Options:
  --harness <names>   claude, codex, gemini, cursor, opencode (comma-separated,
                      repeatable, or "all").
  --scope <s>         user (global, every project) or project (this repo only).
  --dir <path>        Project root for --scope project and .taskflow.json
                      (default: the current directory).
  --hooks / --no-hooks
                      Install the Claude Code lifecycle hooks (default: yes).
  --server <url>      TaskFlow API for a new .taskflow.json
                      (default: ${DEFAULT_SERVER_URL}).
  --project <id>      Project id to link an agent in.
  --token <t>         YOUR user token (or TASKFLOW_USER_TOKEN) — with --project,
                      mints an agent and writes .taskflow.json.
  --profile <name>    Profile name for the minted agent (default: main).
  --display-name <s>  Display name for the minted agent.
  --app-url <url>     Your TaskFlow web app, when self-hosting
                      (default: ${DEFAULT_APP_URL}).
  --no-doctor         Skip the connection check at the end.
  --dry-run           Print what would run / be written; change nothing.
  -y, --yes           Accept defaults; never prompt.
  -h, --help          This message.`;

function takeValue(argv: string[], i: number, flag: string): string {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("-")) {
    throw new InitError(`${flag} needs a value.`);
  }
  return next;
}

export function parseHarnesses(value: string): Harness[] {
  const out: Harness[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name === "all") {
      out.push(...HARNESSES);
      continue;
    }
    const h = HARNESS_ALIASES[name];
    if (!h) {
      throw new InitError(`Unknown harness "${raw.trim()}". Choose from: ${HARNESSES.join(", ")}.`);
    }
    out.push(h);
  }
  return [...new Set(out)];
}

export function parseScope(value: string): Scope {
  const v = value.trim().toLowerCase();
  if (v === "user" || v === "global") return "user";
  if (v === "project" || v === "local" || v === "repo") return "project";
  throw new InitError(`Unknown scope "${value}". Use "user" (global) or "project".`);
}

/** Parse `init`'s arguments (without the `init` word itself). */
export function parseInitArgs(argv: string[], env: NodeJS.ProcessEnv = {}): InitArgs {
  const args: InitArgs = {
    harnesses: [],
    scope: undefined,
    yes: false,
    dryRun: false,
    hooks: undefined,
    dir: undefined,
    server: undefined,
    project: undefined,
    token: env.TASKFLOW_USER_TOKEN || undefined,
    profile: "main",
    displayName: undefined,
    appUrl: undefined,
    doctor: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = takeValue(argv, i, arg);
      i++;
      return v;
    };
    switch (arg) {
      case "--harness":
      case "--harnesses":
      case "--agent":
        args.harnesses = [...new Set([...args.harnesses, ...parseHarnesses(value())])];
        break;
      case "--scope":
        args.scope = parseScope(value());
        break;
      case "--global":
      case "--user":
        args.scope = "user";
        break;
      case "--project-scope":
      case "--local":
        args.scope = "project";
        break;
      case "-y":
      case "--yes":
        args.yes = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--hooks":
        args.hooks = true;
        break;
      case "--no-hooks":
        args.hooks = false;
        break;
      case "--dir":
        args.dir = value();
        break;
      case "--server":
        args.server = value();
        break;
      case "--project": {
        const v = value();
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) throw new InitError(`--project must be a project id, got "${v}".`);
        args.project = n;
        break;
      }
      case "--token":
        args.token = value();
        break;
      case "--profile":
        args.profile = value();
        break;
      case "--display-name":
        args.displayName = value();
        break;
      case "--app-url":
        args.appUrl = value();
        break;
      case "--no-doctor":
        args.doctor = false;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new InitError(`Unknown option "${argv[i]}". Run "taskflow init --help".`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Environment + plan
// ---------------------------------------------------------------------------

/** Read-only view of the machine, for planning. */
export interface PlanEnv {
  home: string;
  /** The project root (for project scope and `.taskflow.json`). */
  dir: string;
  env: NodeJS.ProcessEnv;
  readFile(path: string): string | null;
  exists(path: string): boolean;
  /** Whether an executable is on PATH. */
  which(cmd: string): boolean;
}

export type Action =
  | {
      kind: "exec";
      harness: Harness;
      summary: string;
      cmd: string;
      args: string[];
      /** Tried when the command fails for a reason other than "already exists". */
      fallback?: Action;
    }
  | {
      kind: "write";
      harness: Harness | "taskflow";
      summary: string;
      path: string;
      before: string | null;
      after: string;
    }
  | { kind: "skip"; harness: Harness | "taskflow"; summary: string }
  | { kind: "manual"; harness: Harness | "taskflow"; summary: string; lines: string[] };

function codexHome(p: PlanEnv): string {
  return p.env.CODEX_HOME || join(p.home, ".codex");
}

/** Where each harness keeps its MCP config, per scope. `null` = no such scope. */
export function harnessConfigPath(h: Harness, scope: Scope, p: PlanEnv): string | null {
  switch (h) {
    case "claude":
      // User scope lives inside ~/.claude.json — Claude Code's live state file,
      // which we only ever READ; writes go through the `claude` CLI.
      return scope === "user" ? join(p.home, ".claude.json") : join(p.dir, ".mcp.json");
    case "codex":
      // Codex reads MCP servers from its home config only.
      return join(codexHome(p), "config.toml");
    case "gemini":
      return scope === "user" ? join(p.home, ".gemini", "settings.json") : join(p.dir, ".gemini", "settings.json");
    case "cursor":
      return scope === "user" ? join(p.home, ".cursor", "mcp.json") : join(p.dir, ".cursor", "mcp.json");
    case "opencode":
      return scope === "user"
        ? join(p.env.XDG_CONFIG_HOME || join(p.home, ".config"), "opencode", "opencode.json")
        : join(p.dir, "opencode.json");
  }
}

/** Manual instructions for one harness — the fallback when we won't write. */
export function manualInstructions(h: Harness, scope: Scope, p: PlanEnv): string[] {
  const path = harnessConfigPath(h, scope, p);
  switch (h) {
    case "claude":
      return [
        `Run: claude mcp add --scope ${scope} ${SERVER_NAME} -- ${MCP_COMMAND}`,
        scope === "project"
          ? `or add to ${path}: {"mcpServers":{"${SERVER_NAME}":{"command":"${MCP_COMMAND}","args":[]}}}`
          : "(install Claude Code first if the claude command is missing)",
      ];
    case "codex":
      return [
        `Run: codex mcp add ${SERVER_NAME} -- ${MCP_COMMAND}`,
        `or append to ${path}:`,
        `  [mcp_servers.${SERVER_NAME}]`,
        `  command = "${MCP_COMMAND}"`,
        "  args = []",
      ];
    case "gemini":
    case "cursor":
      return [`Add to ${path}:`, `  {"mcpServers":{"${SERVER_NAME}":{"command":"${MCP_COMMAND}","args":[]}}}`];
    case "opencode":
      return [
        `Add to ${path}:`,
        `  {"mcp":{"${SERVER_NAME}":{"type":"local","command":["${MCP_COMMAND}"],"enabled":true}}}`,
      ];
  }
}

function writeOrManual(
  h: Harness | "taskflow",
  path: string,
  before: string | null,
  merge: (text: string | null) => MergeResult,
  what: string,
  manual: string[],
): Action {
  try {
    const r = merge(before);
    if (!r.changed) return { kind: "skip", harness: h, summary: `${what} already in ${path}` };
    return { kind: "write", harness: h, summary: `${what} → ${path}`, path, before, after: r.text };
  } catch (err) {
    if (err instanceof MergeError) {
      return { kind: "manual", harness: h, summary: `cannot safely edit ${path}: ${err.message}`, lines: manual };
    }
    throw err;
  }
}

/** Plan the MCP registration for one harness. */
export function planRegistration(h: Harness, requested: Scope, p: PlanEnv): Action[] {
  const out: Action[] = [];
  let scope = requested;
  if (h === "codex" && scope === "project") {
    out.push({
      kind: "skip",
      harness: h,
      summary:
        "Codex keeps MCP servers in its user config (~/.codex/config.toml); registering there. " +
        "The server still reads .taskflow.json from the directory Codex runs in.",
    });
    scope = "user";
  }
  const path = harnessConfigPath(h, scope, p)!;
  const manual = manualInstructions(h, scope, p);
  const current = p.readFile(path);
  const label = `${HARNESS_LABEL[h]} MCP server "${SERVER_NAME}"`;

  switch (h) {
    case "claude": {
      if (jsonHasServer(current)) {
        out.push({ kind: "skip", harness: h, summary: `${label} already registered (${path})` });
        return out;
      }
      const fallback =
        scope === "project"
          ? writeOrManual(h, path, current, (t) => mergeMcpServersJson(t, path), label, manual)
          : ({ kind: "manual", harness: h, summary: `register ${label} by hand`, lines: manual } as Action);
      if (p.which("claude")) {
        out.push({
          kind: "exec",
          harness: h,
          summary: `${label} (${scope} scope) via the claude CLI`,
          cmd: "claude",
          args: ["mcp", "add", "--scope", scope, SERVER_NAME, "--", MCP_COMMAND],
          fallback,
        });
      } else {
        out.push(fallback);
      }
      return out;
    }
    case "codex": {
      if (tomlHasServer(current)) {
        out.push({ kind: "skip", harness: h, summary: `${label} already registered (${path})` });
        return out;
      }
      const fallback = writeOrManual(h, path, current, mergeCodexToml, label, manual);
      if (p.which("codex")) {
        out.push({
          kind: "exec",
          harness: h,
          summary: `${label} via the codex CLI`,
          cmd: "codex",
          args: ["mcp", "add", SERVER_NAME, "--", MCP_COMMAND],
          fallback,
        });
      } else {
        out.push(fallback);
      }
      return out;
    }
    case "gemini":
    case "cursor":
      out.push(writeOrManual(h, path, current, (t) => mergeMcpServersJson(t, path), label, manual));
      return out;
    case "opencode": {
      // opencode also accepts opencode.jsonc; a JSONC file is left to the user.
      const jsonc = path.replace(/\.json$/, ".jsonc");
      if (p.exists(jsonc)) {
        out.push({
          kind: "manual",
          harness: h,
          summary: `${jsonc} exists (JSON with comments) — not editing it`,
          lines: manualInstructions(h, scope, p).map((l) => l.replace(path, jsonc)),
        });
        return out;
      }
      out.push(writeOrManual(h, path, current, (t) => mergeOpencodeJson(t, path), label, manual));
      return out;
    }
  }
}

/** Plan the Claude Code hooks. */
export function planHooks(scope: Scope, p: PlanEnv): Action {
  const path = scope === "user" ? join(p.home, ".claude", "settings.json") : join(p.dir, ".claude", "settings.json");
  return writeOrManual(
    "claude",
    path,
    p.readFile(path),
    (t) => mergeClaudeHooks(t, path),
    `Claude Code hooks (${HOOK_COMMAND})`,
    [`Add the "hooks" block from the taskflow-mcp README to ${path}.`],
  );
}

export interface PlanInput {
  harnesses: Harness[];
  scope: Scope;
  hooks: boolean;
}

/** The whole registration plan. Pure over {@link PlanEnv}. */
export function buildPlan(input: PlanInput, p: PlanEnv): Action[] {
  const actions: Action[] = [];
  for (const h of input.harnesses) {
    actions.push(...planRegistration(h, input.scope, p));
    if (h === "claude" && input.hooks) actions.push(planHooks(input.scope, p));
  }
  return actions;
}

/** Render a plan for `--dry-run` (and for the confirm prompt). */
export function describePlan(actions: Action[], withDiffs: boolean): string[] {
  const lines: string[] = [];
  for (const a of actions) {
    switch (a.kind) {
      case "exec":
        lines.push(`  run    ${a.cmd} ${a.args.join(" ")}`);
        lines.push(`         (${a.summary})`);
        break;
      case "write":
        lines.push(`  write  ${a.summary}${a.before === null ? " (new file)" : ` (backup: ${a.path}.bak)`}`);
        if (withDiffs) for (const d of simpleDiff(a.before, a.after)) lines.push(`         ${d}`);
        break;
      case "skip":
        lines.push(`  ok     ${a.summary}`);
        break;
      case "manual":
        lines.push(`  manual ${a.summary}`);
        for (const l of a.lines) lines.push(`         ${l}`);
        break;
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Side-effecting operations. */
export interface ApplyDeps {
  writeFile(path: string, text: string, mode?: number): void;
  copyFile(from: string, to: string): void;
  mkdirp(dir: string): void;
  exists(path: string): boolean;
  exec(cmd: string, args: string[]): ExecResult;
  log(line: string): void;
}

/** Back `path` up to `<path>.bak` (or `.bak.N` when that is taken). Returns the backup path. */
export function backupPath(path: string, exists: (p: string) => boolean): string {
  let candidate = `${path}.bak`;
  for (let n = 1; exists(candidate); n++) candidate = `${path}.bak.${n}`;
  return candidate;
}

function applyWrite(a: Extract<Action, { kind: "write" }>, d: ApplyDeps, mode?: number): void {
  if (a.before !== null && d.exists(a.path)) {
    const bak = backupPath(a.path, d.exists);
    d.copyFile(a.path, bak);
    d.log(`  backup ${bak}`);
  }
  d.mkdirp(dirname(a.path));
  d.writeFile(a.path, a.after, mode);
  d.log(`  wrote  ${a.summary}`);
}

/** Apply a plan. Returns the manual steps still owed by the user. */
export function applyPlan(actions: Action[], d: ApplyDeps): string[] {
  const owed: string[] = [];
  const run = (a: Action): void => {
    switch (a.kind) {
      case "skip":
        d.log(`  ok     ${a.summary}`);
        return;
      case "manual":
        d.log(`  manual ${a.summary}`);
        owed.push(...a.lines);
        return;
      case "write":
        try {
          applyWrite(a, d);
        } catch (err) {
          d.log(`  FAILED writing ${a.path}: ${(err as Error).message}`);
          owed.push(`Edit ${a.path} by hand (see "taskflow init --dry-run" for the change).`);
        }
        return;
      case "exec": {
        const r = d.exec(a.cmd, a.args);
        const output = `${r.stdout}\n${r.stderr}`;
        if (r.code === 0) {
          d.log(`  ran    ${a.cmd} ${a.args.join(" ")}`);
        } else if (/already exists|already configured|already added/i.test(output)) {
          d.log(`  ok     ${a.summary}: already registered`);
        } else {
          d.log(`  FAILED ${a.cmd} ${a.args.join(" ")} (exit ${r.code})`);
          const detail = output.trim().split("\n").filter(Boolean).slice(-2);
          for (const l of detail) d.log(`         ${l}`);
          if (a.fallback) {
            d.log("         falling back:");
            run(a.fallback);
          }
        }
        return;
      }
    }
  };
  for (const a of actions) run(a);
  return owed;
}

// ---------------------------------------------------------------------------
// .taskflow.json
// ---------------------------------------------------------------------------

/** The web app for a given API origin, when we can tell. */
export function appUrlFor(server: string | undefined, explicit: string | undefined): string | undefined {
  if (explicit) return explicit.replace(/\/$/, "");
  if (!server) return DEFAULT_APP_URL;
  try {
    const u = new URL(server);
    if (u.hostname === "api.taskflow.supercodehive.com" || u.hostname === "taskflow.supercodehive.com") {
      return DEFAULT_APP_URL;
    }
  } catch {
    // fall through
  }
  return undefined; // self-hosted: we don't know where its frontend lives
}

/** Build a fresh single-profile `.taskflow.json` from a minted profile. */
export function newConfig(
  server: string,
  project: number,
  profileName: string,
  profile: TaskflowConfig["profiles"][string],
): TaskflowConfig {
  return { server: server.replace(/\/$/, ""), project, default_profile: profileName, profiles: { [profileName]: profile } };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface Prompter {
  ask(question: string): Promise<string>;
  close(): void;
}

export interface InitDeps extends ApplyDeps {
  plan: PlanEnv;
  interactive: boolean;
  prompter?: Prompter;
  fetch?: FetchLike;
  /** Runs the doctor from `dir`; returns its exit code. */
  doctor(dir: string): Promise<number>;
}

async function askChoice<T extends string>(
  pr: Prompter,
  question: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  defaults: T[],
  multi: boolean,
): Promise<T[]> {
  const lines = options.map((o, i) => `  ${i + 1}) ${o.label}${defaults.includes(o.value) ? "  (default)" : ""}`);
  const hint = multi ? "numbers or names, comma-separated" : "number or name";
  for (;;) {
    const raw = (await pr.ask(`${question}\n${lines.join("\n")}\n[${hint}; Enter = default] > `)).trim();
    if (!raw) {
      if (defaults.length) return defaults;
      continue;
    }
    const picks: T[] = [];
    let bad = false;
    for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
      const n = Number(part);
      const byNum = Number.isInteger(n) ? options[n - 1] : undefined;
      const byName = options.find((o) => o.value === part.toLowerCase() || HARNESS_ALIASES[part.toLowerCase()] === o.value);
      const hit = byNum ?? byName;
      if (!hit) bad = true;
      else picks.push(hit.value);
    }
    if (!bad && picks.length && (multi || picks.length === 1)) return [...new Set(picks)];
  }
}

async function askYesNo(pr: Prompter, question: string, dflt: boolean): Promise<boolean> {
  const raw = (await pr.ask(`${question} ${dflt ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  if (!raw) return dflt;
  return raw.startsWith("y");
}

/** Which harness CLIs / config dirs are present, for the default selection. */
export function detectHarnesses(p: PlanEnv): Harness[] {
  const found: Harness[] = [];
  if (p.which("claude")) found.push("claude");
  if (p.which("codex")) found.push("codex");
  if (p.which("gemini")) found.push("gemini");
  if (p.which("cursor") || p.which("cursor-agent") || p.exists(join(p.home, ".cursor"))) found.push("cursor");
  if (p.which("opencode")) found.push("opencode");
  return found;
}

/**
 * The walkthrough. Returns a process exit code: 0 when every registration went
 * through (manual steps may remain), 1 on a usage error.
 */
export async function runInit(argv: string[], deps: InitDeps): Promise<number> {
  const log = deps.log;
  let args: InitArgs;
  try {
    args = parseInitArgs(argv, deps.plan.env);
  } catch (err) {
    log(`taskflow init: ${(err as Error).message}`);
    return 1;
  }
  if (args.help) {
    log(INIT_USAGE);
    return 0;
  }
  const p: PlanEnv = { ...deps.plan, dir: resolve(deps.plan.dir, args.dir ?? ".") };
  const pr = deps.interactive && !args.yes ? deps.prompter : undefined;

  log("TaskFlow setup");
  log("");

  // 1. Harnesses.
  let harnesses = args.harnesses;
  if (harnesses.length === 0) {
    const detected = detectHarnesses(p);
    if (!pr) {
      log("taskflow init: pass --harness (claude, codex, gemini, cursor, opencode) when not running interactively.");
      if (detected.length) log(`               detected on this machine: ${detected.join(", ")}`);
      return 1;
    }
    harnesses = await askChoice(
      pr,
      "Which coding agent(s) should use TaskFlow?",
      HARNESSES.map((h) => ({ value: h, label: `${HARNESS_LABEL[h]}${detected.includes(h) ? "  — detected" : ""}` })),
      detected.length ? detected : ["claude"],
      true,
    );
  }

  // 2. Scope.
  let scope = args.scope;
  if (!scope) {
    scope = pr
      ? (
          await askChoice<Scope>(
            pr,
            "\nInstall scope?",
            [
              { value: "user", label: "user    — global: every project on this machine" },
              { value: "project", label: `project — only ${p.dir}` },
            ],
            ["user"],
            false,
          )
        )[0]!
      : "user";
  }

  // 3. Hooks (Claude Code only).
  let hooks = args.hooks ?? true;
  if (harnesses.includes("claude") && args.hooks === undefined && pr) {
    hooks = await askYesNo(
      pr,
      "\nInstall the Claude Code hooks (live session + activity logging on the board)?",
      true,
    );
  }

  // 4. Plan + confirm + apply.
  const plan = buildPlan({ harnesses, scope, hooks }, p);
  log("");
  log(args.dryRun ? "Plan (dry run — nothing will change):" : "Plan:");
  for (const l of describePlan(plan, args.dryRun)) log(l);
  log("");

  let owed: string[] = [];
  const hasWork = plan.some((a) => a.kind === "exec" || a.kind === "write");
  if (args.dryRun) {
    owed = plan.flatMap((a) => (a.kind === "manual" ? a.lines : []));
  } else if (hasWork && pr && !(await askYesNo(pr, "Apply these changes?", true))) {
    log("Nothing changed.");
    pr.close();
    return 0;
  } else {
    owed = applyPlan(plan, deps);
    log("");
  }

  // 5. .taskflow.json
  let configPath: string | undefined;
  try {
    configPath = findConfigPath({ startDir: p.dir, env: p.env });
  } catch {
    configPath = undefined;
  }
  let server = args.server;
  let project = args.project;
  let token = args.token;
  let createdConfig = false;
  if (configPath) {
    log(`Credentials: found ${configPath}`);
  } else {
    log(`Credentials: no ${CONFIG_FILENAME} in ${p.dir} or its parents.`);
    if (pr && !(project && token)) {
      const want = await askYesNo(
        pr,
        "Link an agent now? This needs a TaskFlow account, a project id and YOUR user token.",
        false,
      );
      if (want) {
        server = (await pr.ask(`  API server [${server ?? DEFAULT_SERVER_URL}]: `)).trim() || server;
        const rawProject = (await pr.ask(`  Project id${project ? ` [${project}]` : ""}: `)).trim();
        if (rawProject) project = Number(rawProject);
        token = (await pr.ask("  User token (input is visible): ")).trim() || token;
      }
    }
    if (project && Number.isInteger(project) && project > 0 && token) {
      const srv = (server ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
      const target = join(p.dir, CONFIG_FILENAME);
      const displayName = args.displayName ?? `${HARNESS_LABEL[harnesses[0] ?? "claude"]} (${args.profile})`;
      if (args.dryRun) {
        log(`  would mint agent "${displayName}" (profile ${args.profile}) in project ${project} at ${srv}`);
        log(`  would write ${target}`);
      } else {
        try {
          const profile = await requestMint(
            srv,
            project,
            { name: args.profile, displayName, token },
            token,
            deps.fetch,
          );
          const cfg = newConfig(srv, project, args.profile, profile);
          deps.writeFile(target, `${JSON.stringify(cfg, null, 2)}\n`, 0o600);
          configPath = target;
          createdConfig = true;
          log(`  minted agent ${profile.agent_id} — wrote ${target}`);
        } catch (err) {
          log(`  could not link an agent: ${(err as Error).message}`);
        }
      }
      // The file holds secret keys: keep it out of git.
      if (p.exists(join(p.dir, ".git")) || p.exists(join(p.dir, ".gitignore"))) {
        const gi = join(p.dir, ".gitignore");
        const r = mergeGitignore(p.readFile(gi));
        if (r.changed) {
          if (args.dryRun) log(`  would add ${CONFIG_FILENAME} to ${gi}`);
          else if (createdConfig) {
            deps.writeFile(gi, r.text);
            log(`  added ${CONFIG_FILENAME} to ${gi}`);
          }
        }
      }
    }
  }
  pr?.close();

  // 6. Doctor.
  if (configPath && args.doctor && !args.dryRun) {
    log("");
    log("Checking the connection (taskflow-mcp --doctor):");
    await deps.doctor(p.dir);
  }

  // 7. Next steps.
  const app = appUrlFor(server, args.appUrl);
  log("");
  log("Next steps:");
  let n = 1;
  const step = (s: string): void => {
    log(`  ${n++}. ${s}`);
  };
  for (const l of owed) step(l);
  step(
    `Restart ${harnesses.map((h) => HARNESS_LABEL[h]).join(" / ")} so it picks up the "${SERVER_NAME}" MCP server.`,
  );
  const needsCredentials = !configPath && !(args.dryRun && project && token);
  const where = app ?? "your own TaskFlow frontend (self-hosted; pass --app-url to have it printed here)";
  if (needsCredentials) {
    step("Once .taskflow.json exists, verify with: taskflow-mcp --doctor");
    step("Ask your agent to call whoami — it should answer with its TaskFlow identity.");
    step(
      `Sign up or log in at ${where}. Create a project, open its API Base page and link an agent ` +
        `(profile "main"), then save the block it shows as ${join(p.dir, CONFIG_FILENAME)} ` +
        "(keep it out of git) — or re-run: taskflow init --project <id> --token <your user token>",
    );
  } else {
    step("Ask your agent to call whoami — it should answer with its TaskFlow identity.");
    step(`Sign up or log in at ${where} to watch your agents work.`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

/** Is `cmd` an executable on PATH? */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, cmd + ext), fsConstants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/** Wire {@link runInit} to the real machine and terminal. */
export async function runInitCommand(argv: string[]): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let rl: ReturnType<typeof createInterface> | undefined;
  const prompter: Prompter | undefined = interactive
    ? {
        ask: (q) => {
          rl ??= createInterface({ input: process.stdin, output: process.stdout });
          return rl.question(q);
        },
        close: () => {
          rl?.close();
          rl = undefined;
        },
      }
    : undefined;
  try {
    return await runInit(argv, {
      interactive,
      prompter,
      plan: {
        home: homedir(),
        dir: process.cwd(),
        env: process.env,
        readFile: (path) => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return null;
          }
        },
        exists: existsSync,
        which: (cmd) => onPath(cmd),
      },
      writeFile: (path, text, mode) => writeFileSync(path, text, mode === undefined ? "utf8" : { encoding: "utf8", mode }),
      copyFile: copyFileSync,
      mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
      exists: existsSync,
      exec: (cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
        return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
      },
      log: (line) => process.stdout.write(`${line}\n`),
      doctor: (dir) => runDoctor({ startDir: dir }),
    });
  } finally {
    prompter?.close();
  }
}
