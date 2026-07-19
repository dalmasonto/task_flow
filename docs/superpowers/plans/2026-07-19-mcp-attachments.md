# MCP Message Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent attach files to a TaskFlow message via the MCP `send_message` tool, instead of pasting file contents into the message body.

**Architecture:** Three layers, each independently testable. A new `src/attachments.ts` validates and reads paths (the security boundary, tested without a server). `src/client.ts` gains a multipart branch in its request helper. `src/server.ts` exposes a `files` parameter. No backend change — `POST /api/taskflow/agents/agent/messages` already accepts multipart.

**Tech Stack:** TypeScript, Node 24 (native `FormData`/`Blob`, no new dependency), Zod for tool schemas, Vitest.

## Global Constraints

- Max attachment size: **25 MB** per file (`MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024`), matching `backend/plugins/taskflow-agents/src/views.rs:43`.
- Project root is `dirname(configPath)`, using the `configPath` const already in scope at `mcp/src/server.ts:77` — the directory holding `.taskflow.json`. **Never** `process.cwd()`.
- Containment is checked **after** `fs.realpath`, using `path.relative` — never a bare string `startsWith`.
- Validation is all-or-nothing: any bad path means nothing is uploaded and no message is created.
- Absent `files` must produce byte-identical behaviour to today (JSON POST).
- Run all commands from `/home/dalmas/E/projects/local_task_tracker/mcp`.
- Node's global `fetch` is used in production; tests inject a stub via `fetchImpl`.

## File Structure

| File | Responsibility |
|---|---|
| `src/attachments.ts` (create) | Validate paths and read bytes. Throws `AttachmentError`. No network. |
| `src/attachments.test.ts` (create) | The security boundary's test coverage. |
| `src/client.ts` (modify) | Widen `FetchLike`, add a multipart branch, extend `sendMessage`. |
| `src/client.test.ts` (create) | Multipart assembly against a stub fetch. |
| `src/server.ts` (modify) | Expose `files` on the `send_message` tool. |

---

### Task 1: Attachment validation and reading

**Files:**
- Create: `mcp/src/attachments.ts`
- Test: `mcp/src/attachments.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `MAX_ATTACHMENT_BYTES: number`, `class AttachmentError extends Error`, `interface Attachment { filename: string; bytes: Buffer }`, `function resolveAttachments(paths: string[], root: string): Promise<Attachment[]>`.

- [ ] **Step 1: Write the failing tests**

Create `mcp/src/attachments.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES, AttachmentError, resolveAttachments } from "./attachments.js";

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "tf-attach-"));
  root = join(base, "project");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, "planning"), { recursive: true });
  await writeFile(join(root, "planning", "spec.md"), "# spec\n");
  await writeFile(join(outside, "secret.txt"), "SECRET\n");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  // A sibling directory sharing the root's name as a string prefix.
  await mkdir(`${root}_evil`, { recursive: true });
  await writeFile(join(`${root}_evil`, "evil.txt"), "EVIL\n");
});

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
  await rm(`${root}_evil`, { recursive: true, force: true });
});

