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
import {
  detectTmuxPane,
  notifyPane,
  runTmuxMirror,
  sendKeySequence,
  startMirrorLoop,
} from "./tmux.js";
import {
  formatIncoming,
  shouldDeliver,
  startAgentEventStream,
} from "./events.js";
import { TaskflowClient } from "./client.js";
import { startMirrorWithRetry } from "./mirror.js";
import { runMint } from "./mint.js";
import { resolveMessage, type MessageSource, type ResolvedMessage } from "./resolve.js";
import { keystrokesForPrompt } from "./prompts.js";
import { loadProfile } from "./config.js";
import { hostname } from "node:os";

const USAGE = `taskflow-v2-mcp — TaskFlow v2 MCP server

  taskflow-v2-mcp                 Serve over stdio (how an MCP client runs it).
  taskflow-v2-mcp --check         Verify config + backend auth, then exit.
  taskflow-v2-mcp --tmux [target] Mirror a tmux pane into the dashboard terminal.
  taskflow-v2-mcp --mint <name>   Create a NEW agent identity + profile, then exit.
  taskflow-v2-mcp --help          This message.

GIVING A SECOND TERMINAL ITS OWN IDENTITY. An agent is identified by
project + profile, so two terminals sharing the default \`main\` profile are ONE
agent: one row in the dashboard, one DM inbox, one shared read cursor. --mint
creates a separate identity and writes it to .taskflow.json:

  taskflow-v2-mcp --mint bear --display-name "Claude (bear)"
  export TASKFLOW_PROFILE=bear     # then start that terminal's agent

It needs YOUR user token (--token, or TASKFLOW_USER_TOKEN), not an agent key:
linking an agent is human-authorized and records who vouched for it, which is
why this is a command you run and not a tool the agent can call. An existing
profile is never overwritten and \`default_profile\` never moves, so terminals
already running keep the identity they have.

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
  // --mint is a human-facing command for the same reason it is not an MCP tool:
  // `POST /agents/link` is RequireAuth-gated, so it needs a USER token that the
  // agent does not have. Prints and exits; never opens the MCP transport.
  if (argv.includes("--mint")) {
    try {
      for (const line of await runMint(argv)) process.stdout.write(`${line}\n`);
      process.exit(0);
    } catch (err) {
      // A MintError is a message written for the operator; anything else is a
      // surprise and keeps its own text.
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
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
 * Adapt the client to {@link MessageSource}.
 *
 * `MessagesPage.messages` is `unknown[]` — the client deliberately does not
 * model every row shape — so the narrowing happens here, once, at the boundary
 * rather than inside the resolver.
 */
function messageSourceFor(client: TaskflowClient): MessageSource {
  return {
    listChannels: () => client.listChannels(),
    listMessages: (params) =>
      client.listMessages(params) as Promise<{ messages: ResolvedMessage[] }>,
  };
}

/**
 * Register a session for this process and stream its pane into the dashboard.
 * Never throws into the MCP transport: a mirror is a nice-to-have, and must not
 * be able to take the tool server down with it.
 *
 * Retried with backoff. Setup calls `registerSession`, so a backend that is
 * still booting when the MCP spawns used to kill mirroring for the whole life
 * of the process — one caught error, one stderr line nobody reads, and a
 * permanently stale terminal. Restarting the backend and reconnecting the MCP
 * together is the normal way to pick up a change, which is exactly when that
 * race happens.
 */
async function startMirrorForThisAgent(): Promise<void> {
  await startMirrorWithRetry({
    detectPane: detectTmuxPane,
    log: (line) => process.stderr.write(`taskflow-v2-mcp: ${line}\n`),
    start: async (pane) => {
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
      process.stderr.write(`taskflow-v2-mcp: mirroring tmux pane ${pane}\n`);

      // Instant delivery: hold the event stream open and write each incoming
      // message straight into the pane. Polling would make a message as slow to
      // arrive as the capture interval, which is what "messages don't appear in
      // the terminal" actually was.
      const events = startAgentEventStream({
        server: profile.server,
        key: profile.key,
        log: (line) => process.stderr.write(`taskflow-v2-mcp: ${line}\n`),
        // A human answered a question the agent is blocked on: press the keys.
        onPromptAnswered: async (prompt) => {
          // A prompt may carry SEVERAL questions, each with its own kind, and
          // the terminal shows them one at a time. keystrokesForPrompt replays
          // them in order and returns nothing at all for a half-answered set —
          // leftover digits would land on whichever screen came next.
          const keys = keystrokesForPrompt(
            prompt.options_json ?? "",
            prompt.kind,
            prompt.question,
            prompt.answer_json,
            prompt.answer,
            prompt.status === "cancelled" ? "cancel" : "submit",
          );
          if (!keys.length) return;
          try {
            // Paced, not a tight loop: Claude Code's multi-select drops
            // keystrokes that arrive while it is re-rendering a toggle.
            await sendKeySequence(keys, pane);
            process.stderr.write(
              `taskflow-v2-mcp: answered prompt ${prompt.id} with [${keys.join(", ")}]\n`,
            );
          } catch (err) {
            process.stderr.write(
              `taskflow-v2-mcp: could not answer prompt ${prompt.id} (${(err as Error).message.split("\n")[0]})\n`,
            );
          }
        },
        onMessage: async (event) => {
          try {
            // The event carries the row id and NOTHING else — chat is id-only on
            // the wire because its group is per-project while its rows are
            // channel-scoped (see resolve.ts). So the body, the sender and the
            // attachments are all fetched back over the authorized read API,
            // which re-checks the roster. A message this agent cannot see
            // resolves to null and is silently skipped, which is the point.
            const message = await resolveMessage(messageSourceFor(client), event.id);
            if (!message) return;
            // Only knowable AFTER resolving: the wire no longer says who sent it.
            // Echoing the agent's own message back into its prompt reads as a
            // fresh instruction — a loop against itself.
            if (!shouldDeliver(message, profile.agentId)) return;
            // Submitted, not just typed: the point is for the agent to READ it.
            await notifyPane(formatIncoming(message, message.attachments ?? []), pane, true);
            // The agent has now been handed the message, so advance its cursor —
            // otherwise check_messages would hand it the same one again.
            await client.markRead(message.channel, message.id);
          } catch (err) {
            process.stderr.write(
              `taskflow-v2-mcp: could not deliver message ${event.id} (${(err as Error).message.split("\n")[0]})\n`,
            );
          }
        },
      });

      startMirrorLoop({
        client,
        session: session.id,
        target: pane,
        log: (line) => process.stderr.write(`taskflow-v2-mcp: ${line}\n`),
        // The mirror talks to the backend every couple of seconds, so it notices a
        // restart long before the stream's idle watchdog would. Hand that over
        // rather than making the stream wait for silence to accumulate.
        onError: (err) => {
          if (/network error|fetch failed|ECONNREFUSED/i.test(err.message)) {
            events.reconnectNow();
          }
        },
      });
    },
  });
}

main().catch((err) => {
  process.stderr.write(`taskflow-v2-mcp: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
