# TaskFlow

A local-first task execution system built for developers who want to track what they're working on, how long it takes, and how tasks relate to each other — all without leaving the browser.

Data stays on your machine via IndexedDB. No accounts, no servers, no sync.

## Features

- **Task Management** — Create, prioritize, and track tasks through a full status lifecycle (not started, in progress, paused, blocked, partial done, done)
- **Timer Sessions** — Start/pause/stop timers on tasks with multiple concurrent sessions supported
- **Projects** — Group tasks under color-coded projects (active projects and project ideas)
- **Dependency Graph** — Visual DAG of task dependencies using ReactFlow + Dagre layout with cycle detection
- **Terminal Interface** — xterm.js-powered command terminal with autocomplete, history, and clickable nav links (Ctrl+K or backtick to open)
- **Analytics** — Daily activity heatmap, focus by day of week, status distribution, time per project, deep work ratio, burndown charts
- **Execution Timeline** — Weekly/monthly session breakdown
- **Activity Pulse** — Real-time audit log of every action taken in the app
- **Bulk Task Creation** — Line-by-line batch import
- **Desktop Notifications** — In-app notification center with configurable alerts
- **Archive** — View completed tasks and reopen them
- **Search** — Global search across tasks and projects from the header
- **Dark/Light Theme** — Persisted toggle with no-flash restore
- **Markdown Descriptions** — Full markdown support for task and project descriptions

## Tech Stack

- **React 19** + TypeScript
- **Vite 8** with React Compiler
- **Dexie.js** — Reactive IndexedDB wrapper (no Redux/Zustand)
- **shadcn/ui** + Tailwind CSS 4 — "Neon Flux" dark theme, Space Grotesk font
- **Recharts** — Analytics charts
- **@xyflow/react** + Dagre — Dependency graph visualization
- **xterm.js** — Terminal emulator
- **react-markdown** + remark-gfm — Markdown rendering
- **Sonner** — Toast notifications
- **Tauri v2** — Desktop app wrapper

## Getting Started

```bash
# Install dependencies
npm install

# Start dev server (browser)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Desktop App (Tauri)

Requires [Rust](https://rustup.rs/) installed.

```bash
# Development — opens native window with hot reload
npm run tauri:dev

# Production build — generates installable binary
npm run tauri:build
```

The first run compiles Rust dependencies and takes a few minutes. Subsequent runs are fast.

### MCP Server (AI Agent Tools)

The MCP server exposes TaskFlow as 28 tools for AI agents via the [Model Context Protocol](https://modelcontextprotocol.io). Any MCP-compatible client (Claude Code, Cursor, Windsurf, etc.) can manage projects, tasks, timers, analytics, and notifications.

#### Option A: Install from npm (recommended)

```bash
npm install -g taskflow-mcp
```

Then register in your `.mcp.json`:

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "taskflow-mcp"
    }
  }
}
```

#### Option B: Build from source

```bash
cd mcp-server
npm install
npm run build
```

Register with the absolute path in `.mcp.json`:

```json
{
  "mcpServers": {
    "taskflow": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

For **Claude Code** specifically, you can also register the server in `.claude/settings.local.json` under `mcpServers`, but `.mcp.json` is the standard cross-client approach.

#### 3. Auto-allow permissions (Claude Code)

By default, Claude Code prompts you to approve each MCP tool call. To allow all TaskFlow tools without prompts, add this to `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__taskflow__*"
    ]
  },
  "enableAllProjectMcpServers": true
}
```

The `mcp__taskflow__*` wildcard matches every tool exposed by the server. For other MCP clients, check their docs for auto-approve configuration.

#### 4. Agent auto-discovery

TaskFlow includes a `get_agent_instructions` tool that returns behavioral rules, a startup checklist, and live project context. Its description tells agents to **call it at the start of every conversation**, so most agents will self-trigger without any user intervention.

For guaranteed auto-discovery, add this to your `CLAUDE.md` (or equivalent agent instructions file):

```markdown
## MCP Integration
At the start of each conversation, call the `get_agent_instructions` tool from the taskflow MCP server to understand your task management workflow.
```

This one line makes the agent:
- Check for in-progress and blocked tasks on startup
- Start/stop timers automatically as it works
- Surface high-priority tasks when you ask "what should I work on?"
- Create tasks for new work to keep the tracker in sync
- Read task descriptions for implementation details and acceptance criteria

See [`mcp-server/README.md`](mcp-server/README.md) for the full agent integration guide and tool reference.

#### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `TASKFLOW_DB_PATH` | `~/.taskflow/taskflow.db` | SQLite database location |
| `TASKFLOW_SSE_PORT` | `3456` | SSE broadcast server port (env var) |
| `--port <number>` | `3456` | SSE port (CLI arg, takes priority over env var) |
| `--http-only` | — | Run HTTP/SSE server only, no MCP stdio transport |

The server port can also be changed from the **Settings** page in the UI (requires restart).

#### Live Sync (SSE)

The MCP server broadcasts changes via Server-Sent Events on `http://0.0.0.0:<port>/events`. The Tauri app connects automatically and mirrors all changes into the UI in real-time.

Available HTTP endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/events` | GET | SSE event stream |
| `/sync` | GET | Full data dump (tasks, projects, sessions, settings) |
| `/api/tasks` | POST | Create a task |
| `/api/tasks/:id` | PATCH | Update a task |
| `/api/tasks/:id` | DELETE | Delete a task |
| `/api/projects/:id` | PATCH | Update a project |
| `/api/projects/:id` | DELETE | Delete a project |
| `/api/sessions` | POST | Create a timer session |
| `/api/sessions/:id` | PATCH | Update a session |
| `/api/clear-data` | POST | Delete all data |
| `/api/broadcast` | POST | Relay an SSE event |

## Terminal Commands

Open with `Ctrl+K` or backtick `` ` ``.

| Command | Description |
|---------|-------------|
| `tasks [--status <s>] [--project <id>]` | List tasks |
| `projects` | List projects |
| `task <id>` | Show task details |
| `project <id>` | Show project details |
| `create task "title" [--project id] [--priority level]` | Create a task |
| `create project "name" [--color #hex] [--type active_project\|project_idea]` | Create a project |
| `start <id>` | Start timer on task |
| `pause <id>` | Pause timer |
| `stop <id> [--done\|--partial]` | Stop timer and set status |
| `status <id> <new_status>` | Change task status |
| `delete task\|project <id>` | Delete entity |
| `link <task_id> --project <id>` | Link task to project |
| `unlink <task_id>` | Unlink from project |
| `nav <path>` | Navigate to a page |
| `clear` | Clear terminal |
| `help` | Show all commands |

## License

MIT
