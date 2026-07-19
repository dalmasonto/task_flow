# Design: agent attachment visibility

**Date:** 2026-07-19
**Status:** approved, ready for implementation plan

## Problem

An agent can send files but cannot see received ones.

Demonstrated live: a user attached an image and asked what it contained. The
message arrived as text only — no filename, no URL, no size, no content type.
There was nothing to describe, and guessing would have been a fabrication.

The capability exists on the write side and is missing on the read side:

- `message_response` (`backend/plugins/taskflow-agents/src/views.rs:66-100`)
  takes `&[TaskflowMessageAttachment]` and serializes each with a resolved
  `url`. The send path uses it.
- `list_messages_as_agent` serializes `"messages": messages` — raw ORM rows —
  and never queries `TaskflowMessageAttachment` at all.

Every field a reader needs is **already persisted** at upload time on
`TaskflowMessageAttachment`: `file`, `name`, `content_type`, `size_bytes`,
`project`, `created_at`. Nothing needs computing or detecting. The read path
simply drops data it already has.

Evidence the hole is general, not specific to one message: message 5 in project
2's room has `body_markdown: ""`. The backend rejects empty text-only sends, so
that message must carry files. An agent reads it as a blank line.

### Why this keeps happening

This is the fourth instance in one working session of the same pattern — the
human surface has a capability the agent surface silently lacks:

1. `send_message` parsed multipart; `send_message_as_agent` didn't → 415
2. The human route raised `DefaultBodyLimit`; the agent route didn't → 2 MiB ceiling
3. `message_response` returns attachments; `list_messages_as_agent` doesn't → this
4. (same root) two serializations of one concept, drifting independently

Each arose from building the agent surface as a *reduced copy* of the human one,
deferring pieces as "Stage N" and never reconciling. Nothing in the type system
or the tests links the twins.

## Scope

Two halves, shipped together: seeing that a file exists, and getting its bytes.

**No new backend endpoint.** See "Why a tool, not a route" below.

## Half 1 — the read path returns attachments

`list_messages_as_agent` gains one batched query and merges the results:

```rust
let ids: Vec<i64> = messages.iter().map(|m| m.id).collect();
let attachments = TaskflowMessageAttachment::objects()
    .filter(taskflow_message_attachment::MESSAGE.in_(&ids))
    .fetch()
    .await?;
// group by message id, then serialize each message with its own attachments
```

One query for the page, never N+1.

**Reuse `message_response`'s serialization.** Do not write a second projection.
The two paths having drifted apart is the entire reason this feature exists;
adding a third shape would repeat the mistake. Extract the per-message
serialization from `message_response` so both call sites share it.

A message with no files serializes `attachments: []` — an empty array, never an
absent key. An absent key is what makes the current bug invisible: a reader
cannot distinguish "no attachments" from "attachments not reported".

## Half 2 — the `download_attachment` MCP tool

```
download_attachment({ url: "/media/955f66e2-…-diagram.png" })
  → GET <server><url>
  → write .taskflow/attachments/955f66e2-…-diagram.png
  → return { path, name, size_bytes, content_type }
```

The tool never reads or interprets the file. It returns a path, and the caller
decides what to do with it.

### The tool takes a URL, not an attachment id

With no backend endpoint there is no route that resolves an attachment id to a
storage key, so an id-based tool would have nothing to look the file up with.
The tool therefore takes the `url` that Half 1 now returns on every attachment.
The agent always has it: `check_messages` hands back `attachments[].url`
alongside `name`, `size_bytes`, and `content_type`.

Only `url` is required. `name` is accepted as an optional override for callers
that want a friendlier filename than the stored key.

**The stored key is already collision-free**, which removes the need for an id
prefix. Umbral's storage layer prefixes every key with a UUID at save time —
`955f66e2-949a-49bc-9784-89392778a053-spec-message-delivery.md` — so two files
legitimately named `notes.pdf` land at distinct paths without any help from this
tool. Deriving the filename from the URL's basename inherits that property.

The URL must be validated: it has to be a path under `/media/`, not an arbitrary
URL. Otherwise the tool becomes a general-purpose fetcher that will retrieve any
address an agent is told to, write the response to disk, and hand back the path.

### Why a tool, not a route

`/media` is currently unauthenticated: `StoragePlugin::media("/media", "./media")`
(`backend/src/main.rs:153`) is a plain static file server with no auth gate. Keys
are UUID-prefixed and therefore unguessable, but that is obscurity, not
authorization.

Storage auth will be fixed at the framework level later. The tool exists so that
when it is, **only the tool changes** — it starts sending the agent key as a
header. The agent-facing interface (`download_attachment(id)` → path on disk)
never moves, and no caller learns that storage auth changed underneath.

That is the durable reason for the tool. "Somewhere to put an auth check" is not,
which is why no new backend endpoint is being built.

