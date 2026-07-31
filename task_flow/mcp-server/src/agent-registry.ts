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

/** Generate a unique agent name from the project folder, auto-suffixing on collision.
 *  A name is available if no row exists or the existing row's process is dead. */
function generateName(folderName: string): string {
  const db = getDb();
  const isAvailable = (name: string): boolean => {
    const row = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name) as AgentRow | undefined;
    if (!row) return true;
    return !isAlive(row.pid);
  };
  if (isAvailable(folderName)) return folderName;
  for (let i = 2; i < 100; i++) {
    const candidate = `${folderName}:${i}`;
    if (isAvailable(candidate)) return candidate;
  }
  return `${folderName}:${Date.now()}`;
}

/** Register an agent. Returns the assigned name.
 *  Uses project_path as the stable identifier — same directory reuses
 *  disconnected entries, preserving message history across sessions.
 *  Multiple concurrent agents in the same project get suffixed names.
 */
export function registerAgent(options?: { customName?: string }): string {
  const db = getDb();
  const agentPid = process.ppid;
  const projectPath = process.cwd();
  const folderName = projectPath.split('/').pop() || 'unknown';
  const tmuxPane = detectTmuxPane(agentPid);
  const ts = new Date().toISOString();

  // Clean up dead agents first so we can reuse their entries
  checkAgentLiveness();

  // Find all entries for this project path
  const entries = db.prepare(
    'SELECT * FROM agent_registry WHERE project_path = ? ORDER BY connected_at DESC'
  ).all(projectPath) as AgentRow[];

  // Priority 0: Same PID already connected — this agent is renaming itself
  // (e.g. auto-registered as folder name, now calling register_agent with a custom name)
  const samePid = entries.find(e => e.status === 'connected' && e.pid === agentPid);
  if (samePid && options?.customName && options.customName !== samePid.name) {
    const oldName = samePid.name;
    const newName = options.customName;

    // If the target name already exists as another row (disconnected from a previous session),
    // delete it to free the UNIQUE name. Messages stay — they're linked by name string, not FK.
    const existing = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(newName) as AgentRow | undefined;
    if (existing && existing.id !== samePid.id) {
      db.prepare('DELETE FROM agent_registry WHERE id = ?').run(existing.id);
    }

    db.prepare(
      'UPDATE agent_registry SET name = ?, tmux_pane = ?, connected_at = ? WHERE id = ?'
    ).run(newName, tmuxPane, ts, samePid.id);

    const row = db.prepare('SELECT * FROM agent_registry WHERE id = ?').get(samePid.id) as AgentRow;
    broadcast('agent_renamed', { entity: 'agent', action: 'agent_renamed', payload: { ...row, oldName } });
    logActivity('agent_renamed', `Agent "${oldName}" renamed to "${newName}"`, { entityType: 'agent' });

    return newName;
  }

  // If same PID is already connected with the right name (or no custom name), just return it
  if (samePid) {
    return samePid.name;
  }

  // Reconnection priority for disconnected entries:
  //   1. Custom name matches a disconnected entry exactly — the name IS the stable identity.
  //      This is how users resume a specific agent: register_agent({ name: "sentinmail_coder" })
  //   2. Same PID — exact session resume (e.g. MCP server restarted, same shell)
  //   3. Only ONE disconnected entry — unambiguous, safe to reuse
  // When multiple disconnected entries exist and no match is found,
  // we create a fresh entry rather than guessing wrong and mixing up histories.
  const allDisconnected = entries.filter(e => e.status === 'disconnected');
  const disconnected = (options?.customName ? allDisconnected.find(e => e.name === options.customName) : undefined)
    || allDisconnected.find(e => e.pid === agentPid)
    || (allDisconnected.length === 1 ? allDisconnected[0] : undefined);
  if (disconnected) {
    const newName = options?.customName || disconnected.name;

    db.prepare(
      'UPDATE agent_registry SET name = ?, pid = ?, tmux_pane = ?, status = ?, connected_at = ?, disconnected_at = NULL WHERE id = ?'
    ).run(newName, agentPid, tmuxPane, 'connected', ts, disconnected.id);

    const row = db.prepare('SELECT * FROM agent_registry WHERE id = ?').get(disconnected.id);
    broadcast('agent_connected', { entity: 'agent', action: 'agent_connected', payload: row });
    logActivity('agent_connected', `Agent "${newName}" reconnected`, { entityType: 'agent' });

    return newName;
  }

  // Priority 3: No reusable disconnected entry — this is a new or concurrent agent
  // Generate a suffixed name to avoid collision with live agents
  const baseName = options?.customName || folderName;
  const name = entries.length === 0 ? baseName : generateName(baseName);

  // Upsert: if a dead entry with this name exists (from another project path),
  // reuse it in-place to preserve its message history. Otherwise insert fresh.
  const stale = db.prepare('SELECT * FROM agent_registry WHERE name = ?').get(name) as AgentRow | undefined;
  if (stale) {
    db.prepare(
      'UPDATE agent_registry SET project_path = ?, pid = ?, tmux_pane = ?, status = ?, connected_at = ?, disconnected_at = NULL WHERE id = ?'
    ).run(projectPath, agentPid, tmuxPane, 'connected', ts, stale.id);
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

/** Check all registered agents and mark dead ones as disconnected.
 *  Also purges entries that have been disconnected for more than 24 hours. */
export function checkAgentLiveness(): void {
  const db = getDb();

  // Mark dead connected agents as disconnected
  const liveAgents = db.prepare("SELECT * FROM agent_registry WHERE status = 'connected'").all() as AgentRow[];
  for (const agent of liveAgents) {
    if (!isAlive(agent.pid)) {
      unregisterAgent(agent.name);
    }
  }

  // Purge entries that have been disconnected for more than 24 hours
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "DELETE FROM agent_registry WHERE status = 'disconnected' AND disconnected_at IS NOT NULL AND disconnected_at < ?"
  ).run(cutoff);
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
