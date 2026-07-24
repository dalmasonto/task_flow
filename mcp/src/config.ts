/**
 * Load and validate `.taskflow.json`, then resolve one profile into a flat,
 * ready-to-use identity for the HTTP client.
 *
 * The file is the stable per-repo credential a human creates via the dashboard's
 * **API Base** page:
 *
 * ```json
 * { "server": "http://localhost:8000", "project": 1, "default_profile": "main",
 *   "profiles": {
 *     "main":     { "agent_id": 12, "key": "tfk_…", "display_name": "Builder" },
 *     "reviewer": { "agent_id": 13, "key": "tfk_…", "display_name": "Reviewer" }
 *   } }
 * ```
 *
 * File resolution: an explicit path (or `TASKFLOW_CONFIG`) wins; otherwise we
 * walk up from a start directory to the first `.taskflow.json`.
 *
 * Profile resolution (highest priority first):
 *   1. an explicit `profile` argument (a per-tool-call override),
 *   2. the `TASKFLOW_PROFILE` env var,
 *   3. the file's `default_profile`,
 *   4. the literal `"main"`.
 *
 * Every function that reads the environment or filesystem takes those as
 * explicit, defaultable options so the whole module is unit-testable without
 * touching real `process.env` or `process.cwd()`.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = ".taskflow.json";
export const DEFAULT_PROFILE_NAME = "main";

/** One profile block as it appears in the file. */
export const profileSchema = z.object({
  agent_id: z.number().int(),
  key: z.string().min(1, "profile key must not be empty"),
  display_name: z.string().optional(),
});

/** The whole `.taskflow.json` file. */
export const taskflowConfigSchema = z.object({
  server: z.string().min(1, "server must not be empty"),
  project: z.number().int(),
  default_profile: z.string().optional(),
  profiles: z
    .record(z.string(), profileSchema)
    .refine((p) => Object.keys(p).length > 0, {
      message: "profiles must contain at least one profile",
    }),
});

export type RawProfile = z.infer<typeof profileSchema>;
export type TaskflowConfig = z.infer<typeof taskflowConfigSchema>;

/** A profile flattened with its file-level context — everything the client needs. */
export interface ResolvedProfile {
  server: string;
  project: number;
  profileName: string;
  agentId: number;
  key: string;
  displayName: string;
  /** Absolute path the config was read from (empty when parsed from a string). */
  configPath: string;
}

/** A clear, user-facing configuration error (never a raw stack). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface FindConfigOptions {
  /** An explicit path to the file; skips the walk-up entirely. */
  configPath?: string | undefined;
  /** Where to start the upward walk (defaults to `process.cwd()`). */
  startDir?: string | undefined;
  /** Environment source (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the absolute path of the `.taskflow.json` to use. Precedence:
 * explicit `configPath` > `TASKFLOW_CONFIG` env > walk up from `startDir`.
 * Throws {@link ConfigError} when nothing is found.
 */
export function findConfigPath(options: FindConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.configPath ?? env.TASKFLOW_CONFIG;
  if (explicit) {
    const abs = resolve(explicit);
    if (!existsSync(abs)) {
      throw new ConfigError(`TaskFlow config not found at ${abs}`);
    }
    return abs;
  }

  let dir = resolve(options.startDir ?? process.cwd());
  // Walk up to the filesystem root looking for the file.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new ConfigError(
    `Could not find ${CONFIG_FILENAME} in ${resolve(
      options.startDir ?? process.cwd(),
    )} or any parent directory. ` +
      `Create one (link an agent in the dashboard's API Base page) or set TASKFLOW_CONFIG.`,
  );
}

