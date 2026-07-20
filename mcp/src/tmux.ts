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
 * By default the pane is only ever READ (`capture-pane`) — nothing is injected and
 * no tmux option is altered, so mirroring cannot disturb the session. `--notify`
 * opts in to WRITING: a one-line unread notice typed into the pane. See
 * {@link buildNotice} for why that text is composed locally and never by the
 * server.
 */

import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

import { TaskflowClient } from "./client.js";
import { loadProfile, type ResolvedProfile } from "./config.js";

const run = promisify(execFile);

/**
 * How often the pane is CAPTURED. This is a local `tmux capture-pane` — a few
 * milliseconds, no network — so it can be frequent without costing anything.
 * What it costs to send is governed separately, below.
 */
export const DEFAULT_INTERVAL_MS = 1000;

/**
 * Minimum gap between two frames on the wire.
 *
 * A working agent repaints constantly — spinners, elapsed-time counters, a
 * cursor — so "the screen changed" is true almost every capture, and sending on
 * every change would ship a full screen per tick forever. Changes are coalesced
 * instead: at most one frame per second, and the LATEST capture wins, so the
 * viewer sees current state rather than a queue of stale ones.
 */
const MIN_SEND_INTERVAL_MS = 1000;

/**
 * How often to prove liveness when the screen is NOT changing.
 *
 * Appending a frame already bumps the session's `last_seen_at` server-side, so a
 * streaming agent never needs a heartbeat. Only a quiet one does, and the
 * liveness window is 90s — beating every couple of seconds was chatter for its
 * own sake.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Backend cap is 20k chars; stay under it so a wide pane can't be rejected. */
const MAX_SNAPSHOT_CHARS = 18_000;

/**
 * How much of a message notice may be TYPED into the pane.
 *
 * Larger than the status-line cap because this text is the agent's only view of
 * an incoming message: it must carry the whole body plus the attachment
 * manifest, or the agent answers half a request without knowing. Still bounded —
 * it becomes literal keystrokes in a live session.
 */
const MAX_TYPED_NOTICE_CHARS = 1_200;

export interface TmuxOptions {
  /** Pane target, e.g. "0:0.0" or a session name. Defaults to tmux's active pane. */
  target?: string | undefined;
  intervalMs?: number;
  profile?: string | undefined;
  log?: (line: string) => void;
  /** Test seam: resolve the profile without touching the filesystem. */
  resolved?: ResolvedProfile;
  /** Type a one-line notice into the pane when unread messages arrive. */
  notify?: boolean;
  /** Press Enter after the notice, so the agent processes it immediately. */
  notifySubmit?: boolean;
}

/**
 * Build the notice typed into the agent's pane.
 *
 * The text is composed HERE, locally, from counts — never from anything the
 * server sends. That is the whole security posture of this feature: the backend
 * cannot dictate keystrokes into a live agent session, because it never supplies
 * the string. Message bodies are deliberately excluded; the agent fetches them
 * through `check_messages`, which is auditable, rather than having them typed
 * into its prompt by a poller.
 *
 * Control characters are stripped and the result is a single line: a stray
 * newline would submit the prompt early, and an escape sequence could rewrite
 * the pane.
 */
export function buildNotice(unread: number, channels: number): string {
  const where = channels > 1 ? `${channels} channels` : "a channel";
  return sanitizeForPane(
    `[taskflow] ${unread} unread message${unread === 1 ? "" : "s"} in ${where} — ` +
      `call check_messages, then mark_read when handled.`,
  );
}

/** One line, printable characters only — see {@link buildNotice}. */
export function sanitizeForPane(text: string, max = 240): string {
  // eslint-disable-next-line no-control-regex
  // Strip whole ANSI escape sequences first: dropping only the ESC byte
  // would leave its printable tail ("[2J") as visible noise. Then remove any
  // remaining C0/C1 controls — a newline would submit the prompt early, and a
  // bare ESC reads as the Escape KEY to a TUI, which can cancel its input.
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F-\x9F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Find the tmux pane this agent is running in, with NO configuration.
 *
 * The MCP server is spawned by the agent (Claude Code), so it can work out where
 * that agent lives rather than being told:
 *
 *  1. `$TMUX_PANE` — set by tmux and inherited straight down. Exact and free.
 *  2. Otherwise match the ANCESTOR's controlling terminal to a pane's tty
 *     (v1's method): `readlink /proc/<pid>/fd/0` gives the pty, and
 *     `tmux list-panes` maps ptys to panes. We walk a few generations up because
 *     the MCP server may sit behind a shell wrapper, and only the agent process
 *     itself is attached to the pane's tty.
 *
 * Returns null when not under tmux, which is a normal state, not an error.
 */
export async function detectTmuxPane(): Promise<string | null> {
  const fromEnv = process.env.TMUX_PANE?.trim();
  if (fromEnv) return fromEnv;

  let panes: Array<{ id: string; tty: string }>;
  try {
    const { stdout } = await run("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_tty}"]);
    panes = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [id, tty] = line.split(" ");
        return { id: id ?? "", tty: tty ?? "" };
      })
      .filter((p) => p.id && p.tty);
  } catch {
    return null; // no tmux server
  }
  if (!panes.length) return null;

  let pid: number | undefined = process.ppid;
  for (let depth = 0; depth < 4 && pid && pid > 1; depth += 1) {
    try {
      const { stdout } = await run("readlink", [`/proc/${pid}/fd/0`]);
      const tty = stdout.trim();
      const hit = panes.find((p) => p.tty === tty);
      if (hit) return hit.id;
    } catch {
      /* pid gone, or no /proc (non-Linux) — try the next ancestor */
    }
    pid = await parentPid(pid);
  }
  return null;
}

