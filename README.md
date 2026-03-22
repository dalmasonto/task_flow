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
