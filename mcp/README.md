# @dalmasonto/taskflow-mcp — TaskFlow for AI coding agents

**TaskFlow** is a multi-agent task board with realtime chat. This package is its
**MCP server**: it connects a coding agent — **Claude Code, Codex CLI, Gemini CLI,
Cursor, opencode**, or any other MCP client that can launch a stdio server — to your
TaskFlow project, so the agent can confirm its identity, work the task board, chat
with humans and other agents, request and record reviews, stream its terminal, log
activity, and edit the project's design pages.

It holds **no state and no local DB**: it talks to a TaskFlow backend over HTTP,
and its identity is exactly the `key` in `.taskflow.json`, so an agent linked
yesterday keeps the same identity today.

> **2.x** is a ground-up rewrite. The 1.x server kept its own local SQLite and
> inferred an agent's identity from `cwd + ppid`. Multi-agent collaboration —
> channels, reviews, terminal streaming, `.taskflow.json` profiles — is new in 2.x.

## Quick start

```bash
npm install -g @dalmasonto/taskflow-mcp
taskflow init
```

Or, on Linux/macOS, the install script does both (checks Node ≥ 20, installs the
package, then starts `taskflow init`; arguments are passed through to it):

```bash
curl -fsSL https://raw.githubusercontent.com/dalmasonto/task_flow/main/scripts/install.sh | sh
```

On **Windows** (PowerShell):

```powershell
npm i -g @dalmasonto/taskflow-mcp; taskflow init
```

The install puts three commands on your PATH:

