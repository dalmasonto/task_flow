import { describe, it, expect } from "vitest";
import { createSerialQueue } from "./pane-queue.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("createSerialQueue", () => {
  it("runs tasks one at a time, never overlapping", async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    const make = (id: string, delay: number) => async () => {
      events.push(`start:${id}`);
      await tick(delay);
      events.push(`end:${id}`);
    };

    // B is enqueued after A but with a shorter delay: without serialization B
    // would finish inside A's window (start A, start B, end B, end A).
    const a = queue(make("A", 30));
    const b = queue(make("B", 1));
    await Promise.all([a, b]);

    expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("preserves call order", async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => queue(async () => { order.push(n); })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("a failing task rejects to its caller but does not wedge the queue", async () => {
    const queue = createSerialQueue();
    const ran: string[] = [];

    const failing = queue(async () => {
      ran.push("boom");
      throw new Error("boom");
    });
    const after = queue(async () => {
      ran.push("after");
    });

    await expect(failing).rejects.toThrow("boom");
    await after;
    expect(ran).toEqual(["boom", "after"]);
  });
});
