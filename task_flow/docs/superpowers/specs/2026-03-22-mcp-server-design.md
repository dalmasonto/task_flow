# TaskFlow MCP Server — Design Spec

## Overview

A Model Context Protocol (MCP) server that exposes the full TaskFlow application surface as tools for AI agents. The server runs as a standalone Node.js process, communicates over stdio, and stores data in a SQLite database at `~/.taskflow/taskflow.db`.

This gives Claude Code sessions and subagents the ability to create tasks, manage projects, track time, query analytics, and manage settings — all through MCP tools.

## Architecture

```
Claude Code / Subagents
        |
        | stdio (MCP protocol)
        v
   mcp-server/          (Node.js process)
   ├── src/
   │   ├── index.ts          — entry point, MCP server setup
   │   ├── db.ts             — SQLite connection + schema init
   │   ├── tools/
   │   │   ├── tasks.ts      — task CRUD + status transitions
   │   │   ├── projects.ts   — project CRUD
   │   │   ├── timer.ts      — start/pause/stop sessions
   │   │   ├── analytics.ts  — computed metrics
   │   │   ├── activity.ts   — activity log read/write
   │   │   ├── notifications.ts — notification management
   │   │   └── settings.ts   — settings read/write
   │   └── types.ts          — shared type definitions
   ├── package.json
   └── tsconfig.json
```

The MCP server lives inside the existing repo at `mcp-server/`. The browser/Tauri app is unaffected — it keeps IndexedDB for demo/onboarding. The MCP server's SQLite is the source of truth for AI agent workflows.

## Storage

**Database:** SQLite via better-sqlite3.

**Location:** `~/.taskflow/taskflow.db` by default, overridable via `TASKFLOW_DB_PATH` env var. The code expands `~` to `os.homedir()` at startup. The directory is created automatically on first run.

**Why better-sqlite3:** Synchronous API (no async overhead in tool handlers), single file, zero config, handles developer-scale data (thousands of tasks, tens of thousands of sessions) with no performance concerns.

## Database Schema

All tables use auto-incrementing integer IDs. Dates stored as ISO 8601 strings. JSON arrays stored as TEXT.

### JSON Column Shapes

