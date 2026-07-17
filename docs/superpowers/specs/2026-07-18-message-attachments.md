# Message Attachments — Design

**Date:** 2026-07-18
**Closes:** the original "messages can hold files (m2m/attachment model), not just a url" gap from
Phase-1's queued attachments sub-project and the very first conversation.

## Goal

Real file/image attachments on chat messages: upload actual files, store them, display images inline
and files as downloads. Per the user's direction: multipart FormData + a custom endpoint that
processes files (name, size, url); the send-message response returns the attachments; attachments are a
separate model with an FK to the message.

## Backend

### Storage
Enable media on the existing `StoragePlugin`: `.media("/media", "./media")`. This registers the ambient
storage backend (`storage_opt()`), serves uploaded files at `/media/<key>`, and enforces a 25 MiB cap.
Files are world-readable by unguessable uuid-prefixed key (acceptable for now; per-project media
access-gating is a tracked follow-up).

### Model — `TaskflowMessageAttachment` (taskflow-agents)
Plain columns (explicit; the endpoint stores the file via `storage_opt().store()` and records the
result):
- `id`
- `message: ForeignKey<TaskflowAgentMessage>` — `on_delete = cascade` (attachments die with the message)
- `project: ForeignKey<TaskflowProject>` — `on_delete = cascade`, denormalized for scoping + realtime routing
- `kind: TaskflowAttachmentKind` — choices `image | file` (image when content_type starts `image/`)
- `name: String` — original filename (max 260)
- `content_type: String` — declared/sniffed MIME (max 160)
- `size_bytes: i64` — from `StoredFile.size`
- `storage_key: String` — `StoredFile.key` (for future cleanup)
- `url: String` — `StoredFile.url` (`/media/<key>`), what the FE renders
- `created_at` — auto_now_add

New table → clean `CreateTable` migration (no UnsafeAlter).

### Endpoint — `POST /api/taskflow/agents/messages` (multipart-capable)
Extend the existing send endpoint to accept **either** JSON (as today, no files) **or**
`multipart/form-data` (fields + file parts). Detect via `is_multipart(content_type)`.
- Multipart fields: `channel`, `body_markdown`, `priority?`, `client_nonce?` (same names as the JSON body).
- File parts: any file part (field name `files`/`file`/anything with a filename).
- Flow (multipart): parse via `umbral::web::multipart::parse_multipart`; run the SAME membership gate +
  body validation as today, except **body may be empty when there is at least one file**; on the
  idempotency short-circuit (same `(channel, client_nonce)`) return the existing message + its
  attachments WITHOUT storing files again; otherwise create the message, then for each file
  `storage_opt().store(filename, content_type, bytes)` → `StoredFile`, and create a
  `TaskflowMessageAttachment` row.
- **Response**: the message row plus an `attachments` array. Shape: `{ ...TaskflowAgentMessage,
  attachments: TaskflowMessageAttachment[] }`. (Text-only JSON posts return `attachments: []`.)
- Reject a file whose store fails or that exceeds the cap with a clear 400/413.

### Realtime + read scoping
- Expose `TaskflowMessageAttachment` project-scoped, field-projected inline (like chat), to group
  `project:{id}:message_attachments`, so other clients receive new attachments and merge them by
  `message` FK.
- `fetchTaskflowWorkspace` fetches `messageAttachments` (project-scoped); the FE groups by message.
- REST resource: scoped by project and **read-only** (attachments are created only through the send
  endpoint, never client REST) — add to `READ_ONLY_PROJECT_SCOPED_TABLES`.
- Regenerate the typed client.

## Frontend

### Composer
- **Remove the dummy controls**: `addImageUrlAttachment` ("Image URL") and `addContextAttachment`
  ("Context") and their buttons — they synthesized fake attachments.
- **Real file attach**: `handleFileSelect` stages the actual `File` objects (keep the File for upload,
  plus a local object-URL preview for images). Show staged files as removable chips/previews.
- `sendTaskflowAgentMessage`: when there are staged files, send `multipart/form-data` (channel,
  body_markdown, priority, client_nonce + each file as a `files` part); otherwise JSON as today. It
  returns `{ ...message, attachments }`.
- `appendAttachmentMarkdown` is retired for real uploads (files are structured attachments now, not
  markdown links). URL/project-path pseudo-attachments are gone with the dummy controls.

### Display
- The message view model's `attachments` is populated from real `TaskflowMessageAttachment` rows
  (grouped by message id from `workspace.messageAttachments`), reconciled with the send response.
- `AttachmentList` renders **images inline** (`<img src={url}>`, capped size, click to open) and
  **non-image files** as a download row (icon + name + human size + open/download link to `url`).
- The optimistic bubble shows staged files as pending previews (object URLs for images) until the send
  response / SSE replaces them with the stored attachments.

### Proxy
Add `/media` to `vite.config.ts` proxy (→ backend) so uploaded files load in dev.

## Out of scope / tracked
- Per-project media access-gating (`.media_access`) — uploads are currently reachable by anyone with
  the unguessable key; fine for now, flag as follow-up.
- Agent-uploaded attachments (agents post via API key) — the endpoint derives sender identity; agent
  file upload is a later concern.
- Retry-after-partial-upload edge: idempotency returns the already-stored message+attachments; a retry
  does not re-upload.
