#!/bin/sh
# Install the TaskFlow MCP package and run its setup walkthrough.
#
#   curl -fsSL https://raw.githubusercontent.com/dalmasonto/task_flow/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --harness claude --scope user --yes
#   sh scripts/install.sh --harness claude --scope user --yes    # args go to taskflow init
#
# Linux and macOS. On Windows (PowerShell):
#   npm i -g @dalmasonto/taskflow-mcp; taskflow init
#
# Environment:
#   TASKFLOW_PACKAGE   package spec to install (default @dalmasonto/taskflow-mcp)
#   TASKFLOW_SKIP_INIT set to 1 to install only
set -eu

PACKAGE="${TASKFLOW_PACKAGE:-@dalmasonto/taskflow-mcp}"
NODE_MAJOR_MIN=20

say() { printf '%s\n' "$*"; }
die() { printf 'taskflow install: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js ${NODE_MAJOR_MIN}+ is required (https://nodejs.org). Install it, then re-run."
command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt "$NODE_MAJOR_MIN" ]; then
  die "Node.js ${NODE_MAJOR_MIN}+ is required; found $(node --version)."
fi

# A global install into a root-owned prefix needs sudo. We never run sudo
# ourselves — say how to fix it instead.
prefix=$(npm prefix -g)
if [ ! -w "$prefix" ] || { [ -d "$prefix/lib/node_modules" ] && [ ! -w "$prefix/lib/node_modules" ]; }; then
  say "npm's global prefix ($prefix) is not writable by $(id -un)."
  say "Either use a user-owned prefix (recommended):"
  say "  npm config set prefix \"\$HOME/.npm-global\" && export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
  say "or a Node version manager (nvm, fnm, volta), then re-run this script."
  say "(Running 'sudo npm i -g $PACKAGE' also works, but is not recommended.)"
  exit 1
fi

say "Installing $PACKAGE ..."
npm install -g "$PACKAGE"

if ! command -v taskflow >/dev/null 2>&1; then
  say ""
  say "Installed, but 'taskflow' is not on your PATH. Add npm's global bin to PATH:"
  say "  export PATH=\"$prefix/bin:\$PATH\""
  say "then run: taskflow init"
  exit 1
fi

if [ "${TASKFLOW_SKIP_INIT:-0}" = "1" ]; then
  say "Installed. Next: taskflow init"
  exit 0
fi

say ""
# Piped from curl, stdin is the script itself: give the walkthrough the terminal.
if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
  exec taskflow init "$@" </dev/tty
fi
exec taskflow init "$@"
