# Design: file attachments for the MCP `send_message` tool

**Date:** 2026-07-19
**Status:** approved, ready for implementation plan

## Problem

An agent cannot send a file over TaskFlow. Asked to share a spec for review, the
only option is pasting its contents into the message body, which arrives as a
wall of text rather than a reviewable document.

> **CORRECTION (2026-07-19, after the final whole-branch review).** The premise
> below is **wrong**, and the error propagated into the plan and all three
> implemented tasks. It is left in place, struck through, because the
> correction is the most important thing this document records.
>
> `views.rs:143-207` is `send_message` — the **human**, `RequireAuth`-gated
> route at `/api/taskflow/agents/messages`. The MCP authenticates with
> `Authorization: Agent <key>` and posts to a *different* route,
> `/api/taskflow/agents/agent/messages` → `send_message_as_agent`
> (`urls.rs:60-65`), which takes `Json(input)` and has no multipart branch at
> all. Its own doc comment says so: *"JSON only — agent sends carry no
> attachments in Stage 1"* (`views.rs:745`). It hardcodes
> `message_response(&message, &[])` (`views.rs:838`), and its route carries no
> `DefaultBodyLimit` layer, so it inherits axum's 2 MiB default.
>
> **A backend change IS required.** See Task 4 in the implementation plan.
>
> Lesson: citing the right file is not citing the right handler. The mistake
> survived spec review, plan review, and three task reviews because every one
> of them was scoped to a layer that could not see the client/server seam.

The capability exists everywhere except the MCP client:

- ~~`POST /api/taskflow/agents/agent/messages` already accepts multipart with file
  parts, normalising both transports to identical logical input
  (`backend/plugins/taskflow-agents/src/views.rs:143-207`)~~ — **false, see
  correction above.** That describes the human route. The agent route is
  JSON-only.
- `MAX_ATTACHMENT_BYTES` is 25 MB per file (`views.rs:43`)
- The route already raises `DefaultBodyLimit` past axum's 2 MB default
  (`backend/plugins/taskflow-agents/src/urls.rs:36`)
- Attachments are created transactionally with the message, and
  `message_response` returns them with resolved URLs (`views.rs:66-100`)
- Messages already return an `attachments: []` array to every reader

`TaskflowMcpClient.sendMessage` posts JSON only (`mcp/src/client.ts:267`), and
the `send_message` tool exposes just `channel`, `body`, `priority`, `profile`.
So the attachment path is unreachable from an agent.

~~**No backend change is required.**~~ — **false.** A backend change is
required: `send_message_as_agent` needs the same multipart branch, size check,
and attachment-storage loop that `send_message` already has, plus its own
`DefaultBodyLimit` layer.

## Interface

One new optional parameter on `send_message`:

```ts
files: z.array(z.string()).optional()
  .describe("Paths to attach, relative to project root. Max 25MB each.")
```

Usage:

```ts
send_message({
  channel: 3,
  body: "Spec for review",
  files: ["planning/spec-message-delivery.md"],
})
```

## Behaviour

When `files` is absent, behaviour is unchanged — JSON post, exactly as today.
When present, the client switches to multipart. The existing path stays
untouched, which keeps the change additive and the old behaviour regression-free.

### Validation

All validation happens **before any upload**, and any failure aborts the entire
send. For each path, in order:

0. If the path is relative, resolve it against the project root — not against
   `process.cwd()`, which may differ. Absolute paths are accepted and subject to
   the same containment check as everything else; an absolute path inside the
   root is legal, one outside it is not.
1. Resolve to an absolute path, following symlinks (`fs.realpath`)
2. Assert the resolved path is inside the project root
3. Assert it exists and is a regular file
4. Assert its size is at most 25 MB

The first failure raises an error naming the offending file and the reason.
No message is created and nothing is uploaded.

This is all-or-nothing by choice: a partially-attached message is worse than no
message, because the recipient sees text referencing a file that never arrived.

### Project root

The project root is **the directory containing `.taskflow.json`**, not the
session `cwd`. `cwd` is agent-supplied and can wander; the config location is
fixed and already defines the boundary of "this project".

### Path containment

An attachment becomes a fetchable URL, so an unrestricted path parameter turns a
single bad instruction into a clean exfiltration channel. Containment is the
security boundary of this feature.

Two ways to get this wrong, both of which the implementation must avoid:

- **Checking before resolving.** A symlink inside the repo pointing at
  `~/.ssh/id_rsa` passes a pre-resolution check. `realpath` must run first.
- **Bare string prefix comparison.** `/path/to/local_task_tracker_evil` passes a
  naive `startsWith` against `/path/to/local_task_tracker`. The comparison must
  be on path segments — compare against `root + path.sep`, or use
  `path.relative` and reject results that are absolute or start with `..`.

## Transport

Native `FormData` and `Blob` (Node 24 — no new dependency), posted to the
existing endpoint.

- Text parts: `channel`, `body_markdown`, `priority`, `client_nonce`
- File parts: one per attachment, using the file's basename as the filename

The server treats a part as a file only if it carries a non-empty filename
(`views.rs:180-186`), so basenames must be preserved.

## Components

| Unit | Responsibility |
|---|---|
| `resolveAttachments(paths, root)` | Validate and read. Returns `{filename, bytes}[]` or throws. Pure apart from filesystem reads; no network. |
| `client.sendMessage(input)` | Branch on `files`. Assemble multipart or JSON, post, return the response. |
| `send_message` tool | Expose `files`, pass through. |

Isolating validation in `resolveAttachments` is what makes the security boundary
unit-testable without a running server.

## Error handling

- **Client-side rejections** surface as MCP tool errors naming the file and
  reason (`"report.pdf is 41MB; the maximum attachment size is 25MB"`).
- **Server-side rejections** — its own size check, malformed multipart — pass
  through unchanged.

## Testing

`resolveAttachments` carries the security boundary, so it gets the coverage:

- [ ] happy path: a file inside the root resolves and reads
- [ ] path traversal: `../../etc/passwd` rejected
- [ ] symlink escape: a symlink inside the root pointing outside is rejected
- [ ] sibling-prefix: `<root>_evil/file` rejected
- [ ] missing file rejected
- [ ] directory rejected
- [ ] oversize (>25 MB) rejected
- [ ] all-or-nothing: one bad path in three sends nothing
- [ ] an absolute path inside the root is accepted
- [ ] a relative path resolves against the project root, not `process.cwd()`

Plus one test asserting multipart assembly against a mock fetch: correct part
names, filenames preserved, and text fields present.

## Out of scope

- Attachments on tasks or reviews
- Send retry with backoff on transient failures (related, independent)
- `client_nonce` idempotency

## Provenance

Found while smoke-testing the taskflow_v2 MCP on 2026-07-19: asked to send a
spec for review, the only available behaviour was inlining ~2.8 KB of markdown
into the message body.
