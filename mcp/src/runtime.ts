/**
 * Everything that runs ONCE THERE IS A LIVE SESSION: the agent event stream
 * (message delivery, prompt replay, terminal keys) and the tmux pane mirror.
 *
 * Extracted from `index.ts` because two callers need it — the bin entry at
 * startup, and `select_profile` once a human has chosen an identity — and
 * because a 170-line closure inside a bin entry is not a unit anyone can
 * reason about.
 *
 * The pane is optional. Without one there is nothing to mirror and nowhere to
 * type a message, so only the parts that need a pane are skipped; the session
 * itself is already live and `check_messages` still works.
 *
 * It also holds the STARTUP entry (`startAgent`) and the two ways in — the bin
 * entry at boot, and `select_profile` once a human has chosen an identity — so
 * both take exactly the same path to a live agent.
 */

import type { ConnectedContext } from "./connect.js";
import type { TaskflowClient } from "./client.js";
import { formatIncoming, shouldDeliver, startAgentEventStream } from "./events.js";
import {
  detectTmuxPane,
  notifyPane,
  sendKeySteps,
  sendKeyToPane,
  startMirrorLoop,
} from "./tmux.js";
import { createSerialQueue } from "./pane-queue.js";
import { stepsForPrompt } from "./prompts.js";
import { resolveMessage, type MessageSource, type ResolvedMessage } from "./resolve.js";
import {
  findConfigPath,
  loadConfigFile,
  resolveProfileOrAsk,
  type ResolvedProfile,
} from "./config.js";
import { readStickyProfile, writeStickyProfile } from "./sessions-store.js";
import { setNeedsProfile, startConnection } from "./connect.js";
import { reportMirror } from "./mirror.js";

const stderrLog = (line: string) => void process.stderr.write(`taskflow-v2-mcp: ${line}\n`);

/**
 * Adapt the client to {@link MessageSource}.
 *
 * `MessagesPage.messages` is `unknown[]` — the client deliberately does not
 * model every row shape — so the narrowing happens here, once, at the boundary
 * rather than inside the resolver.
 */
function messageSourceFor(client: TaskflowClient): MessageSource {
  return {
    listChannels: () => client.listChannels(),
    listMessages: (params) =>
      client.listMessages(params) as Promise<{ messages: ResolvedMessage[] }>,
  };
}

/**
 * Attach the event stream (and, with a pane, the terminal mirror) to a live
 * session.
 */
