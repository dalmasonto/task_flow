/**
 * The identifier that names THIS process's session to the backend.
 *
 * Prefers the tmux pane, so the tools' session and the terminal mirror converge
 * on one row instead of two (register is idempotent per identifier). Falls back
 * to host:pid outside tmux.
 *
 * The IDENTITY — project, agent id and profile name — is part of the identifier
 * because the backend treats an identifier as globally unique and returns 409
 * CONFLICT when the row it names belongs to a different agent
 * (`views.rs:1813`). Every part of the terminal-derived base is shared: the
 * host is one machine, and pane ids are numbered per tmux server, so `%0` is
 * whatever opened first. The profile NAME is not enough on its own — every
 * `.taskflow.json` calls its default profile `main`, so two repos on one
 * machine used to compute the same identifier, and the second agent could
 * never register. Retrying cannot resolve that conflict: neither the stored row
 * nor the caller's identity changes between attempts, so the unbounded retry
 * loop in `connect.ts` spins until the process dies.
 *
 * The AGENT ID is what makes this correct rather than merely unlikely — it is
 * the exact field the backend compares. The config path is hashed in on top so
 * that one agent id configured in two checkouts still gets a row each; without
 * it they collide on a single row (no 409, since the agent matches) and the two
 * terminals fight over one session and one mirror.
 *
 * Do NOT rely on an abandoned row ageing out: a session row keeps
 * `status=connected` indefinitely, so a stale identifier blocks a different
 * agent for as long as the row exists.
 */

import { createHash } from "node:crypto";
import { hostname } from "node:os";

export interface SessionIdentifierOptions {
  /** The tmux pane id, when running under tmux. */
  pane?: string | null;
  /** The resolved profile name — part of the identity, not decoration. */
  profileName: string;
  /** The project the profile belongs to. */
  project: number;
  /** The agent id — the exact value the backend compares in `views.rs:1813`. */
  agentId: number;
  /**
   * Absolute path of the `.taskflow.json` this identity was read from. Empty
   * when the config came from a string rather than disk (config.ts:68), in
   * which case there is no location to name and the suffix is omitted.
   */
  configPath?: string;
  host?: string;
  pid?: number;
}

export function sessionIdentifier(options: SessionIdentifierOptions): string {
  const host = options.host ?? hostname();
  const base = options.pane ? `tmux:${host}:${options.pane}` : `${host}:${options.pid ?? process.pid}`;
  const identity = `p${options.project}.a${options.agentId}.${options.profileName}`;
  // Pane ids are numbered per tmux server, so `%0` is not unique across them.
  // Hashed rather than embedded: the path is long, and only its distinctness
  // matters here. Same digest length as `sessions-store.ts`'s terminal key.
  const location = options.configPath
    ? `@${createHash("sha256").update(options.configPath).digest("hex").slice(0, 6)}`
    : "";
  return `${base}#${identity}${location}`;
}
