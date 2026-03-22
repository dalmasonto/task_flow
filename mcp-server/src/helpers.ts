import { getDb } from './db.js';
import type { ActivityAction, ErrorCode } from './types.js';

export function logActivity(
  action: ActivityAction,
  title: string,
  options?: { detail?: string; entityType?: string; entityId?: number }
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO activity_logs (action, title, detail, entity_type, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(action, title, options?.detail ?? null, options?.entityType ?? null, options?.entityId ?? null, new Date().toISOString());
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
