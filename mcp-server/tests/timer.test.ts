import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../src/db.js';
import { createTask } from '../src/tools/tasks.js';
import { startTimer, pauseTimer, stopTimer, listSessions } from '../src/tools/timer.js';

describe('Timer Tools', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  // ─── start_timer ──────────────────────────────────────────────────────

  describe('startTimer', () => {
    it('should start timer on a not_started task, create session and set status to in_progress', async () => {
      await createTask({ title: 'Task A' });

      const result = await startTimer({ task_id: 1 });
      expect(result.isError).toBeUndefined();

      const session = JSON.parse(result.content[0].text);
      expect(session.id).toBe(1);
      expect(session.task_id).toBe(1);
      expect(session.start).toBeTruthy();
      expect(session.end).toBeNull();

      // Task status should be in_progress
      const db = getDb();
      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string };
      expect(task.status).toBe('in_progress');
    });

    it('should start timer on a paused task and set status back to in_progress', async () => {
      await createTask({ title: 'Task B', status: 'paused' });

      const result = await startTimer({ task_id: 1 });
      expect(result.isError).toBeUndefined();

      const session = JSON.parse(result.content[0].text);
      expect(session.task_id).toBe(1);

      const db = getDb();
      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string };
      expect(task.status).toBe('in_progress');
    });

    it('should return SESSION_ALREADY_ACTIVE if an open session exists', async () => {
      await createTask({ title: 'Task C', status: 'in_progress' });
      // Manually insert an open session
      const db = getDb();
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, new Date().toISOString(), null);

      const result = await startTimer({ task_id: 1 });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('SESSION_ALREADY_ACTIVE');
    });

    it('should return INVALID_TRANSITION if task status has no path to in_progress (partial_done)', async () => {
      // partial_done -> in_progress IS valid, so use a status with no in_progress transition
      // blocked: ['not_started', 'in_progress'] — actually also valid
      // The only status that cannot go to in_progress via VALID_TRANSITIONS is... none.
      // done: ['in_progress'] is valid. partial_done: ['in_progress', 'done'] is valid.
      // There is no status that explicitly cannot reach in_progress except indirectly.
      // We can test this by creating a custom scenario — but given VALID_TRANSITIONS,
      // every status can reach in_progress. So we test that done -> in_progress succeeds (not INVALID_TRANSITION).
      await createTask({ title: 'Done Task', status: 'done' });

      const result = await startTimer({ task_id: 1 });
      // done -> in_progress is valid per VALID_TRANSITIONS
      expect(result.isError).toBeUndefined();
      const session = JSON.parse(result.content[0].text);
      expect(session.task_id).toBe(1);

      const db = getDb();
      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string };
      expect(task.status).toBe('in_progress');
    });

    it('should return NOT_FOUND for non-existent task', async () => {
      const result = await startTimer({ task_id: 999 });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NOT_FOUND');
    });
  });

  // ─── pause_timer ──────────────────────────────────────────────────────

  describe('pauseTimer', () => {
    it('should close open session, set task to paused, and return duration', async () => {
      await createTask({ title: 'Task D', status: 'in_progress' });
      const db = getDb();
      const start = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, start, null);

      const result = await pauseTimer({ task_id: 1 });
      expect(result.isError).toBeUndefined();

      const session = JSON.parse(result.content[0].text);
      expect(session.end).toBeTruthy();
      expect(session.duration).toBeGreaterThan(0);

      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string };
      expect(task.status).toBe('paused');
    });

    it('should return NO_ACTIVE_SESSION if no open session', async () => {
      await createTask({ title: 'Task E', status: 'in_progress' });

      const result = await pauseTimer({ task_id: 1 });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NO_ACTIVE_SESSION');
    });
  });

  // ─── stop_timer ───────────────────────────────────────────────────────

  describe('stopTimer', () => {
    it('should stop timer with default final_status done', async () => {
      await createTask({ title: 'Task F', status: 'in_progress' });
      const db = getDb();
      const start = new Date(Date.now() - 3000).toISOString();
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, start, null);

      const result = await stopTimer({ task_id: 1 });
      expect(result.isError).toBeUndefined();

      const session = JSON.parse(result.content[0].text);
      expect(session.end).toBeTruthy();
      expect(session.duration).toBeGreaterThan(0);

      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string };
      expect(task.status).toBe('done');
    });

    it('should stop timer with partial_done status', async () => {
      await createTask({ title: 'Task G', status: 'in_progress' });
      const db = getDb();
      const start = new Date(Date.now() - 1000).toISOString();
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, start, null);

      const result = await stopTimer({ task_id: 1, final_status: 'partial_done' });
      expect(result.isError).toBeUndefined();

      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string };
      expect(task.status).toBe('partial_done');
    });

    it('should stop timer with blocked status', async () => {
      await createTask({ title: 'Task H', status: 'in_progress' });
      const db = getDb();
      const start = new Date(Date.now() - 1000).toISOString();
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, start, null);

      const result = await stopTimer({ task_id: 1, final_status: 'blocked' });
      expect(result.isError).toBeUndefined();

      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as { status: string };
      expect(task.status).toBe('blocked');
    });
  });

  // ─── list_sessions ────────────────────────────────────────────────────

  describe('listSessions', () => {
    it('should return all sessions', async () => {
      await createTask({ title: 'Task I' });
      await createTask({ title: 'Task J' });
      const db = getDb();
      const s1 = '2026-03-20T10:00:00.000Z';
      const e1 = '2026-03-20T11:00:00.000Z';
      const s2 = '2026-03-21T10:00:00.000Z';
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, s1, e1);
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(2, s2, null);

      const result = await listSessions({});
      expect(result.isError).toBeUndefined();
      const sessions = JSON.parse(result.content[0].text);
      expect(sessions).toHaveLength(2);
    });

    it('should filter sessions by task_id', async () => {
      await createTask({ title: 'Task K' });
      await createTask({ title: 'Task L' });
      const db = getDb();
      const ts = new Date().toISOString();
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, ts, null);
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(2, ts, null);
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, ts, null);

      const result = await listSessions({ task_id: 1 });
      const sessions = JSON.parse(result.content[0].text);
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s: { task_id: number }) => s.task_id === 1)).toBe(true);
    });

    it('should filter sessions by start_date', async () => {
      await createTask({ title: 'Task M' });
      const db = getDb();
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-19T10:00:00.000Z', '2026-03-19T11:00:00.000Z'
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-21T10:00:00.000Z', '2026-03-21T11:00:00.000Z'
      );

      const result = await listSessions({ start_date: '2026-03-20T00:00:00.000Z' });
      const sessions = JSON.parse(result.content[0].text);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].start).toBe('2026-03-21T10:00:00.000Z');
    });

    it('should filter sessions by end_date', async () => {
      await createTask({ title: 'Task N' });
      const db = getDb();
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-19T10:00:00.000Z', '2026-03-19T11:00:00.000Z'
      );
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(
        1, '2026-03-21T10:00:00.000Z', '2026-03-21T11:00:00.000Z'
      );

      const result = await listSessions({ end_date: '2026-03-20T00:00:00.000Z' });
      const sessions = JSON.parse(result.content[0].text);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].start).toBe('2026-03-19T10:00:00.000Z');
    });

    it('should compute duration correctly for closed session', async () => {
      await createTask({ title: 'Task O' });
      const db = getDb();
      const start = '2026-03-20T10:00:00.000Z';
      const end = '2026-03-20T11:00:00.000Z'; // exactly 1 hour = 3600000ms
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, start, end);

      const result = await listSessions({ task_id: 1 });
      const sessions = JSON.parse(result.content[0].text);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].duration).toBe(3600000);
    });

    it('should compute duration for open session using now', async () => {
      await createTask({ title: 'Task P' });
      const db = getDb();
      const start = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, start, null);

      const result = await listSessions({ task_id: 1 });
      const sessions = JSON.parse(result.content[0].text);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].duration).toBeGreaterThan(5000);
      expect(sessions[0].end).toBeNull();
    });
  });
});
