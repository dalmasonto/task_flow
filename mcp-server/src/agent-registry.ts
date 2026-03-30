import { execSync } from 'child_process';
import { getDb } from './db.js';
import { broadcast } from './sse.js';
import { logActivity } from './helpers.js';

interface AgentRow {
  id: number;
  name: string;
  project_path: string;
  pid: number;
  tmux_pane: string | null;
  status: string;
  connected_at: string;
  disconnected_at: string | null;
}

/** Check if a process is still alive */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** Detect the tmux pane for a given PID */
function detectTmuxPane(pid: number): string | null {
  try {
    const ptsPath = execSync(`readlink /proc/${pid}/fd/0`).toString().trim();
    const panes = execSync('tmux list-panes -a -F "#{pane_id} #{pane_tty}"').toString().trim().split('\n');
    for (const line of panes) {
      const [paneId, paneTty] = line.split(' ');
      if (paneTty === ptsPath) return paneId;
    }
  } catch { /* tmux not available */ }
  return null;
}

/** Generate a unique agent name from the project folder, auto-suffixing on collision */
function generateName(folderName: string): string {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(folderName) as AgentRow | undefined;
  if (!existing || !isAlive(existing.pid)) {
    return folderName;
  }
  for (let i = 2; i < 100; i++) {
    const candidate = `${folderName}:${i}`;
    const row = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(candidate) as AgentRow | undefined;
    if (!row || !isAlive(row.pid)) return candidate;
  }
  return `${folderName}:${Date.now()}`;
}

/** Register an agent. Returns the assigned name. */
export function registerAgent(options?: { customName?: string }): string {
  const db = getDb();
  const agentPid = process.ppid;
  const projectPath = process.cwd();
  const folderName = projectPath.split('/').pop() || 'unknown';

  const name = options?.customName || generateName(folderName);
  const tmuxPane = detectTmuxPane(agentPid);
  const ts = new Date().toISOString();

  const existing = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name) as AgentRow | undefined;
  if (existing) {
    db.prepare(
      'UPDATE agent_registry SET project_path = ?, pid = ?, tmux_pane = ?, status = ?, connected_at = ?, disconnected_at = NULL WHERE name = ?'
    ).run(projectPath, agentPid, tmuxPane, 'connected', ts, name);
  } else {
    db.prepare(
      'INSERT INTO agent_registry (name, project_path, pid, tmux_pane, status, connected_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, projectPath, agentPid, tmuxPane, 'connected', ts);
  }

  const row = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name);
  broadcast('agent_connected', { entity: 'agent', action: 'agent_connected', payload: row });
  logActivity('agent_connected', `Agent "${name}" connected`, { entityType: 'agent' });

  return name;
}

/** Mark an agent as disconnected */
export function unregisterAgent(name: string): void {
  const db = getDb();
  const ts = new Date().toISOString();
  db.prepare("UPDATE agent_registry SET status = 'disconnected', disconnected_at = ? WHERE name = ?").run(ts, name);

  const row = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name);
  broadcast('agent_disconnected', { entity: 'agent', action: 'agent_disconnected', payload: row });
  logActivity('agent_disconnected', `Agent "${name}" disconnected`, { entityType: 'agent' });
}

/** Check all registered agents and mark dead ones as disconnected */
export function checkAgentLiveness(): void {
  const db = getDb();
  const liveAgents = db.prepare("SELECT * FROM agent_registry WHERE status = 'connected'").all() as AgentRow[];
  for (const agent of liveAgents) {
    if (!isAlive(agent.pid)) {
      unregisterAgent(agent.name);
    }
  }
}

/** Get a registered agent by name */
export function getAgent(name: string): AgentRow | undefined {
  return getDb().prepare('SELECT * FROM agent_registry WHERE name = ?').get(name) as AgentRow | undefined;
}

/** List all agents, optionally filtered by status */
export function listAgents(status?: string): AgentRow[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM agent_registry WHERE status = ? ORDER BY connected_at DESC').all(status) as AgentRow[];
  }
  return db.prepare('SELECT * FROM agent_registry ORDER BY connected_at DESC').all() as AgentRow[];
}
