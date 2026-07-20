import { describe, it, expect, vi } from "vitest";
import { resolveMessage, type MessageSource } from "./resolve.js";

const msg = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  channel: 1,
  sender_kind: "user",
  sender_label: "dalmasonto",
  body_markdown: `body ${id}`,
  sender_agent: null,
  attachments: [],
  ...over,
});

/** A source that records which channels were queried. */
const source = (
  channels: number[],
  rows: Record<number, ReturnType<typeof msg>[]>,
): MessageSource & { queried: number[] } => {
  const queried: number[] = [];
  return {
    queried,
    listChannels: async () => channels.map((id) => ({ id })),
    listMessages: async ({ channel }) => {
      queried.push(channel);
      return { messages: rows[channel] ?? [] };
    },
  };
};

describe("resolveMessage", () => {
  it("finds the message and returns it whole", async () => {
    const src = source([1, 3], { 3: [msg(42)] });
    const out = await resolveMessage(src, 42);
    expect(out?.id).toBe(42);
    expect(out?.body_markdown).toBe("body 42");
  });

  it("carries the attachments back with it", async () => {
    const files = [{ name: "a.pdf", size_bytes: 10, url: "/media/a.pdf" }];
    const src = source([1], { 1: [msg(42, { attachments: files })] });
    expect((await resolveMessage(src, 42))?.attachments).toEqual(files);
  });

  // The event says only "row 42 appeared somewhere in this project". The agent
  // may not be on that channel at all, in which case the read API returns
  // nothing and there is genuinely nothing to deliver.
  it("returns null when the message is not visible to this agent", async () => {
    const src = source([1, 3], {});
    expect(await resolveMessage(src, 42)).toBeNull();
  });

  // A channel whose fetch fails must not take the whole delivery with it — the
  // message is probably in one of the others.
  it("keeps looking when one channel errors", async () => {
    const src: MessageSource = {
      listChannels: async () => [{ id: 1 }, { id: 3 }],
      listMessages: async ({ channel }) => {
        if (channel === 1) throw new Error("boom");
        return { messages: [msg(42, { channel: 3 })] };
      },
    };
    expect((await resolveMessage(src, 42))?.id).toBe(42);
  });

  it("returns null rather than throwing when every channel fails", async () => {
    const src: MessageSource = {
      listChannels: async () => [{ id: 1 }],
      listMessages: async () => {
        throw new Error("backend down");
      },
    };
    expect(await resolveMessage(src, 42)).toBeNull();
  });

  it("survives the channel list itself failing", async () => {
    const src: MessageSource = {
      listChannels: async () => {
        throw new Error("backend down");
      },
      listMessages: async () => ({ messages: [] }),
    };
    expect(await resolveMessage(src, 42)).toBeNull();
  });

  // A near-miss id must never be delivered as though it were the real one: the
  // narrow `since` window can return a neighbouring row.
  it("never returns a different message than the one asked for", async () => {
    const src = source([1], { 1: [msg(41), msg(43)] });
    expect(await resolveMessage(src, 42)).toBeNull();
  });

  it("asks every channel the agent is on", async () => {
    const src = source([1, 3, 7], { 7: [msg(42)] });
    await resolveMessage(src, 42);
    expect(src.queried.sort()).toEqual([1, 3, 7]);
  });

  // A wide fetch per event would be one full page per message on a busy project.
  it("requests a narrow window around the id, not the whole channel", async () => {
    const listMessages = vi.fn(async () => ({ messages: [msg(42)] }));
    await resolveMessage({ listChannels: async () => [{ id: 1 }], listMessages }, 42);
    expect(listMessages).toHaveBeenCalledWith({ channel: 1, since: 41, limit: 1 });
  });
});
