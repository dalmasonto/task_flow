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
function fakeClient(
  options: { failures?: number; id?: number; heartbeat?: () => Promise<unknown> } = {},
) {
  const id = options.id ?? 77;
  let registerCalls = 0;
  const heartbeats: number[] = [];
  return {
    registerCalls: () => registerCalls,
    heartbeats,
    client: {
      registerSession: async () => {
        registerCalls += 1;
        if (registerCalls <= (options.failures ?? 0)) throw new Error("fetch failed");
        return { id, session_identifier: "x", status: "connected" };
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

/** Let queued microtasks run — the background loop's only clock is the fake
 *  `sleep`, so draining the microtask queue runs it to its budget. No real
 *  timers: this test file must never schedule one. */
async function drain(ticks = 600): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
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
      // This test counts backoff sleeps, and the heartbeat loop shares the same
      // fake `sleep`. Drive beats by hand so a background tick cannot add an
      // 11th delay — that is exactly what `autoHeartbeat` is for.
      autoHeartbeat: false,
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
    const announced: number[] = [];
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(3).sleep,
      onSession: (ctx) => {
        announced.push(ctx.session);
      },
      // The background loop would race this test's explicit beat() and make
      // which call sees the 404 nondeterministic. Drive the tick by hand.
      autoHeartbeat: false,
    });
    await handle.settled;
    await handle.beat();
    expect(fake.registerCalls()).toBe(2);
    // The re-registration must re-adopt the SAME row, or the mirror and the
    // event stream are pointed at a session id that no longer exists.
    expect(getConnectionStatus().state).toBe("active");
    expect(getConnectionStatus().session).toBe(77);
    expect(fake.heartbeats).toEqual([77]);
    // `onSession` is documented as firing ONCE. A re-registration is not a new
    // connection, so it must not re-announce.
    expect(announced).toEqual([77]);
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
    expect(fake.heartbeats).toEqual([77]);
    handle.stop();
  });

  it("keeps beating after a heartbeat rejects with a non-Error", async () => {
    let beats = 0;
    const fake = fakeClient({
      heartbeat: async () => {
        beats += 1;
        // No `.message`: the thing every naive `(err as Error).message` reads.
        return Promise.reject({ code: "ECONNRESET" });
      },
    });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(20).sleep,
      heartbeatMs: 30_000,
    });
    await handle.settled;
    await drain();
    // 20 sleeps in the budget, one beat each. One means the loop died.
    expect(beats).toBe(20);
    handle.stop();
  });

  it("keeps beating when the injected log throws", async () => {
    let beats = 0;
    const fake = fakeClient({
      heartbeat: async () => {
        beats += 1;
        throw new Error("fetch failed");
      },
    });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(20).sleep,
      log: () => {
        throw new Error("log exploded");
      },
    });
    await handle.settled;
    await drain();
    expect(beats).toBe(20);
    handle.stop();
  });

  it("stays active and does not re-register when onSession fails", async () => {
    const fake = fakeClient();
    let announced = 0;
    const logs: string[] = [];
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(3).sleep,
      autoHeartbeat: false,
      log: (line) => logs.push(line),
      onSession: async () => {
        announced += 1;
        throw new Error("mirror attach failed");
      },
    });
    await handle.settled;
    // Registered and heartbeating: a failed mirror attach is not a failed
    // connection, and must not restart the registration loop.
    expect(fake.registerCalls()).toBe(1);
    expect(announced).toBe(1);
    expect(getConnectionStatus().state).toBe("active");
    expect(getConnectionStatus().session).toBe(77);
    expect(logs.join("\n")).toMatch(/mirror attach failed/);
    handle.stop();
  });

  it("does not throw out of startConnection when createClient throws", async () => {
    let handle: ReturnType<typeof startConnection> | undefined;
    expect(() => {
      handle = startConnection({
        profile: PROFILE,
        pane: null,
        // What `new TaskflowClient({server: undefined})` does in production.
        createClient: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'replace')");
        },
        sleep: fakeSleep(2).sleep,
        autoHeartbeat: false,
      });
    }).not.toThrow();
    await expect(handle!.settled).resolves.toBeUndefined();
    expect(getConnectionStatus().state).toBe("retrying");
    expect(getConnectionStatus().detail).toMatch(/replace/);
    handle!.stop();
  });

  it("never rejects when registration throws a non-Error", async () => {
    const client = {
      registerSession: async () => {
        throw "kaboom";
      },
      heartbeat: async () => ({ id: 77, session_identifier: "x", status: "connected" }),
    } as never;
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => client,
      sleep: fakeSleep(2).sleep,
      autoHeartbeat: false,
    });
    await expect(handle.settled).resolves.toBeUndefined();
    expect(getConnectionStatus().state).toBe("retrying");
    expect(getConnectionStatus().detail).toBe("kaboom");
    handle.stop();
  });

  it("stays stopped when stop() lands before the first registration resolves", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announced = 0;
    const client = {
      registerSession: async () => {
        await gate;
        return { id: 77, session_identifier: "x", status: "connected" };
      },
      heartbeat: async () => ({ id: 77, session_identifier: "x", status: "connected" }),
    } as never;
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => client,
      sleep: fakeSleep(2).sleep,
      autoHeartbeat: false,
      onSession: () => {
        announced += 1;
      },
    });
    handle.stop();
    release();
    await handle.settled;
    expect(getConnectionStatus().state).toBe("stopped");
    // Attaching a mirror and an event stream to a torn-down connection.
    expect(announced).toBe(0);
  });

  it("does not let a superseded connection's stop() clobber the live one", async () => {
    const first = fakeClient({ id: 77 });
    const second = fakeClient({ id: 78 });
    const older = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => first.client,
      sleep: fakeSleep(2).sleep,
      autoHeartbeat: false,
    });
    await older.settled;
    const newer = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => second.client,
      sleep: fakeSleep(2).sleep,
      autoHeartbeat: false,
    });
    await newer.settled;
    expect(getConnectionStatus().session).toBe(78);

    older.stop();
    expect(getConnectionStatus()).toMatchObject({ state: "active", session: 78 });
    newer.stop();
    expect(getConnectionStatus().state).toBe("stopped");
  });

  it("reports why a re-registration failed instead of a confident stale 'active'", async () => {
    let registerCalls = 0;
    const client = {
      registerSession: async () => {
        registerCalls += 1;
        if (registerCalls > 1) throw new Error("connection refused");
        return { id: 77, session_identifier: "x", status: "connected" };
      },
      heartbeat: async () => {
        throw new TaskflowApiError("POST", "/agent/sessions/77/heartbeat", 404, "gone");
      },
    } as never;
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => client,
      sleep: fakeSleep(3).sleep,
      autoHeartbeat: false,
    });
    await handle.settled;
    await handle.beat();
    expect(registerCalls).toBe(2);
    expect(getConnectionStatus().detail).toMatch(/connection refused/);
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
