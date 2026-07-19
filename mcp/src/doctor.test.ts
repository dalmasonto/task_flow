import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "./doctor.js";

/** Write a .taskflow.json into a throwaway dir and return the dir. */
function configDir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  writeFileSync(join(dir, ".taskflow.json"), JSON.stringify(config));
  return dir;
}

/** Capture the doctor's output lines. */
function capture() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

const profile = (key: string) => ({ agent_id: 1, key, display_name: "A" });

afterEach(() => vi.unstubAllGlobals());

/** Stub fetch so a listed key authenticates and anything else 401s. */
function stubAuth(validKeys: string[]) {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    const key = auth.replace(/^Agent\s+/, "");
    if (validKeys.includes(key)) {
      return new Response(
        JSON.stringify({ agent_id: 1, display_name: "A", identifier: "x", project: 1, status: "offline" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ detail: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("runDoctor", () => {
  it("fails when no config exists", async () => {
    const { lines, log } = capture();
    // An empty dir with no parent config: use a temp dir far from the repo.
    const dir = mkdtempSync(join(tmpdir(), "doctor-empty-"));
    const code = await runDoctor({ startDir: dir, log, env: {} });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/not found/);
  });

  it("fails on a malformed config without reaching the network", async () => {
    const dir = configDir({ server: "http://x", profiles: {} });
    const { lines, log } = capture();
    const code = await runDoctor({ startDir: dir, log, env: {} });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/not valid/);
  });

  it("is ready when every profile authenticates", async () => {
    stubAuth(["tfk_good"]);
    const dir = configDir({
      server: "http://b", project: 1, default_profile: "main",
      profiles: { main: profile("tfk_good") },
    });
    const { lines, log } = capture();
    expect(await runDoctor({ startDir: dir, log, env: {} })).toBe(0);
    expect(lines.join("\n")).toMatch(/^Ready\./m);
  });

  // Readiness follows the DEFAULT profile: that is what tools use when none is
  // named, so a healthy secondary must not mask a broken default.
  it("is NOT ready when the default profile fails, even if another works", async () => {
    stubAuth(["tfk_good"]);
    const dir = configDir({
      server: "http://b", project: 1, default_profile: "main",
      profiles: { main: profile("tfk_bad"), reviewer: profile("tfk_good") },
    });
    const { lines, log } = capture();
    expect(await runDoctor({ startDir: dir, log, env: {} })).toBe(1);
    expect(lines.join("\n")).toMatch(/Not ready/);
  });

  it("reports mostly-ready when only a non-default profile fails", async () => {
    stubAuth(["tfk_good"]);
    const dir = configDir({
      server: "http://b", project: 1, default_profile: "main",
      profiles: { main: profile("tfk_good"), reviewer: profile("tfk_bad") },
    });
    const { lines, log } = capture();
    expect(await runDoctor({ startDir: dir, log, env: {} })).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/Mostly ready/);
    expect(out).toMatch(/"reviewer"/);
  });
});
