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
  /**
   * Resolves when the initial registration settles — and NEVER rejects.
   *
   * "Settles" means registered, or stopped, or the injected sleep gave up. It
   * does NOT mean "resolves eventually": retries are unbounded, so while the
   * backend is down this stays PENDING forever. Callers on the startup path
   * (Task 6) must therefore not `await` it — doing so would keep the MCP
   * server from serving a single tool call until the backend came up. Start
   * the connection, keep the handle, carry on; only tests await it, and they
   * inject a `sleep` with a finite budget.
   */
  settled: Promise<void>;
  /** Run one heartbeat tick now. Tests use it; production uses the loop. */
  beat: () => Promise<void>;
}

let status: ConnectionStatus = { state: "starting", attempts: 0 };

/**
 * Which connection the module-level `status` describes.
 *
 * There can be more than one live connection in a process — `select_profile`
 * starts a second one after a human picks a profile — and a single shared
 * variable let them cross-talk: the superseded connection's `stop()` would
 * flip the LIVE connection's row to `stopped`, so `whoami` reported an offline
 * agent that was in fact heartbeating. The newest connection owns the status;
 * every write from an older one is dropped.
 */
let statusOwner: object | undefined;

/** The current connection status, for `whoami` to report. */
export function getConnectionStatus(): ConnectionStatus {
  return { ...status };
}

/** Record that we are deliberately NOT connecting until a human picks. */
export function setNeedsProfile(detail: string): void {
  statusOwner = undefined;
  status = { state: "needs_profile", detail, attempts: 0 };
}

/** Test seam — reset module-level status between cases. */
export function resetConnectionStatus(): void {
  statusOwner = undefined;
  status = { state: "starting", attempts: 0 };
}

/**
 * The first line of why something failed, for ANY thrown value.
 *
 * Nothing guarantees a rejection carries an `Error`: `fetch` internals reject
 * with `{code:"ECONNRESET"}`, libraries throw strings, and a bare
 * `Promise.reject()` carries `undefined`. `(err as Error).message.split(...)`
 * on those throws a TypeError from INSIDE the catch block, which escapes the
 * handler that was supposed to contain it — the one thing this module must
 * never do.
 */
function reason(err: unknown): string {
  try {
    const raw = err instanceof Error && typeof err.message === "string" ? err.message : String(err);
    return raw.split("\n")[0] || "unknown";
  } catch {
    return "unknown";
  }
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
    log: rawLog = () => {},
    sleep = defaultSleep,
    heartbeatMs = HEARTBEAT_MS,
    autoHeartbeat = true,
    createClient = (p: ResolvedProfile) => new TaskflowClient({ server: p.server, key: p.key }),
  } = options;

  /** Diagnostics are never worth the connection: an injected `log` that throws
   *  (a closed stream, a broken transport) must not unwind a catch block. */
  const log = (line: string): void => {
    try {
      rawLog(line);
    } catch {
      // Nowhere left to report it — stdout belongs to the MCP transport.
    }
  };

  let stopped = false;
  let session: number | undefined;

  // Starting a connection makes it the one `whoami` describes; the previous
  // one keeps running but can no longer write to the shared status.
  const token = {};
  statusOwner = token;
  status = { state: "starting", attempts: 0 };
  /** Write the shared status — a no-op once this connection is superseded. */
  const publish = (next: ConnectionStatus): void => {
    if (statusOwner !== token) return;
    status = next;
  };

  /**
   * Built on first use, INSIDE the retry loop's try — never in the function
   * body. `new TaskflowClient(...)` throws on a profile with no `server` and
   * on a runtime with no `fetch`, and a throw out here would escape
   * `startConnection` itself: the caller would get no handle, no `settled` to
   * catch on, and — since Task 6 calls this on the startup path — a dead MCP
   * server at boot. Built once and reused so a retry does not leak clients.
   */
  let client: TaskflowClient | undefined;
  let identifier: string | undefined;
  const clientOf = (): TaskflowClient => (client ??= createClient(profile));
  const identifierOf = (): string =>
    (identifier ??= sessionIdentifier({ pane, profileName: profile.profileName }));

  const register = async (): Promise<number> => {
    const row = await clientOf().registerSession({
      session_identifier: identifierOf(),
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
      await clientOf().heartbeat(session);
    } catch (err) {
      // 404: the row is gone (backend restarted with a fresh DB, or it was
      // swept). 401: the credential was rejected mid-flight. Both are fixed by
      // registering again — it is idempotent per identifier and re-adopts the
      // SAME row id, so the mirror's session number stays valid.
      const status_ = err instanceof TaskflowApiError ? err.status : 0;
      if (status_ === 404 || status_ === 401) {
        try {
          session = await register();
          publish({ ...status, state: "active", session, detail: undefined });
          log(`session re-registered as ${session}`);
        } catch (reErr) {
          // The next tick tries again; a backend mid-restart is expected. But
          // do NOT keep reporting a confident `active` against a session id
          // the backend just 404'd — that lie would stand for a full 30s beat.
          const detail = `session ${session} is gone; re-register failed (${reason(reErr)})`;
          publish({ ...status, state: "retrying", detail });
          log(detail);
        }
        return;
      }
      // Transient (network, 5xx): the next tick retries. Re-registering here
      // would hammer a struggling backend with writes instead of cheap beats.
      log(`heartbeat failed (${reason(err)})`);
    }
  };

  const heartbeatLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await sleep(heartbeatMs);
      } catch {
        return; // test sleep budget exhausted, or the timer was torn down
      }
      try {
        await beat();
      } catch {
        // `beat` contains its own failures, but a defect in that containment
        // must cost one tick, not the whole loop: an escape here lands on an
        // unhandled rejection and the agent goes silently offline forever.
      }
    }
  };

  const run = async (): Promise<void> => {
    for (let attempt = 1; !stopped; attempt += 1) {
      let live: number;
      try {
        live = await register();
      } catch (err) {
        const detail = reason(err);
        publish({ state: "retrying", attempts: attempt, detail });
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
        continue;
      }

      // `stop()` may have landed while the register request was in flight.
      // Without this, a torn-down connection reports itself active and hands
      // the caller a session to attach a mirror and an event stream to.
      if (stopped) return;

      session = live;
      publish({ state: "active", attempts: attempt, session });
      if (attempt > 1) log(`connected after ${attempt} attempts`);
      if (autoHeartbeat) void heartbeatLoop();

      // Deliberately OUTSIDE the retry loop and in its own try/catch. The
      // caller attaches the pane mirror and the SSE stream here, and attaching
      // genuinely fails in practice. That is a failed mirror, not a failed
      // connection: the session IS registered and IS heartbeating, so it stays
      // `active` and must never be re-registered — inside the loop, one
      // rejection became an unbounded register storm against the backend.
      try {
        await options.onSession?.({ client: clientOf(), session, profile, pane });
      } catch (err) {
        log(`session attach failed (${reason(err)}) — connection stays active`);
      }
      return;
    }
  };

  // Last-resort net. Every failure path inside `run` is already contained; this
  // exists so that a future one that is not cannot become an unhandled
  // rejection in the MCP process, which is what this module's contract forbids.
  const settled = run().catch(() => {});

  return {
    settled,
    beat,
    stop: () => {
      stopped = true;
      publish({ ...status, state: "stopped" });
    },
  };
}
