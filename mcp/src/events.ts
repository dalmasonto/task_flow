/**
 * Listen to the agent's server-sent event stream so messages reach the terminal
 * the instant they are sent.
 *
 * This is v1's tmux-bridge idea (`task_flow/mcp-server/src/tmux-bridge.ts`):
 * hold a stream open for the life of the session and inject on arrival, instead
 * of polling. Polling made delivery as slow as the interval and cost a request
 * per tick even in silence.
 *
 * It cannot use `EventSource`: agents authenticate with `Authorization: Agent
 * <key>`, and EventSource cannot set headers. Node's fetch can, so the SSE frame
 * parsing is done here — it is a small, well-specified format.
 */

import { TaskflowClient } from "./client.js";

/** Backoff between reconnects: fast first retry, then double, capped. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Treat the stream as dead after this long with NOTHING on it — not even a
 * keep-alive comment.
 *
 * A dropped connection does not reliably surface as an error: when the server
 * goes away mid-stream, `reader.read()` can stay pending forever, so the
 * listener sits there believing it is connected while nothing is delivered.
 * Waiting for an error is waiting for an event that never comes; the only sound
 * signal is the absence of expected traffic. The server sends SSE keep-alives
 * every ~15s, so silence well past that means the stream is gone.
 */
const STREAM_IDLE_TIMEOUT_MS = 45_000;

export interface AgentMessageEvent {
  id: number;
  channel: number;
  sender_kind: string;
  sender_label: string;
  body_markdown: string;
  sender_agent: number | null;
}

export interface EventStreamOptions {
  server: string;
  key: string;
  /** Called for each message created in this agent's project. */
  onMessage: (message: AgentMessageEvent) => void | Promise<void>;
  log?: (line: string) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export interface EventStreamHandle {
  stop: () => void;
  /**
   * Drop the current connection and reconnect now.
   *
   * The idle watchdog is a backstop measured in tens of seconds; when something
   * else in this process has just proven the backend is unreachable (a failed
   * heartbeat, say), there is no reason to wait for it.
   */
  reconnectNow: () => void;
}

/**
 * Hold the stream open, reconnecting with backoff.
 *
 * Never rejects: a stream that cannot connect retries quietly forever, because
 * the agent must keep working whether or not the dashboard is reachable.
 */
export function startAgentEventStream(options: EventStreamOptions): EventStreamHandle {
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.server.replace(/\/+$/, "")}/api/taskflow/agents/events`;
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = () => {
    if (stopped) return;
    const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
    retryTimer.unref?.();
  };

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await doFetch(url, {
        headers: { Authorization: `Agent ${options.key}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        scheduleRetry();
        return;
      }
      attempt = 0;
      log("event stream connected");

      // Watchdog: abort a stream that has gone quiet, which forces the read to
      // settle and drops us into the reconnect path.
      let lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > STREAM_IDLE_TIMEOUT_MS) {
          log("event stream idle — assuming it died, reconnecting");
          controller?.abort();
        }
      }, Math.floor(STREAM_IDLE_TIMEOUT_MS / 3));
      watchdog.unref?.();

      // Parse SSE frames. `data:` may be split across TCP chunks, so text is
      // buffered until a blank line terminates the frame.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Any byte counts as life, keep-alive comments included.
        lastActivity = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleFrame(frame, options);
          boundary = buffer.indexOf("\n\n");
        }
      }
      } finally {
        clearInterval(watchdog);
      }
      if (!stopped) {
        log("event stream closed by server");
        scheduleRetry();
      }
    } catch (err) {
      if (!stopped) {
        log(`event stream error: ${(err as Error).message.split("\n")[0]}`);
        scheduleRetry();
      }
    }
  };

  void connect();

  return {
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    },
    reconnectNow: () => {
      if (stopped) return;
      // Abort settles the pending read, which lands in the reconnect path.
      // Reset the backoff: this is a known-cause drop, not a flapping server.
      attempt = 0;
      controller?.abort();
    },
  };
}

/** Pull the `data:` lines out of one SSE frame and dispatch a message event. */
export function handleFrame(frame: string, options: Pick<EventStreamOptions, "onMessage">): void {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return;

  let envelope: { c?: string; e?: string; d?: unknown };
  try {
    envelope = JSON.parse(data);
  } catch {
    return;
  }
  // Only creations matter for delivery: an edit or a delete is not a new thing
  // for the agent to read.
  if (envelope.e !== "created") return;
  const row = envelope.d as Partial<AgentMessageEvent> | undefined;
  if (!row || typeof row.id !== "number" || typeof row.body_markdown !== "string") return;
  void options.onMessage(row as AgentMessageEvent);
}

/**
 * Whether a message should be delivered to THIS agent's terminal.
 *
 * Its own messages are skipped: echoing them back would read as a new
 * instruction and could loop the agent against itself.
 */
export function shouldDeliver(message: AgentMessageEvent, selfAgentId: number): boolean {
  if (message.sender_kind === "agent" && message.sender_agent === selfAgentId) return false;
  return true;
}

/** Format a delivered message the way v1 did: who it is from, then the text. */
export function formatIncoming(message: AgentMessageEvent): string {
  const who = message.sender_label || (message.sender_kind === "user" ? "User" : "Agent");
  return `[taskflow] Message from ${who}: ${message.body_markdown}`;
}

export type { TaskflowClient };
