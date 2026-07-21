/**
 * A serial queue for pane writes.
 *
 * ## Why this exists
 *
 * Every write to the agent's tmux pane — delivering a message, replaying a
 * prompt answer, sending a terminal key — is a MULTI-STEP tmux sequence
 * (`send-keys -l <text>` then `send-keys Enter`, or a paced run of keys). The
 * event stream dispatches handlers fire-and-forget (`void onMessage(...)`), so
 * two writes that land close together used to interleave: `typeA, typeB,
 * EnterA, EnterB` — and the first Enter submits BOTH texts as one line while the
 * second submits nothing. That is the "a message meant for someone else was
 * typed into my pane and the next message's Enter submitted it" race.
 *
 * Routing every pane write through one serial queue makes each sequence
 * atomic with respect to the others: a write runs to completion before the next
 * begins, so type/Enter pairs can never cross.
 */

/** Runs enqueued tasks one at a time, in call order. */
export interface SerialQueue {
  /** Enqueue a task; resolves/rejects with the task's own result. */
  (task: () => Promise<void>): Promise<void>;
}

/**
 * Create a serial queue. Each task waits for the previous one to settle (success
 * OR failure) before it starts, so a single failing write never wedges or
 * reorders the queue. The caller still sees its own task's rejection.
 */
export function createSerialQueue(): SerialQueue {
  // The tail is a promise that settles when the last-enqueued task is done. It
  // is kept deliberately error-swallowed so one rejection cannot break the chain
  // for everything queued after it.
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}
