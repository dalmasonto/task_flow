import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

// ─── types ───────────────────────────────────────────────────────────

export interface TaskFlowConfig {
  port: number;
  host: string;
  databasePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  agentLivenessInterval: number;
  maxPortAttempts: number;
  relayUrl: string;
  relayPushToken: string;
}

/** Keys that live in the config file (not SQLite) */
export const SERVER_CONFIG_KEYS = new Set<string>([
  'port',
  'host',
  'databasePath',
  'logLevel',
  'agentLivenessInterval',
  'maxPortAttempts',
  'relayUrl',
  'relayPushToken',
]);

// ─── defaults ────────────────────────────────────────────────────────

const DEFAULTS: TaskFlowConfig = {
  port: 3456,
  host: '127.0.0.1',
  databasePath: '~/.taskflow/taskflow.db',
  logLevel: 'info',
  agentLivenessInterval: 30_000,
  maxPortAttempts: 10,
  relayUrl: '',
  relayPushToken: '',
};

// ─── config file path ────────────────────────────────────────────────
// Config lives alongside the database in ~/.taskflow/
// Falls back to legacy ~/.taskflow_config.json for backward compat

import { existsSync } from 'fs';

const NEW_CONFIG_PATH = resolve(homedir(), '.taskflow', 'config.json');
const LEGACY_CONFIG_PATH = resolve(homedir(), '.taskflow_config.json');
const CONFIG_PATH = existsSync(NEW_CONFIG_PATH) ? NEW_CONFIG_PATH
  : existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH
  : NEW_CONFIG_PATH; // default to new path for fresh installs

// ─── loader ──────────────────────────────────────────────────────────

function loadFromFile(): Partial<TaskFlowConfig> {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`[config] Warning: ${CONFIG_PATH} is not a JSON object — using defaults`);
      return {};
    }
    return parsed as Partial<TaskFlowConfig>;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // File doesn't exist — that's fine, use defaults
      return {};
    }
    console.error(`[config] Warning: failed to read ${CONFIG_PATH} — ${err.message}`);
    return {};
  }
}

function applyCliAndEnvOverrides(config: TaskFlowConfig): TaskFlowConfig {
  // Env vars override config file
  if (process.env.TASKFLOW_SSE_PORT) {
    const p = parseInt(process.env.TASKFLOW_SSE_PORT, 10);
    if (!isNaN(p)) config.port = p;
  }
  if (process.env.TASKFLOW_DB_PATH) {
    config.databasePath = process.env.TASKFLOW_DB_PATH;
  }
  if (process.env.TASKFLOW_HOST) {
    config.host = process.env.TASKFLOW_HOST;
  }
  if (process.env.TASKFLOW_LOG_LEVEL) {
    config.logLevel = process.env.TASKFLOW_LOG_LEVEL as TaskFlowConfig['logLevel'];
  }
  if (process.env.TASKFLOW_RELAY_URL) {
    config.relayUrl = process.env.TASKFLOW_RELAY_URL;
  }
  if (process.env.TASKFLOW_RELAY_PUSH_TOKEN) {
    config.relayPushToken = process.env.TASKFLOW_RELAY_PUSH_TOKEN;
  }

  // CLI args take highest priority
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const p = parseInt(process.argv[portArgIdx + 1], 10);
    if (!isNaN(p)) config.port = p;
  }
  const hostArgIdx = process.argv.indexOf('--host');
  if (hostArgIdx !== -1 && process.argv[hostArgIdx + 1]) {
    config.host = process.argv[hostArgIdx + 1];
  }

  return config;
}

// ─── singleton ───────────────────────────────────────────────────────

let _config: TaskFlowConfig | null = null;

export function getConfig(): TaskFlowConfig {
  if (_config) return _config;

  const fileValues = loadFromFile();
  _config = applyCliAndEnvOverrides({ ...DEFAULTS, ...fileValues });
  return _config;
}

/** Check if a setting key is a server-level config key */
export function isServerConfigKey(key: string): boolean {
  return SERVER_CONFIG_KEYS.has(key);
}

// ─── write-back ──────────────────────────────────────────────────────

/**
 * Update a single key in ~/.taskflow_config.json.
 * Re-reads the file first to avoid clobbering other keys.
 * Returns the updated config value.
 */
export function writeConfigKey(key: string, value: unknown): void {
  let existing: Record<string, unknown> = {};
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // File doesn't exist or is malformed — start fresh
  }

  existing[key] = value;

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  // Update the in-memory singleton so get_setting reflects the change immediately
  if (_config && key in DEFAULTS) {
    (_config as any)[key] = value;
  }
}
