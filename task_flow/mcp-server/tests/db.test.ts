import { describe, it, expect, afterEach } from 'vitest';
import { initDb, closeDb, resolvePath } from '../src/db.js';

describe('Database', () => {
  afterEach(() => {
    closeDb();
  });

  it('should create all tables when initDb is called', () => {
    const db = initDb(':memory:');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);

    expect(names).toContain('tasks');
    expect(names).toContain('projects');
    expect(names).toContain('sessions');
    expect(names).toContain('activity_logs');
    expect(names).toContain('notifications');
    expect(names).toContain('settings');
  });

  it('should create indexes', () => {
    const db = initDb(':memory:');
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as { name: string }[];
    const names = indexes.map(i => i.name);

    expect(names).toContain('idx_tasks_status');
    expect(names).toContain('idx_tasks_project_id');
    expect(names).toContain('idx_sessions_task_id');
  });

  it('should expand tilde in path', () => {
    const resolved = resolvePath('~/test.db');
    expect(resolved).not.toContain('~');
    expect(resolved).toContain('test.db');
  });
});
