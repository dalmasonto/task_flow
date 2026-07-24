import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readStickyProfile, terminalKey, writeStickyProfile } from "./sessions-store.js";

/** A throwaway repo root with a .taskflow.json in it; returns that config path. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "taskflow-sticky-"));
  const configPath = join(dir, ".taskflow.json");
  writeFileSync(configPath, "{}");
  return configPath;
}

describe("terminalKey", () => {
  it("uses the tmux pane when there is one", () => {
    expect(terminalKey({ pane: "%3", cwd: "/repo", ppid: 42 })).toBe("tmux:%3");
  });

  it("falls back to a hashed cwd plus the parent pid outside tmux", () => {
    const key = terminalKey({ pane: null, cwd: "/repo", ppid: 42 });
    expect(key).toMatch(/^cwd:[0-9a-f]{6}:42$/);
  });

  it("gives the same cwd the same hash, and different cwds different hashes", () => {
    const a = terminalKey({ pane: null, cwd: "/repo", ppid: 42 });
    const b = terminalKey({ pane: null, cwd: "/repo", ppid: 42 });
    const c = terminalKey({ pane: null, cwd: "/other", ppid: 42 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("sticky profile", () => {
  it("returns undefined when nothing has been chosen", () => {
    const configPath = tempRepo();
    expect(readStickyProfile({ configPath, pane: "%0" })).toBeUndefined();
  });

  it("round-trips a pick for the same terminal", () => {
    const configPath = tempRepo();
    writeStickyProfile("bear", { configPath, pane: "%0" });
    expect(readStickyProfile({ configPath, pane: "%0" })).toBe("bear");
  });

  it("keeps picks for different terminals apart", () => {
    const configPath = tempRepo();
    writeStickyProfile("bear", { configPath, pane: "%0" });
    writeStickyProfile("main", { configPath, pane: "%1" });
    expect(readStickyProfile({ configPath, pane: "%0" })).toBe("bear");
    expect(readStickyProfile({ configPath, pane: "%1" })).toBe("main");
  });

  it("writes the store next to the config file, not the cwd", () => {
    const configPath = tempRepo();
    writeStickyProfile("bear", { configPath, pane: "%0" });
    const stored = JSON.parse(
      readFileSync(join(configPath, "..", ".taskflow", "sessions.json"), "utf8"),
    );
    expect(stored.terminals["tmux:%0"].profile).toBe("bear");
  });

  it("ignores a pick older than the 30-day retention window", () => {
    const configPath = tempRepo();
    const day = 24 * 60 * 60 * 1000;
    writeStickyProfile("bear", { configPath, pane: "%0", now: 1_000_000_000_000 });
    expect(
      readStickyProfile({ configPath, pane: "%0", now: 1_000_000_000_000 + 31 * day }),
    ).toBeUndefined();
  });

  it("prunes expired entries on write so the file cannot grow forever", () => {
    const configPath = tempRepo();
    const day = 24 * 60 * 60 * 1000;
    writeStickyProfile("old", { configPath, pane: "%9", now: 1_000_000_000_000 });
    writeStickyProfile("new", { configPath, pane: "%0", now: 1_000_000_000_000 + 31 * day });
    const stored = JSON.parse(
      readFileSync(join(configPath, "..", ".taskflow", "sessions.json"), "utf8"),
    );
    expect(Object.keys(stored.terminals)).toEqual(["tmux:%0"]);
  });

  it("degrades to undefined on a corrupt store rather than throwing", () => {
    const configPath = tempRepo();
    mkdirSync(join(configPath, "..", ".taskflow"), { recursive: true });
    writeFileSync(join(configPath, "..", ".taskflow", "sessions.json"), "{ not json");
    expect(readStickyProfile({ configPath, pane: "%0" })).toBeUndefined();
  });

  it("never throws when the store cannot be written", () => {
    const configPath = tempRepo();
    const dir = join(configPath, "..", ".taskflow");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    expect(() => writeStickyProfile("bear", { configPath, pane: "%0" })).not.toThrow();
    chmodSync(dir, 0o700);
  });

  it("degrades to undefined rather than throwing when terminalKey's process.cwd() blows up", () => {
    const configPath = tempRepo();
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });
    try {
      expect(readStickyProfile({ configPath })).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
