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
