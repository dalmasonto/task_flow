import { describe, it, expect } from "vitest";
import {
  MergeError,
  isTaskflowHookCommand,
  jsonHasServer,
  mergeClaudeHooks,
  mergeCodexToml,
  mergeGitignore,
  mergeMcpServersJson,
  mergeOpencodeJson,
  simpleDiff,
  tomlHasServer,
} from "./init-config.js";

describe("mergeMcpServersJson", () => {
  it("creates the file content from nothing", () => {
    const r = mergeMcpServersJson(null);
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ mcpServers: { taskflow: { command: "taskflow-mcp", args: [] } } });
  });

  it("treats an empty file as an empty object", () => {
    expect(JSON.parse(mergeMcpServersJson("  \n").text).mcpServers.taskflow.command).toBe("taskflow-mcp");
  });

  it("keeps other servers and unrelated settings", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: ["-v"] } } });
    const out = JSON.parse(mergeMcpServersJson(before).text);
    expect(out.theme).toBe("dark");
    expect(out.mcpServers.other).toEqual({ command: "x", args: ["-v"] });
    expect(out.mcpServers.taskflow).toEqual({ command: "taskflow-mcp", args: [] });
  });

  it("is idempotent", () => {
    const once = mergeMcpServersJson(null).text;
    const twice = mergeMcpServersJson(once);
    expect(twice.changed).toBe(false);
    expect(twice.alreadyPresent).toBe(true);
    expect(twice.text).toBe(once);
  });

  // A customised entry (local build, env block) is the user's call, not ours.
  it("never overwrites an existing taskflow entry", () => {
    const before = JSON.stringify({ mcpServers: { taskflow: { command: "node", args: ["./mcp/dist/index.js"] } } });
    const r = mergeMcpServersJson(before);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(before);
  });

  it("refuses JSON with comments rather than guessing", () => {
    expect(() => mergeMcpServersJson('{ // hi\n "a": 1 }')).toThrow(MergeError);
  });

  it("refuses a non-object top level or section", () => {
    expect(() => mergeMcpServersJson("[]")).toThrow(MergeError);
    expect(() => mergeMcpServersJson('{"mcpServers": []}')).toThrow(MergeError);
  });
});

describe("mergeOpencodeJson", () => {
  it("uses opencode's local-server schema under `mcp`", () => {
    const out = JSON.parse(mergeOpencodeJson(null).text);
    expect(out.$schema).toBe("https://opencode.ai/config.json");
    expect(out.mcp.taskflow).toEqual({ type: "local", command: ["taskflow-mcp"], enabled: true });
  });

  it("does not add $schema to an existing file, and keeps its entries", () => {
    const before = JSON.stringify({ model: "x", mcp: { other: { type: "remote", url: "https://e" } } });
    const out = JSON.parse(mergeOpencodeJson(before).text);
    expect(out.$schema).toBeUndefined();
    expect(out.model).toBe("x");
    expect(out.mcp.other).toEqual({ type: "remote", url: "https://e" });
    expect(mergeOpencodeJson(JSON.stringify(out)).changed).toBe(false);
  });
});

describe("mergeCodexToml", () => {
  it("appends a table to an empty file", () => {
    const r = mergeCodexToml(null);
    expect(r.text).toBe('[mcp_servers.taskflow]\ncommand = "taskflow-mcp"\nargs = []\n');
  });

  it("appends after existing content without touching it", () => {
    const before = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"';
    const r = mergeCodexToml(before);
    expect(r.text.startsWith(`${before}\n\n[mcp_servers.taskflow]`)).toBe(true);
  });

  it("is idempotent, and recognises a quoted table name", () => {
    const once = mergeCodexToml('model = "o3"\n').text;
    expect(mergeCodexToml(once).changed).toBe(false);
    expect(mergeCodexToml('[mcp_servers."taskflow"]\ncommand = "node"\n').changed).toBe(false);
    expect(tomlHasServer(once)).toBe(true);
  });

  it("is not fooled by a similarly named server", () => {
    expect(mergeCodexToml('[mcp_servers.taskflow_old]\ncommand = "x"\n').changed).toBe(true);
  });
});

describe("mergeClaudeHooks", () => {
  it("adds all five events to empty settings", () => {
    const r = mergeClaudeHooks(null);
    const out = JSON.parse(r.text);
    expect(r.added).toEqual(["SessionStart", "PreToolUse", "PostToolUse", "Stop", "Notification"]);
    expect(out.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: "taskflow-hook" }] }]);
    expect(out.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "taskflow-hook" }] }]);
  });

  it("appends after the user's own hooks and keeps other settings", () => {
    const before = JSON.stringify({
      permissions: { allow: ["Bash(ls)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    });
    const out = JSON.parse(mergeClaudeHooks(before).text);
    expect(out.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop[0].hooks[0].command).toBe("say done");
    expect(out.hooks.Stop[1].hooks[0].command).toBe("taskflow-hook");
  });

  it("is idempotent", () => {
    const once = mergeClaudeHooks(null).text;
    const twice = mergeClaudeHooks(once);
    expect(twice.changed).toBe(false);
    expect(twice.added).toEqual([]);
  });

  it("treats a node-path hook as already installed", () => {
    const before = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /x/mcp/hooks/taskflow-hook.mjs" }] }] },
    });
    expect(mergeClaudeHooks(before).added).not.toContain("SessionStart");
  });

  it("refuses a malformed hooks section", () => {
    expect(() => mergeClaudeHooks('{"hooks": {"Stop": {}}}')).toThrow(MergeError);
  });
});

describe("helpers", () => {
  it("isTaskflowHookCommand", () => {
    expect(isTaskflowHookCommand("taskflow-hook")).toBe(true);
    expect(isTaskflowHookCommand("node /a/b/taskflow-hook.mjs")).toBe(true);
    expect(isTaskflowHookCommand("my-taskflow-hooker")).toBe(false);
    expect(isTaskflowHookCommand(undefined)).toBe(false);
  });

  it("jsonHasServer tolerates junk", () => {
    expect(jsonHasServer(null)).toBe(false);
    expect(jsonHasServer("not json")).toBe(false);
    expect(jsonHasServer('{"mcpServers":{"taskflow":{}}}')).toBe(true);
  });

  it("mergeGitignore adds once", () => {
    const once = mergeGitignore("node_modules");
    expect(once.text).toBe("node_modules\n# TaskFlow agent credentials (secret keys)\n.taskflow.json\n");
    expect(mergeGitignore(once.text).changed).toBe(false);
    expect(mergeGitignore("/.taskflow.json\n").changed).toBe(false);
  });

  it("simpleDiff shows only the change", () => {
    const d = simpleDiff("a\nb\nc\n", "a\nb\nX\nc\n");
    expect(d).toEqual(["  … 2 unchanged lines", "+ X", "  … 1 unchanged line"]);
    expect(simpleDiff(null, "x\n")).toEqual(["+ x"]);
  });
});
