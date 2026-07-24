import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The runtime's collaborators are module-level side effects — an SSE stream, a
 * tmux capture loop, a session registration — so they are replaced at the module
 * boundary rather than injected. No test here opens a socket, spawns tmux, or
 * schedules a timer.
 */

/** Captures the options `startAgentRuntime` hands the event stream. */
const events = vi.hoisted(() => ({
  options: null as Record<string, (arg: never) => Promise<void> | void> | null,
}));

vi.mock("./events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./events.js")>();
  return {
    ...actual,
    startAgentEventStream: (options: never) => {
      events.options = options;
      return { stop: () => {}, reconnectNow: () => {} };
    },
  };
});

const tmux = vi.hoisted(() => ({
  notifyPane: vi.fn(async () => {}),
  sendKeySteps: vi.fn(async () => {}),
  sendKeyToPane: vi.fn(async () => {}),
  startMirrorLoop: vi.fn(() => () => {}),
  detectTmuxPane: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock("./tmux.js", () => tmux);

const connect = vi.hoisted(() => ({
  startConnection: vi.fn(() => ({
    settled: Promise.resolve(),
    beat: async () => {},
    stop: () => {},
  })),
  setNeedsProfile: vi.fn(),
}));
vi.mock("./connect.js", () => connect);

import type { ConnectedContext } from "./connect.js";
import type { ResolvedProfile } from "./config.js";
import { ConfigError } from "./config.js";
import { getMirrorStatus, resetMirrorStatus } from "./mirror.js";
import { connectAs, selectProfile, startAgent, startAgentRuntime } from "./runtime.js";
import { readStickyProfile } from "./sessions-store.js";

const PROFILE: ResolvedProfile = {
  server: "http://localhost:8000",
  project: 2,
  profileName: "main",
  agentId: 1,
  key: "tfk_test",
  displayName: "Claude (main)",
  configPath: "/repo/.taskflow.json",
};

/** A client that owns exactly one visible message and records `markRead`. */
function fakeClient() {
  const markRead: Array<{ channel: number; id: number }> = [];
  const message = {
    id: 56,
    channel: 3,
    sender_kind: "user",
    sender_label: "Dalmas",
    body_markdown: "does this survive without a pane?",
    sender_agent: null,
  };
  return {
    markRead,
    client: {
      listChannels: async () => [{ id: 3 }],
      listMessages: async () => ({ messages: [message] }),
      markRead: async (channel: number, id: number) => {
        markRead.push({ channel, id });
        return {};
      },
    } as never,
  };
}

function contextFor(pane: string | null, client: ConnectedContext["client"]): ConnectedContext {
  return { client, session: 77, profile: PROFILE, pane };
}

/** A throwaway repo whose `.taskflow.json` defines `profiles`. */
function tempRepo(profiles: Record<string, unknown>, defaultProfile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "taskflow-runtime-"));
  const configPath = join(dir, ".taskflow.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      server: "http://localhost:8000",
      project: 2,
      ...(defaultProfile ? { default_profile: defaultProfile } : {}),
      profiles,
    }),
  );
  return configPath;
}

const ONE = { main: { agent_id: 1, key: "tfk_main", display_name: "Builder" } };
const TWO = {
  ...ONE,
  reviewer: { agent_id: 2, key: "tfk_rev", display_name: "Reviewer" },
};

