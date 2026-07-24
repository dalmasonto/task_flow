/**
 * Remember which profile a given TERMINAL chose, so the human is asked once per
 * terminal rather than once per MCP reconnect.
 *
 * The store lives beside `.taskflow.json` (never in the cwd — an agent may be
 * launched from a subdirectory) in `.taskflow/sessions.json`, whose directory
 * is already fully gitignored.
 *
 * Every operation is best-effort. A read-only checkout or a corrupt file costs
 * stickiness — the human is asked again — and must never fail the connect.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How long a remembered pick stays good. Bounds the file across pane churn. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface TerminalKeyOptions {
  /** The tmux pane id, when running under tmux. */
  pane?: string | null;
  /** Working directory; only used outside tmux. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Parent pid — the MCP client. Only used outside tmux. Defaults to `process.ppid`. */
  ppid?: number;
}

export interface StickyOptions extends TerminalKeyOptions {
  /** Absolute path of the `.taskflow.json` this store belongs to. */
  configPath: string;
  /** Injected clock for tests. */
  now?: number;
}

interface StoreShape {
  terminals: Record<string, { profile: string; chosen_at: string }>;
}

/**
 * Identify THIS terminal.
 *
 * Mirrors `defaultSessionIdentifier`'s preference: a tmux pane is the most
 * stable handle there is. Outside tmux we fall back to the working directory
 * plus the PARENT pid — the MCP client (Claude Code), which lives as long as
 * the conversation does, unlike this server's own pid.
 */
export function terminalKey(options: TerminalKeyOptions = {}): string {
  if (options.pane) return `tmux:${options.pane}`;
  const cwd = options.cwd ?? process.cwd();
  const ppid = options.ppid ?? process.ppid;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 6);
  return `cwd:${hash}:${ppid}`;
}

function storePath(configPath: string): string {
  return join(dirname(configPath), ".taskflow", "sessions.json");
}

function readStore(configPath: string): StoreShape {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(configPath), "utf8"));
    const terminals = (parsed as StoreShape | null)?.terminals;
    if (terminals && typeof terminals === "object") return { terminals };
  } catch {
    // Missing or corrupt — an empty store is the right answer either way.
  }
  return { terminals: {} };
}

/** The profile this terminal chose last, or undefined if there is none/it expired. */
export function readStickyProfile(options: StickyOptions): string | undefined {
  const now = options.now ?? Date.now();
  const entry = readStore(options.configPath).terminals[terminalKey(options)];
  if (!entry) return undefined;
  const chosenAt = Date.parse(entry.chosen_at);
  if (Number.isNaN(chosenAt) || now - chosenAt > RETENTION_MS) return undefined;
  return entry.profile;
}

/** Remember this terminal's pick, pruning anything past the retention window. */
export function writeStickyProfile(profile: string, options: StickyOptions): void {
  const now = options.now ?? Date.now();
  try {
    const store = readStore(options.configPath);
    for (const [key, entry] of Object.entries(store.terminals)) {
      const chosenAt = Date.parse(entry.chosen_at);
      if (Number.isNaN(chosenAt) || now - chosenAt > RETENTION_MS) {
        delete store.terminals[key];
      }
    }
    store.terminals[terminalKey(options)] = {
      profile,
      chosen_at: new Date(now).toISOString(),
    };
    const path = storePath(options.configPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    // Best-effort: losing stickiness is acceptable, failing the connect is not.
  }
}
