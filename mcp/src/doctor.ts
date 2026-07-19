/**
 * `taskflow-v2-mcp --check` — verify the whole agent chain from a terminal.
 *
 * The MCP tools can only be called by a model through an MCP client, so there is
 * otherwise no way for a human to answer "is this thing actually wired up?"
 * without hand-rolling curl. This walks the same path the server does — find the
 * config, resolve each profile, authenticate against the backend — and reports
 * where it breaks, with the fix.
 *
 * Writes to stdout (this mode is not the MCP transport) and exits non-zero on
 * failure so it can gate a script.
 */

import { TaskflowClient, TaskflowApiError } from "./client.js";
import {
  ConfigError,
  findConfigPath,
  loadConfigFile,
  resolveProfile,
  type TaskflowConfig,
} from "./config.js";

const PASS = "PASS";
const FAIL = "FAIL";

export interface DoctorOptions {
  configPath?: string | undefined;
  startDir?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to writing a line to stdout. */
  log?: (line: string) => void;
}

/**
 * Run every check. Returns a process exit code: 0 when the agent can
 * authenticate as at least one profile, 1 otherwise.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  // 1. Locate the credential file.
  let configPath: string;
  try {
    configPath = findConfigPath({
      configPath: options.configPath,
      startDir: options.startDir,
      env: options.env,
    });
  } catch (err) {
    log(`${FAIL}  .taskflow.json not found`);
    log(`      ${(err as ConfigError).message}`);
    log("");
    log("      Fix: link an agent on the dashboard's API Base page, then save the");
    log("      snippet as .taskflow.json in your repo root.");
    return 1;
  }
  log(`${PASS}  config found — ${configPath}`);

  // 2. Parse + validate it.
  let config: TaskflowConfig;
  try {
    config = loadConfigFile(configPath);
  } catch (err) {
    log(`${FAIL}  config is not valid`);
    log(`      ${(err as Error).message}`);
    return 1;
  }
  const profileNames = Object.keys(config.profiles);
  log(`${PASS}  config valid — server ${config.server}, project ${config.project}`);
  log(
    `      profiles: ${profileNames.join(", ")} (default: ${
      config.default_profile ?? "main"
    })`,
  );

  // A frontend origin here is the classic misconfiguration: the dev server
  // proxies /api to the backend, so it appears to work until the frontend is
  // stopped, at which point the agent dies for no obvious reason.
  if (/:(517[0-9]|300[0-9]|808[0-9])$/.test(config.server) && !/:8000$/.test(config.server)) {
    log(
      `      note: ${config.server} looks like a frontend dev server. It must be the`,
    );
    log("      BACKEND origin — an agent runs headless and must not depend on the UI.");
  }

  // 3. Authenticate each profile against the live backend. Readiness hinges on
  // the DEFAULT profile — that is the one tools use when no profile is named, so
  // a working "reviewer" next to a broken "main" is not a ready setup.
  const defaultName = config.default_profile ?? "main";
  const failed: string[] = [];
  let defaultOk = false;
  for (const name of profileNames) {
    let resolved;
    try {
      resolved = resolveProfile(config, { profile: name, env: options.env, configPath });
    } catch (err) {
      log(`${FAIL}  profile "${name}" — ${(err as Error).message}`);
      failed.push(name);
      continue;
    }

    const client = new TaskflowClient({ server: resolved.server, key: resolved.key });
    try {
      const who = await client.whoami();
      if (name === defaultName) defaultOk = true;
      log(
        `${PASS}  profile "${name}" authenticated — agent #${who.agent_id} ` +
          `"${who.display_name}", project ${who.project}, status ${who.status}`,
      );
    } catch (err) {
      log(`${FAIL}  profile "${name}" could not authenticate`);
      failed.push(name);
      const message = (err as Error).message;
      log(`      ${message}`);

      // The client wraps a network failure as a TaskflowApiError with status 0,
      // so "could not connect" must be matched on the message, not by falling
      // through to a non-API error branch — there isn't one.
      const status = err instanceof TaskflowApiError ? err.status : -1;
      if (status === 401 || status === 403) {
        log("      The key is wrong, revoked, or belongs to another project.");
        log("      Fix: re-link the agent on the API Base page for a fresh key.");
      } else if (status === 0 || /ECONNREFUSED|fetch failed|ENOTFOUND|network/i.test(message)) {
        log(`      Nothing is listening at ${resolved.server}.`);
        log('      Fix: start the backend, or correct the "server" field.');
      }
    }
  }

  log("");
  if (defaultOk && failed.length === 0) {
    log("Ready. The agent can authenticate — MCP tools will work in Claude Code.");
  } else if (defaultOk) {
    log(
      `Mostly ready. The default profile "${defaultName}" works, so tools will run, ` +
        `but ${failed.length === 1 ? "profile" : "profiles"} ${failed
          .map((f) => `"${f}"`)
          .join(", ")} failed and cannot be used.`,
    );
  } else {
    log(
      `Not ready. The default profile "${defaultName}" could not authenticate; ` +
        "see the failures above.",
    );
  }
  return defaultOk ? 0 : 1;
}
