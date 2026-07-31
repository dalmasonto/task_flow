import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, successResponse, broadcastChange } from '../helpers.js';
import { getConfig, isServerConfigKey, writeConfigKey } from '../config.js';

// ─── defaults ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Record<string, unknown> = {
  timerBarDisplayMode: 'carousel',
  notificationInterval: 30,
  browserNotificationsEnabled: true,
  statusColors: {
    not_started: '#484847',
    in_progress: '#00fbfb',
    paused: '#de8eff',
    blocked: '#ff6e84',
    partial_done: '#ffeb3b',
    done: '#69fd5d',
  },
  glowIntensity: 50,
  backdropBlur: 8,
  shadowSpread: 4,
  operatorName: 'operator',
  systemName: 'SYSTEM',
  terminalHistory: [],
};

// ─── interfaces ───────────────────────────────────────────────────────

interface SettingRow {
  key: string;
  value: string;
}

// ─── exported handler functions ───────────────────────────────────────

export async function getSetting(params: { key: string }) {
  // Server-level settings come from the config file
  if (isServerConfigKey(params.key)) {
    const config = getConfig();
    const value = (config as any)[params.key] ?? null;
    return successResponse({ key: params.key, value, source: 'config_file' });
  }

  // UI settings come from SQLite
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(params.key) as SettingRow | undefined;

  if (row) {
    return successResponse({ key: params.key, value: JSON.parse(row.value) });
  }

  const defaultValue = Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, params.key)
    ? DEFAULT_SETTINGS[params.key]
    : null;

  return successResponse({ key: params.key, value: defaultValue });
}

export async function updateSetting(params: { key: string; value: unknown }) {
  // Server-level settings write back to ~/.taskflow_config.json
  if (isServerConfigKey(params.key)) {
    writeConfigKey(params.key, params.value);
    logActivity('settings_saved', params.key, { detail: `Server setting "${params.key}" updated in config file` });
    broadcastChange('setting', 'settings_saved', { key: params.key, value: params.value });
    return successResponse({
      key: params.key,
      value: params.value,
      source: 'config_file',
      note: 'Server setting saved to ~/.taskflow_config.json. Restart the MCP server for the change to take full effect.',
    });
  }

  // UI settings go to SQLite
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    params.key,
    JSON.stringify(params.value),
  );

  logActivity('settings_saved', params.key, { detail: `Setting "${params.key}" updated` });

  broadcastChange('setting', 'settings_saved', { key: params.key, value: params.value });
  return successResponse({ key: params.key, value: params.value });
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerSettingsTools(server: McpServer) {
  server.tool(
    'get_setting',
    'Get a setting value by key. Server settings (port, host, databasePath, logLevel, agentLivenessInterval, maxPortAttempts) come from ~/.taskflow_config.json. UI settings (timerBarDisplayMode, notificationInterval, statusColors, operatorName, systemName, etc.) come from SQLite.',
    { key: z.string() },
    { readOnlyHint: true },
    async (params) => getSetting(params),
  );

  server.tool(
    'update_setting',
    'Update a setting value. Server settings (port, host, databasePath, logLevel, agentLivenessInterval, maxPortAttempts) are written to ~/.taskflow_config.json and require a restart. UI settings are saved to the local SQLite database.',
    {
      key: z.string(),
      value: z.unknown(),
    },
    { readOnlyHint: false },
    async (params) => updateSetting(params),
  );
}