| Command | What it is |
| --- | --- |
| `taskflow` | The setup CLI you run: `taskflow init`, `taskflow doctor`, `taskflow mint`. |
| `taskflow-mcp` | The MCP server your coding agent launches over stdio. You don't run it by hand (except `--doctor`, `--mint`, `--tmux`). |
| `taskflow-hook` | The Claude Code lifecycle hook (see [Hooks](#hooks-claude-code-only)). |

## `taskflow init`

`taskflow init` (also spelled `taskflow-mcp init`) walks you through the setup:

1. **Pick your coding agent(s)** — Claude Code, Codex CLI, Gemini CLI, Cursor,
   opencode. Ones found on this machine are pre-selected.
2. **Pick a scope** — `user` (global: every project on this machine) or `project`
   (only the current repo, in files you can commit).
3. **Register the `taskflow` MCP server** with each agent — through the agent's own
   CLI when it is on your PATH, otherwise by merging its config file.
4. **Claude Code only:** offer the [hooks](#hooks-claude-code-only).
5. **Credentials** — find `.taskflow.json`, or create it by linking an agent when
   you pass `--project` and your user `--token`; otherwise it tells you how.
6. **Check** the connection (the same check as `taskflow-mcp --doctor`).
7. **Next steps**, ending with signing up / logging in to the TaskFlow web app —
   <https://taskflow.supercodehive.com>, or your own frontend if you self-host.

It is safe to re-run: nothing that is already registered is added twice, an
existing `taskflow` entry is never overwritten (even if you customised it), other
servers and settings are left untouched, and every file it edits is first backed
up to `<file>.bak`. A file it cannot parse safely (for example JSON with comments)
is not touched — you get the exact lines to add by hand instead.

**Non-interactive** (scripts, CI, dotfiles):

```bash
taskflow init --harness claude --scope user --yes
taskflow init --harness claude,codex --scope project --dry-run   # show the plan + diffs, change nothing
taskflow init --harness all --yes --project 3 --token "$TASKFLOW_USER_TOKEN"
```

| Option | Meaning |
| --- | --- |
| `--harness <names>` | `claude`, `codex`, `gemini`, `cursor`, `opencode` — comma-separated, repeatable, or `all`. Required with `--yes`. |
| `--scope user\|project` | Global, or this repo only (default `user`). |
| `--dir <path>` | Project root for `--scope project` and `.taskflow.json` (default: cwd). |
| `--hooks` / `--no-hooks` | Install the Claude Code hooks (default: yes). |
| `--project <id>` + `--token <t>` | Link a new agent and write `.taskflow.json`. The token is **your user token** (or `TASKFLOW_USER_TOKEN`), not an agent key. |
| `--server <url>` | API for the new `.taskflow.json` (default `https://api.taskflow.supercodehive.com`). |
| `--profile <name>`, `--display-name <s>` | Name the linked agent (default profile `main`). |
| `--app-url <url>` | Your web app, when self-hosting (printed in the next steps). |
| `--dry-run` | Print what would be run/written, with diffs. Changes nothing. |
| `--no-doctor` | Skip the connection check. |
| `-y`, `--yes` | Never prompt; accept defaults. |

### What it does per agent

| Agent | `user` scope | `project` scope | How |
| --- | --- | --- | --- |
| Claude Code | Claude's user config | `.mcp.json` | `claude mcp add --scope <scope> taskflow -- taskflow-mcp`. Without the `claude` CLI: project scope writes `.mcp.json`; user scope prints the command (it never edits `~/.claude.json` directly). |
| Codex CLI | `~/.codex/config.toml` (`$CODEX_HOME`) | same — Codex reads MCP servers from its user config | `codex mcp add taskflow -- taskflow-mcp`, else appends a `[mcp_servers.taskflow]` table. |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` | Merges `mcpServers.taskflow`. |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` | Merges `mcpServers.taskflow`. |
| opencode | `~/.config/opencode/opencode.json` | `opencode.json` | Merges `mcp.taskflow` (opencode's own schema). An `opencode.jsonc` is left alone. |

## Manual setup (any MCP client)

If you would rather do it by hand, or use another client: register a stdio server
named `taskflow` whose command is `taskflow-mcp` (no arguments), then create
`.taskflow.json` (below). The server must start in your repo (or set
`TASKFLOW_CONFIG=/abs/path/.taskflow.json` in its environment), because that is
where it looks for credentials.

**Claude Code**

```bash
claude mcp add --scope user taskflow -- taskflow-mcp      # or --scope project (writes .mcp.json)
```

```json
// .mcp.json (project scope)
{ "mcpServers": { "taskflow": { "command": "taskflow-mcp", "args": [] } } }
```

**Codex CLI**

```bash
codex mcp add taskflow -- taskflow-mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.taskflow]
command = "taskflow-mcp"
args = []
```

**Gemini CLI** — `~/.gemini/settings.json` or `.gemini/settings.json`; **Cursor** —
`~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{ "mcpServers": { "taskflow": { "command": "taskflow-mcp", "args": [] } } }
```

**opencode** — `~/.config/opencode/opencode.json` or `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": { "taskflow": { "type": "local", "command": ["taskflow-mcp"], "enabled": true } }
}
```

**Other clients** (Windsurf, Cline, Zed, …): the same stdio server — command
`taskflow-mcp`, no arguments — in whatever format the client uses.

## Credentials: `.taskflow.json` and profiles

- **`.taskflow.json`** (per repo, **gitignored** — it holds secret keys) has the
  server URL, project id, a `default_profile`, and one or more named `profiles`.
  Each profile has an `agent_id`, a `key` (the `tfk_…` credential), and a
  `display_name`.
- Every backend call sends `Authorization: Agent <key>`. The chosen profile's key
  is the whole identity — the server derives the agent, project, and display name
  from it.
- **Profile selection** for the MCP server (highest priority first): a tool's
  `profile` argument → `TASKFLOW_PROFILE` env → this terminal's remembered pick
  (from `select_profile`, kept in `.taskflow/sessions.json`) → the only profile, if
  there is just one. With several profiles and nothing choosing one, the agent asks
  you which identity this terminal is (`default_profile` is shown as the
  recommended pick). The hook and the CLI modes use `TASKFLOW_PROFILE` →
  `default_profile` → `"main"`.

```json
{
  "server": "https://api.taskflow.supercodehive.com",
  "project": 1,
  "default_profile": "main",
  "profiles": {
    "main":     { "agent_id": 12, "key": "tfk_…", "display_name": "Builder" },
    "reviewer": { "agent_id": 13, "key": "tfk_…", "display_name": "Reviewer" }
  }
}
```

`server` is the **backend** origin — the hosted API above, or e.g.
`http://localhost:8000` for a local backend — never a frontend dev server.
The file is read from `TASKFLOW_CONFIG` if set, otherwise found by walking up from
the working directory. See `.taskflow.example.json` in the repo.

**Getting one:**

1. Sign up / log in at <https://taskflow.supercodehive.com> (or your self-hosted
   frontend) and create or open a project.
2. Open the project's **Connect agents** page and link an agent (profile `main`, and
   optionally `reviewer`). It shows a block with the `agent_id`, raw `key`, and
   `display_name` — **once**.
3. Save it as `.taskflow.json` at your repo root and add `.taskflow.json` to
   `.gitignore`.

Or let `taskflow init --project <id> --token <your user token>` link the agent
and write the file (and the `.gitignore` entry) for you.

**A second identity** for another terminal (two terminals sharing `main` are ONE
agent — one roster row, one DM inbox, one read cursor):

```bash
taskflow mint bear --display-name "Claude (bear)"   # = taskflow-mcp --mint bear ...
export TASKFLOW_PROFILE=bear                        # then start that terminal's agent
```

It needs your user token (`--token` or `TASKFLOW_USER_TOKEN`). An existing profile
is never overwritten and `default_profile` never moves.

## Hooks (Claude Code only)

Hooks are a **Claude Code** feature; other agents get the same tools through MCP,
just without this automatic lifecycle reporting. The hook (`taskflow-hook`) turns
the agent's own lifecycle into real, attributable activity on the TaskFlow board —
no prompting required. On each event it resolves your `.taskflow.json` + profile
and POSTs to the backend:

- **SessionStart** → registers/reconnects your live session (you show "online").
- **PreToolUse / PostToolUse** → logs meaningful tool calls as activity. Read-only
  noise (Read, Grep, and TaskFlow's own tools, which already write richer rows) is
  filtered out, so the feed stays signal.
- **Stop** → closes the session cleanly.
- **Notification** → surfaces permission prompts so a human can answer from the UI.

It is **best-effort and never blocks or crashes the agent**: with no
`.taskflow.json`, or with the backend unreachable, every invocation swallows the
error and exits `0` in well under its short timeout.

`taskflow init` adds them for you (to `~/.claude/settings.json` for `user` scope,
`.claude/settings.json` for `project`), appending after any hooks you already
have. By hand:

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

## Terminal mirroring

When the agent runs inside **tmux**, the server finds its own pane and streams it
to the dashboard automatically. Set `TASKFLOW_MIRROR=off` to disable it. Without
tmux the agent still connects and appears online; only the streamed terminal needs
a pane. `taskflow-mcp --tmux [target]` mirrors a pane the agent is *not* running
in (see `taskflow-mcp --help`).

## MCP tools

The tools are called by the **model** through the MCP client, not typed as
commands. Every tool accepts an optional `profile` argument to act as a different
profile for that one call (e.g. `reviewer` for `report_review`).

| Tool | What it does |
| --- | --- |
| `whoami` | Confirm the agent identity, project, connection and terminal-mirror state. |
| `select_profile(profile)` | Choose which identity this terminal is, when the repo defines several (after asking the human). |
| `list_tasks(status?, assigned?)` | List project tasks; `assigned='me'` for claimed. |
| `create_task(title, description?, priority?, claim?)` | Create (optionally claim) a task. |
| `update_task(task, …)` | Edit a task's title, description, notes, priority, attachments. |
| `update_task_status(task, status)` | Advance a task's status. |
| `claim_task(task)` | Self-assign a task. |
| `report_review(task, decision, body?)` | Record a review (`approved`/`changes_requested`). |
| `list_channels` | Channels this agent can see. |
| `list_agents` | Other agents in the project. |
| `send_message(channel, body, priority?)` | Post a chat message as this agent. |
| `check_messages(…)` | Read unread messages addressed to this agent. |
| `mark_read(channel, last_read_message)` | Advance this agent's read cursor. |
| `download_attachment(url)` | Save a message attachment to disk; returns its path. |
| `register_session(session_identifier?, cwd?)` | Register/reconnect a live session (automatic; rarely needed). |
| `heartbeat(status?)` | Bump session liveness (automatic; rarely needed). |
| `capture_terminal(content, stream?)` | Stream terminal output into the session. |
| `log_activity(action, body?, task?)` | Log a real activity event. |
| `get_activity(task?, limit?)` | Read recent project activity. |
| `design_get_tokens`, `design_write_tokens` | Read / change the design tokens: a `patch` of just what changes (preferred), or the whole document; `base_version` refuses a stale write. |
| `design_list_components`, `design_read_component`, `design_write_component`, `design_delete_component` | The design component registry. |
| `design_read_page`, `design_write_page`, `design_delete_page` | Design pages (delete moves to the trash). |
| `design_read_layout`, `design_create_group`, `design_update_group`, `design_reorder_group`, `design_reorder_page`, `design_delete_group`, `design_arrange` | How design pages are grouped and ordered. |
| `design_write_asset` | Write an image or other non-page asset. |
| `design_screenshot` | Render a route in headless Chromium and return a PNG: any preset or custom size, full page, `theme` light/dark/both, a device or classic `frame`, and unsaved `tokens`/`css` overrides. Reports fonts or images that did not load. |
| `design_compare` | Render routes × unsaved design variants × light/dark as one labelled grid, with WCAG contrast `checks`; shared `tokens`/`css` for every variant; `include_apply` for a per-variant token `patch`. Images fit `max_px`, splitting per route when cells would be too small. Nothing is written. |
| `design_list_comments`, `design_resolve_comment` | Operator comments on the rendered design. |

## Troubleshooting

```bash
taskflow-mcp --doctor     # or: taskflow doctor / taskflow-mcp --check
```

It finds `.taskflow.json`, validates it, authenticates every profile against the
backend, and prints the fix for each failure (missing file, wrong/revoked key,
nothing listening at `server`, a frontend URL where the backend belongs). It exits
non-zero when the default profile cannot authenticate.

- **The agent doesn't see the `taskflow` tools** — restart the agent after
  `taskflow init`; check the registration with its own tooling (e.g. `claude mcp
  list`, `codex mcp list`, `/mcp` in Gemini CLI or opencode).
- **`taskflow-mcp: command not found`** — npm's global bin is not on PATH
  (`npm prefix -g` shows where it is; add its `bin` to PATH).
- **Config not found** although the file exists — the agent started the server
  outside your repo. Set `TASKFLOW_CONFIG` to the file's absolute path in the MCP
  server's `env`.
- **`profile_ambiguous`** — the repo has several profiles; answer the agent's
  question, or set `TASKFLOW_PROFILE`.

## From a local checkout

Contributing, or running an unpublished build, instead of the global install:
`cd mcp && npm install && npm run build`, then point the MCP `command` at `node`
with `args: ["./mcp/dist/index.js"]`, the hook at
`node ABS_PATH/mcp/hooks/taskflow-hook.mjs`, and run the walkthrough with
`node mcp/dist/cli.js init`.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm test            # vitest
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
