import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../src/db.js';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
} from '../src/tools/projects.js';

describe('Project Tools', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  // --- create_project ---
  describe('createProject', () => {
    it('should create a project with name only and apply defaults', async () => {
      const result = await createProject({ name: 'My Project' });
      expect(result.isError).toBeUndefined();
      const project = JSON.parse(result.content[0].text);
      expect(project.id).toBe(1);
      expect(project.name).toBe('My Project');
      expect(project.color).toBe('#de8eff');
      expect(project.type).toBe('active_project');
      expect(project.description).toBeNull();
      expect(project.created_at).toBeTruthy();
      expect(project.updated_at).toBeTruthy();
    });

    it('should create a project with all params', async () => {
      const result = await createProject({
        name: 'Full Project',
        color: '#ff0000',
        type: 'project_idea',
        description: 'A full description',
      });
      expect(result.isError).toBeUndefined();
      const project = JSON.parse(result.content[0].text);
      expect(project.name).toBe('Full Project');
      expect(project.color).toBe('#ff0000');
      expect(project.type).toBe('project_idea');
      expect(project.description).toBe('A full description');
    });
  });

  // --- list_projects ---
  describe('listProjects', () => {
    it('should list all projects with task_count', async () => {
      await createProject({ name: 'Project A' });
      await createProject({ name: 'Project B' });

      // Link a task to project 1
      const db = getDb();
      const ts = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('Task 1', 'not_started', 'medium', 1, '[]', '[]', '[]', ts, ts);

      const result = await listProjects();
      expect(result.isError).toBeUndefined();
      const projects = JSON.parse(result.content[0].text);
      expect(projects).toHaveLength(2);

      const projA = projects.find((p: { id: number }) => p.id === 1);
      const projB = projects.find((p: { id: number }) => p.id === 2);
      expect(projA.task_count).toBe(1);
      expect(projB.task_count).toBe(0);
    });

    it('should return empty array when no projects exist', async () => {
      const result = await listProjects();
      expect(result.isError).toBeUndefined();
      const projects = JSON.parse(result.content[0].text);
      expect(projects).toHaveLength(0);
    });
  });

  // --- get_project ---
  describe('getProject', () => {
    it('should return project with its tasks array', async () => {
      await createProject({ name: 'Project with Tasks' });

      const db = getDb();
      const ts = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('Task A', 'not_started', 'medium', 1, '[]', '[]', '[]', ts, ts);
      db.prepare(
        `INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('Task B', 'in_progress', 'high', 1, '[]', '[]', '[]', ts, ts);

      const result = await getProject({ id: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe(1);
      expect(data.name).toBe('Project with Tasks');
      expect(Array.isArray(data.tasks)).toBe(true);
      expect(data.tasks).toHaveLength(2);
      expect(data.tasks[0].title).toBe('Task A');
      expect(data.tasks[1].title).toBe('Task B');
    });

    it('should return NOT_FOUND for invalid ID', async () => {
      const result = await getProject({ id: 999 });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NOT_FOUND');
    });
  });

  // --- update_project ---
  describe('updateProject', () => {
    it('should update project fields', async () => {
      await createProject({ name: 'Original Name' });
      const result = await updateProject({
        id: 1,
        name: 'Updated Name',
        color: '#123456',
        type: 'project_idea',
        description: 'New description',
      });
      expect(result.isError).toBeUndefined();
      const project = JSON.parse(result.content[0].text);
      expect(project.name).toBe('Updated Name');
      expect(project.color).toBe('#123456');
      expect(project.type).toBe('project_idea');
      expect(project.description).toBe('New description');
    });

    it('should return NOT_FOUND for invalid ID', async () => {
      const result = await updateProject({ id: 999, name: 'Ghost' });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NOT_FOUND');
    });

    it('should update updated_at timestamp', async () => {
      await createProject({ name: 'Time Check' });
      const before = JSON.parse((await getProject({ id: 1 })).content[0].text);
      // Small delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 10));
      await updateProject({ id: 1, name: 'Time Check Updated' });
      const after = JSON.parse((await getProject({ id: 1 })).content[0].text);
      expect(after.updated_at >= before.updated_at).toBe(true);
    });
  });

  // --- delete_project ---
  describe('deleteProject', () => {
    it('should delete project and set tasks project_id to NULL', async () => {
      await createProject({ name: 'Doomed Project' });

      const db = getDb();
      const ts = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (title, status, priority, project_id, dependencies, links, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('Linked Task', 'not_started', 'medium', 1, '[]', '[]', '[]', ts, ts);

      const result = await deleteProject({ id: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.deleted).toBe(true);
      expect(data.id).toBe(1);

      // Project is gone
      const gone = await getProject({ id: 1 });
      expect(gone.isError).toBe(true);

      // Task still exists but project_id is NULL
      const taskRow = db.prepare('SELECT project_id FROM tasks WHERE id = 1').get() as { project_id: number | null };
      expect(taskRow.project_id).toBeNull();
    });

    it('should return NOT_FOUND for invalid ID', async () => {
      const result = await deleteProject({ id: 999 });
      expect(result.isError).toBe(true);
      const err = JSON.parse(result.content[0].text);
      expect(err.code).toBe('NOT_FOUND');
    });
  });
});
