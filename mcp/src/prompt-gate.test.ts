import { describe, it, expect, vi } from "vitest";
import { createPromptGate } from "./prompt-gate.js";

const SELF = 1;

/** A deliver spy that records the order ids were delivered in. */
function deliverSpy() {
  const delivered: number[] = [];
  const deliver = vi.fn(async (id: number) => {
    delivered.push(id);
  });
  return { delivered, deliver };
}

describe("createPromptGate", () => {
  it("delivers immediately when no prompt is open", async () => {
    const { delivered, deliver } = deliverSpy();
    const gate = createPromptGate({ selfAgentId: SELF, deliver });
    await gate.onMessage(10);
    expect(delivered).toEqual([10]);
    expect(gate.isBlocked()).toBe(false);
  });

  it("queues (does not deliver) while this agent's prompt is open, then flushes in order", async () => {
    const { delivered, deliver } = deliverSpy();
    const gate = createPromptGate({ selfAgentId: SELF, deliver });

    gate.onPromptState({ id: 500, agent: SELF, status: "pending" });
    expect(gate.isBlocked()).toBe(true);

    gate.onMessage(10);
    gate.onMessage(11);
    expect(deliver).not.toHaveBeenCalled();
    expect(gate.queueLength()).toBe(2);

    gate.onPromptState({ id: 500, agent: SELF, status: "answered" });
    await vi.waitFor(() => expect(delivered).toEqual([10, 11]));
    expect(gate.isBlocked()).toBe(false);
    expect(gate.queueLength()).toBe(0);
  });

  it("resumes on a cancelled prompt too (agent-cleared / timed out)", async () => {
    const { delivered, deliver } = deliverSpy();
    const gate = createPromptGate({ selfAgentId: SELF, deliver });
    gate.onPromptState({ id: 7, agent: SELF, status: "pending" });
    gate.onMessage(42);
    gate.onPromptState({ id: 7, agent: SELF, status: "cancelled" });
    await vi.waitFor(() => expect(delivered).toEqual([42]));
  });

  it("ignores another agent's prompt — it does not block this pane", async () => {
    const { delivered, deliver } = deliverSpy();
    const gate = createPromptGate({ selfAgentId: SELF, deliver });
    gate.onPromptState({ id: 9, agent: 2, status: "pending" }); // a different agent
    expect(gate.isBlocked()).toBe(false);
    await gate.onMessage(10);
    expect(delivered).toEqual([10]); // delivered straight through
  });

  it("stays blocked until the LAST of several open prompts resolves", async () => {
    const { delivered, deliver } = deliverSpy();
    const gate = createPromptGate({ selfAgentId: SELF, deliver });
    gate.onPromptState({ id: 1, agent: SELF, status: "pending" });
    gate.onPromptState({ id: 2, agent: SELF, status: "pending" });
    gate.onMessage(10);

    gate.onPromptState({ id: 1, agent: SELF, status: "answered" });
    expect(gate.isBlocked()).toBe(true); // prompt 2 still open
    expect(deliver).not.toHaveBeenCalled();

    gate.onPromptState({ id: 2, agent: SELF, status: "answered" });
    await vi.waitFor(() => expect(delivered).toEqual([10]));
  });

  it("never drops queued messages (cursor-safe): all flush in order even past the warn threshold", async () => {
    // Dropping would lose an id — a later same-channel flush advances the
    // high-water read cursor past it. So the queue holds everything.
    const { delivered, deliver } = deliverSpy();
    const gate = createPromptGate({ selfAgentId: SELF, deliver, warnThreshold: 2 });
    gate.onPromptState({ id: 1, agent: SELF, status: "pending" });
    gate.onMessage(10);
    gate.onMessage(11);
    gate.onMessage(12); // past the warn threshold — still queued, NOT dropped
    expect(gate.queueLength()).toBe(3);

    gate.onPromptState({ id: 1, agent: SELF, status: "answered" });
    await vi.waitFor(() => expect(delivered).toEqual([10, 11, 12]));
  });

  describe("setOpenPrompts (hydration for missed realtime / restart)", () => {
    it("blocks when hydrated with a pending prompt the stream never announced", async () => {
      const { delivered, deliver } = deliverSpy();
      const gate = createPromptGate({ selfAgentId: SELF, deliver });
      gate.setOpenPrompts([77]); // authoritative: backend says this agent has an open prompt
      expect(gate.isBlocked()).toBe(true);
      gate.onMessage(10);
      expect(deliver).not.toHaveBeenCalled();
      gate.onPromptState({ id: 77, agent: SELF, status: "answered" });
      await vi.waitFor(() => expect(delivered).toEqual([10]));
    });

    it("flushes when hydration shows nothing pending (prompt resolved during the outage)", async () => {
      const { delivered, deliver } = deliverSpy();
      const gate = createPromptGate({ selfAgentId: SELF, deliver });
      gate.onPromptState({ id: 5, agent: SELF, status: "pending" });
      gate.onMessage(10);
      expect(gate.isBlocked()).toBe(true);
      gate.setOpenPrompts([]); // backend: no pending prompts anymore
      await vi.waitFor(() => expect(delivered).toEqual([10]));
      expect(gate.isBlocked()).toBe(false);
    });
  });

  it("does not advance delivery for a queued message until flush (deliver not called while blocked)", async () => {
    const { deliver } = deliverSpy();
    const gate = createPromptGate({ selfAgentId: SELF, deliver });
    gate.onPromptState({ id: 1, agent: SELF, status: "pending" });
    gate.onMessage(10);
    // deliver is what resolves + marks read; it must not run while blocked.
    expect(deliver).not.toHaveBeenCalled();
  });
});
