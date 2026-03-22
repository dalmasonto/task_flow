# TaskFlow Launch Thread

---

## Tweet 1 — Hook

I built a task manager with a built-in terminal, dependency graphs, and a hacker aesthetic because apparently a simple to-do list wasn't dramatic enough.

It's local-first. No accounts. No cloud. Your data never leaves your machine.

Fork it. Break it. Improve it. Open a PR — I'll review everything.

github.com/dalmasonto/task_flow

🧵 Here's what's inside...

[Screenshot: dashboard overview — dark theme, tasks visible]

---

## Tweet 2 — Terminal

It has a full terminal.

Ctrl+K opens an xterm.js console — autocomplete, command history, ANSI colors. Create tasks, start timers, check project stats, navigate the app. All without touching the mouse.

Clickable output too — task/project details show a nav command you can click to jump straight to editing.

Try it yourself: task-flow-command.vercel.app

[Screenshot: terminal open, showing task detail output with clickable nav link]

---

## Tweet 3 — Timer

Multiple concurrent timers.

Start working on 3 tasks at once. Pause one, stop another, mark it done — all from the terminal or the UI. Every session is logged with start/end timestamps.

No "only one active timer" nonsense.

[Screenshot: floating timer bar with active sessions]

---

## Tweet 4 — Dependency Graph

Tasks have dependencies. Dependencies have a graph.

Visual DAG layout with automatic cycle detection — it won't let you create circular dependencies. Drag, zoom, explore how your work connects.

[Screenshot: dependency graph page with connected nodes]

---

## Tweet 5 — Analytics

6 charts tracking how you actually work:

- Daily activity heatmap
- Focus by day of week
- Status distribution
- Time per project
- Deep work ratio
- Burndown

Not vanity metrics. Patterns you can act on.

[Screenshot: analytics page with charts]

---

## Tweet 6 — Activity Pulse

Every action is logged. Task created, timer started, status changed, project linked — it's all in the Activity Pulse.

A full audit trail of your work. Scroll back and see exactly what you did on any given day.

[Screenshot: activity pulse page]

---

## Tweet 7 — Stack + CTA

The stack:

React 19 + TypeScript
Dexie.js (IndexedDB, no Redux)
shadcn/ui + Tailwind
xterm.js terminal
ReactFlow dependency graphs
Recharts analytics
Tauri v2 desktop app

100% local. Works offline. Runs in browser or as a native app.

Star it, fork it, open a PR: github.com/dalmasonto/task_flow

---

## Posting tips

- Post tweet 1 with the most visually striking screenshot (terminal or dashboard in dark mode)
- Space replies 1-2 minutes apart
- Pin the thread to your profile for a day
- Reply to your own tweet 1 with each subsequent tweet to form the thread
