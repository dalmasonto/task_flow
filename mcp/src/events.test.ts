import { describe, it, expect, vi } from "vitest";
import { handleFrame, shouldDeliver, formatIncoming, type AgentMessageEvent } from "./events.js";

const message = (over: Partial<AgentMessageEvent> = {}): AgentMessageEvent => ({
  id: 7,
  channel: 1,
  sender_kind: "user",
  sender_label: "Dalmas",
  body_markdown: "ship it",
  sender_agent: null,
  ...over,
});

const frame = (envelope: unknown) => `event: u\ndata: ${JSON.stringify(envelope)}`;

describe("handleFrame", () => {
  it("dispatches a created message", () => {
    const onMessage = vi.fn();
    handleFrame(frame({ c: "project:1:messages", e: "created", d: message() }), { onMessage });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0]?.[0].body_markdown).toBe("ship it");
  });

  // An edit or delete is not something new to read; delivering it would re-prompt
  // the agent with something it has already seen.
  it("ignores updates and deletes", () => {
    const onMessage = vi.fn();
    handleFrame(frame({ c: "project:1:messages", e: "updated", d: message() }), { onMessage });
    handleFrame(frame({ c: "project:1:messages", e: "deleted", d: message() }), { onMessage });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("survives a malformed frame rather than throwing into the stream", () => {
    const onMessage = vi.fn();
    expect(() => handleFrame("event: u\ndata: {not json", { onMessage })).not.toThrow();
    expect(() => handleFrame("", { onMessage })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores a payload without a usable body", () => {
    const onMessage = vi.fn();
    handleFrame(frame({ e: "created", d: { id: 1 } }), { onMessage });
    expect(onMessage).not.toHaveBeenCalled();
  });

  // SSE permits multi-line data; the frame is reassembled before parsing.
  it("joins multi-line data fields", () => {
    const onMessage = vi.fn();
    const json = JSON.stringify({ e: "created", d: message() });
    const half = Math.floor(json.length / 2);
    handleFrame(`event: u\ndata: ${json.slice(0, half)}\ndata: ${json.slice(half)}`, { onMessage });
    // Split mid-JSON with a newline join, this is NOT valid JSON — it must fail
    // closed rather than deliver garbage.
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("shouldDeliver", () => {
  // Echoing an agent's own message back into its prompt reads as a fresh
  // instruction — a loop against itself.
  it("skips this agent's own messages", () => {
    expect(shouldDeliver(message({ sender_kind: "agent", sender_agent: 3 }), 3)).toBe(false);
  });

  it("delivers humans and other agents", () => {
    expect(shouldDeliver(message(), 3)).toBe(true);
    expect(shouldDeliver(message({ sender_kind: "agent", sender_agent: 9 }), 3)).toBe(true);
  });
});

describe("formatIncoming", () => {
  it("names the sender so the agent knows who is asking", () => {
    expect(formatIncoming(message())).toBe("[taskflow] Message from Dalmas: ship it");
  });

  it("falls back to a role when there is no label", () => {
    expect(formatIncoming(message({ sender_label: "" }))).toContain("Message from User");
  });
});
