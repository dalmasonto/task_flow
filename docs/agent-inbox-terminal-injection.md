# Agent Inbox — Terminal Injection Setup

## What this does

When you respond to an agent question from the TaskFlow UI, the response is injected directly into the agent's terminal. The agent continues without you touching the terminal.

## Requirement: tmux

The injection uses `tmux send-keys` to type into the agent's terminal pane. This works from any process, doesn't require window focus, and doesn't interrupt whatever app you're using.

## Install

```bash
sudo apt-get install -y tmux
```

## Usage

Start Claude Code inside a tmux session:

```bash
# Create a named tmux session
tmux new -s agent

# Then run claude inside it
claude
```

That's it. When you respond to a question from the UI, the MCP server detects the tmux pane and injects the response automatically.

### VS Code Integration

You can run tmux inside VS Code's integrated terminal. Just open the terminal and type:

```bash
tmux new -s agent
claude
```

### Multiple agents

Each Claude Code session should run in its own tmux session:

```bash
tmux new -s agent1    # Terminal 1
tmux new -s agent2    # Terminal 2
```

The MCP server auto-detects which tmux pane each agent is in via its PID.

## How it works

1. Agent calls `ask_user` → MCP server stores the question + `agent_pid` (Claude Code's PID)
2. MCP server detects the tmux pane matching the agent's PTY on startup
3. User responds from the TaskFlow UI
4. MCP server's background poller (every 3s) finds the answered message
5. Runs `tmux send-keys -t <pane> "response text" Enter`
6. Claude Code receives the text as if you typed it

No window focus. No PTY hacks. Works while you're in any app.

## Without tmux

If Claude Code is NOT running inside tmux, the terminal injection is disabled. The inbox still works — you just need to manually tell the agent to `check_response` or it picks up the answer next session.

## Disable

Simply don't run Claude Code inside tmux. The injection only activates when a tmux pane is detected.

You can also uninstall tmux:

```bash
sudo apt-get remove tmux
```
