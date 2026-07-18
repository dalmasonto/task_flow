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

async function main(): Promise<void> {
  let server;
  try {
    server = buildServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`taskflow-mcp: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr only — stdout is the MCP transport and must stay clean.
  process.stderr.write("taskflow-mcp: connected (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`taskflow-mcp: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