**Accepted consequence, stated plainly:** with no `RequireAgent` gate on the
download, nothing verifies that an attachment belongs to the agent's project. In
practice an agent only learns URLs from messages in its own project, so access is
scoped by reachability rather than enforcement. The framework-level fix is what
will make it real. This is a deliberate trade, not an oversight.

## Attachments are files in general, not images

The tool must not assume the file is readable or interpretable. Expected handling
by kind:

| kind | handling |
|---|---|
| text (`.md`, `.txt`, `.json`, `.csv`, source) | read directly |
| images, PDF | read directly — rendered natively |
| archives (`.zip`, `.tar.gz`) | list contents; extract only if asked |
| opaque binary (`.docx`, video, executables) | report type and size; state plainly that it cannot be interpreted |

Two consequences for the design:

- **`size_bytes` is load-bearing, not decorative.** A 25 MB CSV downloads to disk
  fine but must never be read wholesale into context. The tool returns size so
  the caller can choose to `head`, `wc -l`, or query instead. The tool
  description must say so — a future agent hitting this needs the same warning.
- **Returning a path rather than bytes is what keeps every handling path open.**
  A tool that returned content inline would force every attachment through one
  interpretation, and would break outright on a 40 MB archive.

## Filename safety

`attachment.name` is client-supplied (`max_length = 260` on the model) and is
used to build a filename. This is the upload containment problem inverted.

- Sanitize to the **basename** — a name or key ending `../../.ssh/authorized_keys`
  must not escape the download directory.
- After building the path, verify the resolved result is still inside
  `.taskflow/attachments/`. Same discipline as `resolveAttachments`: resolve
  first, then compare with `path.relative`, never a bare `startsWith`.
- Collision-freedom comes from the storage key's UUID prefix, not from an id
  prefix added here. See "The tool takes a URL, not an attachment id".
- Real filenames carry spaces, unicode, `#`, `&`, and multiple dots. These are
  valid and must survive sanitization — the tests cover them alongside the
  traversal cases.

The `url` itself is the other untrusted input, and it is checked before any
request is made: it must be a path (or same-origin URL) under `/media/`.
Rejected: absolute URLs to other hosts, `file://`, and anything that escapes
`/media/` via `..`. Without this the tool is an arbitrary-URL fetcher with a
disk write attached.

## Download location

`.taskflow/attachments/` inside the project, with `.taskflow/.gitignore`
containing `*` so downloads are never committed. Files persist across sessions,
so re-reading an attachment costs nothing. They accumulate until cleaned; cleanup
is out of scope.

## Components

| Unit | Responsibility |
|---|---|
| `list_messages_as_agent` (modify) | Batch-fetch and merge attachments |
| shared message serializer (extract) | One projection used by both send and read |
| `attachment-download.ts` (new, MCP) | Sanitize the name, ensure the dir, write the file |
| `download_attachment` tool (`server.ts`) | Expose it |

## Testing

**Backend**
- A message with attachments returns them in the agent read, with resolved URLs
- A message without attachments returns `attachments: []`, not an absent key
- **Shape parity:** the agent read and the send response serialize an attachment
  identically. This is the check that would have caught all four instances of the
  twin-drift pattern above. It guards a class of bug, not an instance.
- The batched query does not N+1 across a multi-message page

**MCP — filename safety**
- Traversal: a name/key ending `../../evil` writes inside the download dir
- An absolute-path name (`/etc/passwd`) writes inside the download dir
- An empty or dot-only name still produces a usable path
- Names with spaces, unicode, `#`, `&`, and multiple dots survive intact
- Two attachments with the same original name do not collide (UUID-prefixed keys)
- The returned path always resolves inside `.taskflow/attachments/`

**MCP — URL validation** (rejected before any request is made)
- An absolute URL to another host (`https://evil.example/x`) is rejected
- A `file://` URL is rejected
- A path outside `/media/` (`/api/taskflow/agents/whoami`) is rejected
- `/media/../etc/passwd` is rejected
- A valid `/media/<key>` path is accepted

## Out of scope

- Setting a real MIME on **upload**. The MCP client sends a bare `Blob` with no
  type, so agent-uploaded files store `application/octet-stream`. The read path
  faithfully returns whatever was stored, so this spec is correct either way, and
  files uploaded through the frontend already carry real types (the browser's
  `File` object supplies them). One-line fix on the write side, separate change.
- Gating `/media` — framework-level, later.
- Attachment deletion or cleanup of the download directory.
- The other two gaps raised alongside this one: the chat drag-and-drop overlay,
  and extracting the composer out of `AgentsConversationView` to stop a 460-line
  re-render per keystroke.

## Provenance

Found 2026-07-19 while smoke-testing MCP attachments. Immediately after shipping
agent→human file sending, a user sent an image the other way and the agent could
not see it.
