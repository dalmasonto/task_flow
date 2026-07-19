# taskflow-v2-mcp — TaskFlow MCP server + Claude Code hooks

An **agent client** for the TaskFlow backend. It lets a coding agent (e.g. Claude
Code) connect to your TaskFlow project using a stable, per-repo credential
(`.taskflow.json`) and drive the whole agent API: identity, tasks, chat, reviews,
live sessions, streamed terminal output, and real activity logging.

Unlike the legacy `task_flow/mcp-server` (which inferred identity from cwd + ppid
and kept its own SQLite), this package holds **no state** and **no local DB**. Its
identity is exactly the `key` in `.taskflow.json`, so an agent linked yesterday
keeps the same identity today.

## How it works

- **`.taskflow.json`** (per repo, gitignored) holds the server URL, project id, a
  `default_profile`, and one or more named `profiles`. Each profile has an
  `agent_id`, a `key` (the `tfk_…` credential), and a `display_name`.
- Every backend call sends `Authorization: Agent <key>`. The chosen profile's key
  is the whole identity — the server derives the agent, project, and display name
  from it.
- **Profile selection** (highest priority first): a tool's `profile` argument →
  `TASKFLOW_PROFILE` env → the file's `default_profile` → `"main"`.

## `.taskflow.json` format

```json
{
  "server": "http://localhost:8000",
  "project": 1,
  "default_profile": "main",
  "profiles": {
    "main":     { "agent_id": 12, "key": "tfk_…", "display_name": "Builder" },
    "reviewer": { "agent_id": 13, "key": "tfk_…", "display_name": "Reviewer" }
  }
}
```

Resolution: the file is read from `TASKFLOW_CONFIG` if set, otherwise found by
walking up from the working directory. See `.taskflow.json.example`.

## Setup

1. **Link an agent.** In the TaskFlow dashboard open your project's **API Base**
   page and link an agent (profile `main`, and optionally `reviewer`). It returns
   a block containing the `agent_id`, raw `key`, and `display_name` — shown once.
2. **Create `.taskflow.json`** at your repo root and paste the returned profile
   block(s) under `profiles`. **Do not commit it** (this package's `.gitignore`
   already ignores `.taskflow.json`).
3. **Build the server:**
   ```bash
   cd mcp
   npm install
   npm run build
   ```
4. **Register the MCP server** with Claude Code — copy `.mcp.json.example` to
   `.mcp.json` and adjust the path:
   ```json
   {
     "mcpServers": {
       "taskflow": { "command": "node", "args": ["./mcp/dist/index.js"] }
     }
   }
   ```
   (For dev without a build: `"command": "npx", "args": ["tsx", "./mcp/src/index.ts"]`.)
5. **Add the hooks** (optional but recommended) — copy the entries from
   `.claude/settings.example.json` into your project's `.claude/settings.json`,
   replacing `ABS_PATH` with the absolute path to this `mcp/` directory. The hook
   posts real activity as you work (session start/stop, tool calls) and keeps the
   agent shown "online". It is best-effort and never blocks or crashes the agent.

## MCP tools

| Tool | What it does |
| --- | --- |
| `whoami` | Confirm the agent identity + project behind the credential. |
| `list_tasks(status?, assigned?)` | List project tasks; `assigned='me'` for claimed. |
| `create_task(title, description?, priority?, claim?)` | Create (optionally claim) a task. |
| `update_task_status(task, status)` | Advance a task's status. |
| `claim_task(task)` | Self-assign a task. |
| `report_review(task, decision, body?)` | Record a review (`approved`/`changes_requested`). |
| `list_channels` | Channels this agent can see. |
| `list_agents` | Other agents in the project. |
| `send_message(channel, body, priority?)` | Post a chat message as this agent. |
| `check_messages(channel, since?)` | Read a channel's messages + read cursor. |
| `mark_read(channel, last_read_message)` | Advance this agent's read cursor. |
| `register_session(session_identifier?, cwd?)` | Register/reconnect a live session. |
| `heartbeat(status?)` | Bump session liveness (`idle`/`busy`). |
| `capture_terminal(content, stream?)` | Stream terminal output into the session. |
| `log_activity(action, body?, task?)` | Log a real activity event. |
| `get_activity(task?, limit?)` | Read recent project activity. |

Every tool also accepts an optional `profile` argument to act as a different
profile for that one call (e.g. use `reviewer` for `report_review`).

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm test            # vitest (config resolution unit tests)
```

## Smoke test (against a real backend)

`scripts/smoke.mjs` drives the compiled client against a running backend. It is
env-driven and safe to run anywhere: with no key or no reachable backend it prints
`SKIPPED` and exits 0.

```bash
npm run build
SMOKE_SERVER=http://localhost:8010 SMOKE_KEY=tfk_your_agent_key node scripts/smoke.mjs
# optional: SMOKE_CHANNEL=<id> to force which channel send/check use
```

It exercises: `whoami`, `create_task`, `list_tasks`, `list_channels`,
`send_message`, `check_messages`, `register_session`, `heartbeat`,
`capture_terminal`, `close_session`, `log_activity`, `get_activity` — printing
`PASS`/`FAIL` per call, and exits non-zero only if a call actually failed against a
reachable backend.
