import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  InitError,
  appUrlFor,
  applyPlan,
  backupPath,
  buildPlan,
  describePlan,
  parseInitArgs,
  runInit,
  type Action,
  type ApplyDeps,
  type InitDeps,
  type PlanEnv,
} from "./init.js";

const HOME = "/fake/home";
const DIR = "/fake/repo";

function planEnv(files: Record<string, string> = {}, onPath: string[] = []): PlanEnv {
  return {
    home: HOME,
    dir: DIR,
    env: {},
    readFile: (p) => files[p] ?? null,
    exists: (p) => p in files,
    which: (c) => onPath.includes(c),
  };
}

describe("parseInitArgs", () => {
  it("parses the non-interactive form", () => {
    const a = parseInitArgs(["--harness", "claude,codex", "--scope", "user", "--yes", "--dry-run"]);
    expect(a.harnesses).toEqual(["claude", "codex"]);
    expect(a.scope).toBe("user");
    expect(a.yes).toBe(true);
    expect(a.dryRun).toBe(true);
  });

  it("accepts = values, repeats, aliases and 'all'", () => {
    expect(parseInitArgs(["--harness=claude-code", "--harness", "gemini"]).harnesses).toEqual(["claude", "gemini"]);
    expect(parseInitArgs(["--harness", "all"]).harnesses).toEqual(["claude", "codex", "gemini", "cursor", "opencode"]);
    expect(parseInitArgs(["--scope=global"]).scope).toBe("user");
    expect(parseInitArgs(["--scope", "project"]).scope).toBe("project");
  });

  it("reads the token from TASKFLOW_USER_TOKEN, but --token wins", () => {
    expect(parseInitArgs([], { TASKFLOW_USER_TOKEN: "env" }).token).toBe("env");
    expect(parseInitArgs(["--token", "flag"], { TASKFLOW_USER_TOKEN: "env" }).token).toBe("flag");
  });

  it("rejects unknown harnesses, scopes, options and bad project ids", () => {
    expect(() => parseInitArgs(["--harness", "vim"])).toThrow(InitError);
    expect(() => parseInitArgs(["--scope", "world"])).toThrow(InitError);
    expect(() => parseInitArgs(["--frobnicate"])).toThrow(InitError);
    expect(() => parseInitArgs(["--project", "abc"])).toThrow(InitError);
    expect(() => parseInitArgs(["--harness"])).toThrow(/needs a value/);
  });

  it("toggles hooks and doctor", () => {
    expect(parseInitArgs(["--no-hooks"]).hooks).toBe(false);
    expect(parseInitArgs(["--hooks"]).hooks).toBe(true);
    expect(parseInitArgs([]).hooks).toBeUndefined();
    expect(parseInitArgs(["--no-doctor"]).doctor).toBe(false);
  });
});

