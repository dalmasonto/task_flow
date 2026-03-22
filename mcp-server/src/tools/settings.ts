import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, successResponse, broadcastChange } from '../helpers.js';

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
    'Get a setting value by key, returning the default if not set. Available keys: timerBarDisplayMode, notificationInterval, statusColors, operatorName, systemName, and more.',
    { key: z.string() },
    async (params) => getSetting(params),
  );

  server.tool(
    'update_setting',
    'Update or create a setting value. Settings persist across sessions in the local SQLite database.',
    {
      key: z.string(),
      value: z.unknown(),
    },
    async (params) => updateSetting(params),
  );
}
