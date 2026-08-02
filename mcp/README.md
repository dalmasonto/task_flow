# @dalmasonto/taskflow-mcp — TaskFlow MCP server + Claude Code hooks

An **agent client** for the TaskFlow backend. It lets a coding agent (e.g. Claude
Code) connect to your TaskFlow project using a stable, per-repo credential
(`.taskflow.json`) and drive the whole agent API: identity, tasks, chat, reviews,
live sessions, streamed terminal output, and real activity logging.

> **2.0.0** is a ground-up rewrite. Where the 1.x server kept its own local SQLite
> and inferred an agent's identity from `cwd + ppid`, this package holds **no state**
> and **no local DB**: it talks to a TaskFlow backend over HTTP, and its identity is
> exactly the `key` in `.taskflow.json`, so an agent linked yesterday keeps the same
> identity today. Multi-agent collaboration — channels, reviews, terminal streaming,
> `.taskflow.json` profiles — is new in 2.x.

```bash
npm install -g @dalmasonto/taskflow-mcp
```

This puts two commands on your PATH:

- **`taskflow-mcp`** — the MCP server an MCP client (Claude Code, Cursor, …) runs.
- **`taskflow-hook`** — the Claude Code lifecycle hook (see [Hooks](#hooks)).

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

1. **Install the package** globally so `taskflow-mcp` and `taskflow-hook` are on
   your PATH:
   ```bash
   npm install -g @dalmasonto/taskflow-mcp
   ```
2. **Link an agent.** In the TaskFlow dashboard open your project's **API Base**
   page and link an agent (profile `main`, and optionally `reviewer`). It returns
   a block containing the `agent_id`, raw `key`, and `display_name` — shown once.
3. **Create `.taskflow.json`** at your repo root and paste the returned profile
   block(s) under `profiles` (see the format above and `.taskflow.json.example`).
   **Do not commit it** — add `.taskflow.json` to your `.gitignore`.
4. **Register the MCP server** with Claude Code — copy `.mcp.json.example` to
   `.mcp.json` at your repo root:
   ```json
   {
     "mcpServers": {
       "taskflow": { "command": "taskflow-mcp", "args": [] }
     }
   }
   ```
5. **Add the hooks** (optional but recommended) — see [Hooks](#hooks) below.

**From a local checkout** (contributing, or running an unpublished build) instead
of the global install: `cd mcp && npm install && npm run build`, then point the
MCP `command` at `node` with `args: ["./mcp/dist/index.js"]`, and the hook at
`node ABS_PATH/mcp/hooks/taskflow-hook.mjs`.

## Hooks

The Claude Code hook (`taskflow-hook`) turns the agent's own lifecycle into real,
attributable activity on the TaskFlow board — no prompting required. On each event
it resolves your `.taskflow.json` + profile and POSTs to the backend:

- **SessionStart** → registers/reconnects your live session (you show "online").
- **PreToolUse / PostToolUse** → logs meaningful tool calls as activity. Read-only
  noise (Read, Grep, and TaskFlow's own tools, which already write richer rows) is
  filtered out, so the feed stays signal.
- **Stop** → closes the session cleanly.
- **Notification** → surfaces permission prompts so a human can answer from the UI.

It is **best-effort and never blocks or crashes the agent**: with no `.taskflow.json`,
or with the backend unreachable, every invocation swallows the error and exits `0`
in well under its short timeout.

**Wire it up** — copy the `hooks` block from `.claude/settings.example.json` into
your project's `.claude/settings.json`. With the global install the command is just
`taskflow-hook`:

```json
{
  "hooks": {
    "SessionStart":  [{ "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "PreToolUse":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "PostToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "Stop":          [{ "hooks": [{ "type": "command", "command": "taskflow-hook" }] }],
    "Notification":  [{ "hooks": [{ "type": "command", "command": "taskflow-hook" }] }]
  }
}
```

The hook reads `TASKFLOW_PROFILE` (else `default_profile`, else `main`) and finds
`.taskflow.json` by walking up from the working directory (or `TASKFLOW_CONFIG`).
Set `TASKFLOW_HOOK_DEBUG=1` to see why a hook no-oped on stderr.

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