describe("resolveAttachments", () => {
  it("reads a relative path inside the root", async () => {
    const out = await resolveAttachments(["planning/spec.md"], root);
    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe("spec.md");
    expect(out[0].bytes.toString()).toBe("# spec\n");
  });

  it("accepts an absolute path inside the root", async () => {
    const out = await resolveAttachments([join(root, "planning", "spec.md")], root);
    expect(out[0].filename).toBe("spec.md");
  });

  it("resolves relative paths against the root, not process.cwd()", async () => {
    const out = await resolveAttachments(["planning/spec.md"], root);
    expect(out[0].bytes.toString()).toBe("# spec\n");
  });

  it("rejects path traversal", async () => {
    await expect(resolveAttachments(["../outside/secret.txt"], root)).rejects.toThrow(
      AttachmentError,
    );
  });

  it("rejects a symlink escaping the root", async () => {
    await expect(resolveAttachments(["escape.txt"], root)).rejects.toThrow(/outside the project/i);
  });

  it("rejects a sibling directory sharing the root's name prefix", async () => {
    await expect(
      resolveAttachments([join(`${root}_evil`, "evil.txt")], root),
    ).rejects.toThrow(/outside the project/i);
  });

  it("rejects a missing file", async () => {
    await expect(resolveAttachments(["nope.md"], root)).rejects.toThrow(/not found/i);
  });

  it("rejects a directory", async () => {
    await expect(resolveAttachments(["planning"], root)).rejects.toThrow(/not a file/i);
  });

  it("rejects an oversize file", async () => {
    const big = join(root, "big.bin");
    await writeFile(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    await expect(resolveAttachments(["big.bin"], root)).rejects.toThrow(/25MB/);
    await rm(big, { force: true });
  });

  it("is all-or-nothing: one bad path yields nothing", async () => {
    await expect(
      resolveAttachments(["planning/spec.md", "nope.md"], root),
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/attachments.test.ts`
Expected: FAIL — `Failed to resolve import "./attachments.js"`.

- [ ] **Step 3: Write the implementation**

Create `mcp/src/attachments.ts`:

```ts
/**
 * Resolve local file paths into message attachments.
 *
 * An attachment becomes a fetchable URL once uploaded, so an unrestricted path
 * parameter would turn one bad instruction into an exfiltration channel. Every
 * path is therefore confined to the project root — the directory holding
 * `.taskflow.json` — and validated fully before any upload begins.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** Mirrors `MAX_ATTACHMENT_BYTES` in the backend (views.rs). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface Attachment {
  filename: string;
  bytes: Buffer;
}

/**
 * True when `candidate` is inside `root`.
 *
 * Uses `path.relative` rather than a string prefix test: `startsWith` would let
 * `<root>_evil` pass, since it shares the root's characters without being under
 * it. Both arguments must already be real (symlink-resolved) paths.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Validate and read every path, or throw. Nothing is returned unless all paths
 * pass — a partially-attached message is worse than none, because the reader
 * sees text citing a file that never arrived.
 */
export async function resolveAttachments(
  paths: string[],
  root: string,
): Promise<Attachment[]> {
  const realRoot = await realpath(root);
  const out: Attachment[] = [];

  for (const input of paths) {
    // Relative paths resolve against the project root, never process.cwd():
    // a stdio MCP server inherits the client's cwd, which need not match.
    const absolute = isAbsolute(input) ? input : resolve(realRoot, input);

    // realpath BEFORE the containment check — a symlink inside the root that
    // points outside it would pass a check made on the unresolved path.
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw new AttachmentError(`Attachment not found: ${input}`);
    }

    if (!isInside(realRoot, real)) {
      throw new AttachmentError(
        `Attachment is outside the project root: ${input} (resolved to ${real})`,
      );
    }

    const info = await stat(real);
    if (!info.isFile()) {
      throw new AttachmentError(`Attachment is not a file: ${input}`);
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      const mb = (info.size / (1024 * 1024)).toFixed(1);
      throw new AttachmentError(
        `Attachment "${input}" is ${mb}MB; the maximum attachment size is 25MB.`,
      );
    }

    out.push({ filename: basename(real), bytes: await readFile(real) });
  }

  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/attachments.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/attachments.ts mcp/src/attachments.test.ts
git commit -m "feat(mcp): validate and read attachment paths

An attachment becomes a fetchable URL once uploaded, so an unrestricted
path parameter would turn one bad instruction into an exfiltration
channel. Paths are confined to the project root and validated fully
before any upload begins.

Two containment mistakes this avoids deliberately: resolving symlinks
after the check instead of before, which lets a symlink inside the root
point anywhere; and a bare startsWith prefix test, which lets a sibling
<root>_evil through. realpath runs first, and path.relative does the
comparison.

Validation is all-or-nothing. A partially-attached message is worse than
no message, because the reader sees text citing a file that never
arrived."
```

---

### Task 2: Multipart transport in the client

**Files:**
- Modify: `mcp/src/client.ts:14-27` (widen `FetchLike`), `mcp/src/client.ts:104-109` (extend `SendMessageInput`), `mcp/src/client.ts:160-213` (multipart branch), `mcp/src/client.ts:266-269` (`sendMessage`)
- Test: `mcp/src/client.test.ts`

**Interfaces:**
- Consumes: `Attachment` from Task 1 (`{ filename: string; bytes: Buffer }`).
- Produces: `SendMessageInput` gains `attachments?: Attachment[]`. `sendMessage(input: SendMessageInput): Promise<unknown>` — signature unchanged.

- [ ] **Step 1: Write the failing tests**

Create `mcp/src/client.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/client.test.ts`
Expected: FAIL — the multipart test reports `body` is a string, not `FormData`.

- [ ] **Step 3: Widen `FetchLike` to carry a form body**

In `mcp/src/client.ts`, replace `body?: string;` (line 19) with:

```ts
    body?: string | FormData;
```

- [ ] **Step 4: Extend `SendMessageInput`**

In `mcp/src/client.ts`, replace the `SendMessageInput` interface (lines 104-109) with:

```ts
export interface SendMessageInput {
  channel: number;
  body_markdown: string;
  priority?: string;
  client_nonce?: string;
  /** Resolved by `resolveAttachments`; switches the POST to multipart. */
  attachments?: { filename: string; bytes: Buffer }[];
}
```

- [ ] **Step 5: Add a form branch to `RequestOptions` and `request`**

In `mcp/src/client.ts`, add `form?: FormData;` to the `RequestOptions` interface.

Then in `request` (lines 182-185), replace:

```ts
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init!.body = JSON.stringify(options.body);
    }
```

with:

```ts
    if (options.form !== undefined) {
      // Deliberately no Content-Type: fetch must set it to supply the
      // multipart boundary. Setting it here produces a body the server
      // cannot parse.
      init!.body = options.form;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init!.body = JSON.stringify(options.body);
    }
```

- [ ] **Step 6: Allow a per-request timeout override**

In `mcp/src/client.ts`, add `timeoutMs?: number;` to `RequestOptions`, then replace line 188:

```ts
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
```

with:

```ts
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.timeoutMs,
    );
```

- [ ] **Step 7: Branch `sendMessage` on attachments**

In `mcp/src/client.ts`, replace `sendMessage` (lines 266-269) with:

```ts
  /** `POST /agents/agent/messages` — speak as this agent in a channel. */
  sendMessage(input: SendMessageInput): Promise<unknown> {
    const { attachments, ...fields } = input;
    if (!attachments?.length) {
      return this.request("POST", `${API_PREFIX}/agents/agent/messages`, { body: fields });
    }

    const form = new FormData();
    form.set("channel", String(fields.channel));
    form.set("body_markdown", fields.body_markdown);
    if (fields.priority) form.set("priority", fields.priority);
    if (fields.client_nonce) form.set("client_nonce", fields.client_nonce);
    for (const file of attachments) {
      // The server treats a part as a file only when it carries a non-empty
      // filename (views.rs:180-186), so the basename must be preserved.
      form.append("files", new Blob([file.bytes]), file.filename);
    }

    // 25MB may not finish inside the default 15s.
    return this.request("POST", `${API_PREFIX}/agents/agent/messages`, {
      form,
      timeoutMs: 120_000,
    });
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/client.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass (26 existing + 14 new = 40), typecheck exit 0.

- [ ] **Step 10: Commit**

```bash
git add mcp/src/client.ts mcp/src/client.test.ts
git commit -m "feat(mcp): post multipart when a message carries attachments

sendMessage posted JSON unconditionally, so the backend's multipart path
was unreachable from an agent even though it has accepted file parts all
along.

Three things had to give. FetchLike typed body as string, so a FormData
body would not typecheck. request() set Content-Type: application/json
whenever a body was present — fatal for multipart, where fetch must set
the header itself to supply the boundary. And the fixed 15s timeout is
short for 25MB, so requests can now override it; multipart uses 120s.

The JSON path is untouched when no attachments are present."
```

---

### Task 3: Expose `files` on the `send_message` tool

**Files:**
- Modify: `mcp/src/server.ts:280-295` (the `send_message` tool)
- Test: manual, via a live send

**Interfaces:**
- Consumes: `resolveAttachments` (Task 1), `SendMessageInput.attachments` (Task 2), `ResolvedProfile.configPath` from `config.ts`.
- Produces: the `send_message` tool's `files?: string[]` parameter.

- [ ] **Step 1: Add the parameter and wire it up**

In `mcp/src/server.ts`, add to the `send_message` schema, after `priority`:

```ts
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Paths to attach, relative to the project root (or absolute, inside it). Max 25MB each.",
        ),
```

Then replace the handler body. `configPath` is already a const in the enclosing scope (`server.ts:77`), so the root is just `dirname(configPath)` — no need to reach through the resolved profile:

```ts
    async ({ channel, body, priority, files, profile }) => {
      try {
        const { client } = clientFor(profile);
        const attachments = files?.length
          ? await resolveAttachments(files, dirname(configPath))
          : undefined;
        return ok(
          await client.sendMessage({
            channel,
            body_markdown: body,
            priority,
            attachments,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
```

- [ ] **Step 2: Add the imports**

At the top of `mcp/src/server.ts`:

```ts
import { dirname } from "node:path";
import { resolveAttachments } from "./attachments.js";
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0. The global `taskflow-v2-mcp` binary symlinks to `dist/index.js`, so this makes the change live on next spawn.

- [ ] **Step 5: Verify end to end**

Restart the MCP server (`/mcp` → reconnect, or restart Claude Code — schemas are handed to the model once at connect time, so a rebuild alone changes nothing for a live session).

Then confirm all four behaviours:

1. `send_message({channel: 3, body: "attached", files: ["planning/spec-message-delivery.md"]})` → response `attachments` array is non-empty and carries a resolved URL.
2. The recipient sees a real file, not inlined text.
3. `send_message({channel: 3, body: "escape", files: ["../../.ssh/id_rsa"]})` → rejected, message NOT created.
4. `send_message({channel: 3, body: "plain"})` → still works, unchanged.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/server.ts
git commit -m "feat(mcp): attach files to a message with send_message

Closes the gap the other two tasks opened up: an agent can now pass
files: [\"planning/spec.md\"] and have it arrive as a reviewable
document rather than a wall of pasted markdown.

Paths resolve against dirname(configPath) — the directory holding
.taskflow.json — rather than process.cwd(). A stdio MCP server inherits
the client's working directory, which need not be the project root, so
resolving against cwd would work by accident today and break silently
the moment someone launches from a subdirectory."
```

---

## Verification

After all three tasks:

```bash
cd /home/dalmas/E/projects/local_task_tracker/mcp
npx vitest run          # 40 tests pass
npx tsc --noEmit        # exit 0
npm run build           # exit 0
taskflow-v2-mcp --check # PASS on all lines
```

Then the four end-to-end checks in Task 3, Step 5 — the traversal rejection matters most, since it is the security boundary and no unit test exercises the real config root.
