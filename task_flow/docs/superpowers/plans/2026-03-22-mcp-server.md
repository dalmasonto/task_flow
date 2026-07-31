# TaskFlow MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that exposes the full TaskFlow app as 27 tools for AI agents, backed by SQLite.

**Architecture:** Standalone Node.js MCP server in `mcp-server/`, communicating over stdio. Uses better-sqlite3 for a local SQLite database at `~/.taskflow/taskflow.db`. Each tool domain (tasks, projects, timer, etc.) is a separate module registering tools on the shared MCP server instance.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, better-sqlite3, zod

**Spec:** `docs/superpowers/specs/2026-03-22-mcp-server-design.md`

---

## File Structure

```
mcp-server/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              — entry point: create server, register all tools, start stdio transport
│   ├── db.ts                 — SQLite connection, schema init, tilde expansion, getDb() export
│   ├── types.ts              — shared types, VALID_TRANSITIONS, error codes, Zod schemas
│   ├── helpers.ts            — logActivity(), errorResponse(), successResponse() utilities
│   └── tools/
│       ├── tasks.ts          — 8 tools: create, list, get, update, update_status, delete, bulk_create, search
│       ├── projects.ts       — 5 tools: create, list, get, update, delete
│       ├── timer.ts          — 4 tools: start, pause, stop, list_sessions
│       ├── analytics.ts      — 2 tools: get_analytics, get_timeline
│       ├── activity.ts       — 2 tools: get_activity_log, clear_activity_log
│       ├── notifications.ts  — 4 tools: list, mark_read, mark_all_read, clear
│       └── settings.ts       — 2 tools: get_setting, update_setting
└── tests/
    ├── db.test.ts
    ├── tasks.test.ts
    ├── projects.test.ts
    ├── timer.test.ts
    ├── analytics.test.ts
    ├── activity.test.ts
    ├── notifications.test.ts
    └── settings.test.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/tsconfig.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "taskflow-mcp-server",
  "version": "1.0.0",
  "description": "MCP server for TaskFlow — exposes task management as AI agent tools",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1",
    "better-sqlite3": "^11.9.1",
    "zod": "^3.25.67"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.14",
    "@types/node": "^24.12.0",
    "typescript": "~5.9.3",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules
dist
```

- [ ] **Step 4: Install dependencies**

Run: `cd mcp-server && npm install`
Expected: `node_modules/` created, no errors.

> **Note:** If any version in package.json is not yet published, use `latest` instead.

- [ ] **Step 5: Verify TypeScript compiles (empty)**

Create a minimal `mcp-server/src/index.ts`:

```typescript
console.log('taskflow-mcp-server');
```

Run: `cd mcp-server && npx tsc`
Expected: `dist/index.js` created.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/package.json mcp-server/package-lock.json mcp-server/tsconfig.json mcp-server/.gitignore mcp-server/src/index.ts
git commit -m "feat(mcp): scaffold MCP server project"
```

---

### Task 2: Database Layer

**Files:**
- Create: `mcp-server/src/db.ts`
- Create: `mcp-server/tests/db.test.ts`

- [ ] **Step 1: Write db.test.ts**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, resolvePath } from '../src/db.js';

describe('Database', () => {
  afterEach(() => {
    closeDb();
  });

  it('should create all tables when initDb is called', () => {
    const db = initDb(':memory:');

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);

    expect(names).toContain('tasks');
    expect(names).toContain('projects');
    expect(names).toContain('sessions');
    expect(names).toContain('activity_logs');
    expect(names).toContain('notifications');
    expect(names).toContain('settings');
  });

  it('should create indexes', () => {
    const db = initDb(':memory:');

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as { name: string }[];
    const names = indexes.map(i => i.name);

    expect(names).toContain('idx_tasks_status');
    expect(names).toContain('idx_tasks_project_id');
    expect(names).toContain('idx_sessions_task_id');
  });

  it('should expand tilde in path', () => {
    const resolved = resolvePath('~/test.db');
    expect(resolved).not.toContain('~');
    expect(resolved).toContain('test.db');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx vitest run tests/db.test.ts`
Expected: FAIL — `../src/db.js` does not exist.

- [ ] **Step 3: Write db.ts**

