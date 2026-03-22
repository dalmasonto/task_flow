import { getDb } from './db.js';
import type { ActivityAction, ErrorCode } from './types.js';
import { broadcast } from './sse.js';

export function logActivity(
  action: ActivityAction,
  title: string,
  options?: { detail?: string; entityType?: string; entityId?: number }
): void {
  const db = getDb();
  const ts = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO activity_logs (action, title, detail, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(action, title, options?.detail ?? null, options?.entityType ?? null, options?.entityId ?? null, ts);

  const entry = db.prepare('SELECT * FROM activity_logs WHERE id = ?').get(result.lastInsertRowid);
  broadcast('activity_logged', { entity: 'activity', action: 'activity_logged', payload: entry });
}

export function errorResponse(error: string, code: ErrorCode) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ error, code }) }],
  };
}

export function successResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function now(): string {
  return new Date().toISOString();
}

export function broadcastChange(entity: string, action: string, payload: unknown): void {
  broadcast(action, { entity, action, payload });
}
