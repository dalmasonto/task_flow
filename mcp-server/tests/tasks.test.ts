import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../src/db.js';
import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  bulkCreateTasks,
  searchTasks,
} from '../src/tools/tasks.js';

describe('Task Tools', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  // --- create_task ---
  describe('createTask', () => {
    it('should create a task with title only and return defaults', async () => {
      const result = await createTask({ title: 'Test task' });
      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.content[0].text);
      expect(task.id).toBe(1);
      expect(task.title).toBe('Test task');
      expect(task.status).toBe('not_started');
      expect(task.priority).toBe('medium');
      expect(task.dependencies).toEqual([]);
      expect(task.tags).toEqual([]);
      expect(task.links).toEqual([]);
    });

    it('should create a task with all params', async () => {
      // Create a project first
      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO projects (name, color, type, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('Project A', '#ff0000', 'active_project', 'desc', now, now);

      const result = await createTask({
        title: 'Full task',
        description: 'A description',
        status: 'in_progress',
        priority: 'high',
        project_id: 1,
        dependencies: [],
        tags: ['frontend', 'urgent'],
        links: [{ label: 'GitHub', url: 'https://github.com' }],
        due_date: '2026-04-01',
        estimated_time: 120,
      });
      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.content[0].text);
      expect(task.title).toBe('Full task');
      expect(task.description).toBe('A description');
      expect(task.status).toBe('in_progress');
      expect(task.priority).toBe('high');
      expect(task.project_id).toBe(1);
      expect(task.tags).toEqual(['frontend', 'urgent']);
      expect(task.links).toEqual([{ label: 'GitHub', url: 'https://github.com' }]);
      expect(task.due_date).toBe('2026-04-01');
      expect(task.estimated_time).toBe(120);
    });

    it('should reject invalid project_id', async () => {
      const result = await createTask({ title: 'Bad project', project_id: 999 });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NOT_FOUND');
    });

    it('should reject non-existent dependency', async () => {
      const result = await createTask({ title: 'Bad dep', dependencies: [999] });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('should detect dependency cycle', async () => {
      // Create task 1 depending on nothing
      await createTask({ title: 'Task 1' });
      // Create task 2 depending on task 1
      await createTask({ title: 'Task 2', dependencies: [1] });
      // Create task 3 depending on task 2 — so chain is 1 -> 2 -> 3
      await createTask({ title: 'Task 3', dependencies: [2] });

      // Now try to update task 1 to depend on task 3 — cycle: 1->3->2->1
      const result = await updateTask({ id: 1, dependencies: [3] });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('CYCLE_DETECTED');
    });
  });

  // --- list_tasks ---
  describe('listTasks', () => {
    it('should list all tasks with no filter', async () => {
      await createTask({ title: 'A' });
      await createTask({ title: 'B' });
      const result = await listTasks({});
      const tasks = JSON.parse(result.content[0].text);
      expect(tasks).toHaveLength(2);
    });

    it('should filter by status', async () => {
      await createTask({ title: 'A', status: 'in_progress' });
      await createTask({ title: 'B' });
      const result = await listTasks({ status: 'in_progress' });
      const tasks = JSON.parse(result.content[0].text);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('A');
    });

    it('should filter by tag', async () => {
      await createTask({ title: 'Tagged', tags: ['bug'] });
      await createTask({ title: 'No tag' });
      const result = await listTasks({ tag: 'bug' });
      const tasks = JSON.parse(result.content[0].text);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('Tagged');
    });
  });

  // --- get_task ---
  describe('getTask', () => {
    it('should return task with total_time and session_count', async () => {
      await createTask({ title: 'Timed task' });
      const db = getDb();
      const start = '2026-03-20T10:00:00.000Z';
      const end = '2026-03-20T11:00:00.000Z';
      db.prepare('INSERT INTO sessions (task_id, start, end) VALUES (?, ?, ?)').run(1, start, end);

      const result = await getTask({ id: 1 });
      const task = JSON.parse(result.content[0].text);
      expect(task.id).toBe(1);
      expect(task.session_count).toBe(1);
      // ~1 hour in ms = 3600000 (allow some floating point tolerance)
      expect(task.total_time).toBeGreaterThan(3500000);
      expect(task.total_time).toBeLessThan(3700000);
    });

    it('should return NOT_FOUND for invalid ID', async () => {
      const result = await getTask({ id: 999 });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NOT_FOUND');
    });
  });

  // --- update_task ---
  describe('updateTask', () => {
    it('should update task fields', async () => {
      await createTask({ title: 'Original' });
      const result = await updateTask({ id: 1, title: 'Updated', priority: 'critical' });
      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.content[0].text);
      expect(task.title).toBe('Updated');
      expect(task.priority).toBe('critical');
    });
  });

  // --- update_task_status ---
  describe('updateTaskStatus', () => {
    it('should transition status when valid', async () => {
      await createTask({ title: 'Task' });
      // not_started -> in_progress is valid
      const result = await updateTaskStatus({ id: 1, status: 'in_progress' });
      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.content[0].text);
      expect(task.status).toBe('in_progress');
    });

    it('should reject invalid transition', async () => {
      await createTask({ title: 'Task' });
      // not_started -> done is invalid
      const result = await updateTaskStatus({ id: 1, status: 'done' });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('INVALID_TRANSITION');
    });

    it('should return NOT_FOUND for invalid task', async () => {
      const result = await updateTaskStatus({ id: 999, status: 'in_progress' });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NOT_FOUND');
    });
  });

  // --- delete_task ---
  describe('deleteTask', () => {
    it('should delete task and confirm', async () => {
      await createTask({ title: 'Doomed' });
      const result = await deleteTask({ id: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.deleted).toBe(true);

      // Verify it's gone
      const get = await getTask({ id: 1 });
      expect(get.isError).toBe(true);
    });
  });

  // --- bulk_create_tasks ---
  describe('bulkCreateTasks', () => {
    it('should create multiple tasks and return them', async () => {
      const result = await bulkCreateTasks({
        tasks: [
          { title: 'Bulk 1' },
          { title: 'Bulk 2', priority: 'high' },
          { title: 'Bulk 3', tags: ['test'] },
        ],
      });
      expect(result.isError).toBeUndefined();
      const tasks = JSON.parse(result.content[0].text);
      expect(tasks).toHaveLength(3);
      expect(tasks[0].id).toBe(1);
      expect(tasks[1].priority).toBe('high');
      expect(tasks[2].tags).toEqual(['test']);
    });
  });

  // --- search_tasks ---
  describe('searchTasks', () => {
    it('should match title case-insensitively', async () => {
      await createTask({ title: 'Fix Login Bug' });
      await createTask({ title: 'Add Feature' });
      const result = await searchTasks({ query: 'login' });
      const tasks = JSON.parse(result.content[0].text);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('Fix Login Bug');
    });

    it('should match description', async () => {
      await createTask({ title: 'Task', description: 'This involves authentication' });
      await createTask({ title: 'Other' });
      const result = await searchTasks({ query: 'authentication' });
      const tasks = JSON.parse(result.content[0].text);
      expect(tasks).toHaveLength(1);
    });
  });
});
