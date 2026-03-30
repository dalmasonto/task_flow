# Agent Inbox — Terminal Injection Setup

## What this does

When you respond to an agent question from the TaskFlow UI, the response is injected directly into the agent's terminal. The agent continues without you touching the terminal.

## Requirement: TIOCSTI

The injection uses Linux's `TIOCSTI` ioctl to write characters into a terminal's input queue. This was disabled by default in kernel 6.2+ as a defense against container escape attacks.

**This is safe on a desktop/laptop dev machine.** The security concern only applies to multi-tenant container environments.

## Enable

```bash
sudo sysctl -w dev.tty.legacy_tiocsti=1
```

This lasts until reboot.

To make it persist across reboots:

```bash
echo 'dev.tty.legacy_tiocsti=1' | sudo tee /etc/sysctl.d/99-tiocsti.conf
sudo sysctl --system
```

## Disable

Temporary (until reboot):

```bash
sudo sysctl -w dev.tty.legacy_tiocsti=0
```

Permanent:

```bash
sudo rm /etc/sysctl.d/99-tiocsti.conf
sudo sysctl -w dev.tty.legacy_tiocsti=0
```

## How it works

1. Agent calls `ask_user` → MCP server stores the question + `agent_pid` (Claude Code's PID)
2. User responds from the TaskFlow UI
3. HTTP handler reads `agent_pid`, resolves the PTY (`/dev/pts/N`) from `/proc/<pid>/fd/0`
4. Uses `TIOCSTI` ioctl to inject each character into the PTY input queue
5. Claude Code receives the text as if it was typed on the keyboard

No window focus required. Works while you're in any app.
