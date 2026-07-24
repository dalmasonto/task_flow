import { describe, expect, it, vi } from "vitest";

/**
 * `connectAs` on a module whose connection slot has NEVER been filled — the
 * very first connect of a process.
 *
 * This is its own file on purpose. It used to live in `runtime.test.ts` as a
 * `vi.resetModules()` plus a dynamic import, which mutates the shared module
 * registry: every case after it would have got fresh module instances (and so
 * fresh module-level state) instead of the ones the file imported statically,
 * and the case passed only because it happened to be written last. A test file
 * has its own registry, so the isolation is structural and position stops
 * mattering.
 */
vi.mock("./connect.js", () => ({
  startConnection: vi.fn(() => ({
    settled: Promise.resolve(),
    beat: async () => {},
    stop: () => {},
  })),
  setNeedsProfile: vi.fn(),
}));

import type { ResolvedProfile } from "./config.js";
import { connectAs } from "./runtime.js";

const PROFILE: ResolvedProfile = {
  server: "http://localhost:8000",
  project: 2,
  profileName: "main",
  agentId: 1,
  key: "tfk_test",
  displayName: "Claude (main)",
  configPath: "/repo/.taskflow.json",
};

describe("the first connectAs of a process", () => {
  it("does not throw when there is no previous connection or runtime to stop", () => {
    // Both slots — the connection handle and its runtime teardown — are empty
    // here, which is exactly the shape at startup.
    expect(connectAs(PROFILE, null)).toBeUndefined();
  });
});
