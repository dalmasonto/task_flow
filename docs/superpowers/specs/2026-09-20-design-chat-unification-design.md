# Design-page chat unification — Phase 1 design

**Date:** 2026-09-20
**Status:** Approved for implementation planning
**Scope:** Phase 1 of a larger design-page rework (see "Roadmap / out of scope").

## Problem

The design page (`v2_fe/src/pages/design/DesignSurfacePage.tsx`) has its own
messaging pipe: a bespoke input (`design-prompt-bar.tsx` — a custom textarea +
agent-picker + selection chip), a bespoke agent→design dispatch path
(`plugins/taskflow-design/src/dispatch.rs`, `/api/design/{project}/prompt`), and
a bespoke "agent output appears here" streaming area fed by `terminal_frames`.

This is a parallel system to the real chat. It cannot share attachments, media
rendering, pagination, or agent routing with `/agents`, and it drifts. The user's
directive: **design should not be a second messaging system. It should be a view
over the existing chat**, distinguished only by a flag.

## Goal

Design messages become ordinary chat messages in the project's existing public
channel ("Project room", `kind: Project`), carrying one new boolean
`is_design = true`. Any connected agent or human can participate. The design page
renders that channel *filtered to `is_design`* using the **same** components as
`/agents`, so attachments, media lightbox, left/right author rendering, and
reverse-infinite-scroll all work by reuse, not reimplementation.

## Non-goals (Phase 1)

Explicitly deferred to later phases (see roadmap):

- Right-panel tabs (Inspect / Components / Tokens / Pages).
- Tokens-as-CSS-variables rework and clean single-swap CSS export.
- Top design-nav rework (pan / select / zoom with real icons, extra tools).
- Multi-page-open canvas and per-page multi-device rows.
- Realistic device emulation (killing the oversized scrollbar; likely a library).

Phase 1 delivers the shared message flow and the minimal layout skeleton it
requires. The right panel stays the current inspector; the middle stays the
current canvas.

## Key decisions (from brainstorming)

1. **Decomposition:** Foundation first — `is_design` + composer/list reuse +
   badge + minimal layout skeleton. Right-panel tabs, canvas/nav, and device
   emulation are later phases.
2. **Agent flagging:** an agent's reply is marked design via an **MCP param**
   (`is_design` on the agent send path), with the server auto-setting it where it
   safely can. No thread/reply schema is added.
3. **Selection reference travel:** the inspected-element reference rides **inside
   the message body** as a fenced ` ```design-ref ` block — no second column.
   Honors the user's "the only field we add is `is_design`" constraint.
4. **Reuse unit:** the design rail reuses the whole `AgentsConversationView`
   (composer + message list together), the same component the floating dock uses,
   via a new `variant="design"`.

## Architecture

```
                    project "Project room" channel  (kind: Project)
                    ┌───────────────────────────────────────────────┐
   /agents  ───────▶│  all messages   (is_design badge on design ones)│
                    │                                                 │
   design page ────▶│  messages WHERE is_design = true                │
                    └───────────────────────────────────────────────┘
                         one message model, one send path, one SSE
