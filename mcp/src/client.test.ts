import { describe, expect, it } from "vitest";
import { TaskflowClient, type FetchLike } from "./client.js";

function stubFetch() {
  const calls: { url: string; init: any }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ id: 1 }),
    };
  };
  return { calls, impl };
}

function client(impl: FetchLike) {
  return new TaskflowClient({ server: "http://localhost:8000", key: "tfk_test", fetchImpl: impl });
}

describe("sendMessage", () => {
  it("posts JSON when there are no attachments", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).sendMessage({ channel: 3, body_markdown: "hi" });

    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ channel: 3, body_markdown: "hi" });
  });

  it("posts multipart when attachments are present", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).sendMessage({
      channel: 3,
      body_markdown: "spec attached",
      attachments: [{ filename: "spec.md", bytes: Buffer.from("# spec\n") }],
    });

    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("channel")).toBe("3");
    expect(body.get("body_markdown")).toBe("spec attached");

    const file = body.get("files") as File;
    expect(file.name).toBe("spec.md");
    expect(await file.text()).toBe("# spec\n");
  });

  it("does not set Content-Type on multipart, so fetch supplies the boundary", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).sendMessage({
      channel: 3,
      body_markdown: "x",
      attachments: [{ filename: "a.txt", bytes: Buffer.from("a") }],
    });

    expect(calls[0].init.headers["Content-Type"]).toBeUndefined();
  });

  it("omits empty optional fields from the multipart form", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).sendMessage({
      channel: 3,
      body_markdown: "x",
      attachments: [{ filename: "a.txt", bytes: Buffer.from("a") }],
    });

    const body = calls[0].init.body as FormData;
    expect(body.get("priority")).toBeNull();
    expect(body.get("client_nonce")).toBeNull();
  });

  it("sends every attachment under the same field name", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).sendMessage({
      channel: 3,
      body_markdown: "two",
      attachments: [
        { filename: "a.txt", bytes: Buffer.from("a") },
        { filename: "b.txt", bytes: Buffer.from("b") },
      ],
    });

    const body = calls[0].init.body as FormData;
    expect(body.getAll("files")).toHaveLength(2);
  });
});

describe("updateTask", () => {
  it("posts only the fields it was given, so an edit is not an overwrite", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).updateTask(42, { title: "renamed" });

    expect(calls[0].url).toContain("/agents/tasks/42");
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: "renamed" });
  });

  it("carries description, notes and priority when present", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).updateTask(7, {
      description_markdown: "d",
      notes_markdown: "n",
      priority: "high",
    });

    expect(JSON.parse(calls[0].init.body)).toEqual({
      description_markdown: "d",
      notes_markdown: "n",
      priority: "high",
    });
  });
});

describe("uploadTaskAttachments", () => {
  it("posts multipart to the agent task attachment route", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).uploadTaskAttachments(9, [
      { filename: "design.md", bytes: Buffer.from("# design\n") },
    ]);

    expect(calls[0].url).toContain("/agents/tasks/9/attachments");
    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get("files") as File;
    expect(file.name).toBe("design.md");
  });
});

describe("createTask", () => {
  it("posts JSON when there are no attachments", async () => {
    const { calls, impl } = stubFetch();
    await client(impl).createTask({ title: "plain" });

    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: "plain" });
  });
});

describe("network-error retry", () => {
  // Counts fetch attempts and always throws a network error, to prove how many
  // times a given call hits the wire.
  function throwingFetch(): { impl: FetchLike; count: () => number } {
    let n = 0;
    const impl: FetchLike = async () => {
      n += 1;
      throw new Error("fetch failed");
    };
    return { impl, count: () => n };
  }

  // --- idempotent operations DO retry once ---

  it("retries an idempotent read (whoami) once and succeeds on the second try", async () => {
    let n = 0;
    const impl: FetchLike = async () => {
      n += 1;
      if (n === 1) throw new Error("fetch failed");
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ agent_id: 1 }) };
    };
    const res = await client(impl).whoami();
    expect(n).toBe(2);
    expect((res as { agent_id: number }).agent_id).toBe(1);
  });

  it("retries markRead (idempotent cursor set) once on a network error", async () => {
    let n = 0;
    const impl: FetchLike = async () => {
      n += 1;
      if (n === 1) throw new Error("fetch failed");
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ id: 9 }) };
    };
    const res = await client(impl).markRead(1, 5);
    expect(n).toBe(2);
    expect(res).toEqual({ id: 9 });
  });

  it("gives up after one retry on a persistent network error (idempotent call)", async () => {
    const { impl, count } = throwingFetch();
    await expect(client(impl).markRead(1, 5)).rejects.toThrow(/network error: fetch failed/);
    expect(count()).toBe(2);
  });

  // --- non-idempotent writes do NOT retry (one fetch only) ---
  // A `fetch failed` cannot prove the server didn't already process the write, so
  // retrying could duplicate the task/message/review/activity/frame.

  it("does NOT retry createTask", async () => {
    const { impl, count } = throwingFetch();
    await expect(client(impl).createTask({ title: "x" })).rejects.toThrow(/network error/);
    expect(count()).toBe(1);
  });

  it("does NOT retry a JSON sendMessage", async () => {
    const { impl, count } = throwingFetch();
    await expect(client(impl).sendMessage({ channel: 1, body_markdown: "x" })).rejects.toThrow(
      /network error/,
    );
    expect(count()).toBe(1);
  });

  it("does NOT retry reportReview", async () => {
    const { impl, count } = throwingFetch();
    await expect(client(impl).reportReview(1, "approved")).rejects.toThrow(/network error/);
    expect(count()).toBe(1);
  });

  it("does NOT retry logActivity", async () => {
    const { impl, count } = throwingFetch();
    await expect(client(impl).logActivity({ action: "note" })).rejects.toThrow(/network error/);
    expect(count()).toBe(1);
  });

  it("does NOT retry appendFrame", async () => {
    const { impl, count } = throwingFetch();
    await expect(client(impl).appendFrame(1, { content: "x" })).rejects.toThrow(/network error/);
    expect(count()).toBe(1);
  });

  it("does NOT retry a multipart upload (FormData body may not survive a resend)", async () => {
    const { impl, count } = throwingFetch();
    await expect(
      client(impl).sendMessage({
        channel: 1,
        body_markdown: "x",
        attachments: [{ filename: "a.txt", bytes: Buffer.from("a") }],
      }),
    ).rejects.toThrow(/network error/);
    expect(count()).toBe(1);
  });
});
