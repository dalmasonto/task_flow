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
import { detectTmuxPane, runTmuxMirror, startMirrorLoop } from "./tmux.js";
import { TaskflowClient } from "./client.js";
import { loadProfile } from "./config.js";
import { hostname } from "node:os";

const USAGE = `taskflow-v2-mcp — TaskFlow v2 MCP server

  taskflow-v2-mcp                 Serve over stdio (how an MCP client runs it).
  taskflow-v2-mcp --check         Verify config + backend auth, then exit.
  taskflow-v2-mcp --tmux [target] Mirror a tmux pane into the dashboard terminal.
  taskflow-v2-mcp --help          This message.

The MCP tools (whoami, create_task, ...) are called by the MODEL through an MCP
client, not typed as commands. To check the setup yourself, use --check.

TERMINAL MIRRORING IS AUTOMATIC. When the agent runs inside tmux, the server
finds its own pane and streams it to the dashboard — nothing to launch, no pane
id to look up. Set TASKFLOW_MIRROR=off to disable it.

--tmux is only for mirroring a pane the agent is NOT running in (say, watching a
build in another window). It runs in the foreground until Ctrl-C; the target
defaults to tmux's active pane, or pass one from \`tmux list-panes -a\`. Options:
  --interval=<ms>    Capture cadence (default 2000).
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

  // Mirror this agent's terminal automatically. The server is spawned BY the
  // agent, so it can find the pane itself (see detectTmuxPane) — asking a human
  // to run a second command with a pane id they have to look up is not a setup
  // step, it's a thing to forget. Best-effort in every direction: no tmux, no
  // credential, or a backend that is down all degrade to simply not mirroring.
  if (process.env.TASKFLOW_MIRROR !== "off") {
    void startMirrorForThisAgent();
  }
}

/**
 * Register a session for this process and stream its pane into the dashboard.
 * Never throws into the MCP transport: a mirror is a nice-to-have, and must not
 * be able to take the tool server down with it.
 */
async function startMirrorForThisAgent(): Promise<void> {
  try {
    const pane = await detectTmuxPane();
    if (!pane) return; // not in tmux — normal, nothing to mirror
    const profile = loadProfile();
    const client = new TaskflowClient({ server: profile.server, key: profile.key });
    const session = await client.registerSession({
      // Same identifier the tools use, so this is ONE session, not a duplicate.
      session_identifier: `tmux:${hostname()}:${pane}`,
      host: hostname(),
      pid: process.pid,
      cwd: process.cwd(),
      transport: "tmux",
    });
    startMirrorLoop({
      client,
      session: session.id,
      target: pane,
      log: (line) => process.stderr.write(`taskflow-v2-mcp: ${line}\n`),
    });
    process.stderr.write(`taskflow-v2-mcp: mirroring tmux pane ${pane}\n`);
  } catch (err) {
    process.stderr.write(
      `taskflow-v2-mcp: terminal mirror unavailable (${(err as Error).message.split("\n")[0]})\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`taskflow-v2-mcp: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
