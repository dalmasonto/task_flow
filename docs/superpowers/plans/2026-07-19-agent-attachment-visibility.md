# Agent Attachment Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent see attachments on messages it receives, and download them to disk so it can open them.

**Architecture:** Three tasks. Task 1 (Rust) extracts the attachment serializer that `message_response` already contains and reuses it in `list_messages_as_agent`, so the send and read paths can no longer drift. Tasks 2-3 (TypeScript) add a `download_attachment` MCP tool that fetches a `/media` URL and writes it under `.taskflow/attachments/`. No new backend endpoint.

**Tech Stack:** Rust (axum, umbral ORM), TypeScript/Node 24, Zod, Vitest.

## Global Constraints

- **No new backend endpoint.** The tool fetches `/media/<key>` directly. It exists as insulation: when storage is gated at the framework level, only the tool changes (gaining an auth header).
- A message with no attachments serializes `attachments: []` — an **empty array, never an absent key**. An absent key is what made the current bug invisible.
- The attachment serialization must be **shared** between `message_response` and `list_messages_as_agent`. Do not write a second projection; two projections drifting apart is why this feature exists.
- The batched attachment query uses `.in_(&ids)` — one query per page, never N+1.
- Downloads land in `.taskflow/attachments/` with `.taskflow/.gitignore` containing `*`.
- The `url` parameter is untrusted: it must resolve to a path under `/media/`. Reject other hosts, `file://`, non-media paths, and `..` escapes — otherwise the tool is an arbitrary-URL fetcher with a disk write attached.
- The filename derives from the URL basename. Storage keys are already UUID-prefixed (`955f66e2-…-notes.pdf`), so collisions are impossible by construction — do not add an id prefix.
- Sanitize the filename to a basename, then verify the resolved path is inside the download dir using `path.relative` — never a bare `startsWith`.
- The tool returns a **path**, never file content. Attachments are files in general (archives, video, opaque binaries), not just images.
- Rust commands run from `/home/dalmas/E/projects/local_task_tracker/backend`; TS commands from `/home/dalmas/E/projects/local_task_tracker/mcp`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/plugins/taskflow-agents/src/views.rs` (modify) | Extract `attachment_json`; use it in both paths |
| `backend/plugins/taskflow-agents/tests/message_attachments.rs` (modify) | Agent-read attachment cases + shape parity |
| `mcp/src/attachment-download.ts` (create) | Validate URL, sanitize name, fetch, write |
| `mcp/src/attachment-download.test.ts` (create) | The security boundary's coverage |
| `mcp/src/server.ts` (modify) | Expose the `download_attachment` tool |

---

### Task 1: Return attachments from the agent read path

**Files:**
- Modify: `backend/plugins/taskflow-agents/src/views.rs:74-103` (extract serializer), and `list_messages_as_agent` at `:2506`
- Test: `backend/plugins/taskflow-agents/tests/message_attachments.rs`

**Interfaces:**
- Consumes: `TaskflowMessageAttachment`, `taskflow_message_attachment::MESSAGE` (already imported in `views.rs`).
- Produces: `fn attachment_json(a: &TaskflowMessageAttachment) -> serde_json::Value` — the single shared attachment projection.

- [ ] **Step 1: Write the failing tests**

Add to `backend/plugins/taskflow-agents/tests/message_attachments.rs`, following the existing cases in that file for fixtures and multipart construction:

```rust
// 8. The agent READ path returns attachments, not just message text. This is
//    the gap that made received files invisible to agents.
#[tokio::test]
async fn agent_read_returns_attachments_for_a_message() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "diagram attached"),
        file("files", "diagram.png", "image/png", b"PNGDATA"),
    ]);
    let sent = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;
    assert_eq!(sent.status(), 200, "body: {:?}", sent.json().await);
    let sent_row = sent.json().await;
    let message_id = sent_row["id"].as_i64().expect("message id");

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    assert_eq!(read.status(), 200, "body: {:?}", read.json().await);
    let page = read.json().await;

    let message = page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|m| m["id"].as_i64() == Some(message_id))
        .expect("the sent message is in the page");

    let attachments = message["attachments"]
        .as_array()
        .expect("attachments array on the READ path");
    assert_eq!(attachments.len(), 1);
    let att = &attachments[0];
    assert_eq!(att["name"], serde_json::json!("diagram.png"));
    assert_eq!(att["content_type"], serde_json::json!("image/png"));
    assert_eq!(att["size_bytes"], serde_json::json!("PNGDATA".len()));
    assert_eq!(att["message"], serde_json::json!(message_id));
    assert!(
        att["url"]
            .as_str()
            .expect("url")
            .starts_with("/media/"),
        "url should resolve to /media/<key>, got {:?}",
        att["url"]
    );
}

