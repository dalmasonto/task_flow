import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResponse, successResponse, broadcastChange } from '../helpers.js';

// ─── interfaces ───────────────────────────────────────────────────────

interface NotificationRow {
  id: number;
  title: string;
  message: string;
  type: string;
  read: number;
  created_at: string;
}

// ─── exported handler functions ───────────────────────────────────────

export async function listNotifications(params: {
  limit?: number;
  unread_only?: boolean;
}) {
  const db = getDb();
  const limit = params.limit ?? 50;

  let sql = 'SELECT * FROM notifications';
  const values: unknown[] = [];

  if (params.unread_only) {
    sql += ' WHERE read = 0';
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  values.push(limit);

  const rows = db.prepare(sql).all(...values) as NotificationRow[];
  return successResponse(rows);
}

export async function markNotificationRead(params: { id: number }) {
  const db = getDb();
  const result = db
    .prepare('UPDATE notifications SET read = 1 WHERE id = ?')
    .run(params.id);

  if (result.changes === 0) {
    return errorResponse('Notification not found', 'NOT_FOUND');
  }

  const row = db
    .prepare('SELECT * FROM notifications WHERE id = ?')
    .get(params.id) as NotificationRow;
  const notification = row;
  broadcastChange('notification', 'notification_updated', notification);
  return successResponse(notification);
}

export async function markAllNotificationsRead() {
  const db = getDb();
  const result = db
    .prepare('UPDATE notifications SET read = 1 WHERE read = 0')
    .run();
  broadcastChange('notification', 'notifications_all_read', {});
  return successResponse({ updated: result.changes });
}

export async function clearNotifications() {
  const db = getDb();
  const countRow = db
    .prepare('SELECT COUNT(*) AS count FROM notifications')
    .get() as { count: number };
  db.prepare('DELETE FROM notifications').run();
  broadcastChange('notification', 'notifications_cleared', {});
  return successResponse({ deleted: countRow.count, message: 'Notifications cleared' });
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerNotificationTools(server: McpServer) {
  server.tool(
    'list_notifications',
    'List notifications. Check with unread_only=true at conversation start to surface important updates for the user.',
    {
      limit: z.number().optional(),
      unread_only: z.boolean().optional(),
    },
    async (params) => listNotifications(params),
  );

  server.tool(
    'mark_notification_read',
    'Mark a notification as read after surfacing it to the user.',
    { id: z.number() },
    async (params) => markNotificationRead(params),
  );

  server.tool(
    'mark_all_notifications_read',
    'Mark all unread notifications as read. Call after the user has been briefed on pending notifications.',
    {},
    async () => markAllNotificationsRead(),
  );

  server.tool(
    'clear_notifications',
    'Delete all notifications. Use with caution — this is irreversible.',
    {},
    async () => clearNotifications(),
  );
}