describe("buildPlan", () => {
  it("uses the claude CLI when present, with a .mcp.json fallback at project scope", () => {
    const plan = buildPlan({ harnesses: ["claude"], scope: "project", hooks: false }, planEnv({}, ["claude"]));
    expect(plan).toHaveLength(1);
    const a = plan[0]!;
    expect(a.kind).toBe("exec");
    if (a.kind !== "exec") return;
    expect([a.cmd, ...a.args]).toEqual(["claude", "mcp", "add", "--scope", "project", "taskflow", "--", "taskflow-mcp"]);
    expect(a.fallback?.kind).toBe("write");
    if (a.fallback?.kind === "write") expect(a.fallback.path).toBe(`${DIR}/.mcp.json`);
  });

  it("never writes ~/.claude.json: user scope without the CLI is manual", () => {
    const plan = buildPlan({ harnesses: ["claude"], scope: "user", hooks: false }, planEnv());
    expect(plan[0]!.kind).toBe("manual");
  });

  it("skips claude when already registered", () => {
    const files = { [`${HOME}/.claude.json`]: '{"mcpServers":{"taskflow":{"command":"x"}}}' };
    const plan = buildPlan({ harnesses: ["claude"], scope: "user", hooks: false }, planEnv(files, ["claude"]));
    expect(plan[0]!.kind).toBe("skip");
  });

  it("adds the hooks for claude to the scope's settings.json", () => {
    const plan = buildPlan({ harnesses: ["claude"], scope: "user", hooks: true }, planEnv({}, ["claude"]));
    const hooks = plan[1]!;
    expect(hooks.kind).toBe("write");
    if (hooks.kind === "write") expect(hooks.path).toBe(`${HOME}/.claude/settings.json`);
  });

  it("registers codex in ~/.codex/config.toml even at project scope, honouring CODEX_HOME", () => {
    const p = { ...planEnv(), env: { CODEX_HOME: "/fake/codexhome" } };
    const plan = buildPlan({ harnesses: ["codex"], scope: "project", hooks: true }, p);
    expect(plan[0]!.kind).toBe("skip"); // the scope note
    const w = plan[1]!;
    expect(w.kind).toBe("write");
    if (w.kind === "write") {
      expect(w.path).toBe("/fake/codexhome/config.toml");
      expect(w.after).toContain("[mcp_servers.taskflow]");
    }
  });

  it("prefers `codex mcp add` when codex is on PATH", () => {
    const plan = buildPlan({ harnesses: ["codex"], scope: "user", hooks: false }, planEnv({}, ["codex"]));
    const a = plan[0]!;
    expect(a.kind === "exec" && [a.cmd, ...a.args].join(" ")).toBe("codex mcp add taskflow -- taskflow-mcp");
  });

  it("writes gemini, cursor and opencode to the right files per scope", () => {
    const paths = (scope: "user" | "project") =>
      buildPlan({ harnesses: ["gemini", "cursor", "opencode"], scope, hooks: true }, planEnv()).map(
        (a) => (a.kind === "write" ? a.path : a.kind),
      );
    expect(paths("user")).toEqual([
      `${HOME}/.gemini/settings.json`,
      `${HOME}/.cursor/mcp.json`,
      `${HOME}/.config/opencode/opencode.json`,
    ]);
    expect(paths("project")).toEqual([`${DIR}/.gemini/settings.json`, `${DIR}/.cursor/mcp.json`, `${DIR}/opencode.json`]);
  });

  it("falls back to manual instructions for a file it cannot parse", () => {
    const files = { [`${HOME}/.gemini/settings.json`]: "{ // comment\n}" };
    const plan = buildPlan({ harnesses: ["gemini"], scope: "user", hooks: false }, planEnv(files));
    expect(plan[0]!.kind).toBe("manual");
  });

  it("leaves an opencode.jsonc alone", () => {
    const files = { [`${DIR}/opencode.jsonc`]: "{}" };
    const plan = buildPlan({ harnesses: ["opencode"], scope: "project", hooks: false }, planEnv(files));
    expect(plan[0]!.kind).toBe("manual");
  });

  it("describePlan prints a diff only when asked", () => {
    const plan = buildPlan({ harnesses: ["cursor"], scope: "user", hooks: false }, planEnv());
    expect(describePlan(plan, false).some((l) => l.includes("+ "))).toBe(false);
    expect(describePlan(plan, true).some((l) => l.includes('+     "taskflow": {'))).toBe(true);
  });
});

function fakeApply(existing: string[] = []): ApplyDeps & { writes: Record<string, string>; copies: string[][]; logs: string[]; execs: string[] } {
  const present = new Set(existing);
  const d = {
    writes: {} as Record<string, string>,
    copies: [] as string[][],
    logs: [] as string[],
    execs: [] as string[],
    writeFile: (p: string, t: string) => {
      d.writes[p] = t;
      present.add(p);
    },
    copyFile: (a: string, b: string) => {
      d.copies.push([a, b]);
      present.add(b);
    },
    mkdirp: () => {},
    exists: (p: string) => present.has(p),
    exec: (cmd: string, args: string[]) => {
      d.execs.push([cmd, ...args].join(" "));
      return { code: 1, stdout: "", stderr: "boom" };
    },
    log: (l: string) => {
      d.logs.push(l);
    },
  };
  return d;
}