// 9. A text-only message returns an EMPTY ARRAY, never an absent key. An absent
//    key is indistinguishable from "not reported", which is exactly how the
//    original bug hid.
#[tokio::test]
async fn agent_read_returns_empty_array_for_a_message_with_no_files() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let sent = app
        .post_as_agent(
            &key,
            AGENT_SEND,
            serde_json::json!({ "channel": channel, "body_markdown": "no files here" }),
        )
        .await;
    assert_eq!(sent.status(), 200, "body: {:?}", sent.json().await);
    let message_id = sent.json().await["id"].as_i64().expect("message id");

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    let page = read.json().await;
    let message = page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|m| m["id"].as_i64() == Some(message_id))
        .expect("the sent message is in the page");

    // The KEY must exist — not merely be falsy. `get` returning None is the bug.
    let attachments = message
        .get("attachments")
        .expect("attachments key must be present even with no files");
    assert_eq!(attachments, &serde_json::json!([]));
}

// 10. SHAPE PARITY: the send response and the agent read serialize an
//     attachment identically. This is the check that catches the whole CLASS of
//     human-route-vs-agent-route drift, rather than one instance of it.
#[tokio::test]
async fn send_response_and_agent_read_serialize_attachments_identically() {
    let app = TestApp::new().await;
    let (_project, channel, key) = seed_agent_and_room(&app).await;

    let (content_type, body) = encode_multipart(&[
        field("channel", &channel.to_string()),
        field("body_markdown", "parity check"),
        file("files", "report.pdf", "application/pdf", b"%PDF-1.4 fake"),
    ]);
    let sent = app
        .post_multipart_as_agent(&key, AGENT_SEND, &content_type, body)
        .await;
    assert_eq!(sent.status(), 200, "body: {:?}", sent.json().await);
    let sent_row = sent.json().await;
    let message_id = sent_row["id"].as_i64().expect("message id");
    let from_send = sent_row["attachments"][0].clone();

    let read = app
        .get_as_agent(
            &key,
            &format!("/api/taskflow/agents/messages?channel={channel}"),
        )
        .await;
    let page = read.json().await;
    let from_read = page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|m| m["id"].as_i64() == Some(message_id))
        .expect("the sent message is in the page")["attachments"][0]
        .clone();

    assert_eq!(
        from_send, from_read,
        "send and read must serialize an attachment identically; \
         a divergence here is the drift this feature exists to stop"
    );
}
```

These use the file's existing helpers: `TestApp::new`, `seed_agent_and_room`
(defined at `tests/message_attachments.rs:188`), `encode_multipart`, `field`,
`file`, `AGENT_SEND`, `post_multipart_as_agent`, `post_as_agent`, and
`get_as_agent` from `tests/support/mod.rs`. `get_as_agent` is already used for
this endpoint in `tests/agent_read_api.rs:210`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && cargo test -p taskflow-agents --test message_attachments`
Expected: the three new tests FAIL — the read response has no `attachments` key.

- [ ] **Step 3: Extract the shared attachment serializer**

In `backend/plugins/taskflow-agents/src/views.rs`, add this above `message_response` (which currently starts at line 74):

```rust
/// The single attachment projection, shared by every path that returns one.
///
/// Both `file` (the storage key, matching the model/realtime representation)
/// and the resolved `url` are emitted, so a client can key off `file` uniformly
/// regardless of which path delivered the row.
///
/// This exists as its own function because the send path and the agent read path
/// previously serialized attachments separately — the read path simply omitted
/// them, and nothing caught it. One projection, two call sites.
fn attachment_json(a: &TaskflowMessageAttachment) -> serde_json::Value {
    json!({
        "id": a.id,
        "message": a.message.id(),
        "project": a.project.id(),
        "file": a.file.key(),
        "url": a.file.url(),
        "name": a.name,
        "content_type": a.content_type,
        "size_bytes": a.size_bytes,
        "created_at": a.created_at,
    })
}

/// Serialize one message with its attachments into a JSON object.
///
/// Text-only messages emit `attachments: []` — an empty array, never an absent
/// key. A reader must be able to distinguish "no files" from "files not
/// reported"; the absent key is what let the read-path gap go unnoticed.
fn message_json(
    message: &TaskflowAgentMessage,
    attachments: &[TaskflowMessageAttachment],
) -> Result<serde_json::Value, StatusCode> {
    let mut value =
        serde_json::to_value(message).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items: Vec<serde_json::Value> = attachments.iter().map(attachment_json).collect();
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("attachments".to_string(), json!(items));
    }
    Ok(value)
}
```