```typescript
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';

const DEFAULT_DB_PATH = '~/.taskflow/taskflow.db';

let db: Database.Database | null = null;

// Expands ~/path to $HOME/path. Only handles ~/ prefix, not ~user/ paths.
export function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export function getDb(): Database.Database {
  if (db) return db;
  return initDb(process.env.TASKFLOW_DB_PATH || DEFAULT_DB_PATH);
}

// For testing: initialize with a specific path (use ':memory:' for tests)
export function initDb(path: string): Database.Database {
  if (db) { db.close(); db = null; }

  const dbPath = path === ':memory:' ? ':memory:' : resolvePath(path);
  if (path !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#de8eff',
      type TEXT NOT NULL DEFAULT 'active_project',
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && npx vitest run tests/db.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/db.ts mcp-server/tests/db.test.ts
git commit -m "feat(mcp): database layer with schema init and tilde expansion"
```

---

### Task 3: Types and Helpers

**Files:**
- Create: `mcp-server/src/types.ts`
- Create: `mcp-server/src/helpers.ts`

- [ ] **Step 1: Write types.ts**

Contains all shared types, Zod schemas, VALID_TRANSITIONS, and error codes. Mirror the types from the web app's `src/types/index.ts`.

```typescript
import { z } from 'zod';

// Status & Priority
export const TaskStatus = z.enum([
  'not_started', 'in_progress', 'paused', 'blocked', 'partial_done', 'done'
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['low', 'medium', 'high', 'critical']);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const ProjectType = z.enum(['active_project', 'project_idea']);
export type ProjectType = z.infer<typeof ProjectType>;

export const NotificationType = z.enum(['info', 'success', 'warning', 'error']);
export type NotificationType = z.infer<typeof NotificationType>;

export const ActivityAction = z.enum([
  'task_created', 'task_deleted', 'task_status_changed', 'task_completed',
  'task_partial_done', 'timer_started', 'timer_paused', 'timer_stopped',
  'project_created', 'project_deleted', 'project_updated',
  'tasks_bulk_created', 'settings_saved', 'data_seeded', 'data_cleared',
  'task_linked', 'task_unlinked', 'dependency_added', 'dependency_removed',
  'link_added', 'tag_added', 'tag_removed',
]);
export type ActivityAction = z.infer<typeof ActivityAction>;

// Transition map
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  not_started: ['in_progress', 'blocked'],
  in_progress: ['paused', 'blocked', 'partial_done', 'done'],
  paused: ['in_progress', 'blocked', 'partial_done', 'done'],
  blocked: ['not_started', 'in_progress'],
  partial_done: ['in_progress', 'done'],
  done: ['in_progress'],
};

// Error codes
export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'VALIDATION_ERROR'
  | 'CYCLE_DETECTED'
  | 'SESSION_ALREADY_ACTIVE'
  | 'NO_ACTIVE_SESSION';

// Link schema (for JSON columns)
export const LinkSchema = z.object({ label: z.string(), url: z.string() });
```

- [ ] **Step 2: Write helpers.ts**

```typescript
import { getDb } from './db.js';
import type { ActivityAction, ErrorCode } from './types.js';

export function logActivity(
  action: ActivityAction,
  title: string,
  options?: { detail?: string; entityType?: string; entityId?: number }
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO activity_logs (action, title, detail, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(action, title, options?.detail ?? null, options?.entityType ?? null, options?.entityId ?? null, new Date().toISOString());
}

export function errorResponse(error: string, code: ErrorCode) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error, code }) }],
  };
}

export function successResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function now(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd mcp-server && npx tsc`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/types.ts mcp-server/src/helpers.ts
git commit -m "feat(mcp): shared types, Zod schemas, and helper utilities"
```

---

### Task 4: Task Tools (8 tools)

**Files:**
- Create: `mcp-server/src/tools/tasks.ts`
- Create: `mcp-server/tests/tasks.test.ts`

- [ ] **Step 1: Write tasks.test.ts**

Test all 8 task tools: create_task, list_tasks, get_task, update_task, update_task_status, delete_task, bulk_create_tasks, search_tasks. Each test uses a fresh in-memory or temp SQLite database.

Tests to cover:
- Create task with minimal params (title only) → returns task with ID, defaults
- Create task with all params → returns task with all fields
- List tasks with no filter → returns all
- List tasks filtered by status → returns matching
- Get task by ID → returns task with total_time and session_count
- Get task with invalid ID → returns NOT_FOUND error
- Update task fields (title, priority, tags) → returns updated task
- Update task status with valid transition → succeeds
- Update task status with invalid transition → returns INVALID_TRANSITION error
- Delete task → removes task and sessions
- Bulk create → returns array of created tasks
- Search → matches title and description substring
- Dependency cycle detection → returns CYCLE_DETECTED error
- Create task with non-existent dependency ID → returns VALIDATION_ERROR
- Create task with invalid project_id → returns NOT_FOUND error

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/tasks.test.ts`
Expected: FAIL — tools module does not exist.

- [ ] **Step 3: Write tools/tasks.ts**

