/**
 * `taskflow-v2-mcp --tmux [target]` — mirror a tmux pane into TaskFlow so humans
 * can watch what an agent is doing.
 *
 * WHY A MIRROR AND NOT A LOG. The obvious design is to tail new output and append
 * it as frames. That does not work for the case this exists for: a full-screen
 * TUI agent (Claude Code itself) runs on tmux's ALTERNATE SCREEN buffer, which
 * has no scrollback — `history_size` stays flat no matter how much scrolls by,
 * so there is no stream of new lines to tail. The only observable state is the
 * current screen, redrawn in place. So each capture is sent as a `snapshot`
 * frame that REPLACES the view rather than appending to it.
 *
 * Sends only when the screen actually changed, so an idle agent costs one cheap
 * capture per tick and no writes.
 *
 * The pane is only ever READ (`capture-pane`); nothing is injected into it and
 * no tmux option is altered, so mirroring cannot disturb the session.
 */

import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

import { TaskflowClient } from "./client.js";
import { loadProfile, type ResolvedProfile } from "./config.js";

const run = promisify(execFile);

/** Default poll cadence. Fast enough to feel live, slow enough to stay cheap. */
export const DEFAULT_INTERVAL_MS = 2000;
/** Backend cap is 20k chars; stay under it so a wide pane can't be rejected. */
const MAX_SNAPSHOT_CHARS = 18_000;

export interface TmuxOptions {
  /** Pane target, e.g. "0:0.0" or a session name. Defaults to tmux's active pane. */
  target?: string | undefined;
  intervalMs?: number;
  profile?: string | undefined;
  log?: (line: string) => void;
  /** Test seam: resolve the profile without touching the filesystem. */
  resolved?: ResolvedProfile;
}

/** Is tmux installed and is a server running? */
export async function tmuxAvailable(): Promise<boolean> {
  try {
    await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture a pane's visible screen as plain text. Deliberately WITHOUT `-e`, so
 * tmux resolves colour/cursor escapes into rendered text — the transcript stores
 * readable content instead of raw ANSI the UI would have to interpret.
 *
 * Trailing blank lines are dropped: a TUI pads the screen to its full height, and
 * keeping that padding would make every snapshot differ on cursor movement alone.
 */
export async function capturePane(target?: string): Promise<string> {
  const args = ["capture-pane", "-p"];
  if (target) args.push("-t", target);
  const { stdout } = await run("tmux", args, { maxBuffer: 4 * 1024 * 1024 });
  return normalizeSnapshot(stdout);
}

/**
 * Trim a raw capture into what gets stored: trailing blank lines dropped, and
 * the TAIL kept when oversized (the bottom of a screen is where current output
 * is; truncating the head loses scrolled-away context, truncating the tail would
 * lose the live part).
 */
export function normalizeSnapshot(raw: string, max = MAX_SNAPSHOT_CHARS): string {
  const trimmed = raw.replace(/\s+$/u, "");
  return trimmed.length > max ? trimmed.slice(trimmed.length - max) : trimmed;
}

/** Describe a pane for the session label, e.g. "0:0.0 (claude)". */
export async function describePane(target?: string): Promise<string> {
  const args = ["display-message", "-p"];
  if (target) args.push("-t", target);
  args.push("#{session_name}:#{window_index}.#{pane_index} (#{pane_current_command})");
  try {
    const { stdout } = await run("tmux", args);
    return stdout.trim();
  } catch {
    return target ?? "tmux";
  }
}

/**
 * Mirror the pane until interrupted. Resolves with an exit code.
 */
export async function runTmuxMirror(options: TmuxOptions = {}): Promise<number> {
  const log = options.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  if (!(await tmuxAvailable())) {
    log("FAIL  tmux is not available (is a tmux server running?)");
    return 1;
  }

  let resolved: ResolvedProfile;
  try {
    resolved = options.resolved ?? loadProfile({ profile: options.profile });
  } catch (err) {
    log(`FAIL  ${(err as Error).message}`);
    return 1;
  }

  // Fail fast on an unreachable pane rather than looping on errors.
  let screen: string;
  try {
    screen = await capturePane(options.target);
  } catch (err) {
    log(`FAIL  could not capture pane${options.target ? ` "${options.target}"` : ""}.`);
    log(`      ${(err as Error).message.split("\n")[0]}`);
    log("      List panes with: tmux list-panes -a");
    return 1;
  }

  const label = await describePane(options.target);
  const client = new TaskflowClient({ server: resolved.server, key: resolved.key });

  let session: number;
  try {
    const row = await client.registerSession({
      // Stable per pane, so re-running reconnects the same session instead of
      // piling up rows the human has to pick between.
      session_identifier: `tmux:${hostname()}:${label.split(" ")[0]}`,
      host: hostname(),
      pid: process.pid,
      cwd: process.cwd(),
      transport: "tmux",
    });
    session = row.id;
  } catch (err) {
    log(`FAIL  could not register a session: ${(err as Error).message}`);
    return 1;
  }

  log(`Mirroring ${label} → ${resolved.server} as "${resolved.displayName}" (session ${session}).`);
  log(`Sending a snapshot whenever the screen changes, every ${intervalMs}ms. Ctrl-C to stop.`);

  let lastSent: string | null = null;
  let sent = 0;
  let stopping = false;

  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`\n${signal} — closing session ${session} (${sent} snapshot${sent === 1 ? "" : "s"} sent).`);
    try {
      await client.closeSession(session);
    } catch {
      /* best effort: the session goes stale on its own within the heartbeat window */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // Heartbeat every tick so the agent reads as online for as long as we mirror;
  // liveness is heartbeat-recency based, so a silent screen must still beat.
  for (;;) {
    if (stopping) return 0;
    try {
      const current = await capturePane(options.target);
      if (current !== lastSent) {
        await client.appendFrame(session, { stream: "snapshot", content: current });
        lastSent = current;
        sent += 1;
      } else {
        await client.heartbeat(session, "busy");
      }
    } catch (err) {
      // Transient backend/tmux errors must not kill a long-running mirror.
      log(`  warn: ${(err as Error).message.split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
