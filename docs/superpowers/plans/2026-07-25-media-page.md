# Media Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the Media page of task #60 — a `/dashboard/media` gallery of all chat + task attachments, opening each in the exact chat preview lightbox, with filters and source provenance.

**Architecture:** Frontend-only. Fetch both attachment REST tables (project-scoped; channel privacy already enforced server-side), map rows to the chat component's `MessageAttachmentItem` shape via pure tested helpers, render a filterable gallery, and reuse the chat `AttachmentPreviewDialog` (exported) as the lightbox.

**Tech Stack:** React + TypeScript (Vite), vitest (**node env — no jsdom**).

**Spec:** `docs/superpowers/specs/2026-07-25-media-page-design.md`

## Global Constraints

- All paths under `/home/dalmas/E/projects/local_task_tracker/v2_fe`; run `npm` there.
- **No backend changes.** Reuse the REST tables + existing scoping.
- vitest is **node env, no jsdom** — the row→item mapping and the filter predicate are pure and unit-tested; the React page + dialog export are verified by `npm run build` + a live pass (repo has no component tests).
- Reuse, don't reinvent: `MessageAttachmentItem` + `AttachmentPreviewDialog` from `@/components/message-attachments`; `getAttachmentKind`/`AttachmentKind` from `@/lib/attachment-kind`. Do NOT add a new preview renderer.
- Channel-private attachments are already filtered out by the REST scope — do not add client-side privacy logic.
- eslint baseline is dirty (~3 pre-existing in App.tsx); new files add none. `.tsx`/`.ts` use `@/` alias, no import extension.
- Do not touch chat/board/dashboard flows beyond the one `export` keyword and the route+nav additions.

---

### Task 1: Media data layer — mapping helpers + fetch

**Files:**
- Create: `src/lib/media-items.ts`
- Create: `src/lib/media-items.test.ts`
- Modify: `src/lib/taskflow-api.ts` (add `fetchProjectMedia`)

**Interfaces:**
- Consumes: `MessageAttachmentItem` (`@/components/message-attachments`); `getAttachmentKind` (`@/lib/attachment-kind`); `taskflowApi`, `taskflowTables`, the row types `TaskflowMessageAttachment`/`TaskflowTaskAttachment` (`taskflow-api.ts`).
- Produces:
  - `type MediaSource`, `type MediaItem`, `type MediaFilter` (per spec)
  - `mediaUrlFromKey(key: string): string`
  - `messageRowToMediaItem(row, channelLabel, href): MediaItem`
  - `taskRowToMediaItem(row, taskLabel, href): MediaItem`
  - `matchesMediaFilter(item: MediaItem, filter: MediaFilter): boolean`
  - `fetchProjectMedia(projectId: number): Promise<{ chat: TaskflowMessageAttachment[]; task: TaskflowTaskAttachment[] }>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/media-items.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import {
  mediaUrlFromKey,
  messageRowToMediaItem,
  taskRowToMediaItem,
  matchesMediaFilter,
  type MediaItem,
} from "./media-items"

const imageRow = {
  id: 7, name: "shot.png", content_type: "image/png", size_bytes: 1234,
  file: "abc-shot.png", created_at: "2026-07-20T00:00:00Z", channel: 3,
} as never
const pdfTaskRow = {
  id: 9, name: "spec.pdf", content_type: "application/pdf", size_bytes: 5000,
  file: "def-spec.pdf", created_at: "2026-07-21T00:00:00Z", task: 42,
} as never

describe("mediaUrlFromKey", () => {
  it("prefixes a bare storage key with /media/", () => {
    expect(mediaUrlFromKey("abc-shot.png")).toBe("/media/abc-shot.png")
  })
  it("leaves an already-resolved url or blob untouched", () => {
    expect(mediaUrlFromKey("/media/x")).toBe("/media/x")
    expect(mediaUrlFromKey("blob:xyz")).toBe("blob:xyz")
    expect(mediaUrlFromKey("http://h/x")).toBe("http://h/x")
  })
})

describe("row → MediaItem", () => {
  it("maps a chat image row", () => {
    const item = messageRowToMediaItem(imageRow, "#general", "/dashboard/agents")
    expect(item).toMatchObject({
      id: "7", name: "shot.png", contentType: "image/png", sizeBytes: 1234,
      url: "/media/abc-shot.png", createdAt: "2026-07-20T00:00:00Z",
      source: { kind: "chat", channelId: 3, label: "#general", href: "/dashboard/agents" },
    })
  })
  it("maps a task pdf row", () => {
    const item = taskRowToMediaItem(pdfTaskRow, "task #42", "/dashboard/board")
    expect(item).toMatchObject({
      id: "9", name: "spec.pdf", contentType: "application/pdf", sizeBytes: 5000,
      url: "/media/def-spec.pdf",
      source: { kind: "task", taskId: 42, label: "task #42", href: "/dashboard/board" },
    })
  })
})

describe("matchesMediaFilter", () => {
  const img = messageRowToMediaItem(imageRow, "#general", "/x") as MediaItem
  const pdf = taskRowToMediaItem(pdfTaskRow, "task #42", "/y") as MediaItem
  it("all matches everything", () => {
    expect(matchesMediaFilter(img, "all")).toBe(true)
    expect(matchesMediaFilter(pdf, "all")).toBe(true)
  })
  it("images matches images only", () => {
    expect(matchesMediaFilter(img, "images")).toBe(true)
    expect(matchesMediaFilter(pdf, "images")).toBe(false)
  })
  it("files matches non-images only", () => {
    expect(matchesMediaFilter(pdf, "files")).toBe(true)
    expect(matchesMediaFilter(img, "files")).toBe(false)
  })
  it("chat / tasks partition by source", () => {
    expect(matchesMediaFilter(img, "chat")).toBe(true)
    expect(matchesMediaFilter(img, "tasks")).toBe(false)
    expect(matchesMediaFilter(pdf, "tasks")).toBe(true)
    expect(matchesMediaFilter(pdf, "chat")).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- media-items`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `media-items.ts`**