Implements all 8 tools. Each tool:
1. Parses input with Zod
2. Executes SQLite query
3. Logs activity where specified
4. Returns successResponse or errorResponse

Key implementation details:
- `create_task`: Validate project_id exists if provided. Check dependency cycles. JSON.stringify arrays for storage.
- `list_tasks`: Build WHERE clause dynamically from filters. Parse JSON columns in results.
- `get_task`: JOIN with sessions to compute total_time (SUM of durations) and session_count.
- `update_task`: Diff old vs new dependencies/tags/links to log granular actions.
- `update_task_status`: Check VALID_TRANSITIONS map before updating.
- `delete_task`: Just delete — FK CASCADE handles sessions.
- `bulk_create_tasks`: Wrap in transaction for atomicity.
- `search_tasks`: Use `WHERE title LIKE ? OR description LIKE ?` with `%query%`.

Cycle detection: Given a task ID and proposed dependencies, build adjacency list from all tasks' dependencies and run DFS to check for back-edges.

Each tool exports a registration function that takes the MCP `Server` instance and calls `server.tool()`.

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && npx vitest run tests/tasks.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/tasks.ts mcp-server/tests/tasks.test.ts
git commit -m "feat(mcp): task tools — create, list, get, update, delete, bulk, search"
```

---

### Task 5: Project Tools (5 tools)

**Files:**
- Create: `mcp-server/src/tools/projects.ts`
- Create: `mcp-server/tests/projects.test.ts`

- [ ] **Step 1: Write projects.test.ts**

Tests to cover:
- Create project with name only → defaults color, type
- Create project with all params
- List projects → includes task_count per project
- Get project by ID → includes project's tasks
- Get project invalid ID → NOT_FOUND
- Update project fields
- Delete project → tasks get project_id set to NULL

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/projects.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write tools/projects.ts**

Key details:
- `list_projects`: Use `LEFT JOIN tasks ON tasks.project_id = projects.id GROUP BY projects.id` to get task_count.
- `get_project`: Fetch project + all its tasks in a second query.
- `delete_project`: FK `ON DELETE SET NULL` handles unlinking. Just delete and log.

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && npx vitest run tests/projects.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/projects.ts mcp-server/tests/projects.test.ts
git commit -m "feat(mcp): project tools — create, list, get, update, delete"
```

---

### Task 6: Timer + Sessions Tools (4 tools)

**Files:**
- Create: `mcp-server/src/tools/timer.ts`
- Create: `mcp-server/tests/timer.test.ts`

- [ ] **Step 1: Write timer.test.ts**

Tests to cover:
- Start timer on not_started task → creates session, sets task to in_progress
- Start timer on paused task → creates session, sets task to in_progress
- Start timer on task with active session → SESSION_ALREADY_ACTIVE error
- Start timer on done task → INVALID_TRANSITION error
- Pause timer → closes session, sets task to paused
- Pause with no active session → NO_ACTIVE_SESSION error
- Stop timer with done → closes session, sets task to done
- Stop timer with partial_done → sets task to partial_done
- Stop timer with blocked → sets task to blocked
- List sessions → returns all sessions
- List sessions by task_id → filters correctly
- List sessions by date range → filters correctly
- Session duration computed correctly

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/timer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write tools/timer.ts**

Key details:
- `start_timer`: Check for open session (WHERE task_id = ? AND end IS NULL). Check task status allows transition to in_progress. Create session with start = now(). Update task status.
- `pause_timer`: Find open session, set end = now(). Compute duration. Update task status to paused.
- `stop_timer`: Same as pause but sets final_status (done | partial_done | blocked).
- `list_sessions`: Query sessions with optional task_id and date range filters. Compute duration for each (end - start, or now - start if end is null).

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && npx vitest run tests/timer.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/timer.ts mcp-server/tests/timer.test.ts
git commit -m "feat(mcp): timer tools — start, pause, stop, list_sessions"
```

---

### Task 7: Analytics Tools (2 tools)

**Files:**
- Create: `mcp-server/src/tools/analytics.ts`
- Create: `mcp-server/tests/analytics.test.ts`

- [ ] **Step 1: Write analytics.test.ts**

Tests to cover:
- get_analytics with no data → zeros
- get_analytics with tasks and sessions → correct totals
- get_analytics with date range → filters sessions
- get_timeline grouped by day → correct buckets
- get_timeline grouped by week → correct buckets
- time_per_project computed correctly

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/analytics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write tools/analytics.ts**

Key details:
- `get_analytics`: Query task counts by status. SUM session durations (with optional date filter). GROUP BY project_id for time_per_project.
- `get_timeline`: Query sessions, group by date (strftime('%Y-%m-%d')) or week (strftime('%Y-W%W')), SUM durations per bucket.

Duration calculation: `(julianday(COALESCE(end, datetime('now'))) - julianday(start)) * 86400000` for milliseconds.

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && npx vitest run tests/analytics.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/analytics.ts mcp-server/tests/analytics.test.ts
git commit -m "feat(mcp): analytics tools — get_analytics, get_timeline"
```