- [ ] **Step 4: Rewrite `message_response` to use it**

Replace the body of `message_response` (lines 74-103) with:

```rust
/// Serialize a message plus its attachments into the endpoint's response body.
///
/// The message's own fields are emitted exactly as the JSON path always
/// returned them (so the frontend's optimistic reconcile keeps working), with
/// an `attachments` array appended.
fn message_response(
    message: &TaskflowAgentMessage,
    attachments: &[TaskflowMessageAttachment],
) -> Result<Response, StatusCode> {
    let value = message_json(message, attachments)?;
    Ok((StatusCode::OK, Json(value)).into_response())
}
```

- [ ] **Step 5: Batch-fetch attachments in the agent read**

In `list_messages_as_agent`, after the `let messages = query…fetch().await?;` block and before the final `Ok((StatusCode::OK, Json(json!({…})))`, insert:

```rust
    // One batched query for the whole page — never N+1. Grouped by message id
    // so each message carries only its own files.
    let message_ids: Vec<i64> = messages.iter().map(|m| m.id).collect();
    let all_attachments = if message_ids.is_empty() {
        Vec::new()
    } else {
        TaskflowMessageAttachment::objects()
            .filter(taskflow_message_attachment::MESSAGE.in_(&message_ids))
            .fetch()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };

    let mut serialized = Vec::with_capacity(messages.len());
    for message in &messages {
        let own: Vec<TaskflowMessageAttachment> = all_attachments
            .iter()
            .filter(|a| a.message.id() == message.id)
            .cloned()
            .collect();
        serialized.push(message_json(message, &own)?);
    }
```

Then change the response body from `"messages": messages` to
`"messages": serialized`, leaving `read_cursor` and `unread_count` unchanged.
`unread_count` must stay `messages.len()` — it counts messages, not attachments.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && cargo test -p taskflow-agents --test message_attachments`
Expected: all cases pass, including the pre-existing ones.

`TaskflowMessageAttachment` derives `Clone` (`models.rs:268`), so the `.cloned()`
in Step 5 compiles as written.

- [ ] **Step 7: Run the full plugin suite**

Run: `cd backend && cargo test -p taskflow-agents`
Expected: no regressions. `message_response`'s signature is unchanged, so its
callers are unaffected.

- [ ] **Step 8: Commit**

```bash
git add backend/plugins/taskflow-agents/src/views.rs \
        backend/plugins/taskflow-agents/tests/message_attachments.rs
git commit -m "feat(agents): return attachments from the agent read path

An agent could send files but never see received ones. A user attached an
image and asked what it contained; the message arrived as text only, with
no filename, url, size or type. There was nothing to describe.

Every field was already persisted at upload time. list_messages_as_agent
just dropped them: it serialized raw ORM rows and never queried the
attachment table, while the send path used message_response, which
serializes attachments with resolved urls. Two projections of one concept,
and the read one silently omitted a field.

They are now one projection with two call sites. A message with no files
emits attachments: [] rather than nothing at all -- an absent key is
indistinguishable from 'not reported', which is precisely how this hid.

The parity test is the durable part: it asserts the send response and the
agent read serialize an attachment identically, guarding the class of
human-route-vs-agent-route drift rather than this one instance of it."
```

---

### Task 2: Validate, sanitize, and write a downloaded attachment

**Files:**
- Create: `mcp/src/attachment-download.ts`
- Test: `mcp/src/attachment-download.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (leaf module).
- Produces:
  - `class AttachmentDownloadError extends Error`
  - `interface DownloadResult { path: string; name: string; size_bytes: number; content_type: string }`
  - `function mediaPathFrom(url: string): string` — validates and returns the `/media/...` path
  - `function downloadFilenameFrom(mediaPath: string, override?: string): string`
  - `function downloadAttachment(opts: { url: string; server: string; root: string; name?: string; fetchImpl?: BinaryFetch }): Promise<DownloadResult>`
  - `type BinaryFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; statusText: string; headers: { get(n: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>`

