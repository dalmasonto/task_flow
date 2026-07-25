# Media page

**Status:** approved design, ready for planning
**Date:** 2026-07-25
**Task:** #60 (second of two pages; the Dashboard page shipped separately)
**Area:** `v2_fe` only. No backend changes.

## Problem

Files and images are scattered across chat channels and task sheets with no way
to browse them in one place. Task #60: "Media page: Shows all media using the
same preview used in chat messages across chat and tasks."

## What already exists

- Two attachment tables, both with the same core shape (`file` → `/media/<key>`,
  `name`, `content_type`, `size_bytes`, `created_at`, `project`):
  - `taskflow_message_attachment` (chat) — also `message`, `channel`. **Channel-
    scoped server-side**: the REST scope hides attachments from channels the
    caller isn't in, so DMs stay private with no extra work here.
  - `taskflow_task_attachment` (tasks) — also `task`.
- Both are queryable through the generic REST API:
  `taskflowApi.from(table).filter({ project }).orderBy(...).list()`.
- A rich, reusable chat preview in `v2_fe/src/components/message-attachments.tsx`:
  - `MessageAttachmentItem = { id, name, contentType, sizeBytes, url, pending? }`
    (exported).
  - `getAttachmentKind(contentType, name) → AttachmentKind` (image/pdf/video/…),
    already imported there and reusable.
  - `AttachmentPreviewDialog` — the lightbox carousel (image zoom, PDF,
    spreadsheet, Shiki code, text, video/audio). Currently a **local** function;
    this spec exports it.
- `resolveAttachmentUrl(file) → /media/<key>` (`App.tsx:1744`) maps a bare
  storage key to its URL.

## Goals

- A `/dashboard/media` page, nav label **Media**, showing every image/file the
  member can see across chat + tasks, in a filterable gallery, opening each item
  in the **exact** chat preview lightbox.

## Non-goals

- No backend changes — the REST tables + existing channel scoping are enough.
- No upload/delete from this page (it's a browser); no cross-project view (scoped
  to the active project like every other dashboard page).
- No new preview rendering — reuse `AttachmentPreviewDialog` verbatim.

## Design

Frontend-only, three pieces.

### 1. A tiny data + mapping layer

New `v2_fe/src/lib/media-items.ts` (pure, node-tested):

```ts
export type MediaSource =
  | { kind: "chat"; channelId: number | null; label: string; href: string }
  | { kind: "task"; taskId: number; label: string; href: string }

export type MediaItem = MessageAttachmentItem & {
  source: MediaSource
  createdAt: string | null
}

export type MediaFilter = "all" | "images" | "files" | "chat" | "tasks"

/** True if `item` passes `filter` (images vs files via getAttachmentKind). */
export function matchesMediaFilter(item: MediaItem, filter: MediaFilter): boolean
```

The row→`MediaItem` mapping (message row and task row → the unified shape, using
`resolveAttachmentUrl` for `url`) also lives here as small pure functions so it
is unit-tested. `href` targets the source: a chat item links to its channel
(`/dashboard/agents` context), a task item to `/dashboard/board` with the task
open — match however the app already deep-links to a task/channel (the plan pins
the exact route).

A fetch function in `taskflow-api.ts` (beside the other project fetches):
`fetchProjectMedia(projectId)` — lists both attachment tables (project-scoped,
paginated to a sane cap), returns `{ chat: rows, task: rows }` for the page to
map. Ordered newest-first by `created_at`.

### 2. Export the preview dialog

In `message-attachments.tsx`, add `export` to `AttachmentPreviewDialog` (no
behavior change) so the Media page opens the identical lightbox. If any of its
helper types it needs aren't exported, export those too. `getAttachmentKind` is
already importable from its lib.

### 3. The Media page

New `v2_fe/src/pages/dashboard/MediaPage.tsx`, in the dashboard shell (same auth
gate + project context). Route `/dashboard/media`; a **Media** nav item added to
`components/app-sidebar.tsx` after **Dashboard**, with a lucide image/grid icon.

- On mount (keyed on `projectId`), `fetchProjectMedia`, map both sides to one
  `MediaItem[]` sorted newest-first; loading / error / empty states.
- **Filter chips**: All / Images / Files / Chat / Tasks (`matchesMediaFilter`).
  The active filter also defines the carousel's item set.
- **Gallery**: a responsive grid. Images render as square thumbnails (the
  `/media` url in an `<img>` with `object-cover`); non-images render as compact
  file cards (icon from `getAttachmentKind` + name + size), matching chat's card
  style. Each tile carries a small **source chip** (`#channel` / `task #N`) that
  links back via `source.href`.
- **Click → the chat lightbox**: opens `AttachmentPreviewDialog` with the
  filtered `MediaItem[]` and the clicked index, so paging in the carousel walks
  the same set the grid shows.
- Same-project guard like the Dashboard: tag fetched data with its `projectId`
  and only render matching data, so a project switch can't show another
  project's media.

## Error handling

| Case | Behavior |
|---|---|
| No project selected | "Select a project" message; no fetch |
| Fetch fails / network | retryable error card |
| Empty (no media) | friendly empty state ("No media in this project yet") |
| A single broken/missing file | the thumbnail `<img>` `onError` falls back to a file card; one bad item never blanks the grid |
| Channel-private attachments | never returned by the REST scope; nothing to do here |

## Testing

- **`media-items.test.ts`** (node): row→`MediaItem` mapping (both message and
  task rows → correct `url` via `resolveAttachmentUrl`, `contentType`/`sizeBytes`
  from the snake_case columns, `source` shape + `href`); `matchesMediaFilter`
  across all five filters (an image passes `images`+`all`+its source, a PDF
  passes `files` not `images`, chat vs task partitioning).
- The React page + the dialog export are verified by `npm run build` + a live
  pass (open the page, filter, click an image → the chat lightbox opens and pages
  across the filtered set; a file card opens the PDF/code preview). Repo has no
  jsdom/component tests, so no component unit tests — the mapping/filter logic
  that could regress lives in the tested helpers.

## Migration & compatibility

Additive and frontend-only: a new page, a nav item, one pure helper module, one
fetch function, and an `export` keyword on an existing dialog. No backend, no
schema, no change to chat/board/dashboard flows. Channel privacy is unchanged
(enforced by the existing REST scope).