```ts
import { getAttachmentKind } from "@/lib/attachment-kind"
import type { MessageAttachmentItem } from "@/components/message-attachments"

export type MediaSource =
  | { kind: "chat"; channelId: number | null; label: string; href: string }
  | { kind: "task"; taskId: number; label: string; href: string }

export type MediaItem = MessageAttachmentItem & {
  source: MediaSource
  createdAt: string | null
}

export type MediaFilter = "all" | "images" | "files" | "chat" | "tasks"

/** A stored attachment row's `file` is a bare key; already-resolved urls and
 *  blobs pass through. */
export function mediaUrlFromKey(key: string): string {
  if (!key) return ""
  return key.startsWith("/") || key.startsWith("blob:") || key.startsWith("http")
    ? key
    : `/media/${key}`
}

/** The attachment-row fields both tables share. */
type BaseRow = {
  id: number
  name: string
  content_type: string
  size_bytes: number
  file: string
  created_at?: string | null
}

function baseItem(row: BaseRow): MessageAttachmentItem & { createdAt: string | null } {
  return {
    id: String(row.id),
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    url: mediaUrlFromKey(row.file),
    createdAt: row.created_at ?? null,
  }
}

export function messageRowToMediaItem(
  row: BaseRow & { channel?: number | null },
  channelLabel: string,
  href: string,
): MediaItem {
  return {
    ...baseItem(row),
    source: { kind: "chat", channelId: row.channel ?? null, label: channelLabel, href },
  }
}

export function taskRowToMediaItem(
  row: BaseRow & { task: number },
  taskLabel: string,
  href: string,
): MediaItem {
  return {
    ...baseItem(row),
    source: { kind: "task", taskId: row.task, label: taskLabel, href },
  }
}

/** Image vs file uses the same classifier chat uses. */
export function matchesMediaFilter(item: MediaItem, filter: MediaFilter): boolean {
  const isImage = getAttachmentKind(item.contentType, item.name) === "image"
  switch (filter) {
    case "all": return true
    case "images": return isImage
    case "files": return !isImage
    case "chat": return item.source.kind === "chat"
    case "tasks": return item.source.kind === "task"
  }
}
```

