import { beforeEach, describe, expect, it } from "vitest";
import {
  getMirrorStatus,
  resetMirrorStatus,
  startMirrorWithRetry,
} from "./mirror.js";

/** Collect the delays a run would have slept, without actually sleeping. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

beforeEach(() => {
  resetMirrorStatus();
});

describe("mirror status", () => {
  it("starts out reporting that nothing has been attempted", () => {
    expect(getMirrorStatus().state).toBe("starting");
  });

  it("reports 'off' when there is no tmux pane, and never calls start", async () => {
    let started = 0;
    await startMirrorWithRetry({
      detectPane: async () => null,
      start: async () => {
        started += 1;
      },
      sleep: fakeSleep().sleep,
    });

    const status = getMirrorStatus();
    expect(status.state).toBe("off");
    expect(status.detail).toMatch(/tmux/i);
    expect(started).toBe(0);
  });

  it("reports 'active' after a clean start", async () => {
    await startMirrorWithRetry({
      detectPane: async () => "%0",
      start: async () => {},
      sleep: fakeSleep().sleep,
    });

    const status = getMirrorStatus();
    expect(status.state).toBe("active");
    expect(status.pane).toBe("%0");
    expect(status.attempts).toBe(1);
  });
});

describe("startMirrorWithRetry", () => {
  it("retries a failing start and succeeds — the bug that left the terminal stale", async () => {
    // The real failure: the backend was still booting when the MCP spawned, so
    // registerSession threw. Previously that killed mirroring for the whole
    // life of the process.
    let attempts = 0;
    await startMirrorWithRetry({
      detectPane: async () => "%0",
      start: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("network error: fetch failed");
      },
      sleep: fakeSleep().sleep,
    });

    expect(attempts).toBe(3);
    expect(getMirrorStatus().state).toBe("active");
    expect(getMirrorStatus().attempts).toBe(3);
  });

  it("backs off between attempts, growing and then capping", async () => {
    const { delays, sleep } = fakeSleep();
    await startMirrorWithRetry({
      detectPane: async () => "%0",
      start: async () => {
        throw new Error("ECONNREFUSED");
      },
      maxAttempts: 6,
      baseMs: 100,
      maxMs: 400,
      sleep,
    });

    expect(delays.length).toBe(5); // one sleep between each pair of attempts

    // Each delay sits in [ceiling/2, ceiling] for its attempt, where the
    // ceiling doubles and then caps. Asserting monotonic growth would be wrong:
    // the delay is deliberately jittered so a backend coming back up is not hit
    // by every client at the same instant, which means a later delay can be
    // smaller than an earlier one.
    delays.forEach((delay, i) => {
      const ceiling = Math.min(100 * 2 ** i, 400);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
      expect(delay).toBeLessThanOrEqual(ceiling);
    });

    // The last two attempts are both at the cap, proving it actually caps.
    expect(Math.max(...delays)).toBeLessThanOrEqual(400);
    expect(delays[3]).toBeGreaterThanOrEqual(200);
    expect(delays[4]).toBeGreaterThanOrEqual(200);
  });

  it("gives up after maxAttempts and reports why", async () => {
    await startMirrorWithRetry({
      detectPane: async () => "%0",
      start: async () => {
        throw new Error("network error: fetch failed");
      },
      maxAttempts: 3,
      baseMs: 1,
      sleep: fakeSleep().sleep,
    });

    const status = getMirrorStatus();
    expect(status.state).toBe("failed");
    expect(status.attempts).toBe(3);
    // The reason must survive — "mirror is broken" without a cause is what
    // made this cost an hour of process forensics.
    expect(status.detail).toMatch(/fetch failed/);
  });

  it("never throws, whatever start does — a mirror must not take the server down", async () => {
    await expect(
      startMirrorWithRetry({
        detectPane: async () => {
          throw new Error("tmux exploded");
        },
        start: async () => {},
        maxAttempts: 2,
        baseMs: 1,
        sleep: fakeSleep().sleep,
      }),
    ).resolves.toBeUndefined();

    expect(getMirrorStatus().state).toBe("failed");
    expect(getMirrorStatus().detail).toMatch(/tmux exploded/);
  });

  it("does not retry when there is no pane — absence of tmux is permanent, not transient", async () => {
    const { delays, sleep } = fakeSleep();
    await startMirrorWithRetry({
      detectPane: async () => null,
      start: async () => {},
      maxAttempts: 5,
      baseMs: 1,
      sleep,
    });

    expect(delays.length).toBe(0);
    expect(getMirrorStatus().state).toBe("off");
  });
});