- [ ] **Step 1: Write the failing tests**

Create `mcp/src/attachment-download.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, relative } from "node:path";
import {
  AttachmentDownloadError,
  mediaPathFrom,
  downloadFilenameFrom,
  downloadAttachment,
  type BinaryFetch,
} from "./attachment-download.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tf-dl-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function stubFetch(bytes: Buffer, contentType = "image/png"): BinaryFetch {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

describe("mediaPathFrom", () => {
  it("accepts a bare /media path", () => {
    expect(mediaPathFrom("/media/abc-notes.pdf")).toBe("/media/abc-notes.pdf");
  });

  it("accepts an absolute url whose path is under /media", () => {
    expect(mediaPathFrom("http://localhost:8000/media/abc-notes.pdf")).toBe("/media/abc-notes.pdf");
  });

  it("rejects an absolute url to another host", () => {
    expect(() => mediaPathFrom("https://evil.example/media/x")).toThrow(AttachmentDownloadError);
  });

  it("rejects a file:// url", () => {
    expect(() => mediaPathFrom("file:///etc/passwd")).toThrow(AttachmentDownloadError);
  });

  it("rejects a path outside /media", () => {
    expect(() => mediaPathFrom("/api/taskflow/agents/whoami")).toThrow(/media/i);
  });

  it("rejects a traversal escape from /media", () => {
    expect(() => mediaPathFrom("/media/../etc/passwd")).toThrow(AttachmentDownloadError);
  });
});

describe("downloadFilenameFrom", () => {
  it("uses the url basename", () => {
    expect(downloadFilenameFrom("/media/955f66e2-notes.pdf")).toBe("955f66e2-notes.pdf");
  });

  it("strips directory components from an override", () => {
    expect(downloadFilenameFrom("/media/abc-x.bin", "../../evil.sh")).toBe("evil.sh");
  });

  it("strips an absolute path override", () => {
    expect(downloadFilenameFrom("/media/abc-x.bin", "/etc/passwd")).toBe("passwd");
  });

  it("keeps spaces, unicode, ampersands and multiple dots", () => {
    const n = downloadFilenameFrom("/media/abc-my report (v2) & notes.tar.gz");
    expect(n).toBe("abc-my report (v2) & notes.tar.gz");
  });

  it("falls back to a usable name when the basename is empty or dots", () => {
    expect(downloadFilenameFrom("/media/", "..")).toBe("attachment");
    expect(downloadFilenameFrom("/media/", ".")).toBe("attachment");
  });
});

describe("downloadAttachment", () => {
  it("writes the file and reports its metadata", async () => {
    const bytes = Buffer.from("PNGDATA");
    const out = await downloadAttachment({
      url: "/media/abc-diagram.png",
      server: "http://localhost:8000",
      root,
      fetchImpl: stubFetch(bytes),
    });

    expect(out.name).toBe("abc-diagram.png");
    expect(out.size_bytes).toBe(bytes.length);
    expect(out.content_type).toBe("image/png");
    expect(await readFile(out.path)).toEqual(bytes);
  });

  it("always writes inside the download dir, even for a hostile override", async () => {
    const out = await downloadAttachment({
      url: "/media/abc-x.bin",
      server: "http://localhost:8000",
      root,
      name: "../../../../etc/passwd",
      fetchImpl: stubFetch(Buffer.from("x")),
    });

    const dir = join(root, ".taskflow", "attachments");
    const rel = relative(dir, out.path);
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(dirname(out.path)).toBe(dir);
  });

  it("creates the download dir and a gitignore that excludes everything", async () => {
    await downloadAttachment({
      url: "/media/abc-y.bin",
      server: "http://localhost:8000",
      root,
      fetchImpl: stubFetch(Buffer.from("y")),
    });
    expect((await readFile(join(root, ".taskflow", ".gitignore"), "utf8")).trim()).toBe("*");
  });

  it("throws on a non-2xx response and writes nothing", async () => {
    const failing: BinaryFetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      downloadAttachment({
        url: "/media/abc-missing.bin",
        server: "http://localhost:8000",
        root,
        fetchImpl: failing,
      }),
    ).rejects.toThrow(/404/);
  });

  it("defaults content_type when the response omits it", async () => {
    const out = await downloadAttachment({
      url: "/media/abc-z.bin",
      server: "http://localhost:8000",
      root,
      fetchImpl: stubFetch(Buffer.from("z"), ""),
    });
    expect(out.content_type).toBe("application/octet-stream");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/attachment-download.test.ts`