---

### Task 8: Activity Log, Notifications, Settings Tools (8 tools)

**Files:**
- Create: `mcp-server/src/tools/activity.ts`
- Create: `mcp-server/src/tools/notifications.ts`
- Create: `mcp-server/src/tools/settings.ts`
- Create: `mcp-server/tests/activity.test.ts`
- Create: `mcp-server/tests/notifications.test.ts`
- Create: `mcp-server/tests/settings.test.ts`

- [ ] **Step 1: Write tests for all three modules**

Activity tests: get_activity_log returns entries, filter by action, filter by entity_type, clear_activity_log empties table.

Notification tests: list_notifications returns entries, unread_only filter, mark_notification_read, mark_all_notifications_read, clear_notifications.

Settings tests: get_setting returns default when unset, update_setting writes value, get_setting reads it back, update_setting logs activity.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && npx vitest run tests/activity.test.ts tests/notifications.test.ts tests/settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write all three tool modules**

These are straightforward CRUD. Key details:
- `activity.ts`: get_activity_log builds WHERE from optional filters, ORDER BY created_at DESC, LIMIT.
- `notifications.ts`: list_notifications filters by read=0 if unread_only. mark_all uses UPDATE WHERE read=0.
- `settings.ts`: get_setting returns default from a DEFAULT_SETTINGS map if key not in DB. update_setting uses INSERT OR REPLACE.

- [ ] **Step 4: Run tests**

Run: `cd mcp-server && npx vitest run tests/activity.test.ts tests/notifications.test.ts tests/settings.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/activity.ts mcp-server/src/tools/notifications.ts mcp-server/src/tools/settings.ts mcp-server/tests/activity.test.ts mcp-server/tests/notifications.test.ts mcp-server/tests/settings.test.ts
git commit -m "feat(mcp): activity log, notifications, and settings tools"
```

---

### Task 9: Server Entry Point + Integration

**Files:**
- Modify: `mcp-server/src/index.ts`
- Create: `mcp-server/tests/integration.test.ts`

- [ ] **Step 1: Write integration test**

Test that the server registers all 27 tools by instantiating the server and checking tool count. Also test a full workflow: create project → create task → start timer → pause → stop → get analytics.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx vitest run tests/integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write index.ts**

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTimerTools } from './tools/timer.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerActivityTools } from './tools/activity.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerSettingsTools } from './tools/settings.js';

const server = new McpServer({
  name: 'taskflow',
  version: '1.0.0',
});

// Register all tool domains
registerTaskTools(server);
registerProjectTools(server);
registerTimerTools(server);
registerAnalyticsTools(server);
registerActivityTools(server);
registerNotificationTools(server);
registerSettingsTools(server);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Run integration test**

Run: `cd mcp-server && npx vitest run tests/integration.test.ts`
Expected: All PASS.

- [ ] **Step 5: Build and verify**

Run: `cd mcp-server && npm run build`
Expected: `dist/` created with all JS files, no errors.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/index.ts mcp-server/tests/integration.test.ts
git commit -m "feat(mcp): server entry point — registers all 27 tools, stdio transport"
```

---

### Task 10: Documentation + Final Push

**Files:**
- Modify: `README.md` (root)
- Modify: `mcp-server/package.json` (if needed)

- [ ] **Step 1: Add MCP server section to root README**

Add after the "Desktop App (Tauri)" section:

```markdown
### MCP Server (AI Agent Tools)

The MCP server exposes TaskFlow as 27 tools for Claude Code and other AI agents.

\```bash
cd mcp-server && npm install && npm run build
\```

Add to your Claude Code settings (`.claude/settings.json`):

\```json
{
  "mcpServers": {
    "taskflow": {
      "command": "node",
      "args": ["<path-to-repo>/mcp-server/dist/index.js"]
    }
  }
}
\```

Data stored at `~/.taskflow/taskflow.db`. Override with `TASKFLOW_DB_PATH` env var.
```

- [ ] **Step 2: Run all tests one final time**

Run: `cd mcp-server && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 3: Build**

Run: `cd mcp-server && npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "feat(mcp): TaskFlow MCP server — 27 tools for AI agent task management"
git push
```