export function startAgentRuntime(ctx: ConnectedContext, log: (line: string) => void): void {
  const { client, session, profile, pane } = ctx;
  if (pane) log(`mirroring tmux pane ${pane}`);

  // Every write to the pane — message delivery, prompt replay, terminal
  // keys — goes through this ONE serial queue. The event stream dispatches
  // handlers fire-and-forget, so without serialization two writes that land
  // together interleave their `send-keys <text>` / `send-keys Enter` steps
  // and one message's Enter submits another's text (see pane-queue.ts).
  const paneQueue = createSerialQueue();

  // Deliver ONE message to the pane, resolving it by id (chat is id-only on
  // the wire). Shared by the live stream and the reconnect catch-up so both
  // apply the same shouldDeliver + notify + mark-read. The pane write itself
  // is serialized; the resolve/markRead round-trips stay outside the lock so
  // network latency doesn't stall other deliveries.
  //
  // Without a pane there is nowhere to type it, so we stop BEFORE markRead: the
  // read cursor means "the agent has seen this", and nothing saw it.
  // `check_messages` defaults to unread_only, so advancing the cursor here
  // would drop the message for good (see planning/spec-message-delivery.md) —
  // leaving it unread is what makes `check_messages` still work.
  const deliverMessageById = async (id: number) => {
    const message = await resolveMessage(messageSourceFor(client), id);
    if (!message) return;
    if (!shouldDeliver(message, profile.agentId)) return;
    if (!pane) return;
    await paneQueue(() =>
      notifyPane(formatIncoming(message, message.attachments ?? [], profile.agentId), pane, true),
    );
    await client.markRead(message.channel, message.id);
  };

  // On RE-connect, deliver anything that arrived while the stream was down.
  // The live push is at-most-once and never redelivers, so a message sent
  // during a backend/session restart would otherwise only surface via a
  // manual check_messages — the "messages aren't coming" gap. Delivering
  // unread (oldest first) closes it; already-delivered messages are past the
  // read cursor, so they are not repeated.
  const catchUpUnread = async () => {
    try {
      const channels = await client.listChannels();
      const ids: number[] = [];
      for (const channel of channels) {
        const page = await client.listMessages({ channel: channel.id, unread: true });
        for (const row of page.messages as Array<{ id?: number }>) {
          if (typeof row.id === "number") ids.push(row.id);
        }
      }
      ids.sort((a, b) => a - b);
      if (ids.length) {
        log(`reconnect catch-up — ${ids.length} missed message(s)`);
      }
      for (const id of ids) {
        try {
          await deliverMessageById(id);
        } catch (err) {
          log(`catch-up could not deliver ${id} (${(err as Error).message.split("\n")[0]})`);
        }
      }
    } catch (err) {
      log(`reconnect catch-up failed (${(err as Error).message.split("\n")[0]})`);
    }
  };

  // Instant delivery: hold the event stream open and write each incoming
  // message straight into the pane. Polling would make a message as slow to
  // arrive as the capture interval, which is what "messages don't appear in
  // the terminal" actually was.
  const events = startAgentEventStream({
    server: profile.server,
    key: profile.key,
    log,
    // Deliver messages missed while the stream was down (see catchUpUnread).
    onReconnect: catchUpUnread,
    // A human answered a question the agent is blocked on: press the keys.
    onPromptAnswered: async (prompt) => {
      // No pane, no keyboard to replay the answer on.
      if (!pane) return;
      // A prompt may carry SEVERAL questions, each with its own kind, and
      // the terminal shows them one at a time. stepsForPrompt replays them
      // in order and returns nothing at all for a half-answered set —
      // leftover digits would land on whichever screen came next. A
      // free-text "Other" answer becomes a text step typed into the field.
      const steps = stepsForPrompt(
        prompt.options_json ?? "",
        prompt.kind,
        prompt.question,
        prompt.answer_json,
        prompt.answer,
        prompt.answer_text_json ?? null,
        prompt.status === "cancelled" ? "cancel" : "submit",
      );
      if (!steps.length) return;
      try {
        // Paced, not a tight loop: Claude Code's multi-select drops
        // keystrokes that arrive while it is re-rendering a toggle.
        // Serialized with message delivery so an incoming message can't type
        // itself into the middle of this answer's key sequence.
        await paneQueue(() => sendKeySteps(steps, pane));
        log(`answered prompt ${prompt.id} with ${steps.length} step(s)`);
      } catch (err) {
        log(
          `could not answer prompt ${prompt.id} (${(err as Error).message.split("\n")[0]})`,
        );
      }
    },
    onMessage: async (event) => {
      // The event carries the row id and NOTHING else — chat is id-only on
      // the wire (its group is per-project while its rows are channel-
      // scoped, see resolve.ts). deliverMessageById fetches the body/sender/
      // attachments back over the authorized read API, applies shouldDeliver
      // (a message this agent cannot see, or its own, is skipped), types it
      // into the pane, and advances the read cursor.
      try {
        await deliverMessageById(event.id);
      } catch (err) {
        log(`could not deliver message ${event.id} (${(err as Error).message.split("\n")[0]})`);
      }
    },
    // A human pressed a key in the dashboard terminal. The event is broadcast
    // to the whole project, so act only on keys addressed to THIS agent's
    // pane; send-keys types it as a key NAME (not the literal word).
    onTerminalKey: async (input) => {
      // No pane, nothing to send the key to.
      if (!pane) return;
      if (input.agent !== profile.agentId) return;
      try {
        await paneQueue(() => sendKeyToPane(input.keys, pane));
        log(`terminal key "${input.keys}" → pane ${pane}`);
      } catch (err) {
        log(`could not send key "${input.keys}" (${(err as Error).message.split("\n")[0]})`);
      }
    },
  });

  // TASKFLOW_MIRROR=off suppresses the MIRROR only — never the connection. The
  // agent still registers, heartbeats and receives messages; it just doesn't
  // stream its terminal. (Before Task 6 this flag gated the whole startup, so
  // turning off the mirror also took the agent offline.)
  if (pane && process.env.TASKFLOW_MIRROR !== "off") {
    startMirrorLoop({
      client,
      session,
      target: pane,
      log,
      // The mirror talks to the backend every couple of seconds, so it notices a
      // restart long before the stream's idle watchdog would. Hand that over
      // rather than making the stream wait for silence to accumulate.
      onError: (err) => {
        if (/network error|fetch failed|ECONNREFUSED/i.test(err.message)) {
          events.reconnectNow();
        }
      },
    });
    // Publish what `whoami` reports. Since the mirror moved here, this module —
    // not `startMirrorWithRetry` — is the only thing that knows the answer.
    reportMirror({ state: "active", pane, attempts: 1 });
  } else {
    reportMirror({
      state: "off",
      detail: pane ? "TASKFLOW_MIRROR=off" : "not running inside tmux — nothing to mirror",
      attempts: 0,
    });
  }
}

/**
 * Bring this agent online: resolve which identity this terminal is, then
 * connect and start the runtime. When the repo defines several identities and
 * nothing says which one this is, connect NOTHING and record `needs_profile` —
 * guessing would silently collapse two terminals into one agent.
 *
 * Deliberately NOT conditional on tmux: registering a session is what makes the
 * agent visible and reachable, and that must happen whether or not there is a
 * pane to mirror.
 */
export async function startAgent(options: { configPath?: string } = {}): Promise<void> {
  const configPath = options.configPath ?? findConfigPath();
  const config = loadConfigFile(configPath);
  const pane = await detectTmuxPane().catch(() => null);
  const sticky = readStickyProfile({ configPath, pane });
  const resolution = resolveProfileOrAsk(config, { env: process.env, configPath, sticky });

  if (resolution.kind === "ambiguous") {
    const names = resolution.profiles.map((p) => p.name).join(", ");
    setNeedsProfile(`${resolution.profiles.length} profiles defined (${names}); waiting for select_profile`);
    stderrLog(`multiple identities (${names}) — the agent must ask its human, then call select_profile`);
    return;
  }
  connectAs(resolution.profile, pane);
}

/**
 * Connect as a known profile and start the runtime. Used by `select_profile`.
 *
 * Nothing is awaited: `startConnection`'s `settled` stays pending for as long as
 * the backend is down, so awaiting it here would keep the MCP server from
 * serving a single tool call until the backend came up.
 */
export function connectAs(profile: ResolvedProfile, pane: string | null): void {
  startConnection({
    profile,
    pane,
    log: stderrLog,
    onSession: (ctx) => startAgentRuntime(ctx, stderrLog),
  });
}

/** Persist a human's pick for this terminal, then connect as it. */
export async function selectProfile(profile: ResolvedProfile): Promise<void> {
  const pane = await detectTmuxPane().catch(() => null);
  writeStickyProfile(profile.profileName, { configPath: profile.configPath, pane });
  connectAs(profile, pane);
}
