# TaskFlow Launch Thread

Each tweet is under 280 characters (excluding screenshot/video placeholders).

---

## Tweet 1 — Hook

I built a task manager with a terminal, dependency graphs, and an MCP server that lets AI agents manage your tasks autonomously.

Local-first. No accounts. No cloud.

Fork it, open a PR — I'll review everything.

github.com/dalmasonto/task_flow

🧵

[Screenshot: dashboard overview — dark theme]

---

## Tweet 2 — MCP Server (lead with the new thing)

It ships with an MCP server.

Claude, Cursor, Windsurf — any AI agent can create tasks, start timers, track bugs, and mark work done. 29 tools. One npm install.

npm install -g @dalmasonto/taskflow-mcp

The agent manages your project board while it codes.

[Screenshot: MCP tools in action / task list populated by agent]

---

## Tweet 3 — Video (the demo)

Here's an AI agent implementing a full feature in ~20 minutes — creating tasks, tracking time, debugging, marking done. All reflected live in the UI.

No human touched the task board.

[Video: 20-min MCP agent demo]

---

## Tweet 4 — Live Sync

The MCP server broadcasts every change via SSE.

Agent creates a task in SQLite → SSE event fires → Tauri app updates IndexedDB → UI re-renders instantly.

You watch your task board update in real-time while the agent works.

[Screenshot/GIF: task appearing live in UI]

---

## Tweet 5 — Terminal

It has a full terminal.

Ctrl+K opens a console with autocomplete, command history, and ANSI colors. Create tasks, start timers, navigate — all without touching the mouse.

Try it: task-flow-command.vercel.app

[Screenshot: terminal open with task detail]

---

## Tweet 6 — Debug Logging

When the agent debugs, it leaves breadcrumbs.

The log_debug tool records what it's investigating, what it tried, errors found, hypotheses — all visible in the Activity Pulse with a yellow bug icon.

You can follow its reasoning in real-time.

[Screenshot: activity pulse with debug_log entries]

---

## Tweet 7 — Timer

Multiple concurrent timers.

Work on 3 tasks at once. Pause one, stop another, mark it done. Every session is logged with timestamps.

No "only one active timer" nonsense.

[Screenshot: floating timer bar with sessions]

---

## Tweet 8 — Dependency Graph

Tasks have dependencies. Dependencies have a graph.

Visual DAG with automatic cycle detection — it won't let you create loops. Drag, zoom, see how your work connects.

[Screenshot: dependency graph]

---

## Tweet 9 — Analytics

6 charts tracking how you actually work:

- Activity heatmap
- Focus by day of week
- Status distribution
- Time per project
- Deep work ratio
- Burndown

Not vanity metrics.

[Screenshot: analytics]

---

## Tweet 10 — Agent Rules

The MCP server teaches agents how to behave:

- Check for existing tasks before creating duplicates
- Start timers before coding, stop when done
- Mark blocked tasks when hitting issues
- Check dependencies before starting work
- Log debug breadcrumbs while investigating

All automatic. Zero config.

---

## Tweet 11 — Stack + CTA

The stack:

React 19 + TypeScript
Dexie.js + SQLite (dual storage)
shadcn/ui + Tailwind
xterm.js terminal
ReactFlow dependency graphs
Recharts analytics
Tauri v2 desktop app
MCP server (29 tools)
SSE live sync

npm install -g @dalmasonto/taskflow-mcp
github.com/dalmasonto/task_flow

---

## Tweet 12 — Setup Guide + Agent Swarm

Running multiple agents? You can see what every one of them is doing.

TaskFlow shows live activity from Claude, Cursor, Windsurf — all on one board. Debug logs, task updates, timers. One dashboard for your entire agent swarm.

Setup guide: dalmasonto.github.io/task_flow/

[Screenshot: activity pulse showing multiple agent sessions]

---

## Posting tips

- Lead with tweet 1 + the most striking screenshot (dashboard dark mode)
- Tweet 3 (video) is the anchor — this is what stops the scroll
- Space replies 1-2 minutes apart
- Pin the thread to your profile for a day
- Reply to the previous tweet (not tweet 1) to form a linear thread
- Use the compose thread (+) button to draft all at once before posting


The new tweets added (not in the original thread):

  - Tweet 2 — MCP Server — npm install, 29 tools, agents manage your board while coding
  - Tweet 3 — Video — placeholder for your 20-min agent demo
  - Tweet 4 — Live Sync — SSE broadcast, SQLite→IndexedDB→UI in real-time
  - Tweet 6 — Debug Logging — log_debug breadcrumbs in Activity Pulse
  - Tweet 10 — Agent Rules — dedup, timers, blocked status, dependency checks