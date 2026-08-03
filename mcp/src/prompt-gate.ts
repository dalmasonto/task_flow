/**
 * #127: pause pane message delivery while THIS agent has an open prompt.
 *
 * The problem: message delivery and prompt-answer replay share one live terminal
 * surface. If a chat message is typed into the pane while a permission/question
 * prompt is waiting, the text lands in the prompt and can submit an answer nobody
 * chose. Blocking the sender's UI is not enough — another human or agent can send
 * a message that reaches the same pane.
 *
 * The fix, at the delivery layer: when a prompt for this agent is `pending`, hold
 * inbound message deliveries in a bounded queue instead of typing them; when the
 * prompt is `answered`/`cancelled` (incl. agent-cleared/timeout), flush the queue
 * in order. Crucially, a queued message is NOT resolved or marked read until it
 * is actually delivered — so nothing advances the read cursor while it waits, and
 * a restart mid-block leaves it unread and recoverable via `check_messages`.
 *
 * Prompt-answer key replay is deliberately NOT gated — that is the human's
 * deliberate response and must reach the pane. The runtime enqueues those keys
 * before it lets the gate flush, so the answer submits before any queued chat.
 */

/** The prompt fields the gate needs off a realtime `:prompts` event. */
export interface PromptGateEvent {
  id: number;
  /** The agent whose terminal the prompt is on. The gate ignores other agents'
   *  prompts — they don't block THIS pane. */
  agent?: number | null;
  /** "pending" opens the block; "answered"/"cancelled" resolve it. */
  status: string;
}

export interface PromptGateOptions {
  /** This runtime's agent id — only its own prompts gate its pane. */
  selfAgentId: number;
  /** Actually deliver a message (resolve → notify pane → mark read). Called
   *  immediately when unblocked, or per queued item on flush. */
  deliver: (id: number, edited: boolean) => Promise<void>;
  log?: (line: string) => void;
  /** Soft threshold: when the queue first passes this size, log a warning so a
   *  stuck-open prompt holding many messages is visible. The queue is NOT capped
   *  by dropping — TaskFlow read cursors are high-water per channel (unread is
   *  `id > read_cursor`), so dropping a queued id while a later same-channel
   *  message flushes + marks read would make the dropped id unrecoverable. Each
   *  entry is just an id + flag (tiny), and the queue only lives for the duration
   *  of one open prompt, so it is bounded in practice by message volume. */
  warnThreshold?: number;
}

export interface PromptGate {
  /** Route one inbound message: deliver now, or queue if a prompt is open. */
  onMessage: (id: number, edited?: boolean) => void | Promise<void>;
  /** Feed every `:prompts` event: opens/resolves the block for this agent. */
  onPromptState: (prompt: PromptGateEvent) => void;
  /** Authoritative reconcile — replace the open-prompt set with the backend's
   *  current pending prompts for this agent. Used to hydrate on connect/reconnect
   *  so a prompt created (or resolved) while the stream was down is still
   *  reflected, closing the gap where realtime `:prompts` events were missed. */
  setOpenPrompts: (promptIds: number[]) => void;
  /** True while at least one of this agent's prompts is open. */
  isBlocked: () => boolean;
  /** How many messages are waiting to be flushed. */
  queueLength: () => number;
}

const DEFAULT_WARN_THRESHOLD = 200;

export function createPromptGate(options: PromptGateOptions): PromptGate {
  const log = options.log ?? (() => {});
  const warnThreshold = options.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
  // Open prompt ids for THIS agent. A set, not a boolean: a prompt SET can raise
  // several, and delivery must stay paused until the last one clears.
  const open = new Set<number>();
  const queue: Array<{ id: number; edited: boolean }> = [];
  let flushing = false;

  const flush = async () => {
    // One flush at a time; if a new prompt opens mid-flush the loop stops and the
    // remainder waits for the next resolve.
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0 && open.size === 0) {
        const next = queue.shift()!;
        try {
          await options.deliver(next.id, next.edited);
        } catch (err) {
          log(`prompt-gate: could not deliver queued message ${next.id} (${(err as Error).message.split("\n")[0]})`);
        }
      }
    } finally {
      flushing = false;
    }
  };

  return {
    onMessage: (id, edited = false) => {
      if (open.size === 0) return options.deliver(id, edited);
      // Never drop: a dropped id would be lost, because a later same-channel
      // message flushing + marking read advances the high-water cursor past it.
      // Entries are tiny (id + flag) and live only while the prompt is open.
      queue.push({ id, edited });
      if (queue.length === warnThreshold) {
        log(`prompt-gate: ${queue.length}+ messages queued behind an open prompt — will flush when it resolves`);
      }
      return undefined;
    },

    setOpenPrompts: (promptIds) => {
      open.clear();
      for (const promptId of promptIds) open.add(promptId);
      if (open.size === 0) {
        void flush();
      } else {
        log(`prompt-gate: hydrated ${open.size} open prompt(s) — pausing pane message delivery`);
      }
    },

    onPromptState: (prompt) => {
      // Only THIS agent's prompts block THIS pane.
      if (prompt.agent !== options.selfAgentId) return;
      if (prompt.status === "pending") {
        const wasOpen = open.size > 0;
        open.add(prompt.id);
        if (!wasOpen) log(`prompt-gate: prompt ${prompt.id} open — pausing pane message delivery`);
      } else {
        // answered / cancelled (incl. agent-cleared or timed-out): resolve it.
        if (open.delete(prompt.id) && open.size === 0) {
          log(`prompt-gate: prompt ${prompt.id} ${prompt.status} — resuming delivery, flushing ${queue.length} queued`);
          void flush();
        }
      }
    },

    isBlocked: () => open.size > 0,
    queueLength: () => queue.length,
  };
}
