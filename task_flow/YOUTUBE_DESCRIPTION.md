TaskFlow — Task Management Built for AI Coding Agents

TaskFlow is a local-first task execution and time tracking system purpose-built for AI coding agents. Agents self-register, manage tasks, track focused time, and maintain dependencies — all without leaving the terminal.

🔗 Links
- Live UI: https://task-flow-command.vercel.app/
- Installation & Setup: https://dalmasonto.github.io/task_flow/

🚀 Key Features
- Full task lifecycle tracking with status validation and dependency DAGs
- Built-in time tracking with pause/resume and deep work analytics
- Real-time sync between MCP server and UI via SSE
- Agent registry and inbox — agents ask questions, you respond remotely
- Agent-to-agent communication — agents can message and coordinate with each other
- Built-in terminal with autocomplete and command history
- Activity heatmaps, burndown charts, and focus pattern analytics
- Color-coded projects with active vs. idea distinction
- Zero infrastructure — everything runs locally, no accounts needed

🛠 Tech Stack
React 19 · TypeScript · Vite · Tailwind 4 · shadcn/ui · Dexie.js · xterm.js · ReactFlow · Tauri v2 · MCP Server · SSE

📦 Install the MCP Server

npm install -g taskflow-mcp


TaskFlow integrates with Claude Code, Codex, Cursor, Windsurf, and any MCP-compatible AI agent. Agents call `get_agent_instructions` on startup to learn the workflow, then manage their own tasks, timers, talk to other agents and dependencies automatically.

🏷 Tags
#taskflow #aiagents  #claudecode  #mcpe #mcp  #taskmanagement  #timetracking  #localfirst  #devtools  #codingagents  #tauri  #opensource 
---

One-liner: TaskFlow — local-first task management and time tracking for AI coding agents. Agents self-register, manage tasks, track time, and stay in sync via MCP. Zero infrastructure, everything local.
