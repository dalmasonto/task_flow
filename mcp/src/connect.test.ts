import { beforeEach, describe, expect, it } from "vitest";
import {
  getConnectionStatus,
  resetConnectionStatus,
  setNeedsProfile,
  startConnection,
} from "./connect.js";
import { TaskflowApiError } from "./client.js";
import type { ResolvedProfile } from "./config.js";

const PROFILE: ResolvedProfile = {
  server: "http://localhost:8000",
  project: 2,
  profileName: "main",
  agentId: 1,
  key: "tfk_test",
  displayName: "Claude (main)",
  configPath: "/repo/.taskflow.json",
};

/** A fake client recording calls; `registerSession` fails the first `failures` times. */
function fakeClient(options: { failures?: number; heartbeat?: () => Promise<unknown> } = {}) {
  let registerCalls = 0;
  const heartbeats: number[] = [];
  return {
    registerCalls: () => registerCalls,
    heartbeats,
    client: {
      registerSession: async () => {
        registerCalls += 1;
        if (registerCalls <= (options.failures ?? 0)) throw new Error("fetch failed");
        return { id: 77, session_identifier: "x", status: "connected" };
      },
      heartbeat: async (session: number) => {
        heartbeats.push(session);
        if (options.heartbeat) return options.heartbeat();
        return { id: session, session_identifier: "x", status: "connected" };
      },
    } as never,
  };
}

/** Records sleep durations without sleeping; stops the run after `budget` sleeps. */
function fakeSleep(budget = 50) {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
      if (delays.length > budget) throw new Error("sleep budget exhausted");
    },
  };
}

beforeEach(() => {
  resetConnectionStatus();
});

describe("startConnection", () => {
  it("registers a session with NO tmux pane — the reported bug", async () => {
    const fake = fakeClient();
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep().sleep,
      heartbeatMs: 30_000,
    });
    await handle.settled;
    expect(fake.registerCalls()).toBe(1);
    expect(getConnectionStatus().state).toBe("active");
    expect(getConnectionStatus().session).toBe(77);
    handle.stop();
  });

  it("announces the live session once, with the pane it has (or does not have)", async () => {
    const fake = fakeClient();
    const seen: Array<{ session: number; pane: string | null }> = [];
    const handle = startConnection({
      profile: PROFILE,
      pane: "%0",
      createClient: () => fake.client,
      sleep: fakeSleep().sleep,
      onSession: (ctx) => {
        seen.push({ session: ctx.session, pane: ctx.pane });
      },
    });
    await handle.settled;
    expect(seen).toEqual([{ session: 77, pane: "%0" }]);
    handle.stop();
  });

  it("keeps retrying past the old 8-attempt give-up point", async () => {
    const fake = fakeClient({ failures: 12 });
    const sleeper = fakeSleep();
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: sleeper.sleep,
    });
    await handle.settled;
    expect(fake.registerCalls()).toBe(13);
    expect(getConnectionStatus().state).toBe("active");
    handle.stop();
  });

  it("caps and jitters the backoff like the event stream does", async () => {
    const fake = fakeClient({ failures: 10 });
    const sleeper = fakeSleep();
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: sleeper.sleep,
    });
    await handle.settled;
    expect(sleeper.delays.length).toBe(10);
    expect(Math.min(...sleeper.delays)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...sleeper.delays)).toBeLessThanOrEqual(30_000);
    handle.stop();
  });

  it("reports 'retrying' with the reason while the backend is down", async () => {
    const fake = fakeClient({ failures: 2 });
    const sleeper = fakeSleep();
    let sawRetrying = false;
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: async (ms) => {
        if (getConnectionStatus().state === "retrying") sawRetrying = true;
        return sleeper.sleep(ms);
      },
    });
    await handle.settled;
    expect(sawRetrying).toBe(true);
    handle.stop();
  });

  it("never rejects, even when registration fails forever", async () => {
    const fake = fakeClient({ failures: Number.MAX_SAFE_INTEGER });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(5).sleep,
    });
    await expect(handle.settled).resolves.toBeUndefined();
    handle.stop();
  });

  it("re-registers when a heartbeat says the session is gone (404)", async () => {
    let beats = 0;
    const fake = fakeClient({
      heartbeat: async () => {
        beats += 1;
        if (beats === 1) {
          throw new TaskflowApiError("POST", "/heartbeat", 404, "no such session");
        }
        return { id: 77, session_identifier: "x", status: "connected" };
      },
    });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(3).sleep,
      // The background loop would race this test's explicit beat() and make
      // which call sees the 404 nondeterministic. Drive the tick by hand.
      autoHeartbeat: false,
    });
    await handle.settled;
    await handle.beat();
    expect(fake.registerCalls()).toBe(2);
    handle.stop();
  });

  it("does not re-register on a transient heartbeat failure", async () => {
    const fake = fakeClient({
      heartbeat: async () => {
        throw new Error("fetch failed");
      },
    });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(3).sleep,
      autoHeartbeat: false,
    });
    await handle.settled;
    await handle.beat();
    expect(fake.registerCalls()).toBe(1);
    handle.stop();
  });
});

describe("needs_profile", () => {
  it("reports that it is deliberately not connecting", () => {
    setNeedsProfile("2 profiles defined; waiting for select_profile");
    expect(getConnectionStatus().state).toBe("needs_profile");
    expect(getConnectionStatus().detail).toMatch(/select_profile/);
  });
});
