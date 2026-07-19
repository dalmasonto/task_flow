#!/usr/bin/env node
/**
 * Bin entry: load `.taskflow.json`, build the MCP server, and serve over stdio.
 *
 * A configuration failure prints a clear message to stderr and exits non-zero so
 * the human fixes the credential file rather than getting a silent dead server.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { ConfigError } from "./config.js";
import { runDoctor } from "./doctor.js";
import { runTmuxMirror } from "./tmux.js";

const USAGE = `taskflow-v2-mcp — TaskFlow v2 MCP server

  taskflow-v2-mcp                 Serve over stdio (how an MCP client runs it).
  taskflow-v2-mcp --check         Verify config + backend auth, then exit.
  taskflow-v2-mcp --tmux [target] Mirror a tmux pane into the dashboard terminal.
  taskflow-v2-mcp --help          This message.

The MCP tools (whoami, create_task, ...) are called by the MODEL through an MCP
client, not typed as commands. To check the setup yourself, use --check.

--tmux runs in the foreground and mirrors the pane until Ctrl-C. Target defaults
to tmux's active pane; pass one from \`tmux list-panes -a\` to pick another, and
--interval=<ms> to change the 2000ms cadence. Options:
  --profile=<name>   Act as a non-default .taskflow.json profile.
  --notify           Type a one-line unread notice INTO the pane when messages
                     arrive. Off by default: this writes to a live session.
  --notify-submit    Also press Enter, so the agent acts on it unprompted.
                     Anyone who can post to a channel can then wake the agent —
                     enable it only for sessions you control.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  // --check is a human-facing diagnostic, so it prints to stdout and exits;
  // it never opens the MCP transport.
  if (argv.includes("--check") || argv.includes("--doctor")) {
    process.exit(await runDoctor());
  }
  const tmuxIndex = argv.indexOf("--tmux");
  if (tmuxIndex !== -1) {
    const flag = (name: string): string | undefined => {
      const hit = argv.find((a) => a.startsWith(`--${name}=`));
      return hit ? hit.slice(name.length + 3) : undefined;
    };
    // The first non-flag argument after --tmux is the pane target.
    const target = argv.slice(tmuxIndex + 1).find((a) => !a.startsWith("--"));
    const interval = flag("interval");
    process.exit(
      await runTmuxMirror({
        target,
        profile: flag("profile"),
        notify: argv.includes("--notify") || argv.includes("--notify-submit"),
        notifySubmit: argv.includes("--notify-submit"),
        ...(interval ? { intervalMs: Number(interval) } : {}),
      }),
    );
  }

  let server;
  try {
    server = buildServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`taskflow-v2-mcp: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr only — stdout is the MCP transport and must stay clean.
  process.stderr.write("taskflow-v2-mcp: connected (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`taskflow-v2-mcp: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
