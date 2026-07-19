/**
 * Mirror lifecycle: start the terminal mirror, keep trying if the backend is not
 * ready yet, and remember what happened so a human can ask.
 *
 * This module exists because of a real failure. The mirror's *running* loop is
 * carefully resilient — `startMirrorLoop` swallows transient errors and
 * reconnects the event stream — but its *startup* had no such protection. Setup
 * calls `registerSession`, so a backend that was still booting when the MCP
 * spawned threw once, was caught, logged to stderr, and mirroring was dead for
 * the entire life of the process. The dashboard then showed a stale terminal
 * with nothing anywhere saying why.
 *
 * Restarting the backend and reconnecting the MCP together is the normal way to
 * pick up a change, which is exactly when the race is most likely.
 */

/** Backoff between startup attempts. Mirrors `events.ts`'s reconnect policy. */
const START_BASE_MS = 1_000;
const START_MAX_MS = 30_000;
const START_MAX_ATTEMPTS = 8;

export type MirrorState =
  /** Not attempted yet. */
  | "starting"
  /** Deliberately not mirroring — no tmux pane to mirror. Not an error. */
  | "off"
  /** Streaming. */
  | "active"
  /** Gave up after exhausting retries; `detail` carries the last reason. */
  | "failed";

export interface MirrorStatus {
  state: MirrorState;
  /** Why, in the caller's words — always set for `off` and `failed`. */
  detail?: string;
  /** The tmux pane being mirrored, once known. */
  pane?: string;
  /** How many start attempts have been made. */
  attempts: number;
}

let status: MirrorStatus = { state: "starting", attempts: 0 };

/** The current mirror status, for `whoami` to report. */
export function getMirrorStatus(): MirrorStatus {
  return { ...status };
}

/** Test seam — reset the module-level status between cases. */
export function resetMirrorStatus(): void {
  status = { state: "starting", attempts: 0 };
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never hold the process open for a retry.
    (t as unknown as { unref?: () => void }).unref?.();
  });

export interface StartMirrorOptions {
  /** Resolve the pane to mirror, or null when not running under tmux. */
  detectPane: () => Promise<string | null>;
  /** Do the actual setup (register, stream, loop). Throws if it cannot. */
  start: (pane: string) => Promise<void>;
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Start the mirror, retrying with backoff until it takes or the attempts run
 * out. Never throws: a mirror is a nice-to-have and must not be able to take
 * the tool server down with it.
 *
 * No pane means no tmux, which is a permanent and legitimate condition — that
 * returns immediately rather than retrying, so a non-tmux agent does not spend
 * eight backoff rounds discovering the same thing.
 */
export async function startMirrorWithRetry(options: StartMirrorOptions): Promise<void> {
  const {
    detectPane,
    start,
    maxAttempts = START_MAX_ATTEMPTS,
    baseMs = START_BASE_MS,
    maxMs = START_MAX_MS,
    sleep = wait,
    log,
  } = options;

  let pane: string | null;
  try {
    pane = await detectPane();
  } catch (err) {
    status = {
      state: "failed",
      detail: (err as Error).message,
      attempts: 0,
    };
    log?.(`terminal mirror unavailable (${(err as Error).message})`);
    return;
  }

  if (!pane) {
    status = {
      state: "off",
      detail: "not running inside tmux — nothing to mirror",
      attempts: 0,
    };
    return;
  }

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await start(pane);
      status = { state: "active", pane, attempts: attempt };
      if (attempt > 1) log?.(`terminal mirror started after ${attempt} attempts`);
      return;
    } catch (err) {
      lastError = (err as Error).message.split("\n")[0] ?? String(err);
      status = { state: "starting", pane, attempts: attempt, detail: lastError };
      if (attempt === maxAttempts) break;

      // Same shape as the event stream's reconnect: grow, cap, and jitter so a
      // backend coming back up is not hit by every client at once.
      const ceiling = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
      log?.(`terminal mirror not up yet (${lastError}) — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  status = { state: "failed", pane, detail: lastError, attempts: maxAttempts };
  log?.(`terminal mirror gave up after ${maxAttempts} attempts (${lastError})`);
}