beforeEach(() => {
  events.options = null;
  resetMirrorStatus();
  tmux.notifyPane.mockClear();
  tmux.startMirrorLoop.mockClear();
  tmux.detectTmuxPane.mockClear();
  tmux.detectTmuxPane.mockImplementation(async () => null);
  connect.startConnection.mockClear();
  connect.setNeedsProfile.mockClear();
  // The real environment must not decide what these tests resolve to.
  vi.stubEnv("TASKFLOW_PROFILE", "");
  vi.stubEnv("TASKFLOW_MIRROR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("message delivery without a pane", () => {
  it("does NOT mark a message read when there is no pane to type it into", async () => {
    const { client, markRead } = fakeClient();
    startAgentRuntime(contextFor(null, client), () => {});
    await events.options?.onMessage({ id: 56 } as never);

    // Nothing consumed it, so the read cursor must not move: check_messages
    // defaults to unread_only and this is the agent's only way to see it.
    expect(markRead).toEqual([]);
    expect(tmux.notifyPane).not.toHaveBeenCalled();
  });

  it("types it into the pane and marks it read when there IS a pane", async () => {
    const { client, markRead } = fakeClient();
    startAgentRuntime(contextFor("%4", client), () => {});
    await events.options?.onMessage({ id: 56 } as never);

    expect(tmux.notifyPane).toHaveBeenCalledTimes(1);
    expect(tmux.notifyPane.mock.calls[0]?.[0]).toContain("does this survive without a pane?");
    expect(markRead).toEqual([{ channel: 3, id: 56 }]);
  });

  it("leaves a pane-less catch-up unread too, so nothing is lost on reconnect", async () => {
    const { client, markRead } = fakeClient();
    startAgentRuntime(contextFor(null, client), () => {});
    await events.options?.onReconnect(undefined as never);
    expect(markRead).toEqual([]);
  });
});

describe("mirror status reporting", () => {
  it("reports active with a pane", () => {
    const { client } = fakeClient();
    startAgentRuntime(contextFor("%4", client), () => {});
    expect(tmux.startMirrorLoop).toHaveBeenCalledTimes(1);
    expect(getMirrorStatus()).toEqual({ state: "active", pane: "%4", attempts: 1 });
  });

  it("reports off without a pane", () => {
    const { client } = fakeClient();
    startAgentRuntime(contextFor(null, client), () => {});
    expect(tmux.startMirrorLoop).not.toHaveBeenCalled();
    expect(getMirrorStatus()).toEqual({
      state: "off",
      detail: "not running inside tmux — nothing to mirror",
      attempts: 0,
    });
  });

  it("TASKFLOW_MIRROR=off suppresses the mirror but not the event stream", () => {
    vi.stubEnv("TASKFLOW_MIRROR", "off");
    const { client } = fakeClient();
    startAgentRuntime(contextFor("%4", client), () => {});
    expect(tmux.startMirrorLoop).not.toHaveBeenCalled();
    expect(getMirrorStatus()).toEqual({
      state: "off",
      detail: "TASKFLOW_MIRROR=off",
      attempts: 0,
    });
    // The connection's runtime is still fully attached.
    expect(events.options).not.toBeNull();
  });
});

describe("startAgent", () => {
  it("connects as the only profile, in or out of tmux", async () => {
    await startAgent({ configPath: tempRepo(ONE) });
    expect(connect.startConnection).toHaveBeenCalledTimes(1);
    const options = connect.startConnection.mock.calls[0]?.[0] as unknown as {
      profile: ResolvedProfile;
      pane: string | null;
    };
    expect(options.profile.profileName).toBe("main");
    expect(options.pane).toBeNull();
    expect(connect.setNeedsProfile).not.toHaveBeenCalled();
  });

  it("passes the detected pane through to the connection", async () => {
    tmux.detectTmuxPane.mockImplementation(async () => "%9");
    await startAgent({ configPath: tempRepo(ONE) });
    const options = connect.startConnection.mock.calls[0]?.[0] as unknown as { pane: string | null };
    expect(options.pane).toBe("%9");
  });

  it("connects even when pane detection throws", async () => {
    tmux.detectTmuxPane.mockImplementation(async () => {
      throw new Error("tmux exploded");
    });
    await startAgent({ configPath: tempRepo(ONE) });
    expect(connect.startConnection).toHaveBeenCalledTimes(1);
  });

  it("connects NOTHING when several profiles are defined and nothing says which", async () => {
    await startAgent({ configPath: tempRepo(TWO, "main") });
    expect(connect.startConnection).not.toHaveBeenCalled();
    const detail = connect.setNeedsProfile.mock.calls[0]?.[0] as unknown as string;
    expect(detail).toContain("main");
    expect(detail).toContain("reviewer");
    expect(detail).toContain("select_profile");
  });

  it("honours TASKFLOW_PROFILE when several are defined", async () => {
    vi.stubEnv("TASKFLOW_PROFILE", "reviewer");
    await startAgent({ configPath: tempRepo(TWO, "main") });
    const options = connect.startConnection.mock.calls[0]?.[0] as unknown as {
      profile: ResolvedProfile;
    };
    expect(options.profile.profileName).toBe("reviewer");
  });

  it("honours a remembered pick for this terminal", async () => {
    tmux.detectTmuxPane.mockImplementation(async () => "%9");
    const configPath = tempRepo(TWO, "main");
    await selectProfile({ ...PROFILE, profileName: "reviewer", configPath });
    connect.startConnection.mockClear();

    await startAgent({ configPath });
    const options = connect.startConnection.mock.calls[0]?.[0] as unknown as {
      profile: ResolvedProfile;
    };
    expect(options.profile.profileName).toBe("reviewer");
    expect(connect.setNeedsProfile).not.toHaveBeenCalled();
  });

  it("rejects with a legible ConfigError naming the profiles that DO exist", async () => {
    vi.stubEnv("TASKFLOW_PROFILE", "typo");
    const configPath = tempRepo(TWO, "main");
    await expect(startAgent({ configPath })).rejects.toBeInstanceOf(ConfigError);
    // The message the `void startAgent().catch(...)` net prints must be enough
    // to fix the mistake — no stack required.
    const err = await startAgent({ configPath }).catch((e: Error) => e);
    expect(err.message).toContain('Profile "typo" is not defined');
    expect(err.message).toContain("main, reviewer");
    expect(err.message).not.toContain("\n    at ");
    expect(connect.startConnection).not.toHaveBeenCalled();
  });
});

describe("selectProfile", () => {
  it("remembers the pick for this terminal, then connects as it", async () => {
    tmux.detectTmuxPane.mockImplementation(async () => "%9");
    const configPath = tempRepo(TWO, "main");
    await selectProfile({ ...PROFILE, profileName: "reviewer", configPath });

    expect(readStickyProfile({ configPath, pane: "%9" })).toBe("reviewer");
    expect(connect.startConnection).toHaveBeenCalledTimes(1);
  });
});

describe("connectAs", () => {
  it("does not await the connection — startup must never block on the backend", () => {
    // A `settled` that never resolves is the documented behaviour while the
    // backend is down; `connectAs` returns synchronously regardless.
    connect.startConnection.mockImplementationOnce(() => ({
      settled: new Promise<void>(() => {}),
      beat: async () => {},
      stop: () => {},
    }));
    expect(connectAs(PROFILE, null)).toBeUndefined();
  });
});