/** The parent pid of `pid`, or undefined when it cannot be read. */
async function parentPid(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parsed = Number(stdout.trim());
    return Number.isFinite(parsed) && parsed > 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Deliver a notice to a pane. The two modes are deliberately different
 * MECHANISMS, not the same one with a flag:
 *
 * - `submit: false` → `display-message`, which paints the status line and never
 *   touches the input buffer. Typing an unsubmitted notice instead (the obvious
 *   first attempt) corrupts whatever the human or agent was mid-way through
 *   typing, and successive notices concatenate into one unreadable line.
 * - `submit: true` → `send-keys -l` + `Enter`, delivering the notice as input so
 *   the agent actually processes it. `-l` sends the text LITERALLY; without it
 *   tmux reads words like "Enter" as key names.
 *
 * Non-submit is for a human watching the pane; submit is for waking the agent.
 */
export async function notifyPane(
  text: string,
  target?: string,
  submit = false,
): Promise<void> {
  const base = target ? ["-t", target] : [];
  // The two modes have different limits because they are different surfaces.
  // `display-message` paints tmux's status line — one row, so a long notice is
  // unreadable there. `send-keys` TYPES into the pane, where the agent reads it
  // as input, and cutting at 240 silently lost the tail of real messages: a
  // request arrived half-written and was answered as if complete.
  const line = sanitizeForPane(text, submit ? MAX_TYPED_NOTICE_CHARS : 240);
  if (!submit) {
    await run("tmux", ["display-message", ...base, line]);
    return;
  }
  await run("tmux", ["send-keys", ...base, "-l", line]);
  await run("tmux", ["send-keys", ...base, "Enter"]);
}

/**
 * Send ONE key to a pane, by tmux key NAME (not literally).
 *
 * Answering a prompt means pressing keys, not typing text: "Right" must arrive
 * as the arrow key that opens the review pane, and "1" as the digit that toggles
 * an option. `send-keys -l` (used for message delivery) would type the literal
 * word "Right", so this deliberately omits it.
 */
export async function sendKeyToPane(key: string, target?: string): Promise<void> {
  const base = target ? ["-t", target] : [];
  // Whitelist: only ever send a bare digit or a named navigation key. Without
  // this, an answer travelling from the server could name any tmux key —
  // "C-c" would kill the agent.
  if (!/^(?:[0-9]|Right|Left|Up|Down|Enter|Space|Tab)$/.test(key)) {
    throw new Error(`refusing to send unrecognised key "${key}"`);
  }
  await run("tmux", ["send-keys", ...base, key]);
}

/**
 * How long to wait between keystrokes in a replayed answer.
 *
 * Keys fired back to back sometimes dropped the middle ones: Claude Code's
 * multi-select re-renders on each toggle, and a keystroke arriving mid-render
 * was lost. Observed non-deterministically — [1,2,3,4] recorded once as {1,4}
 * and once as {1,2,3,4} from identical input. A short pause lets the TUI settle
 * between keys. Human-in-the-loop, so ~700ms for a four-option answer is fine.
 */
const KEY_SEQUENCE_DELAY_MS = 90;

/** Injected in tests so the ordering and pacing can be checked without tmux. */
export interface KeySequenceDeps {
  sendKey?: (key: string, target?: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
}

/**
 * Send a sequence of keys to a pane with a pause BETWEEN each (never after the
 * last), so a re-rendering TUI does not drop the ones in the middle.
 */
export async function sendKeySequence(
  keys: string[],
  target: string | undefined,
  deps: KeySequenceDeps = {},
): Promise<void> {
  const sendKey = deps.sendKey ?? sendKeyToPane;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delayMs = deps.delayMs ?? KEY_SEQUENCE_DELAY_MS;
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) await sleep(delayMs);
    await sendKey(keys[i]!, target);
  }
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


export interface MirrorLoopOptions {
  client: TaskflowClient;
  session: number;
  target?: string | undefined;
  intervalMs?: number;
  notify?: boolean;
  notifySubmit?: boolean;
  log?: (line: string) => void;
  /** Called when a tick fails, so callers can react to the backend going away. */
  onError?: (error: Error) => void;
}

/**
 * Stream a pane into an EXISTING session until stopped. Returns a stop function.
 *
 * Split out of the CLI path so the MCP server can run the same loop in-process:
 * the mirror should not be a second thing a human remembers to launch.
 */
export function startMirrorLoop(options: MirrorLoopOptions): () => void {
  const { client, session, target } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? (() => {});
  let lastSent: string | null = null;
  let lastNotifiedMessageId = 0;
  let stopped = false;

  const notifyIfUnread = async () => {
    const channels = await client.listChannels();
    let unread = 0;
    let channelsWithUnread = 0;
    let highest = 0;
    for (const channel of channels) {
      const page = await client.listMessages({ channel: channel.id, unread: true });
      const rows = page.messages as Array<{ id?: number }>;
      if (!rows.length) continue;
      unread += rows.length;
      channelsWithUnread += 1;
      for (const row of rows) if (typeof row.id === "number" && row.id > highest) highest = row.id;
    }
    if (!unread || highest <= lastNotifiedMessageId) return;
    lastNotifiedMessageId = highest;
    await notifyPane(buildNotice(unread, channelsWithUnread), target, options.notifySubmit);
    log(`  notified: ${unread} unread in ${channelsWithUnread} channel(s)`);
  };

  let lastSentAt = 0;
  let lastContactAt = Date.now();
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    try {
      const current = await capturePane(target);
      const now = Date.now();
      const changed = current !== lastSent;

      if (changed && now - lastSentAt >= MIN_SEND_INTERVAL_MS) {
        inFlight = true;
        try {
          await client.appendFrame(session, { stream: "snapshot", content: current });
        } finally {
          inFlight = false;
        }
        // Only mark it sent AFTER the write lands: a failed send must stay
        // pending so the next tick retries rather than silently dropping it.
        lastSent = current;
        lastSentAt = now;
        lastContactAt = now;
      } else if (!changed && now - lastContactAt >= HEARTBEAT_INTERVAL_MS) {
        // Quiet screen: the only reason to touch the network is liveness.
        await client.heartbeat(session, "busy");
        lastContactAt = now;
      }
      // A change seen too soon after the last send is NOT dropped — `lastSent`
      // is unchanged, so the next eligible tick sends the newest capture. That
      // trailing send is what stops the view freezing on a stale screen when
      // activity stops abruptly.

      if (options.notify) await notifyIfUnread();
    } catch (err) {
      // Transient backend/tmux errors must not kill a long-running mirror.
      inFlight = false;
      log(`  warn: ${(err as Error).message.split("\n")[0]}`);
      options.onError?.(err as Error);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Don't hold the process open on our account — the MCP transport decides
  // lifetime, not this poller.
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Auto-start mirroring for an agent that is running inside tmux. Silently does
 * nothing when there is no pane to find — being outside tmux is normal.
 */
export async function startAutoMirror(options: {
  client: TaskflowClient;
  session: number;
  intervalMs?: number;
  notify?: boolean;
  notifySubmit?: boolean;
  log?: (line: string) => void;
}): Promise<(() => void) | null> {
  const pane = await detectTmuxPane();
  if (!pane) return null;
  const log = options.log ?? (() => {});
  log(`mirroring tmux pane ${pane} into the dashboard terminal`);
  return startMirrorLoop({ ...options, target: pane });
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
  if (options.notify) {
    log(
      options.notifySubmit
        ? "Notify: ON (submit) — unread notices are typed into the pane AND submitted, so the agent acts on them unprompted."
        : "Notify: ON — unread notices show on the tmux status line, leaving the input untouched. Use --notify-submit to hand them to the agent instead.",
    );
  }

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

  // Notices are rate-limited to one per unread BURST: re-typing the same notice
  // every tick would bury the pane and, with submit on, re-prompt the agent in a
  // loop. A new notice only goes out when the highest unread id has moved, i.e.
  // when something genuinely new arrived.
  let lastNotifiedMessageId = 0;

  /** Poll unread across channels; type one notice if there is anything new. */
  const notifyIfUnread = async () => {
    const channels = await client.listChannels();
    let unread = 0;
    let channelsWithUnread = 0;
    let highest = 0;
    for (const channel of channels) {
      const page = await client.listMessages({ channel: channel.id, unread: true });
      const rows = page.messages as Array<{ id?: number }>;
      if (!rows.length) continue;
      unread += rows.length;
      channelsWithUnread += 1;
      for (const row of rows) if (typeof row.id === "number" && row.id > highest) highest = row.id;
    }
    if (!unread || highest <= lastNotifiedMessageId) return;
    lastNotifiedMessageId = highest;
    await notifyPane(buildNotice(unread, channelsWithUnread), options.target, options.notifySubmit);
    log(`  notified: ${unread} unread in ${channelsWithUnread} channel(s)`);
  };

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
      if (options.notify) await notifyIfUnread();
    } catch (err) {
      // Transient backend/tmux errors must not kill a long-running mirror.
      log(`  warn: ${(err as Error).message.split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
