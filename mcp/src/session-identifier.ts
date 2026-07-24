/**
 * The identifier that names THIS process's session to the backend.
 *
 * Prefers the tmux pane, so the tools' session and the terminal mirror converge
 * on one row instead of two (register is idempotent per identifier). Falls back
 * to host:pid outside tmux.
 *
 * The PROFILE is part of the identifier because the backend treats an
 * identifier as globally unique and returns 409 CONFLICT when the row it names
 * belongs to a different agent (`views.rs:1813`). A pane where `main` has
 * already registered would otherwise be unable to re-register as `bear`, so
 * switching identity in a terminal — the whole point of profile selection —
 * would fail. Distinct identifiers give each identity its own row; the
 * abandoned one goes stale on its own inside the 90s liveness window.
 */

import { hostname } from "node:os";

export interface SessionIdentifierOptions {
  /** The tmux pane id, when running under tmux. */
  pane?: string | null;
  /** The resolved profile name — part of the identity, not decoration. */
  profileName: string;
  host?: string;
  pid?: number;
}

export function sessionIdentifier(options: SessionIdentifierOptions): string {
  const host = options.host ?? hostname();
  const base = options.pane ? `tmux:${host}:${options.pane}` : `${host}:${options.pid ?? process.pid}`;
  return `${base}#${options.profileName}`;
}
