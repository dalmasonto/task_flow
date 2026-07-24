/**
 * The agent's connection to TaskFlow: register a session, prove liveness, and
 * keep doing both for as long as the process lives.
 *
 * ## Why this is its own module
 *
 * This ran as step one of `startMirrorForThisAgent`'s `start(pane)` callback,
 * behind `mirror.ts`'s "no tmux pane, nothing to mirror" early return. A
 * capability (presence) was smuggled inside a feature (terminal mirroring), so
 * the feature's precondition became the capability's: an agent outside tmux
 * never registered, never heartbeat, and never appeared in the dashboard.
 *
 * Mirroring is now layered on top of this — `onSession` hands the caller a live
 * session to attach the event stream and the pane mirror to.
 *
 * Retries are UNBOUNDED. The old startup gave up after 8 attempts (~2 minutes)
 * and stayed dead for the life of the process, which is indistinguishable from
 * the bug this module fixes: starting the MCP before the backend is a normal
 * ordering, not an error.
 */

import { TaskflowApiError, TaskflowClient } from "./client.js";
import type { ResolvedProfile } from "./config.js";
import { sessionIdentifier } from "./session-identifier.js";
import { hostname } from "node:os";

/** Backoff, matching `events.ts`'s reconnect policy exactly. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** 30s beats inside a 90s liveness window — a three-way contract with the
 *  backend's AGENT_HEARTBEAT_WINDOW_SECS and the frontend's ..._MS. */
const HEARTBEAT_MS = 30_000;

export type ConnectionState = "starting" | "active" | "retrying" | "needs_profile" | "stopped";

export interface ConnectionStatus {
  state: ConnectionState;
  /** Why, in the caller's words — always set for `retrying` and `needs_profile`. */
  detail?: string;
  attempts: number;
  /** The live session row id, once registered. */
  session?: number;
}

export interface ConnectedContext {
  client: TaskflowClient;
  session: number;
  profile: ResolvedProfile;
  pane: string | null;
}

export interface ConnectOptions {
  profile: ResolvedProfile;
  /** The tmux pane, or null outside tmux. Null is a normal, connectable state. */
  pane: string | null;
  /** Fired ONCE, on the first successful registration. */
  onSession?: (ctx: ConnectedContext) => void | Promise<void>;
  /** Test seam. */
  createClient?: (profile: ResolvedProfile) => TaskflowClient;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
  /** Test seam. False drives heartbeats by hand via `handle.beat()`, so a
   *  background tick cannot race an assertion. Always true in production. */
  autoHeartbeat?: boolean;
}

export interface ConnectionHandle {
  stop: () => void;
  /** Resolves when the initial registration settles. Tests await this. */
  settled: Promise<void>;
  /** Run one heartbeat tick now. Tests use it; production uses the loop. */
  beat: () => Promise<void>;
}

let status: ConnectionStatus = { state: "starting", attempts: 0 };

/** The current connection status, for `whoami` to report. */
export function getConnectionStatus(): ConnectionStatus {
  return { ...status };
}

/** Record that we are deliberately NOT connecting until a human picks. */
export function setNeedsProfile(detail: string): void {
  status = { state: "needs_profile", detail, attempts: 0 };
}

/** Test seam — reset module-level status between cases. */
export function resetConnectionStatus(): void {
  status = { state: "starting", attempts: 0 };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never hold the process open for a retry.
    (t as unknown as { unref?: () => void }).unref?.();
  });

/**
 * Connect and stay connected. Never throws and never rejects: the agent must
 * keep working whether or not the dashboard is reachable.
 */
export function startConnection(options: ConnectOptions): ConnectionHandle {
  const {
    profile,
    pane,
    log = () => {},
    sleep = defaultSleep,
    heartbeatMs = HEARTBEAT_MS,
    autoHeartbeat = true,
    createClient = (p: ResolvedProfile) => new TaskflowClient({ server: p.server, key: p.key }),
  } = options;

  const client = createClient(profile);
  const identifier = sessionIdentifier({ pane, profileName: profile.profileName });
  let stopped = false;
  let session: number | undefined;

  const register = async (): Promise<number> => {
    const row = await client.registerSession({
      session_identifier: identifier,
      host: hostname(),
      pid: process.pid,
      cwd: process.cwd(),
      transport: pane ? "tmux" : "mcp",
    });
    return row.id;
  };

  /** One heartbeat tick. A dead session is re-registered; anything else waits. */
  const beat = async (): Promise<void> => {
    if (stopped || session === undefined) return;
    try {
      await client.heartbeat(session);
    } catch (err) {
      // 404: the row is gone (backend restarted with a fresh DB, or it was
      // swept). 401: the credential was rejected mid-flight. Both are fixed by
      // registering again — it is idempotent per identifier and re-adopts the
      // SAME row id, so the mirror's session number stays valid.
      const status_ = err instanceof TaskflowApiError ? err.status : 0;
      if (status_ === 404 || status_ === 401) {
        try {
          session = await register();
          status = { ...status, session };
          log(`session re-registered as ${session}`);
        } catch {
          // The next tick tries again; a backend mid-restart is expected.
        }
        return;
      }
      // Transient (network, 5xx): the next tick retries. Re-registering here
      // would hammer a struggling backend with writes instead of cheap beats.
      log(`heartbeat failed (${(err as Error).message.split("\n")[0]})`);
    }
  };

  const heartbeatLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await sleep(heartbeatMs);
      } catch {
        return; // test sleep budget exhausted, or the timer was torn down
      }
      await beat();
    }
  };

  const run = async (): Promise<void> => {
    for (let attempt = 1; !stopped; attempt += 1) {
      try {
        session = await register();
        status = { state: "active", attempts: attempt, session };
        if (attempt > 1) log(`connected after ${attempt} attempts`);
        await options.onSession?.({ client, session, profile, pane });
        if (autoHeartbeat) {
          // Deferred to a macrotask, not called inline: an inline call would
          // run synchronously up to the loop's first `await sleep(...)` (a
          // no-op `async` fake has nothing to suspend on), so its first tick
          // would land inside THIS function's synchronous tail — before
          // `settled` resolves and before the caller's `await handle.settled`
          // continuation runs. That double-counts a heartbeat sleep as a
          // retry-backoff sleep in tests that share one `sleep` for both.
          const timer = setTimeout(() => {
            if (!stopped) void heartbeatLoop();
          }, 0);
          (timer as unknown as { unref?: () => void }).unref?.();
        }
        return;
      } catch (err) {
        const detail = (err as Error).message.split("\n")[0] ?? String(err);
        status = { state: "retrying", attempts: attempt, detail };
        // Grow, cap, jitter — so a backend coming back up is not hit by every
        // client at once.
        const ceiling = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
        const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
        log(`not connected yet (${detail}) — retrying in ${delay}ms`);
        try {
          await sleep(delay);
        } catch {
          return; // test sleep budget exhausted
        }
      }
    }
  };

  const settled = run();

  return {
    settled,
    beat,
    stop: () => {
      stopped = true;
      status = { ...status, state: "stopped" };
    },
  };
}