```

### 1. Data model — `is_design` on messages

- Add to `TaskflowAgentMessage` (`backend/plugins/taskflow-agents/src/models.rs`,
  struct at ~242-292), following the existing `archived` bool pattern
  (`models.rs:210`):

  ```rust
  #[umbral(default = "false")]
  pub is_design: bool,
  ```

- Generate a **new** migration via `cd backend && cargo run -- makemigrations`.
  It emits `backend/migrations/taskflow_agents/0020_<desc>.json` (current highest
  is `0019_...`). Template: `0018_add_taskflow_agent_message_edited_at.json`
  (single `AddColumn` op + full `snapshot_after`).
  **Never** hand-edit or regenerate an already-applied migration under the same
  id/filename — the runner tracks applied ids and a rewritten same-named file
  silently never re-runs (migration rewrite trap).
- Serde/ORM derive carries the field automatically on auto-REST reads. Realtime
  is id-only (`realtime.rs:206`), so no broadcast projection change — clients
  refetch the row and get the column for free.

### 2. Write paths

**Human send** (`backend/plugins/taskflow-agents/src/views.rs`):
- Add `is_design: Option<bool>` to `SendMessageInput` (~65-80), default false.
- Handle it in the multipart field-parse branch (`send_message`, ~358-367) and
  pass it into the `create`.

**Agent send:**
- Add `is_design` param to `AgentSendMessageInput` (`views.rs:1324-1331`) +
  `send_message_as_agent` (`views.rs:1349`) multipart parse, and to the MCP
  `send_message` tool definition (`mcp/src/server.ts`, ~1012-1217 region).
- **Definitive Phase 1 rule — honor the explicit param, no inference.** The
  agent send path carries no `targets` and messages have no reply/thread linkage,
  so there is nothing reliable for the server to infer design-ness from. The
  server therefore sets `is_design` to exactly what the agent passes, defaulting
  to `false` when omitted. Agents are instructed (MCP tool description + the
  design-request message body) to pass `is_design: true` when answering a design
  request. This keeps the flag reliable and honest rather than fuzzily guessed;
  a future phase can add reply-threading to enable inheritance.

**Selection reference (body-encoded):**
- The design rail's composer, when a selection chip is present, appends a fenced
  block to `body_markdown` on send:

  ````
  ```design-ref
  {"page_path":"pages/home.js","component_name":null,"element_path":"...","src_ref":"...","viewport":"desktop"}
  ```
  ````

- A small shared parser/renderer extracts this block so:
  - the design bubble renders it as a compact, non-noisy chip;
  - agents parse it to know which element to act on.
- Location: a helper in `v2_fe/src/lib/` (parse + strip for display) plus a render
  branch in the bubble. Keep the raw block in the stored body (agents read it).

### 3. Read path — filtered pagination

- Add an optional `isDesign` filter to `fetchChannelMessages`
  (`v2_fe/src/lib/taskflow-api.ts:540`) as a server-side query param on the scoped
  list, and thread it through `useAgentChat`
  (`v2_fe/src/components/chat/use-agent-chat.ts`) so the per-conversation page
  state machine (`channelPageState`, `loadOlderMessages`) works unchanged for the
  filtered view.
- Backend: support an `is_design` filter on the human-facing scoped message list
  (auto-REST list scoped by `visible_channel_ids`) and/or
  `list_messages_as_agent` (`views.rs:3428`). Filtering must be **server-side** so
  "newest 20 first, older on scroll" is correct (client-side filtering of a
  20-row page could yield zero design rows).
- The design rail requests the project room + `isDesign: true`.

### 4. The design rail (frontend reuse)

- Remove `DesignPromptBar` usage from `DesignSurfacePage.tsx` (the custom input
  **and** the "agent output appears here" streaming area, `design-prompt-bar.tsx`
  lines ~74-107, 93-95). The `terminal_frames` design-log buffering
  (`DesignSurfacePage.tsx:83,129-142`) is removed from this surface.
- Mount `AgentsConversationView`
  (`v2_fe/src/components/chat/conversation-view.tsx:27`) with a new
  `variant="design"`:
  - targets the project-room channel with the `isDesign` filter;
  - auto-sets `is_design=true` on send (`handleSendMessage`, ~331);
  - accepts a new optional **`contextChip`** prop `{ label, reference }` fed the
    current inspect selection; renders a removable chip and appends the
    `design-ref` block on send. In `/agents` the prop is omitted → no chip, no
    block.
  - keeps @mention, "To:" agent targeting (= "tag an agent"), attachments,
    priority, media lightbox (`message-attachments.tsx`), left/right bubbles
    (`bubbles.tsx`), reverse-infinite-scroll.
  - `variant="design"` trims the conversation-switcher/header chrome the narrow
    rail doesn't need.
- Widen the left rail so the composer works comfortably.

### 5. The badge

- Add `showDesignBadge?: boolean` (default `false`) to `AgentChatBubble`
  (`v2_fe/src/components/chat/bubbles.tsx:141`).
- `/agents` (`conversation-view.tsx` used by the Agents page) passes `true` →
  messages with `is_design` show a small "Design" badge.
- The design rail passes `false` (every message there is design; the badge is
  redundant).

### 6. Layout skeleton (minimal)

`DesignSurfacePage.tsx` reflows to full-height three-column flow (header +
top-nav aside):
- **Left:** the design chat rail (full height, composer fixed at the bottom),
  widened.
- **Middle:** the existing `DesignCanvas` (unchanged this phase).
- **Right:** the existing `DesignInspector` (unchanged this phase; tabs are
  Phase 2).
- The bottom prompt bar row is removed; the three columns extend to the bottom.

## Data flow (design message round-trip)

1. User inspects an element in the canvas → selection state feeds the rail's
   `contextChip`.
2. User types, @mentions / "To:" a specific agent, sends. Composer posts a normal
   message to the project room with `is_design=true` and the `design-ref` body
   block.
3. Message broadcasts id-only over SSE; `/agents` and the design rail both
   refetch; the design rail (filtered) shows it, `/agents` shows it with a badge.
4. The targeted agent receives it (existing directed-message routing), reads the
   `design-ref` block, acts, and replies via the agent send path with
   `is_design=true`.
5. The reply shows in the design rail (filtered) and in `/agents` (badged).
   Agents share work via existing targeting — only the tagged agent acts.

## Error handling / edge cases

- **Filter param absent / false:** behaves exactly as today (full channel).
- **Zero design messages yet:** the rail shows the standard empty state; sending
  the first one creates it in the existing project room (no new channel).
- **Optimistic send:** reuse existing optimistic bubble path
  (`message-store.ts`); the `is_design` flag and `design-ref` block are part of
  the optimistic payload so the bubble renders correctly before reconcile.
- **Malformed `design-ref` block:** the parser fails soft — render the raw body,
  no chip; never throw in the bubble.
- **Agent omits `is_design`:** the reply defaults to `false` and lands in general
  chat only — visible and recoverable, not lost. The MCP tool description and the
  design-request body prompt the agent to pass the flag.

## Testing

- **Backend:** `cargo test --workspace` (bare `cargo test` in `backend/` skips
  plugin crates). Cover: migration applies; send with `is_design`; scoped list
  filters by `is_design`; agent send honors + auto-sets the param.
- **MCP:** `send_message` param plumbs through to `send_message_as_agent`.
- **Frontend:** `npm run build` (the built app is what the user views — an unbuilt
  change looks like a revert). Manual: design rail shows only `is_design` msgs,
  newest 20 + older on scroll-up; send from the rail flags `is_design` and encodes
  the chip; media lightbox works in the rail; `/agents` shows the "Design" badge;
  `contextChip` absent in `/agents`.

## Roadmap / out of scope (later phases)

- **Phase 2:** right-panel tabs (Inspect / Components / Tokens / Pages);
  tokens rework to proper Tailwind CSS variables with a clean single-swap export;
  full-height right panel.
- **Phase 3:** top-nav rework (pan / select / zoom real icons, rounded tool
  buttons, extra design tools); multi-page-open canvas with per-page
  multi-device rows; realistic device emulation library (fix oversized scrollbar
  on small viewports).

## Affected files (reference)

Backend:
- `backend/plugins/taskflow-agents/src/models.rs` — add `is_design`.
- `backend/migrations/taskflow_agents/0020_*.json` — new migration.
- `backend/plugins/taskflow-agents/src/views.rs` — `SendMessageInput`,
  `send_message`, `send_message_as_agent`, `list_messages_as_agent` filter.
- `backend/src/rest.rs` — scoped list `is_design` filter support (if needed).
- `mcp/src/server.ts` — `send_message` tool `is_design` param.

Frontend:
- `v2_fe/src/pages/design/DesignSurfacePage.tsx` — layout reflow, mount
  `AgentsConversationView`, drop `DesignPromptBar`.
- `v2_fe/src/components/chat/conversation-view.tsx` — `variant="design"`,
  `contextChip` prop.
- `v2_fe/src/components/chat/use-agent-chat.ts` — `isDesign` filter.
- `v2_fe/src/lib/taskflow-api.ts` — `fetchChannelMessages` `isDesign` param.
- `v2_fe/src/components/chat/bubbles.tsx` — `showDesignBadge`, `design-ref` chip.
- `v2_fe/src/lib/` — `design-ref` parse/strip helper.
- (remove usage) `v2_fe/src/pages/design/design-prompt-bar.tsx`.
