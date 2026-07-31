import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../src/db.js';
import { logActivity } from '../src/helpers.js';
import { getActivityLog, clearActivityLog } from '../src/tools/activity.js';

describe('Activity Tools', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  describe('getActivityLog', () => {
    it('returns entries ordered by created_at DESC', async () => {
      logActivity('task_created', 'Task A', { entityType: 'task', entityId: 1 });
      logActivity('task_completed', 'Task B', { entityType: 'task', entityId: 2 });

      const result = await getActivityLog({});
      expect(result.isError).toBeUndefined();
      const logs = JSON.parse(result.content[0].text);
      expect(logs.length).toBe(2);
      // Most recent first
      expect(logs[0].action).toBe('task_completed');
      expect(logs[1].action).toBe('task_created');
    });

    it('respects limit param', async () => {
      logActivity('task_created', 'Task A');
      logActivity('task_completed', 'Task B');
      logActivity('timer_started', 'Task C');

      const result = await getActivityLog({ limit: 2 });
      const logs = JSON.parse(result.content[0].text);
      expect(logs.length).toBe(2);
    });

    it('filters by action', async () => {
      logActivity('task_created', 'Task A', { entityType: 'task', entityId: 1 });
      logActivity('task_completed', 'Task B', { entityType: 'task', entityId: 2 });
      logActivity('task_created', 'Task C', { entityType: 'task', entityId: 3 });

      const result = await getActivityLog({ action: 'task_created' });
      const logs = JSON.parse(result.content[0].text);
      expect(logs.length).toBe(2);
      expect(logs.every((l: { action: string }) => l.action === 'task_created')).toBe(true);
    });

    it('filters by entity_type', async () => {
      logActivity('task_created', 'Task A', { entityType: 'task', entityId: 1 });
      logActivity('project_created', 'Project X', { entityType: 'project', entityId: 1 });
      logActivity('task_completed', 'Task B', { entityType: 'task', entityId: 2 });

      const result = await getActivityLog({ entity_type: 'task' });
      const logs = JSON.parse(result.content[0].text);
      expect(logs.length).toBe(2);
      expect(logs.every((l: { entity_type: string }) => l.entity_type === 'task')).toBe(true);
    });

    it('returns empty array when no entries', async () => {
      const result = await getActivityLog({});
      const logs = JSON.parse(result.content[0].text);
      expect(logs).toEqual([]);
    });
  });

  describe('clearActivityLog', () => {
    it('deletes all entries and returns count', async () => {
      logActivity('task_created', 'Task A');
      logActivity('task_completed', 'Task B');
      logActivity('timer_started', 'Task C');

      const result = await clearActivityLog();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.deleted).toBe(3);

      const checkResult = await getActivityLog({});
      const logs = JSON.parse(checkResult.content[0].text);
      expect(logs.length).toBe(0);
    });

    it('returns 0 when table already empty', async () => {
      const result = await clearActivityLog();
      const data = JSON.parse(result.content[0].text);
      expect(data.deleted).toBe(0);
    });
  });
});