describe("applyPlan", () => {
  it("backs up an existing file before writing", () => {
    const d = fakeApply(["/f.json", "/f.json.bak"]);
    const plan: Action[] = [{ kind: "write", harness: "cursor", summary: "s", path: "/f.json", before: "{}", after: "{1}" }];
    applyPlan(plan, d);
    expect(d.copies).toEqual([["/f.json", "/f.json.bak.1"]]);
    expect(d.writes["/f.json"]).toBe("{1}");
  });

  it("runs the fallback when the CLI fails", () => {
    const d = fakeApply();
    const plan: Action[] = [
      {
        kind: "exec",
        harness: "codex",
        summary: "s",
        cmd: "codex",
        args: ["mcp", "add"],
        fallback: { kind: "write", harness: "codex", summary: "w", path: "/c.toml", before: null, after: "x" },
      },
    ];
    applyPlan(plan, d);
    expect(d.execs).toEqual(["codex mcp add"]);
    expect(d.writes["/c.toml"]).toBe("x");
  });

  it("treats 'already exists' from a CLI as success", () => {
    const d = fakeApply();
    d.exec = () => ({ code: 1, stdout: "", stderr: "MCP server taskflow already exists in user config" });
    const fallback: Action = { kind: "write", harness: "claude", summary: "w", path: "/x", before: null, after: "x" };
    applyPlan([{ kind: "exec", harness: "claude", summary: "s", cmd: "claude", args: [], fallback }], d);
    expect(d.writes).toEqual({});
  });

  it("returns the manual steps", () => {
    const owed = applyPlan([{ kind: "manual", harness: "gemini", summary: "s", lines: ["do this"] }], fakeApply());
    expect(owed).toEqual(["do this"]);
  });

  it("backupPath", () => {
    expect(backupPath("/a", () => false)).toBe("/a.bak");
  });
});

describe("appUrlFor", () => {
  it("maps the hosted API to the hosted app, and knows nothing about self-hosted", () => {
    expect(appUrlFor(undefined, undefined)).toBe("https://taskflow.supercodehive.com");
    expect(appUrlFor("https://api.taskflow.supercodehive.com", undefined)).toBe("https://taskflow.supercodehive.com");
    expect(appUrlFor("http://localhost:8000", undefined)).toBeUndefined();
    expect(appUrlFor("http://localhost:8000", "http://localhost:5173/")).toBe("http://localhost:5173");
  });
});

/** Real-filesystem deps rooted in a temp dir — never the real home. */
function tempDeps(): { deps: InitDeps; home: string; dir: string; logs: string[] } {
  const root = mkdtempSync(join(tmpdir(), "taskflow-init-"));
  const home = join(root, "home");
  const dir = join(root, "repo");
  mkdirSync(home);
  mkdirSync(dir);
  const logs: string[] = [];
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const deps: InitDeps = {
    interactive: false,
    plan: { home, dir, env: { TASKFLOW_CONFIG: "" }, readFile: read, exists: existsSync, which: () => false },
    writeFile: (p, t) => writeFileSync(p, t),
    copyFile: (a, b) => writeFileSync(b, readFileSync(a)),
    mkdirp: (d) => mkdirSync(d, { recursive: true }),
    exists: existsSync,
    exec: () => ({ code: 127, stdout: "", stderr: "not found" }),
    log: (l) => logs.push(l),
    doctor: async () => 0,
  };
  return { deps, home, dir, logs };
}