Expected: FAIL — `Failed to resolve import "./attachment-download.js"`.

- [ ] **Step 3: Write the implementation**

Create `mcp/src/attachment-download.ts`:

```ts
/**
 * Download a message attachment to disk.
 *
 * The tool exists as insulation, not as an authorization point. `/media` is
 * currently served without auth; when storage is gated at the framework level,
 * only this module changes — it starts sending the agent key as a header — and
 * the agent-facing contract (url in, path out) stays put.
 *
 * Two untrusted inputs: the `url` (must resolve under `/media/`, or this
 * becomes an arbitrary-URL fetcher with a disk write attached) and the
 * filename (must not escape the download directory).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export class AttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentDownloadError";
  }
}

export interface DownloadResult {
  path: string;
  name: string;
  size_bytes: number;
  content_type: string;
}

export type BinaryFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const MEDIA_PREFIX = "/media/";

/**
 * Validate an attachment url and reduce it to its `/media/...` path.
 *
 * Absolute urls are accepted only for their path — the host is discarded, so a
 * url pointing at another origin cannot redirect the fetch. Anything that does
 * not land under `/media/` after normalisation is rejected.
 */
export function mediaPathFrom(url: string): string {
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AttachmentDownloadError(`Not a valid attachment url: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AttachmentDownloadError(
        `Attachment url must be http(s) or a /media path, got: ${url}`,
      );
    }
    path = parsed.pathname;
  } else {
    path = url;
  }

  // Normalise so `/media/../etc/passwd` cannot masquerade as a media path.
  const normalised = resolve("/", path);
  if (!normalised.startsWith(MEDIA_PREFIX)) {
    throw new AttachmentDownloadError(
      `Attachment url must be under ${MEDIA_PREFIX} — got: ${url}`,
    );
  }
  return normalised;
}

/**
 * The filename to write, always a bare basename.
 *
 * Storage keys are already UUID-prefixed, so the url basename is unique by
 * construction and needs no extra prefix. An override is accepted for a
 * friendlier name, but is reduced to its basename first.
 */
export function downloadFilenameFrom(mediaPath: string, override?: string): string {
  const raw = override && override.trim() ? override : mediaPath;
  const name = basename(raw.replace(/[/\\]+$/, ""));
  if (!name || name === "." || name === "..") return "attachment";
  return name;
}

/** Absolute path of the download directory for a project root. */
export function downloadDirFor(root: string): string {
  return join(root, ".taskflow", "attachments");
}