/** Validate an already-parsed object (or JSON text) into a {@link TaskflowConfig}. */
export function parseConfig(input: string | unknown, sourceLabel = "<string>"): TaskflowConfig {
  let data: unknown;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (err) {
      throw new ConfigError(
        `Failed to parse ${sourceLabel} as JSON: ${(err as Error).message}`,
      );
    }
  } else {
    data = input;
  }

  const result = taskflowConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid ${sourceLabel}:\n${issues}`);
  }
  return result.data;
}

/** Read + validate the config file at an absolute path. */
export function loadConfigFile(configPath: string): TaskflowConfig {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(`Failed to read ${configPath}: ${(err as Error).message}`);
  }
  return parseConfig(text, configPath);
}

export interface ResolveProfileOptions {
  /** An explicit per-call profile override (highest precedence). */
  profile?: string | undefined;
  /** Environment source (defaults to `process.env`); reads `TASKFLOW_PROFILE`. */
  env?: NodeJS.ProcessEnv;
  /** Path the config came from, for error messages and the resolved result. */
  configPath?: string;
}

/**
 * Pick the effective profile name using the documented precedence:
 * argument > `TASKFLOW_PROFILE` > `default_profile` > `"main"`.
 */
export function chooseProfileName(
  config: TaskflowConfig,
  options: ResolveProfileOptions = {},
): string {
  const env = options.env ?? process.env;
  const fromArg = options.profile?.trim();
  const fromEnv = env.TASKFLOW_PROFILE?.trim();
  return (
    (fromArg && fromArg.length > 0 ? fromArg : undefined) ??
    (fromEnv && fromEnv.length > 0 ? fromEnv : undefined) ??
    config.default_profile ??
    DEFAULT_PROFILE_NAME
  );
}

/**
 * Resolve `config` + options into a flat {@link ResolvedProfile}. Throws
 * {@link ConfigError} if the chosen profile is not present in the file.
 */
export function resolveProfile(
  config: TaskflowConfig,
  options: ResolveProfileOptions = {},
): ResolvedProfile {
  const profileName = chooseProfileName(config, options);
  const profile = config.profiles[profileName];
  if (!profile) {
    const available = Object.keys(config.profiles).join(", ") || "(none)";
    throw new ConfigError(
      `Profile "${profileName}" is not defined in ${
        options.configPath ?? CONFIG_FILENAME
      }. Available profiles: ${available}.`,
    );
  }
  return {
    server: config.server.replace(/\/+$/, ""),
    project: config.project,
    profileName,
    agentId: profile.agent_id,
    key: profile.key,
    displayName: profile.display_name ?? profileName,
    configPath: options.configPath ?? "",
  };
}

/** One selectable identity, as offered to the human choosing among them. */
export interface ProfileChoice {
  name: string;
  display_name: string;
  /** True for the file's `default_profile` — a hint, never a decision. */
  recommended: boolean;
  /** Filled in by the caller from live session data; omitted if unknown. */
  in_use?: boolean;
}

export type ProfileResolution =
  | { kind: "resolved"; profile: ResolvedProfile }
  | { kind: "ambiguous"; profiles: ProfileChoice[] };

export interface AskProfileOptions extends ResolveProfileOptions {
  /** This terminal's remembered pick, if any (see `sessions-store.ts`). */
  sticky?: string | undefined;
}

/**
 * Resolve a profile, or report that a human has to choose.
 *
 * Ambiguous means: several profiles defined, and nothing said which one this
 * terminal is. `default_profile` deliberately does NOT settle it — `--mint`
 * adds profiles without moving it, so honouring it would mean the prompt never
 * fires and two terminals silently share one identity, which is the bug.
 *
 * `resolveProfile` keeps its throwing contract for callers that already have a
 * name (`--tmux --profile=x`, `--mint`, a per-tool `profile` argument).
 */
export function resolveProfileOrAsk(
  config: TaskflowConfig,
  options: AskProfileOptions = {},
): ProfileResolution {
  const env = options.env ?? process.env;
  const explicit = options.profile?.trim() || env.TASKFLOW_PROFILE?.trim();
  if (explicit) {
    // Unknown name is a real error, not an invitation to ask: the caller
    // asserted an identity and got it wrong.
    return { kind: "resolved", profile: resolveProfile(config, { ...options, profile: explicit }) };
  }

  const names = Object.keys(config.profiles);
  // A stale sticky pick (profile since removed from the file) falls through to
  // asking rather than throwing — the human never typed that name today.
  const sticky = options.sticky?.trim();
  if (sticky && config.profiles[sticky]) {
    return { kind: "resolved", profile: resolveProfile(config, { ...options, profile: sticky }) };
  }

  if (names.length === 1) {
    return { kind: "resolved", profile: resolveProfile(config, { ...options, profile: names[0] }) };
  }

  const recommended = config.default_profile ?? DEFAULT_PROFILE_NAME;
  return {
    kind: "ambiguous",
    profiles: names.map((name) => ({
      name,
      display_name: config.profiles[name]?.display_name ?? name,
      recommended: name === recommended,
    })),
  };
}

export interface LoadProfileOptions extends FindConfigOptions, ResolveProfileOptions {}

/**
 * The one-call convenience the bin entry and hooks use: find the file, load +
 * validate it, and resolve the chosen profile into a {@link ResolvedProfile}.
 */
export function loadProfile(options: LoadProfileOptions = {}): ResolvedProfile {
  const configPath = findConfigPath(options);
  const config = loadConfigFile(configPath);
  return resolveProfile(config, { ...options, configPath });
}
