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

const USAGE = `taskflow-v2-mcp — TaskFlow v2 MCP server

  taskflow-v2-mcp            Serve over stdio (how an MCP client runs it).
  taskflow-v2-mcp --check    Verify config + backend auth, then exit.
  taskflow-v2-mcp --help     This message.

The MCP tools (whoami, create_task, ...) are called by the MODEL through an MCP
client, not typed as commands. To check the setup yourself, use --check.`;

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
