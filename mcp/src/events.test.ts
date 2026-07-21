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

  // #12: a terminal key is projected inline and routed to onTerminalKey, which
  // (in index.ts) types it into the pane only if it is for this agent.
  it("routes a terminal key with its agent and key name", () => {
    const onMessage = vi.fn();
    const onTerminalKey = vi.fn();
    handleFrame(frame({ c: "project:1:terminal_inputs", e: "created", d: { agent: 5, keys: "Up" } }), {
      onMessage,
      onTerminalKey,
    });
    expect(onTerminalKey).toHaveBeenCalledWith({ agent: 5, keys: "Up" });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores a terminal_inputs frame missing agent or keys", () => {
    const onMessage = vi.fn();
    const onTerminalKey = vi.fn();
    handleFrame(frame({ c: "project:1:terminal_inputs", e: "created", d: { agent: 5 } }), {
      onMessage,
      onTerminalKey,
    });
    expect(onTerminalKey).not.toHaveBeenCalled();
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

  // #29: a directed group message (target_agent set) only reaches that agent's
  // pane; a null target broadcasts to everyone on the channel (the default).
  it("delivers a message targeted at this agent", () => {
    expect(shouldDeliver(message({ target_agent: 3 }), 3)).toBe(true);
  });

  it("skips a message targeted at a different agent", () => {
    expect(shouldDeliver(message({ target_agent: 9 }), 3)).toBe(false);
  });

  it("broadcasts when there is no target", () => {
    expect(shouldDeliver(message({ target_agent: null }), 3)).toBe(true);
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

  // #29 part 2: the pushed notice used to be prose only, so an agent that did
  // not already hold the context had to guess (or reply to the wrong task /
  // person). Carry the ids so it can query and act without a round trip.
  it("appends a context block with the ids an agent needs to act", () => {
    const out = formatIncoming(message({ project: 2, task: 21, sender_user: 1, sender_kind: "user" }));
    expect(out).toContain("project=2");
    expect(out).toContain("channel=1");
    expect(out).toContain("message=7");
    expect(out).toContain("task=21");
    expect(out).toContain("from=user:1");
  });

  it("shows an agent sender and omits an absent task", () => {
    const out = formatIncoming(message({ project: 2, sender_agent: 9, sender_kind: "agent" }));
    expect(out).toContain("project=2");
    expect(out).not.toContain("task=");
    expect(out).toContain("from=agent:9");
  });

  it("adds no context block when there is no project to scope", () => {
    expect(formatIncoming(message())).toBe("[taskflow] Message from Dalmas: ship it");
  });

  it("keeps the context block when the body is shortened", () => {
    const out = formatIncoming(message({ project: 2, task: 21, body_markdown: "z".repeat(2_000) }));
    expect(out).toContain("task=21");
    expect(out).toContain("…");
  });

  it("stays a single line with the context block so it cannot submit early", () => {
    const out = formatIncoming(message({ project: 2, task: 21 }));
    expect(out).not.toContain("\n");
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

  // Observed live 2026-07-21: numbers TOGGLE, then Right opens the review
  // screen ("Ready to submit your answers?"). answerKeystrokes only REACHES
  // that screen; the submit is owned by keystrokesForPrompt, because the same
  // review screen is shared with multi-question sets. The earlier trailing "1"
  // here was a submit attempt with no Enter — it highlighted the option and
  // left the agent waiting, exactly like the single-select bug.
  it("multi-select toggles each, then Right to reach the review screen", () => {
    expect(answerKeystrokes([1, 3], "multi")).toEqual(["1", "3", "Right"]);
  });

  it("a one-item multi-select still opens the review screen", () => {
    expect(answerKeystrokes([2], "multi")).toEqual(["2", "Right"]);
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
