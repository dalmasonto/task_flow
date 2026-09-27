#!/usr/bin/env node
/**
 * The `taskflow` command — the human-facing CLI that ships next to the
 * `taskflow-mcp` server bin. It never serves MCP; harnesses run `taskflow-mcp`.
 *
 *   taskflow init      Post-install walkthrough (also: taskflow-mcp init).
 *   taskflow doctor    Same as taskflow-mcp --doctor.
 *   taskflow mint ...  Same as taskflow-mcp --mint ...
 */

import { createRequire } from "node:module";
import { runInitCommand } from "./init.js";
import { runDoctor } from "./doctor.js";
import { runMint } from "./mint.js";

const USAGE = `taskflow — set up and check TaskFlow for your coding agents

  taskflow init [options]        Connect Claude Code, Codex, Gemini CLI, Cursor or
                                 opencode to TaskFlow (see: taskflow init --help).
  taskflow doctor                Verify .taskflow.json + backend auth.
  taskflow mint <name> [--display-name <s>] [--token <t>]
                                 Create another agent identity in .taskflow.json.
  taskflow --version             Print the package version.

The MCP server itself is the taskflow-mcp command, which your agent runs.`;

function version(): string {
  const require = createRequire(import.meta.url);
  return (require("../package.json") as { version: string }).version;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return runInitCommand(rest);
    case "doctor":
    case "check":
      return runDoctor();
    case "mint":
      for (const line of await runMint(["--mint", ...rest])) process.stdout.write(`${line}\n`);
      return 0;
    case "-v":
    case "--version":
      process.stdout.write(`${version()}\n`);
      return 0;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`taskflow: unknown command "${cmd}"\n\n${USAGE}\n`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`taskflow: ${err.message}\n`);
    process.exit(1);
  },
);
