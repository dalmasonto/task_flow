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
import { createPromptGate } from "./prompt-gate.js";
import { stepsForPrompt } from "./prompts.js";
import { resolveMessage, type MessageSource, type ResolvedMessage } from "./resolve.js";
import {
  findConfigPath,
  loadConfigFile,
  resolveProfileOrAsk,
  type ResolvedProfile,
} from "./config.js";
import { readStickyProfile, writeStickyProfile } from "./sessions-store.js";
import { setNeedsProfile, startConnection, type ConnectionHandle } from "./connect.js";
import { reportMirror } from "./mirror.js";

const stderrLog = (line: string) => void process.stderr.write(`taskflow-mcp: ${line}\n`);

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
 *
 * Returns a teardown that detaches BOTH. A profile switch must be able to call
 * it: the mirror keeps calling `appendFrame(oldSession, …)` every couple of
 * seconds and the backend reads a frame as proof of life, so an abandoned
 * runtime keeps the OLD identity online in the dashboard however thoroughly its
 * heartbeat was stopped — and its SSE stream keeps delivering that identity's
 * DMs into this pane and marking them read as it. Idempotent.
 */
export function startAgentRuntime(
  ctx: ConnectedContext,
  log: (line: string) => void,
): () => void {
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
  // #127: created-message deliveries this runtime has already made, so the same
  // id is never typed into the pane twice. The reconnect catch-up (unread REST)
  // and the buffered live `:messages` frame can both target a message posted just
  // after reconnect — `resolveMessage` fetches by id (not `unread=true`), so the
  // catch-up `markRead` does NOT suppress the live frame. Bounded (ids only).
  const deliveredIds = new Set<number>();
  const DELIVERED_CAP = 1000;

  const deliverMessageById = async (id: number, edited = false) => {
    // Reserve the id SYNCHRONOUSLY (before any await) so two concurrent
    // deliveries of the same created message can't both pass the check and type
    // it twice. An edit (edited=true, #107) is an intentional re-delivery and is
    // never deduped.
    if (!edited) {
      if (deliveredIds.has(id)) return;
      deliveredIds.add(id);
      if (deliveredIds.size > DELIVERED_CAP) {
        // Sets keep insertion order — drop the oldest to stay bounded.
        const oldest = deliveredIds.values().next().value;
        if (oldest !== undefined) deliveredIds.delete(oldest);
      }
    }
    let delivered = false;
    try {
      const message = await resolveMessage(messageSourceFor(client), id);
      if (!message) return;
      if (!shouldDeliver(message, profile.agentId)) return;
      if (!pane) return;
      await paneQueue(() =>
        notifyPane(
          formatIncoming(message, message.attachments ?? [], profile.agentId, edited),
          pane,
          true,
        ),
      );
      // For an edit of an already-read message this is a no-op — the cursor only
      // ever moves forward — which is exactly right: redelivery is a notice, not
      // new unread state.
      await client.markRead(message.channel, message.id);
      delivered = true;
    } finally {
      // Reserved but not actually delivered (no pane, unresolved, or an error):
      // release the id so a later attempt (catch-up/retry) can still deliver it.
      // A skipped own-message (shouldDeliver=false) is released too — harmless,
      // it never writes to the pane.
      if (!edited && !delivered) deliveredIds.delete(id);
    }
  };

  // #127: gate pane delivery on this agent's open prompts. While a prompt is
  // pending, gate.onMessage queues instead of calling deliverMessageById, so no
  // chat text is typed into the prompt and nothing marks the message read; on
  // answer/cancel it flushes in order. Prompt-answer key replay is NOT gated (it
  // is the human's deliberate response) and is enqueued into the pane BEFORE the
  // gate flushes — see handleFrame's ordering in events.ts.
  const promptGate = createPromptGate({
    selfAgentId: profile.agentId,
    deliver: deliverMessageById,
    log,
  });

  // #127: hydrate the gate's open-prompt state from an authoritative read.
  // Realtime `:prompts` events are at-most-once and never replayed, so a prompt
  // raised while the stream was down — or one already pending when this process
  // (re)starts — would be invisible to the gate and let catch-up type chat into
  // the open prompt. Reconciling against the backend's current pending set before
  // catch-up delivery closes that gap (and resumes if it resolved during an
  // outage). Best-effort: a failed read must not wedge startup.
  const hydrateOpenPrompts = async () => {
    try {
      const prompts = await client.listOpenPrompts();
      promptGate.setOpenPrompts(prompts.map((p) => p.id));
    } catch (err) {
      log(`could not hydrate open prompts (${(err as Error).message.split("\n")[0]})`);
    }
  };

  // On RE-connect, deliver anything that arrived while the stream was down.
  // The live push is at-most-once and never redelivers, so a message sent
  // during a backend/session restart would otherwise only surface via a
  // manual check_messages — the "messages aren't coming" gap. Delivering
  // unread (oldest first) closes it; already-delivered messages are past the
  // read cursor, so they are not repeated.
  const catchUpUnread = async () => {
    // Nowhere to deliver, and `deliverMessageById` would drop every one of
    // them anyway — so fetching the backlog is pure cost. `check_messages`
    // still surfaces them on demand, which is the whole point of leaving
    // them unread.
    if (!pane) return;
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
          // Through the gate: if a prompt is open, these queue too (and stay
          // unread) rather than typing into the prompt.
          await promptGate.onMessage(id);
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
    // #127 barrier (awaited before any frame is parsed — see events.ts): hydrate
    // this agent's open-prompt state first, so a live message or catch-up can't be
    // typed into an already-open prompt; then, on a reconnect only, deliver what
    // was missed while the stream was down.
    onConnected: async (isReconnect) => {
      await hydrateOpenPrompts();
      if (isReconnect) await catchUpUnread();
    },
    // The stream has failed to reconnect for a sustained stretch — tell the
    // agent its live feed is paused so it does not sit waiting on a dead stream.
    // Typed through the same serial queue as messages so it cannot interleave
    // with a delivery. Without a pane there is nowhere to type it.
    onUnreachable: async (failures) => {
      if (!pane) return;
      await paneQueue(() =>
        notifyPane(
          `[taskflow] ⚠️ TaskFlow server unreachable — ${failures} reconnect attempts failed. ` +
            `Live message delivery is paused; I'll keep retrying and catch up automatically when it returns. ` +
            `If this persists, check the backend/connection.`,
          pane,
          true,
        ),
      );
    },
    // Back after an outage the agent was told about: say so, so it knows live
    // delivery has resumed (catchUpUnread has already replayed anything missed).
    onRecovered: async () => {
      if (!pane) return;
      await paneQueue(() =>
        notifyPane(`[taskflow] ✅ Reconnected to TaskFlow — live message delivery resumed.`, pane, true),
      );
    },
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
    onMessage: async (event, action) => {
      // The event carries the row id and NOTHING else — chat is id-only on
      // the wire (its group is per-project while its rows are channel-
      // scoped, see resolve.ts). deliverMessageById fetches the body/sender/
      // attachments back over the authorized read API, applies shouldDeliver
      // (a message this agent cannot see, or its own, is skipped), types it
      // into the pane, and advances the read cursor. An "updated" action is
      // an edit (#107), delivered with an EDITED framing so the agent
      // continues from the revised content rather than treating it as new.
      try {
        // #127: through the gate — queued (not typed) while a prompt is open.
        await promptGate.onMessage(event.id, action === "updated");
      } catch (err) {
        log(`could not deliver message ${event.id} (${(err as Error).message.split("\n")[0]})`);
      }
    },
    // #127: track this agent's prompt open/resolved state so message delivery is
    // paused while a prompt waits and flushed once it is answered/cancelled.
    onPromptState: (prompt) => promptGate.onPromptState(prompt),
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
  let stopMirror: (() => void) | null = null;
  if (pane && process.env.TASKFLOW_MIRROR !== "off") {
    stopMirror = startMirrorLoop({
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

  let stopped = false;
  return () => {
    // Idempotent: the caller may tear down a runtime it already replaced, and
    // stopping a mirror twice must not be an error worth thinking about.
    if (stopped) return;
    stopped = true;
    // Mirror first: it is what keeps a stale identity showing as online (the
    // backend counts appended terminal frames as proof of life), and this
    // teardown is idempotent-gated — if `events.stop()` threw first, the
    // mirror would never stop and this function could not be retried.
    stopMirror?.();
    stopMirror = null;
    events.stop();
  };
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

/** The live connection, so a profile switch can stop the one it replaces. */
let current: ConnectionHandle | null = null;
/** Its runtime (event stream + mirror), which must go down with it. */
let currentRuntime: (() => void) | null = null;
/**
 * Which `connectAs` call owns the slots above.
 *
 * `onSession` fires whenever registration finally succeeds — which, with the
 * backend down, can be minutes after a newer `connectAs` superseded this one.
 * Without the token that late callback would overwrite the LIVE runtime's
 * teardown with a stale one, and the next switch would tear down the wrong
 * mirror while leaving the old one streaming. Same ownership rule as
 * `connect.ts`'s status.
 */
let runtimeOwner: object | undefined;

/**
 * Connect as a known profile and start the runtime. Used by `select_profile`.
 *
 * Nothing is awaited: `startConnection`'s `settled` stays pending for as long as
 * the backend is down, so awaiting it here would keep the MCP server from
 * serving a single tool call until the backend came up.
 */
export function connectAs(profile: ResolvedProfile, pane: string | null): void {
  // A profile switch must not leave the old identity heartbeating: its session
  // row would stay `connected` and the dashboard would show one agent twice.
  // Stopping the heartbeat is not enough on its own — the old runtime's mirror
  // keeps the row live by appending frames — so its runtime goes with it.
  current?.stop();
  currentRuntime?.();
  currentRuntime = null;

  const token = {};
  runtimeOwner = token;
  current = startConnection({
    profile,
    pane,
    log: stderrLog,
    onSession: (ctx) => {
      const teardown = startAgentRuntime(ctx, stderrLog);
      // Superseded while this connection was still registering: attach nothing
      // and take it straight back down.
      if (runtimeOwner !== token) {
        teardown();
        return;
      }
      currentRuntime = teardown;
    },
  });
}

/** Persist a human's pick for this terminal, then connect as it. */
export async function selectProfile(profile: ResolvedProfile): Promise<void> {
  const pane = await detectTmuxPane().catch(() => null);
  writeStickyProfile(profile.profileName, { configPath: profile.configPath, pane });
  connectAs(profile, pane);
}