export async function downloadAttachment(opts: {
  url: string;
  server: string;
  root: string;
  name?: string;
  key?: string;
  fetchImpl?: BinaryFetch;
}): Promise<DownloadResult> {
  const mediaPath = mediaPathFrom(opts.url);
  const filename = downloadFilenameFrom(mediaPath, opts.name);

  const dir = downloadDirFor(opts.root);
  const target = resolve(dir, filename);

  // Belt and braces: the basename reduction above should make escape
  // impossible, so this asserts the invariant rather than trusting it.
  const rel = relative(dir, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new AttachmentDownloadError(
      `Refusing to write outside the download directory: ${filename}`,
    );
  }

  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as BinaryFetch);
  const absolute = `${opts.server.replace(/\/$/, "")}${mediaPath}`;

  // When storage is gated at the framework level, the auth header goes HERE and
  // nothing else in the system needs to change.
  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = `Agent ${opts.key}`;

  const res = await doFetch(absolute, { headers });
  if (!res.ok) {
    throw new AttachmentDownloadError(
      `Download failed: ${res.status} ${res.statusText} for ${mediaPath}`,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dir, { recursive: true });
  // Downloads are scratch, never committed.
  await writeFile(join(opts.root, ".taskflow", ".gitignore"), "*\n");
  await writeFile(target, bytes);

  return {
    path: target,
    name: filename,
    size_bytes: bytes.length,
    content_type: res.headers.get("content-type") || "application/octet-stream",
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/attachment-download.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/attachment-download.ts mcp/src/attachment-download.test.ts
git commit -m "feat(mcp): download an attachment to disk

Two untrusted inputs, both checked before anything is written.

The url must resolve under /media/ after normalisation. Absolute urls are
accepted only for their path, so one pointing at another origin cannot
redirect the fetch, and /media/../etc/passwd cannot masquerade as a media
path. Without this the tool is an arbitrary-url fetcher with a disk write
attached.

The filename is reduced to a bare basename and the resolved target is then
asserted to sit inside the download directory. Storage keys are already
UUID-prefixed, so the url basename is unique by construction and needs no
id prefix -- two files legitimately named notes.pdf already land apart.

The auth header slot is deliberate. /media is open today; when it is gated
at the framework level, the header goes in this one place and the
agent-facing contract (url in, path out) does not move."
```

---

### Task 3: Expose the `download_attachment` tool

**Files:**
- Modify: `mcp/src/server.ts` (imports; new tool registration alongside `send_message`)
- Test: manual, via a live download

**Interfaces:**
- Consumes: `downloadAttachment`, `DownloadResult` (Task 2); `configPath` const at `mcp/src/server.ts:79`; `clientFor(profile)` returning `{ resolved, client }` where `resolved` carries `server` and `key`.
- Produces: the `download_attachment` MCP tool.

- [ ] **Step 1: Add the imports**

At the top of `mcp/src/server.ts`, alongside the existing `resolveAttachments` import:

```ts
import { downloadAttachment } from "./attachment-download.js";
```

`dirname` is already imported from `node:path` — do not add it twice.

- [ ] **Step 2: Register the tool**

Add after the `send_message` tool registration:

```ts
  server.tool(
    "download_attachment",
    "Download a message attachment to disk and return its path. Get the `url` from an attachment on a message returned by check_messages. Returns a PATH, not the file's contents — open it with your own file-reading tool. Attachments are files in general: text and PDFs can be read directly, archives should be listed rather than read, and large files should be inspected in parts. Check `size_bytes` before reading anything wholesale.",
    {
      url: z
        .string()
        .min(1)
        .describe("The attachment's `url` from check_messages, e.g. /media/<key>."),
      name: z
        .string()
        .optional()
        .describe("Optional friendlier filename. Directory parts are stripped."),
      ...profileArg,
    },
    async ({ url, name, profile }) => {
      try {
        const { resolved } = clientFor(profile);
        return ok(
          await downloadAttachment({
            url,
            name,
            server: resolved.server,
            key: resolved.key,
            root: dirname(configPath),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
```

Note `resolved.key` is passed so the auth header is already wired; it is
harmless while `/media` is open and becomes load-bearing when it is gated.

- [ ] **Step 3: Typecheck and run the suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck exit 0; all tests pass.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0. The global `taskflow-v2-mcp` binary symlinks to `dist/index.js`.

- [ ] **Step 5: Verify statically, then write a manual checklist**

Do NOT attempt a live MCP call or restart the server — it is a stdio subprocess
whose lifecycle the client owns, and tool schemas are handed to the model once at
connect time. A rebuild alone changes nothing for a connected session.

Verify statically: confirm `dist/server.js` contains `download_attachment` and
the `downloadAttachment` call, and that `taskflow-v2-mcp --check` exits 0.

Then record this manual checklist in your report, marked NOT RUN:

1. Restart the backend (Task 1 is a Rust change), then `/mcp` reconnect.
2. `check_messages` on a channel containing a message with a file → each message
   object has an `attachments` array; text-only messages show `[]`.
3. `download_attachment({url: "<that url>"})` → returns a path under
   `.taskflow/attachments/`; the file exists with the right size.
4. Read the downloaded file → contents match.
5. `download_attachment({url: "https://example.com/x"})` → rejected, nothing written.
6. `download_attachment({url: "/api/taskflow/agents/whoami"})` → rejected.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/server.ts
git commit -m "feat(mcp): add the download_attachment tool

Closes the loop the other tasks opened: an agent can now see a file on a
message and fetch it to disk.

The tool returns a path and never the file's contents. Attachments are
files in general -- archives, video, opaque binaries -- and a tool that
returned bytes would force every one of them through a single
interpretation and fall over on a 40MB archive. The description says so,
and points at size_bytes, because the next agent to use this needs the
same warning."
```

---

## Verification

After all three tasks:

```bash
cd /home/dalmas/E/projects/local_task_tracker/backend && cargo test -p taskflow-agents
cd /home/dalmas/E/projects/local_task_tracker/mcp && npx vitest run && npx tsc --noEmit && npm run build
taskflow-v2-mcp --check
```

Then the six manual checks in Task 3, Step 5. Checks 5 and 6 matter most: they
are the security boundary, and no unit test exercises it against the real
configured server.
