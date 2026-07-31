# TaskFlow MCP Server

A local-first task and time tracking system exposed as [MCP](https://modelcontextprotocol.io) tools. Any MCP-compatible AI agent can manage projects, tasks, timers, analytics, and notifications through this server.

## Quickstart

### 1. Install and build

```bash
cd mcp-server
npm install
npm run build
```

### 2. Configure your MCP client

Add a `.mcp.json` file to your project root (or wherever your MCP client reads config):

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

Replace the path with the absolute path to your built `dist/index.js`.

### 3. Auto-allow permissions (Claude Code)

By default, Claude Code will prompt you to approve each MCP tool call. To allow all TaskFlow tools without prompts, add this to `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__taskflow__*"
    ]
  },
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": [
    "taskflow"
  ]
}
```

The `mcp__taskflow__*` wildcard matches every tool exposed by this server.

For other MCP clients (Cursor, Windsurf, etc.), check their docs for permission/auto-approve configuration.

## Agent Integration Guide

### How agents discover TaskFlow

TaskFlow uses two layers to guide agent behavior:

**Layer 1: Tool descriptions (passive discovery)**
Every tool has a description that hints at when and why to use it. MCP clients surface these descriptions when the agent connects, so the agent learns the workflow organically. For example, `start_timer` says "Call this before beginning work on any task to track focused time."

**Layer 2: `get_agent_instructions` tool (active onboarding)**
This is the key tool. Its description says **"Call this at the start of every conversation."** When called, it returns:

- A role description for the agent
- A startup checklist (list projects, check in-progress tasks, check notifications)
- Behavioral rules (when to start/stop timers, how to handle blockers, etc.)
- Live context (current project count, in-progress tasks, blocked tasks, unread notifications)
- The full task status workflow with valid transitions

Any well-behaved agent will call this tool when it sees the description, without needing explicit user instructions.

### Making it automatic (recommended)

For the most reliable experience, add one line to your project's `CLAUDE.md` (or equivalent agent config):

```markdown
## MCP Integration
At the start of each conversation, call the `get_agent_instructions` tool from the taskflow MCP server to understand your task management workflow.
```

This guarantees the agent calls the instruction tool on every conversation start. Without this, the agent will still likely discover the tool via its description, but the CLAUDE.md line makes it deterministic.

### Example conversation flow

Here's what a conversation looks like when the agent is properly connected:

```
Agent connects → sees get_agent_instructions in tool list → calls it
  ↓
Gets instructions + live context (3 projects, 2 tasks in progress, 1 blocked)
  ↓
Calls list_tasks(status="in_progress") → sees "Build dashboard page" is active
  ↓
User: "Let's work on the dashboard"
  ↓
Agent: calls get_task(id=5) → reads description for implementation details
Agent: calls start_timer(task_id=5) → time tracking begins
  ↓
Agent implements the feature, referencing task description for acceptance criteria
  ↓
Agent: calls stop_timer(task_id=5, final_status="done")
Agent: checks if any blocked tasks depended on task 5
```

### Strategies for proactive agent behavior

The `get_agent_instructions` tool tells agents to:

1. **Check tasks before coding** — before starting work, search for a matching task and start its timer
2. **Track time automatically** — start_timer when beginning work, pause_timer on context switches, stop_timer when done
3. **Surface blockers** — if stuck, update the task to "blocked" with context in the description
4. **Suggest next work** — when the user asks "what should I work on?", surface high-priority unblocked tasks
5. **Stay in sync** — create tasks for new work items to keep the tracker up to date
6. **Read descriptions** — task descriptions contain implementation details and acceptance criteria

## Agent Inbox — Remote Communication

The Agent Inbox lets agents ask questions that appear in the TaskFlow UI. Users can respond from any device (phone, browser, another machine), and the response is delivered back to the agent's terminal automatically.

### How it works

1. Agent calls `ask_user` with a question, context, and optional quick-tap choices
2. Question appears instantly in the TaskFlow UI at `/inbox`
3. User responds from the UI — response is injected into the agent's terminal via tmux
4. Agent also asks in the terminal normally, so the user can answer from either place

### Setup for auto-injection

For responses to be injected directly into the terminal, run Claude Code inside tmux:

```bash
# Install tmux (one-time)
sudo apt-get install -y tmux

# Start a tmux session and run claude inside it
tmux new -s agent
claude
```

Without tmux, the inbox still works — agents can use `check_response` to poll for answers, or the user can dismiss questions answered in the terminal.

See [Terminal Injection Setup](../docs/agent-inbox-terminal-injection.md) for full details, multiple agent setup, and cleanup instructions.

## Available Tools

### Agent
| Tool | Description |
|------|-------------|
| `get_agent_instructions` | Returns onboarding instructions and live context for AI agents. **Call first.** |

### Tasks
| Tool | Description |
|------|-------------|
| `create_task` | Create a task with dependencies, tags, links, and time estimates |
| `list_tasks` | List tasks with filters (status, project, priority, tag) |
| `get_task` | Get a task by ID with time tracking info |
| `update_task` | Update task fields |
| `update_task_status` | Change status with transition validation |
| `delete_task` | Delete a task by ID |
| `bulk_create_tasks` | Create multiple tasks in a single transaction |
| `search_tasks` | Full-text search by title or description |

### Projects
| Tool | Description |
|------|-------------|
| `create_project` | Create a project (active_project or project_idea) |
| `list_projects` | List all projects with task counts |
| `get_project` | Get a project with all its tasks |
| `update_project` | Update project fields |
| `delete_project` | Delete a project (tasks are unlinked, not deleted) |

### Timer
| Tool | Description |
|------|-------------|
| `start_timer` | Start a timer session (task transitions to in_progress) |
| `pause_timer` | Pause the active session (task transitions to paused) |
| `stop_timer` | Stop timer with final status (done/partial_done/blocked) |
| `list_sessions` | List sessions with optional date range filter |

### Analytics
| Tool | Description |
|------|-------------|
| `get_analytics` | Summary: focused time, completion rates, status distribution, time per project |
| `get_timeline` | Focused time grouped by day or week |

### Activity
| Tool | Description |
|------|-------------|
| `get_activity_log` | Recent activity: completions, timer events, status changes |
| `clear_activity_log` | Delete all activity log entries |

### Notifications
| Tool | Description |
|------|-------------|
| `list_notifications` | List notifications (filter by unread) |
| `mark_notification_read` | Mark a single notification as read |
| `mark_all_notifications_read` | Mark all as read |
| `clear_notifications` | Delete all notifications |

### Agent Inbox
| Tool | Description |
|------|-------------|
| `ask_user` | Post a question to the Agent Inbox for remote response. Returns immediately with message ID |
| `check_response` | Check if the user has responded to a previously posted question |

### Settings
| Tool | Description |
|------|-------------|
| `get_setting` | Get a setting by key (returns default if not set) |
| `update_setting` | Update or create a setting |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `TASKFLOW_SSE_PORT` | `3456` | Port for the SSE broadcast server |
| Database location | `~/.taskflow/taskflow.db` | SQLite database with WAL mode |

The SSE server at `http://localhost:3456/events` broadcasts real-time changes to connected UI clients. The `/sync` endpoint returns a full data dump for initial sync.
