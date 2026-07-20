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

  // Chat events are id-only on the wire: the rows are channel-scoped but the
  // realtime group is per-PROJECT, so projecting `body_markdown` broadcast every
  // DM to the whole project (see backend/tests/realtime_dm_privacy.rs). The
  // delivery path must therefore accept a bare id and resolve the message over
  // the authorized read API.
  //
  // This test previously asserted the OPPOSITE — that `{id: 1}` is ignored —
  // and stayed green when the projection changed, silently certifying that live
  // delivery was dead.
  it("dispatches an id-only message event", () => {
    const onMessage = vi.fn();
    handleFrame(frame({ c: "project:1:messages", e: "created", d: { id: 42 } }), { onMessage });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0]?.[0].id).toBe(42);
  });

  it("ignores a payload with no id at all — there is nothing to resolve", () => {
    const onMessage = vi.fn();
    handleFrame(frame({ c: "project:1:messages", e: "created", d: {} }), { onMessage });
    handleFrame(frame({ c: "project:1:messages", e: "created", d: { id: "nope" } }), { onMessage });
    expect(onMessage).not.toHaveBeenCalled();
  });

  // Every table shares the project room, so an id-only row from `tasks` or
  // `read_cursors` looks exactly like an id-only message. Only the group name
  // distinguishes them; without this filter every task edit would be delivered
  // to the agent as if someone had spoken to it.
  it("ignores id-only rows from other tables in the same project", () => {
    const onMessage = vi.fn();
    handleFrame(frame({ c: "project:1:tasks", e: "created", d: { id: 42 } }), { onMessage });
    handleFrame(frame({ c: "project:1:read_cursors", e: "created", d: { id: 42 } }), { onMessage });
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

  it("adds nothing when there are no attachments", () => {
    expect(formatIncoming(message(), [])).toBe("[taskflow] Message from Dalmas: ship it");
  });

  // A pushed message used to be text only, so an attached file was invisible:
  // the agent answered the message and never knew a file came with it.
  it("lists an attachment's name, size and url", () => {
    const out = formatIncoming(message(), [
      { name: "diagram.png", size_bytes: 105_613, url: "/media/abc-diagram.png" },
    ]);
    expect(out).toContain("1 attachment");
    expect(out).toContain("diagram.png");
    expect(out).toContain("103 KB");
    expect(out).toContain("/media/abc-diagram.png");
  });

  it("lists every attachment when there are several", () => {
    const out = formatIncoming(message(), [
      { name: "a.png", size_bytes: 1_024, url: "/media/a.png" },
      { name: "b.pdf", size_bytes: 2_097_152, url: "/media/b.pdf" },
    ]);
    expect(out).toContain("2 attachments");
    expect(out).toContain("a.png");
    expect(out).toContain("b.pdf");
    expect(out).toContain("2.0 MB");
  });

  it("says the body was shortened rather than trimming it silently", () => {
    // Silent truncation is what lost a request mid-sentence: the agent read a
    // half message, answered it, and had no signal there was more.
    const long = "x".repeat(2_000);
    const out = formatIncoming(message({ body_markdown: long }));
    expect(out).toContain("…");
    expect(out).toMatch(/check_messages/);
    expect(out.length).toBeLessThan(1_200);
  });

  it("keeps the attachment list intact when the body is shortened", () => {
    // The manifest must never be the part that gets cut — it is the pointer to
    // everything the notice could not carry.
    const out = formatIncoming(message({ body_markdown: "y".repeat(2_000) }), [
      { name: "keep-me.png", size_bytes: 2_048, url: "/media/keep-me.png" },
    ]);
    expect(out).toContain("keep-me.png");
    expect(out).toContain("/media/keep-me.png");
    expect(out).toContain("…");
  });

  it("stays a single line so it cannot submit the prompt early", () => {
    const out = formatIncoming(message({ body_markdown: "line one\nline two" }), [
      { name: "x.png", size_bytes: 10, url: "/media/x.png" },
    ]);
    expect(out).not.toContain("\n");
  });
});

import { answerKeystrokes, chosenNumbers, isAnsweredPrompt } from "./events.js";

describe("answerKeystrokes", () => {
  // Observed live 2026-07-21: pressing the number HIGHLIGHTS the option but does
  // not submit it — the agent sat waiting on an answered prompt. The previous
  // comment here claimed the number both selects and submits, and was wrong.
  // Selection without submission is the worst failure mode available: the
  // dashboard shows the question answered while the agent is still blocked.
  it("single-select needs an explicit submit after the number", () => {
    expect(answerKeystrokes([2], "single")).toEqual(["2", "Enter"]);
  });

  // Also verified live: numbers TOGGLE, Right opens the review pane, 1 submits.
  // Sending one digit here would tick a box and leave the agent still waiting.
  it("multi-select toggles each, then Right, then 1 to submit", () => {
    expect(answerKeystrokes([1, 3], "multi")).toEqual(["1", "3", "Right", "1"]);
  });

  it("a one-item multi-select still needs the submit stage", () => {
    expect(answerKeystrokes([2], "multi")).toEqual(["2", "Right", "1"]);
  });

  it("sends nothing when nothing was chosen", () => {
    expect(answerKeystrokes([], "single")).toEqual([]);
    expect(answerKeystrokes([], "multi")).toEqual([]);
  });
});

describe("chosenNumbers", () => {
  const base = { id: 1, session: 1, question: "q", kind: "single", status: "answered" };

  it("reads the multi answer list", () => {
    expect(chosenNumbers({ ...base, kind: "multi", answer: 1, answer_json: "[1,3]" })).toEqual([1, 3]);
  });

  it("falls back to the single answer", () => {
    expect(chosenNumbers({ ...base, answer: 2, answer_json: null })).toEqual([2]);
  });

  it("survives malformed answer_json instead of throwing at the agent", () => {
    expect(chosenNumbers({ ...base, answer: 2, answer_json: "{oops" })).toEqual([2]);
  });
});

describe("isAnsweredPrompt", () => {
  it("ignores a prompt that is still pending", () => {
    expect(isAnsweredPrompt({ id: 1, status: "pending", answer: null, answer_json: null })).toBe(false);
  });

  // "Cancel" is the other button on the review screen, and reaching it means
  // replaying every answer first — so a human cancel is just as actionable as a
  // human submit. `answered_by` is what separates it from the agent clearing its
  // own prompt (timed out, answered in the terminal), which must NOT fire keys:
  // that agent has already moved on and the digits would land elsewhere.
  it("acts on a prompt a human cancelled from the dashboard", () => {
    expect(
      isAnsweredPrompt({ id: 1, status: "cancelled", answer: 2, answer_json: "[[2],[1]]", answered_by: 1 })
    ).toBe(true);
  });

  it("ignores a prompt the AGENT cancelled for itself", () => {
    expect(
      isAnsweredPrompt({ id: 1, status: "cancelled", answer: null, answer_json: null, answered_by: null })
    ).toBe(false);
  });

  it("accepts an answered one", () => {
    expect(isAnsweredPrompt({ id: 1, status: "answered", answer: 2, answer_json: null })).toBe(true);
  });

  it("ignores junk", () => {
    expect(isAnsweredPrompt(null)).toBe(false);
    expect(isAnsweredPrompt({ status: "answered" })).toBe(false);
  });
});
