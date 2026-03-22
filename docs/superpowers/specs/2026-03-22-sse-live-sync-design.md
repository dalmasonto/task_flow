# MCP → UI Live Sync via SSE — Design Spec

## Overview

Bridge the MCP server (SQLite) and the web/Tauri app (IndexedDB) so that changes made via MCP tools appear in the UI in real-time. Uses Server-Sent Events (SSE) broadcast from the MCP process, consumed by the web app which mirrors changes into Dexie.

## Architecture

```
MCP tool call (e.g. create_task)
    │
    ▼
SQLite write
    │
    ▼
broadcast() → SSE event to all connected clients
    │
    ▼
Web/Tauri app (EventSource on localhost:3456/events)
    │
    ▼
Write to Dexie/IndexedDB
    │
    ▼
useLiveQuery re-renders UI automatically
```

## MCP Server Changes

### New file: `mcp-server/src/sse.ts`

Starts an HTTP server alongside the MCP stdio transport. Single endpoint.

- **Port:** `3456` by default, configurable via `TASKFLOW_SSE_PORT` env var
- **Endpoint:** `GET /events` — SSE stream
- **CORS:** Allow all origins (localhost dev use)
- **Exports:** `broadcast(event: string, data: object)` — sends to all connected SSE clients
- **Uses:** Node.js built-in `http` module (no Express dependency)
- **Starts automatically** when the MCP server process starts (called from `index.ts`)

### Modified: `mcp-server/src/helpers.ts`

Add a `broadcastChange(entity, action, payload)` function that wraps `broadcast()`. Call it from every write operation across all tool modules.

### Modified: All tool files in `mcp-server/src/tools/`

After each write operation (create, update, delete, timer start/pause/stop), call `broadcastChange()` with the entity type, action, and the full entity data as payload.

## Web App Changes

### New file: `src/hooks/use-sync.ts`

A React hook that connects to the SSE endpoint and mirrors changes into Dexie.

- **Connects to:** `http://localhost:3456/events` via `EventSource`
- **Reconnects automatically** on disconnect (EventSource does this natively)
- **Gracefully degrades:** If the MCP server isn't running, no errors — just no sync
- **Event handling:** Parses each SSE event and performs the corresponding Dexie operation

Event → Dexie mapping:

| Event | Dexie Operation |
|-------|----------------|
| `task_created` | `db.tasks.put(payload)` |
| `task_updated`, `task_status_changed`, `task_completed`, `task_partial_done` | `db.tasks.put(payload)` |
| `task_deleted` | `db.tasks.delete(payload.id)` |
| `project_created` | `db.projects.put(payload)` |
| `project_updated` | `db.projects.put(payload)` |
| `project_deleted` | `db.projects.delete(payload.id)` |
| `timer_started` | `db.sessions.put(payload.session)` + `db.tasks.update(payload.task_id, { status: 'in_progress' })` |
| `timer_paused` | `db.sessions.put(payload.session)` + `db.tasks.update(payload.task_id, { status: 'paused' })` |
| `timer_stopped` | `db.sessions.put(payload.session)` + `db.tasks.update(payload.task_id, { status: payload.final_status })` |
| `tasks_bulk_created` | `db.tasks.bulkPut(payload.tasks)` |
| `settings_saved` | `db.settings.put(payload)` |

### Modified: `src/App.tsx`

Call `useSync()` once at the app root level, inside the `<RootLayout>` or at the top of the `App` component.

## SSE Event Format

```json
event: task_created
data: {"entity":"task","action":"created","payload":{"id":5,"title":"New task","status":"not_started","priority":"medium","dependencies":[],"tags":[],"links":[],"created_at":"2026-03-22T...","updated_at":"2026-03-22T..."}}
```

## Configuration

The SSE port is configurable via the same MCP server env var mechanism:

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "node",
      "args": ["<path>/mcp-server/dist/index.js"],
      "env": {
        "TASKFLOW_SSE_PORT": "3456"
      }
    }
  }
}
```

The web app connects to `localhost:3456` by default. For the Tauri app, same — it's all localhost.

## What This Does NOT Change

- MCP stdio transport unchanged
- SQLite remains source of truth for MCP operations
- IndexedDB remains UI's data source
- No new npm dependencies (EventSource + http are built-in)
- Web app works fine without MCP server running (no sync, no errors)
