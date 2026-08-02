/**
 * `taskflow-mcp --mint <name>` — create a NEW agent identity and record it as
 * a profile in `.taskflow.json`.
 *
 * ## Why this is a CLI and not an MCP tool
 *
 * `POST /api/taskflow/agents/link` is gated on `RequireAuth` plus an active
 * project membership, and it stamps the linking human onto the agent. An agent
 * authenticates with `Authorization: Agent <key>` and would simply be refused.
 *
 * That gate is correct and this command deliberately does not work around it:
 * an agent able to mint sibling agents could grow an unbounded roster that no
 * human vouched for. Creating an identity is a human act, so a human runs this.
 *
 * ## What it is for
 *
 * Identity is `project + profile`. Two terminals sharing the `main` profile are
 * ONE agent — same roster entry, and, more importantly, one shared DM inbox and
 * one shared read cursor. Giving the second terminal its own profile is what
 * makes them distinguishable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { findConfigPath, taskflowConfigSchema, type RawProfile, type TaskflowConfig } from "./config.js";

/** A clear, user-facing failure (never a raw stack). */
export class MintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintError";
  }
}

export interface MintArgs {
  name: string;
  displayName: string;
  token: string | undefined;
}

/**
 * Parse `--mint <name> [--display-name <s>] [--token <t>]`.
 *
 * The token falls back to `TASKFLOW_USER_TOKEN`, but an explicit `--token`
 * wins — a one-off mint against another account must not silently pick up
 * whatever is exported in the shell.
 */
export function parseMintArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): MintArgs {
  const valueFor = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const next = argv[i + 1];
    // A flag consuming the next flag as its value is how `--mint --token t`
    // would otherwise mint a profile literally named "--token".
    return next && !next.startsWith("--") ? next : undefined;
  };

  const name = valueFor("--mint");
  if (!name) {
    throw new MintError("--mint needs a profile name, e.g. `--mint bear`.");
  }

  return {
    name,
    displayName: valueFor("--display-name") ?? `Claude (${name})`,
    token: valueFor("--token") ?? env.TASKFLOW_USER_TOKEN,
  };
}

/**
 * Return a copy of `config` with `profile` recorded under `name`.
 *
 * Pure, and deliberately non-destructive in three ways:
 * - an existing profile is never overwritten (its key is unrecoverable, and it
 *   is what a running terminal authenticates with)
 * - `default_profile` never moves, so existing terminals keep their identity
 * - every other field is carried through untouched
 */
export function addProfile(config: TaskflowConfig, name: string, profile: RawProfile): TaskflowConfig {
  const key = name.trim();
  if (!key) {
    throw new MintError("A profile name must not be blank.");
  }
  if (config.profiles[key]) {
    throw new MintError(
      `Profile "${key}" already exists in .taskflow.json. ` +
        `Pick another name — overwriting it would discard a key that cannot be recovered.`,
    );
  }
  return { ...config, profiles: { ...config.profiles, [key]: profile } };
}

/** The line the operator runs to start the other terminal as the new identity. */
export function exportHint(name: string): string {
  return `export TASKFLOW_PROFILE=${name}`;
}

/** The subset of `fetch` this module uses; injectable so tests see the real request. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Mint against the server and return the profile block it hands back. */
export async function requestMint(
  server: string,
  project: number,
  args: MintArgs,
  token: string,
  doFetch: FetchLike = fetch,
): Promise<RawProfile> {
  const res = await doFetch(`${server.replace(/\/$/, "")}/api/taskflow/agents/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ project, display_name: args.displayName, profile: args.name }),
  });

  if (res.status === 401) {
    throw new MintError("The server rejected that token (401). It must be a USER token, not an agent key.");
  }
  if (res.status === 403) {
    throw new MintError(`That account is not an active member of project ${project} (403).`);
  }
  if (!res.ok) {
    throw new MintError(`Mint failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { taskflow_profile?: RawProfile };
  // The raw key exists in this response and nowhere else — the server stores
  // only a hash. A malformed body here means the key is already lost, so say so
  // rather than writing a profile that cannot authenticate.
  if (!body.taskflow_profile?.key) {
    throw new MintError("The server's response carried no key; the minted agent is unusable. Nothing was written.");
  }
  return body.taskflow_profile;
}

/**
 * Run the command. Returns the lines to print.
 *
 * The write is last: a failed mint must not leave a half-edited config, and a
 * successful mint must not lose its key to a formatting error.
 */
export async function runMint(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const args = parseMintArgs(argv, env);
  if (!args.token) {
    throw new MintError(
      "No user token. Pass --token <t> or set TASKFLOW_USER_TOKEN.\n" +
        "Minting an agent is a human action, so this needs YOUR login token, not an agent key.",
    );
  }

  const configPath = findConfigPath({ env });
  const config = taskflowConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));

  // Fail on a duplicate name BEFORE minting, so a mistyped command cannot leave
  // an orphan agent on the server that nothing references.
  addProfile(config, args.name, { agent_id: 0, key: "probe" });

  const profile = await requestMint(config.server, config.project, args, args.token);
  const next = addProfile(config, args.name, profile);
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return [
    `minted agent ${profile.agent_id} — ${profile.display_name ?? args.displayName}`,
    `wrote profile "${args.name}" to ${configPath}`,
    "",
    "run the other terminal with:",
    `  ${exportHint(args.name)}`,
  ];
}