(If `AttachmentKind`'s image variant is named other than `"image"`, match the actual value from `@/lib/attachment-kind`.)

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- media-items`
Expected: PASS.

- [ ] **Step 5: Add `fetchProjectMedia` to `taskflow-api.ts`**

Mirror the existing reference fetches (`taskflowApi.from(table).filter({project}).orderBy(...).param("page_size", …).list()`, which returns `{ results }`). Add:

```ts
/** All attachments the caller can see in a project, from both chat + tasks.
 *  Channel-private chat attachments are excluded by the REST scope. */
export async function fetchProjectMedia(projectId: number): Promise<{
  chat: TaskflowMessageAttachment[]
  task: TaskflowTaskAttachment[]
}> {
  const [chat, task] = await Promise.all([
    taskflowApi.from(taskflowTables.messageAttachments)
      .filter({ project: projectId }).orderBy("-created_at", "-id").param("page_size", 500).list(),
    taskflowApi.from(taskflowTables.taskAttachments)
      .filter({ project: projectId }).orderBy("-created_at", "-id").param("page_size", 500).list(),
  ])
  return {
    chat: chat.results as TaskflowMessageAttachment[],
    task: task.results as TaskflowTaskAttachment[],
  }
}
```

Confirm `taskflowTables.messageAttachments`/`.taskAttachments` and the row types are already imported/defined in the file (they are — grep to confirm the exact names).

- [ ] **Step 6: Verify**

Run: `npm test && npm run build`
Expected: all tests pass; build clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/media-items.ts src/lib/media-items.test.ts src/lib/taskflow-api.ts
git commit -m "feat(v2_fe): media item mapping/filter helpers + fetchProjectMedia"
```

---

### Task 2: The Media page (gallery + reused chat lightbox)

Pure UI wiring. Verified by build + live pass.

**Files:**
- Modify: `src/components/message-attachments.tsx` (add `export` to `AttachmentPreviewDialog`; export any prop type it needs that isn't already public)
- Create: `src/pages/dashboard/MediaPage.tsx`
- Modify: `src/App.tsx` (route + pass callbacks; import)
- Modify: `src/components/app-sidebar.tsx` (nav item)

**Interfaces:**
- Consumes: `fetchProjectMedia`, the mapping helpers + types (Task 1); `AttachmentPreviewDialog`, `MessageAttachmentItem` (`@/components/message-attachments`); `getAttachmentKind` (`@/lib/attachment-kind`).
- Props for `MediaPage`: `{ projectId: number | null; channelName: (id: number | null) => string; onOpenTask: (taskId: number) => void; onOpenChannel: (channelId: number | null) => void }`.

- [ ] **Step 1: Export the dialog**

In `src/components/message-attachments.tsx`, change `function AttachmentPreviewDialog(` to `export function AttachmentPreviewDialog(`. No behavior change. If its props reference a non-exported type, export that type too. Confirm the build still passes.

- [ ] **Step 2: Build `MediaPage.tsx`**

A page component that:
- Holds `filter` state (`"all"` default) and `data`/`loading`/`error`, plus the `dataProjectId` tag (same stale-guard pattern as `OverviewPage`, so a project switch can't show another project's media).
- On mount / when `projectId` changes: if null → "select a project"; else `fetchProjectMedia(projectId)`, then map:
  - each `chat` row → `messageRowToMediaItem(row, channelName(row.channel), "/dashboard/agents")`
  - each `task` row → `taskRowToMediaItem(row, `task #${row.task}`, "/dashboard/board")`
  - concat, sort by `createdAt` desc, store with `dataProjectId = projectId`.
- Derives `displayData = data && dataProjectId === projectId ? data : null`; `visible = displayData.filter(i => matchesMediaFilter(i, filter))`.
- Renders:
  1. Header + filter chips (All / Images / Files / Chat / Tasks); active chip styled selected; each shows its count.
  2. A responsive grid (`grid` with auto-fill/min-width tiles). For each `visible` item:
     - image (`getAttachmentKind(...)==="image"`) → a square thumbnail `<img src={item.url} loading="lazy" className="h-full w-full object-cover">` with an `onError` that swaps to the file-card fallback;
     - else → a compact file card (kind icon + name + formatted size).
     - Each tile overlays/appends a small **source chip** (`item.source.label`) that, on click (stopPropagation), calls `onOpenTask(source.taskId)` or `onOpenChannel(source.channelId)` per kind.
     - Clicking the tile body sets `activeIndex` = this item's index within `visible`.
  3. `<AttachmentPreviewDialog attachments={visible} activeIndex={activeIndex ?? 0} open={activeIndex !== null} onIndexChange={setActiveIndex} onOpenChange={(o)=>!o && setActiveIndex(null)} />` — the identical chat lightbox, paging across the filtered set.
- Loading skeleton, retryable error card, and an empty state ("No media in this project yet" / "No items match this filter").
- Reuse existing card/panel/tile styling from the app; keep small tile subcomponents local.

- [ ] **Step 3: Wire route + nav in `App.tsx` and `app-sidebar.tsx`**

- In `App.tsx`, import `MediaPage` and add the route in the dashboard routes block:

```tsx
<Route
  path="/dashboard/media"
  element={
    <MediaPage
      projectId={activeProject ? liveId(activeProject.id) : null}
      channelName={(id) => /* look up channel title from the workspace channels map, else `#${id}` */}
      onOpenTask={(taskId) => { navigate("/dashboard/board"); setOpenTaskId(String(taskId)) }}
      onOpenChannel={() => navigate("/dashboard/agents")}
    />
  }
/>
```

Adapt to the exact names in that scope (grep for how channels are held — there is a channels list in the live workspace; map id→title; fall back to `#${id}`). `setOpenTaskId` and `navigate` are already in scope (used elsewhere in App.tsx).

- In `src/components/app-sidebar.tsx`, add a **Media** nav entry after the Dashboard one, url `/dashboard/media`, a lucide icon (e.g. `ImageIcon` or `GalleryVerticalEndIcon`).

- [ ] **Step 4: Typecheck, build, lint**

Run: `npm run build`
Expected: clean.

Run: `npx eslint src/pages/dashboard/MediaPage.tsx src/components/message-attachments.tsx src/App.tsx src/components/app-sidebar.tsx`
Expected: no NEW errors beyond the pre-existing baseline.

Run: `npm test`
Expected: existing tests (incl. Task 1's) stay green.

- [ ] **Step 5: Commit**

```bash
git add src/pages/dashboard/MediaPage.tsx src/components/message-attachments.tsx src/App.tsx src/components/app-sidebar.tsx
git commit -m "feat(v2_fe): media gallery page reusing the chat attachment lightbox"
```

---

### Task 3: Live verification

- [ ] **Step 1: Automated**

Run: `npm test && npm run build`
Expected: green. Record counts.

- [ ] **Step 2: Live**

Restart the Vite dev server if needed (a long-running one may not pick up new files/routes). Load `/dashboard/media`:
- The grid shows images (thumbnails) + files (cards) from both chat and tasks.
- Filter chips switch the set; counts look right.
- Clicking an image opens the chat lightbox and pages across the filtered set (zoom works); a file card opens the PDF/code/text preview.
- A source chip navigates to the task (board, task open) or the chat area.
- Empty and error states behave.

If no browser is available, hand this pass to the user with the automated results.

- [ ] **Step 3: Report on TaskFlow #60**

With both pages (Dashboard + Media) shipped, #60 is complete — mark it done (or partial_done if a review gate is desired) and post a note.

---

## Notes for the implementer

- **Restart the Vite dev server** for the new page/route to appear.
- **Do not add a preview renderer** — the whole point is reusing `AttachmentPreviewDialog`. If it needs a prop type exported, export it; don't fork it.
- **Channel privacy is server-side** — never add client filtering for it; the REST scope already excludes channels the caller isn't in.
- **Match `OverviewPage`'s stale-data guard** (tag data with its projectId; render `displayData`) so a project switch can't show another project's media.
