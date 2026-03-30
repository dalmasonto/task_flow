# Agent Inbox — Terminal Injection Setup

## What this does

When you respond to an agent question from the TaskFlow UI, the response is injected directly into the agent's terminal. The agent continues without you touching the terminal — you can respond from your phone, another machine, or while in any app.

## Requirements

- **tmux** — terminal multiplexer (used for input injection)
- Claude Code running inside a tmux session

## Install

```bash
sudo apt-get install -y tmux
```

## Usage

Start Claude Code inside a tmux session:

```bash
# Create a named tmux session and run claude inside it
tmux new -s agent
claude
```

That's it. When you respond to an inbox question from the UI, the MCP server detects the tmux pane and injects the response automatically.

### VS Code Integration

You can run tmux inside VS Code's integrated terminal:

1. Open a terminal in VS Code
2. Run `tmux new -s agent`
3. Run `claude` inside the tmux session

### Multiple agents

Each Claude Code session should run in its own tmux session:

```bash
# Terminal 1
tmux new -s agent1

# Terminal 2
tmux new -s agent2
```

The MCP server auto-detects which tmux pane each agent is in via its PID.

### Detach and reattach

You can detach from a tmux session (`Ctrl+B` then `D`) and reattach later:

```bash
# List sessions
tmux ls

# Reattach
tmux attach -t agent
```

## How it works

1. Agent calls `ask_user` → MCP server stores the question + `agent_pid` (Claude Code's PID)
2. On startup, MCP server detects the tmux pane matching the agent's PTY
3. User responds from the TaskFlow UI (phone, browser, any device)
4. MCP server's background poller (every 3s) finds the answered message
5. Runs `tmux send-keys -t <pane> "response text" Enter`
6. Claude Code receives the text as if you typed it

No window focus needed. No kernel hacks. Works while you're in any app.

## Without tmux

If Claude Code is NOT running inside tmux, terminal injection is disabled. The inbox still works — you just need to manually tell the agent to `check_response` or dismiss the question from the UI.

## Cleanup / Uninstall

### Disable terminal injection

Simply don't run Claude Code inside tmux. The injection only activates when a tmux pane is detected.

### Uninstall tmux

```bash
sudo apt-get remove tmux
```

### Uninstall xdotool (if installed during earlier testing)

`xdotool` was tested during development but is NOT required. You can safely remove it:

```bash
sudo apt-get remove xdotool
```

### Disable TIOCSTI (if enabled during earlier testing)

TIOCSTI was tested but is NOT required for the tmux approach. If you enabled it, disable it:

```bash
# Temporary (resets on reboot anyway)
sudo sysctl -w dev.tty.legacy_tiocsti=0

# If you made it persistent, remove the config
sudo rm -f /etc/sysctl.d/99-tiocsti.conf
```

Check current status:

```bash
cat /proc/sys/dev/tty/legacy_tiocsti
# 0 = disabled (default, safe)
# 1 = enabled (not needed)
```