- `dependencies` — `number[]` (array of task IDs)
- `links` — `Array<{ label: string; url: string }>` (array of objects)
- `tags` — `string[]` (array of strings)
- `settings.value` — JSON-serialized value matching the `SettingsMap` type for the given key

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  priority TEXT NOT NULL DEFAULT 'medium',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  dependencies TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  due_date TEXT,
  estimated_time INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#de8eff',
  type TEXT NOT NULL DEFAULT 'active_project',
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  start TEXT NOT NULL,
  end TEXT
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
```

## MCP Tools

### Tasks (8 tools)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `create_task` | title (required), description, status, priority, project_id, dependencies (number[]), tags (string[]), links (Array<{label, url}>), due_date, estimated_time | Created task with ID | Logs `task_created` |
| `list_tasks` | status, project_id, priority, tag (all optional filters) | Array of tasks | None |
| `get_task` | id (required) | Task with computed total_time and session_count | None |
| `update_task` | id (required), any writable field | Updated task | Logs granular actions: `dependency_added`, `dependency_removed`, `link_added`, `tag_added`, `tag_removed`, or generic `task_status_changed` as appropriate |
| `update_task_status` | id (required), status (required) | Updated task | Validates transition via VALID_TRANSITIONS map, logs `task_status_changed`, `task_completed`, or `task_partial_done` |
| `delete_task` | id (required) | Confirmation | Cascade-deletes sessions (via FK), logs `task_deleted` |
| `bulk_create_tasks` | tasks array of {title, description?, priority?, project_id?, status?, dependencies?, tags?} | Array of created tasks with IDs | Logs `tasks_bulk_created` |
| `search_tasks` | query (required) | Matching tasks | None. Case-insensitive substring match on `title` and `description` via SQLite `LIKE '%query%'` |

### Projects (5 tools)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `create_project` | name (required), color, type, description | Created project with ID | Logs `project_created` |
| `list_projects` | None | Projects with task_count per project | None |
| `get_project` | id (required) | Project with its tasks | None |
| `update_project` | id (required), name, color, type, description | Updated project | Logs `project_updated` |
| `delete_project` | id (required) | Confirmation | Tasks unlinked via `ON DELETE SET NULL` FK constraint, logs `project_deleted` |

### Timer (3 tools)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `start_timer` | task_id (required) | Created session | Errors if task already has an open session. Sets task to `in_progress`, logs `timer_started` |
| `pause_timer` | task_id (required) | Closed session with duration | Sets task to `paused`, logs `timer_paused` |
| `stop_timer` | task_id (required), final_status (done, partial_done, or blocked; default done) | Closed session with duration | Sets task status, logs `timer_stopped` + status change |

### Sessions (1 tool)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `list_sessions` | task_id (optional), start_date, end_date (optional date range) | Array of sessions with computed durations | None |

### Analytics (2 tools)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `get_analytics` | start_date, end_date (optional) | total_focused_time, tasks_completed, tasks_in_progress, total_tasks, time_per_project, status_distribution | None |
| `get_timeline` | start_date, end_date (optional), group_by (day or week, default day) | Session breakdown per period | None |

### Activity Log (2 tools)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `get_activity_log` | limit (default 50), action, entity_type (optional filters) | Array of log entries | None |
| `clear_activity_log` | None | Confirmation | Deletes all logs |

### Notifications (4 tools)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `list_notifications` | limit (default 50), unread_only (boolean) | Array of notifications | None |
| `mark_notification_read` | id (required) | Updated notification | None |
| `mark_all_notifications_read` | None | Count of updated | None |
| `clear_notifications` | None | Confirmation | Deletes all |

### Settings (2 tools)

| Tool | Parameters | Returns | Side Effects |
|------|-----------|---------|-------------|
| `get_setting` | key (required) | Current value for the key, or default if unset | None |
| `update_setting` | key (required), value (required) | Updated value | Logs `settings_saved` |

**Total: 27 tools**

## Validation

- **Status transitions** enforced using the same `VALID_TRANSITIONS` map from the web app. Invalid transitions return an error.
- **Input validation** via Zod schemas on every tool. Invalid params return structured error messages.
- **Dependency cycles** checked on `create_task` and `update_task` when dependencies are provided.
- **Referential integrity** — project_id validated against existing projects, task dependencies validated against existing tasks.
- **Open session checks** — `start_timer` errors if the task already has an open session (end is NULL).

## Error Responses

All errors return `isError: true` with a structured JSON content block:

```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "{\"error\": \"Cannot transition from not_started to done\", \"code\": \"INVALID_TRANSITION\"}"
  }]
}
```

Error codes: `NOT_FOUND`, `INVALID_TRANSITION`, `VALIDATION_ERROR`, `CYCLE_DETECTED`, `SESSION_ALREADY_ACTIVE`, `NO_ACTIVE_SESSION`.

## Tech Stack

- `@modelcontextprotocol/sdk` — MCP server framework
- `better-sqlite3` — SQLite driver (synchronous)
- `typescript` — compiled to `dist/`
- `zod` — input validation

## Configuration

Users add to their Claude Code settings (`.claude/settings.json` or project-level):

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "node",
      "args": ["<path-to-repo>/mcp-server/dist/index.js"]
    }
  }
}
```

Optionally override the database path:

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "node",
      "args": ["<path-to-repo>/mcp-server/dist/index.js"],
      "env": {
        "TASKFLOW_DB_PATH": "/custom/path/taskflow.db"
      }
    }
  }
}
```

Default path: `~/.taskflow/taskflow.db` (tilde expanded via `os.homedir()` in code).

## Setup Steps

1. Clone the repo
2. `cd mcp-server && npm install && npm run build`
3. Add MCP config to Claude Code settings
4. All Claude Code sessions now have TaskFlow tools available

## What This Does NOT Change

- The browser app (Vercel) continues using Dexie/IndexedDB
- The Tauri desktop app continues using Dexie/IndexedDB
- No sync between SQLite and IndexedDB — they are independent datastores
- The MCP server is for AI agent workflows; the web/desktop app is for manual use and demos
