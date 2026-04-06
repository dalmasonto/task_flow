import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import { getConfig } from './config.js';

let db: Database.Database | null = null;

// Expands ~/path to $HOME/path. Only handles ~/ prefix, not ~user/ paths.
export function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

export function getDb(): Database.Database {
  if (db) return db;
  return initDb(getConfig().databasePath);
}

// For testing: initialize with a specific path (use ':memory:' for tests)
export function initDb(path: string): Database.Database {
  if (db) { db.close(); db = null; }

  const dbPath = path === ':memory:' ? ':memory:' : resolvePath(path);
  if (path !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#de8eff',
      type TEXT NOT NULL DEFAULT 'active_project',
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'not_started',
      priority TEXT NOT NULL DEFAULT 'medium',
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      dependencies TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      estimated_time INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      start TEXT NOT NULL,
      end TEXT
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      context TEXT,
      choices TEXT,
      response TEXT,
      agent_pid INTEGER,
      delivered INTEGER,
      sender_name TEXT NOT NULL DEFAULT 'unknown',
      recipient_name TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'mcp',
      created_at TEXT NOT NULL,
      answered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      project_path TEXT NOT NULL,
      pid INTEGER NOT NULL,
      tmux_pane TEXT,
      status TEXT NOT NULL DEFAULT 'connected',
      connected_at TEXT NOT NULL,
      disconnected_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_project_id ON agent_messages(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);
    CREATE INDEX IF NOT EXISTS idx_agent_registry_name ON agent_registry(name);

    CREATE TABLE IF NOT EXISTS tool_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_executions_tool_name ON tool_executions(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_created_at ON tool_executions(created_at);
  `);

  // Migrations — add columns that may be missing on existing databases
  const cols = db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('agent_pid')) {
    db.exec('ALTER TABLE agent_messages ADD COLUMN agent_pid INTEGER');
  }
  if (!colNames.has('delivered')) {
    db.exec('ALTER TABLE agent_messages ADD COLUMN delivered INTEGER');
  }
  if (!colNames.has('sender_name')) {
    db.exec("ALTER TABLE agent_messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!colNames.has('recipient_name')) {
    db.exec("ALTER TABLE agent_messages ADD COLUMN recipient_name TEXT NOT NULL DEFAULT 'user'");
  }
  if (!colNames.has('source')) {
    db.exec("ALTER TABLE agent_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'mcp'");
  }

  // Migration: make agent_messages.project_id nullable if it was NOT NULL
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_messages'").get() as { sql: string } | undefined;
    if (tableInfo?.sql?.includes('project_id INTEGER NOT NULL')) {
      db.exec(`
        CREATE TABLE agent_messages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          context TEXT,
          choices TEXT,
          response TEXT,
          agent_pid INTEGER,
          delivered INTEGER,
          sender_name TEXT NOT NULL DEFAULT 'unknown',
          recipient_name TEXT NOT NULL DEFAULT 'user',
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT 'mcp',
          created_at TEXT NOT NULL,
          answered_at TEXT
        );
        INSERT INTO agent_messages_new SELECT
          id, project_id, question, context, choices, response, agent_pid, delivered,
          COALESCE(sender_name, 'unknown'), COALESCE(recipient_name, 'user'),
          status, COALESCE(source, 'mcp'), created_at, answered_at
        FROM agent_messages;
        DROP TABLE agent_messages;
        ALTER TABLE agent_messages_new RENAME TO agent_messages;
        CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status);
        CREATE INDEX IF NOT EXISTS idx_agent_messages_project_id ON agent_messages(project_id);
      `);
    }
  } catch { /* table may not exist yet */ }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