describe("runInit", () => {
  it("--dry-run writes nothing and prints the plan", async () => {
    const { deps, home, logs } = tempDeps();
    const code = await runInit(["--harness", "cursor,gemini", "--scope", "user", "--yes", "--dry-run"], deps);
    expect(code).toBe(0);
    expect(readdirSync(home)).toEqual([]);
    expect(logs.join("\n")).toContain("Plan (dry run");
    expect(logs.join("\n")).toContain(join(home, ".cursor", "mcp.json"));
  });

  it("applies, backs up, and is idempotent on a re-run", async () => {
    const { deps, home, logs } = tempDeps();
    const cursor = join(home, ".cursor", "mcp.json");
    mkdirSync(dirname(cursor));
    writeFileSync(cursor, JSON.stringify({ mcpServers: { other: { command: "o" } } }));

    expect(await runInit(["--harness", "cursor", "--scope", "user", "--yes"], deps)).toBe(0);
    const merged = JSON.parse(readFileSync(cursor, "utf8"));
    expect(Object.keys(merged.mcpServers)).toEqual(["other", "taskflow"]);
    expect(existsSync(`${cursor}.bak`)).toBe(true);

    const after = readFileSync(cursor, "utf8");
    await runInit(["--harness", "cursor", "--scope", "user", "--yes"], deps);
    expect(readFileSync(cursor, "utf8")).toBe(after);
    expect(existsSync(`${cursor}.bak.1`)).toBe(false);
    expect(logs.join("\n")).toMatch(/already in/);
  });

  it("requires --harness when not interactive", async () => {
    const { deps, logs } = tempDeps();
    expect(await runInit(["--yes"], deps)).toBe(1);
    expect(logs.join("\n")).toMatch(/pass --harness/);
  });

  it("mints and writes .taskflow.json when given a project and token", async () => {
    const { deps, dir } = tempDeps();
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    let seen: { url: string; auth: string | undefined } | undefined;
    deps.fetch = async (url, init) => {
      seen = { url, auth: (init.headers as Record<string, string>).Authorization };
      return new Response(JSON.stringify({ taskflow_profile: { agent_id: 7, key: "tfk_x", display_name: "Codex CLI (main)" } }), {
        status: 201,
      });
    };
    const code = await runInit(
      ["--harness", "codex", "--yes", "--server", "http://localhost:8000", "--project", "3", "--token", "ut"],
      deps,
    );
    expect(code).toBe(0);
    expect(seen).toEqual({ url: "http://localhost:8000/api/taskflow/agents/link", auth: "Bearer ut" });
    const cfg = JSON.parse(readFileSync(join(dir, ".taskflow.json"), "utf8"));
    expect(cfg).toEqual({
      server: "http://localhost:8000",
      project: 3,
      default_profile: "main",
      profiles: { main: { agent_id: 7, key: "tfk_x", display_name: "Codex CLI (main)" } },
    });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".taskflow.json");
  });

  it("walks through the prompts interactively", async () => {
    const { deps, dir, logs } = tempDeps();
    const answers = ["4", "2", "y", "n"]; // Cursor, project scope, apply, don't link now
    const asked: string[] = [];
    deps.interactive = true;
    deps.prompter = {
      ask: async (q) => {
        asked.push(q);
        return answers.shift() ?? "";
      },
      close: () => {},
    };
    expect(await runInit([], deps)).toBe(0);
    expect(asked).toHaveLength(4);
    expect(asked[0]).toMatch(/Which coding agent/);
    expect(JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")).mcpServers.taskflow.command).toBe(
      "taskflow-mcp",
    );
    expect(logs[logs.length - 1]).toMatch(/Sign up or log in at .*API Base/);
  });

  it("ends the next steps at the web app", async () => {
    const { deps, logs } = tempDeps();
    await runInit(["--harness", "cursor", "--yes", "--dry-run"], deps);
    expect(logs[logs.length - 1]).toMatch(/Sign up or log in at https:\/\/taskflow\.supercodehive\.com/);
  });
});
