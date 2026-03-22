import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../src/db.js';
import { getAnalytics, getTimeline } from '../src/tools/analytics.js';

describe('Analytics Tools', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  // ─── get_analytics ────────────────────────────────────────────────────

  describe('getAnalytics', () => {
    it('should return all zeros/empty when no data exists', async () => {
      const result = await getAnalytics({});
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      expect(data.total_focused_time).toBe(0);
      expect(data.tasks_completed).toBe(0);
      expect(data.tasks_in_progress).toBe(0);
      expect(data.total_tasks).toBe(0);
      expect(data.status_distribution).toEqual({});
      expect(data.time_per_project).toEqual([]);
    });

    it('should return correct totals with tasks and completed sessions', async () => {
      const db = getDb();
      const ts = '2026-03-20T00:00:00.000Z';

      // Insert projects
      db.prepare('INSERT INTO projects (name, color, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        'Project Alpha', '#ff0000', 'active_project', ts, ts
      );

      // Insert tasks
      db.prepare(
        'INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 1', 'done', 'high', 1, '[]', '[]', '[]', ts, ts);
      db.prepare(
        'INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 2', 'in_progress', 'medium', 1, '[]', '[]', '[]', ts, ts);
      db.prepare(
        'INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 3', 'not_started', 'low', null, '[]', '[]', '[]', ts, ts);

      // Insert sessions: task1 has 1 hour session, task2 has 30 min session
      const s1 = '2026-03-20T10:00:00.000Z';
      const e1 = '2026-03-20T11:00:00.000Z'; // 1 hour = 3600000ms
      const s2 = '2026-03-20T12:00:00.000Z';
      const e2 = '2026-03-20T12:30:00.000Z'; // 30 min = 1800000ms
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, s1, e1);
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(2, s2, e2);

      const result = await getAnalytics({});
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      expect(data.total_focused_time).toBe(3600000 + 1800000);
      expect(data.tasks_completed).toBe(1);
      expect(data.tasks_in_progress).toBe(1);
      expect(data.total_tasks).toBe(3);
      expect(data.status_distribution).toEqual({
        done: 1,
        in_progress: 1,
        not_started: 1,
      });
    });

    it('should filter sessions by date range', async () => {
      const db = getDb();
      const ts = '2026-03-01T00:00:00.000Z';

      db.prepare(
        'INSERT INTO tasks (title, status, priority, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 1', 'done', 'high', '[]', '[]', '[]', ts, ts);

      // Session inside range
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-10T10:00:00.000Z', '2026-03-10T11:00:00.000Z' // 1h = 3600000ms
      );
      // Session outside range (before)
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-01T10:00:00.000Z', '2026-03-01T11:00:00.000Z' // 1h
      );
      // Session outside range (after)
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-20T10:00:00.000Z', '2026-03-20T11:00:00.000Z' // 1h
      );

      const result = await getAnalytics({
        start_date: '2026-03-09T00:00:00.000Z',
        end_date: '2026-03-15T00:00:00.000Z',
      });
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      // Only the session on 2026-03-10 should be counted
      expect(data.total_focused_time).toBe(3600000);
    });

    it('should return correct time_per_project grouping', async () => {
      const db = getDb();
      const ts = '2026-03-20T00:00:00.000Z';

      db.prepare('INSERT INTO projects (name, color, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        'Alpha', '#ff0000', 'active_project', ts, ts
      );
      db.prepare('INSERT INTO projects (name, color, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        'Beta', '#00ff00', 'active_project', ts, ts
      );

      db.prepare(
        'INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task A1', 'done', 'high', 1, '[]', '[]', '[]', ts, ts);
      db.prepare(
        'INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task A2', 'done', 'medium', 1, '[]', '[]', '[]', ts, ts);
      db.prepare(
        'INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task B1', 'done', 'low', 2, '[]', '[]', '[]', ts, ts);
      db.prepare(
        'INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task No Project', 'done', 'low', null, '[]', '[]', '[]', ts, ts);

      // Sessions: task_id 1 → 2h, task_id 2 → 1h, task_id 3 → 30min
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-20T08:00:00.000Z', '2026-03-20T10:00:00.000Z' // 2h = 7200000ms
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        2, '2026-03-20T10:00:00.000Z', '2026-03-20T11:00:00.000Z' // 1h = 3600000ms
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        3, '2026-03-20T11:00:00.000Z', '2026-03-20T11:30:00.000Z' // 30min = 1800000ms
      );

      const result = await getAnalytics({});
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      const timePerProject: Array<{ project_id: number; project_name: string; total_time: number }> = data.time_per_project;

      // Sort by project_id for deterministic comparison
      timePerProject.sort((a, b) => (a.project_id ?? 0) - (b.project_id ?? 0));

      expect(timePerProject).toHaveLength(2);

      const alpha = timePerProject.find(p => p.project_id === 1);
      expect(alpha).toBeDefined();
      expect(alpha!.project_name).toBe('Alpha');
      expect(alpha!.total_time).toBe(7200000 + 3600000); // 3h

      const beta = timePerProject.find(p => p.project_id === 2);
      expect(beta).toBeDefined();
      expect(beta!.project_name).toBe('Beta');
      expect(beta!.total_time).toBe(1800000); // 30min
    });
  });

  // ─── get_timeline ─────────────────────────────────────────────────────

  describe('getTimeline', () => {
    it('should return empty array when no sessions exist', async () => {
      const result = await getTimeline({});
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual([]);
    });

    it('should group sessions by day correctly', async () => {
      const db = getDb();
      const ts = '2026-03-01T00:00:00.000Z';

      db.prepare(
        'INSERT INTO tasks (title, status, priority, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 1', 'done', 'high', '[]', '[]', '[]', ts, ts);

      // Day 1: two sessions (1h + 30min = 90min = 5400000ms)
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z' // 1h
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-10T10:00:00.000Z', '2026-03-10T10:30:00.000Z' // 30min
      );
      // Day 2: one session (2h = 7200000ms)
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-11T09:00:00.000Z', '2026-03-11T11:00:00.000Z' // 2h
      );

      const result = await getTimeline({ group_by: 'day' });
      expect(result.isError).toBeUndefined();

      const data: Array<{ period: string; total_time: number; session_count: number }> = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(2);

      const day1 = data.find(d => d.period === '2026-03-10');
      expect(day1).toBeDefined();
      expect(day1!.total_time).toBe(3600000 + 1800000); // 90min
      expect(day1!.session_count).toBe(2);

      const day2 = data.find(d => d.period === '2026-03-11');
      expect(day2).toBeDefined();
      expect(day2!.total_time).toBe(7200000); // 2h
      expect(day2!.session_count).toBe(1);
    });

    it('should group sessions by week correctly', async () => {
      const db = getDb();
      const ts = '2026-03-01T00:00:00.000Z';

      db.prepare(
        'INSERT INTO tasks (title, status, priority, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 1', 'done', 'high', '[]', '[]', '[]', ts, ts);

      // Week 10 (Mon Mar 9 - Sun Mar 15): 1h + 1h = 2h
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-09T08:00:00.000Z', '2026-03-09T09:00:00.000Z' // 1h
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-12T10:00:00.000Z', '2026-03-12T11:00:00.000Z' // 1h
      );
      // Week 11 (Mon Mar 16 - Sun Mar 22): 30min
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-16T09:00:00.000Z', '2026-03-16T09:30:00.000Z' // 30min
      );

      const result = await getTimeline({ group_by: 'week' });
      expect(result.isError).toBeUndefined();

      const data: Array<{ period: string; total_time: number; session_count: number }> = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(2);

      // Week 10: 2h total, 2 sessions
      const week10 = data.find(d => d.period === '2026-W10');
      expect(week10).toBeDefined();
      expect(week10!.total_time).toBe(7200000); // 2h
      expect(week10!.session_count).toBe(2);

      // Week 11: 30min, 1 session
      const week11 = data.find(d => d.period === '2026-W11');
      expect(week11).toBeDefined();
      expect(week11!.total_time).toBe(1800000); // 30min
      expect(week11!.session_count).toBe(1);
    });

    it('should filter timeline by date range', async () => {
      const db = getDb();
      const ts = '2026-03-01T00:00:00.000Z';

      db.prepare(
        'INSERT INTO tasks (title, status, priority, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 1', 'done', 'high', '[]', '[]', '[]', ts, ts);

      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-01T08:00:00.000Z', '2026-03-01T09:00:00.000Z' // outside range
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z' // inside range
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-25T08:00:00.000Z', '2026-03-25T09:00:00.000Z' // outside range
      );

      const result = await getTimeline({
        group_by: 'day',
        start_date: '2026-03-09T00:00:00.000Z',
        end_date: '2026-03-15T00:00:00.000Z',
      });
      expect(result.isError).toBeUndefined();

      const data: Array<{ period: string }> = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].period).toBe('2026-03-10');
    });

    it('should default to group_by day when not specified', async () => {
      const db = getDb();
      const ts = '2026-03-01T00:00:00.000Z';

      db.prepare(
        'INSERT INTO tasks (title, status, priority, dependencies, links, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('Task 1', 'done', 'high', '[]', '[]', '[]', ts, ts);

      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z'
      );

      const result = await getTimeline({});
      expect(result.isError).toBeUndefined();

      const data: Array<{ period: string }> = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(1);
      // period should be YYYY-MM-DD format (day grouping)
      expect(data[0].period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
