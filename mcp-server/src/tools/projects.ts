import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { logActivity, errorResponse, successResponse, now, broadcastChange } from '../helpers.js';
import { ProjectType } from '../types.js';

// ─── helpers ──────────────────────────────────────────────────────────

interface ProjectRow {
  id: number;
  name: string;
  color: string;
  type: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_id: number | null;
  dependencies: string;
  links: string;
  tags: string;
  due_date: string | null;
  estimated_time: number | null;
  created_at: string;
  updated_at: string;
}

function parseTask(row: TaskRow) {
  return {
    ...row,
    dependencies: JSON.parse(row.dependencies) as number[],
    links: JSON.parse(row.links) as Array<{ label: string; url: string }>,
    tags: JSON.parse(row.tags) as string[],
  };
}

// ─── exported handler functions ───────────────────────────────────────

export async function createProject(params: {
  name: string;
  color?: string;
  type?: string;
  description?: string;
}) {
  const db = getDb();
  const {
    name,
    color = '#de8eff',
    type = 'active_project',
    description,
  } = params;

  const ts = now();
  const result = db.prepare(
    `INSERT INTO projects (name, color, type, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, color, type, description ?? null, ts, ts);

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid) as ProjectRow;
  logActivity('project_created', name, { entityType: 'project', entityId: project.id });

  const createdProject = project;
  broadcastChange('project', 'project_created', createdProject);
  return successResponse(createdProject);
}

export async function listProjects() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT projects.*, COUNT(tasks.id) AS task_count
     FROM projects
     LEFT JOIN tasks ON tasks.project_id = projects.id
     GROUP BY projects.id`
  ).all() as Array<ProjectRow & { task_count: number }>;

  return successResponse(rows);
}

export async function getProject(params: { id: number }) {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id) as ProjectRow | undefined;
  if (!project) return errorResponse('Project not found', 'NOT_FOUND');

  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(params.id) as TaskRow[];

  return successResponse({
    ...project,
    tasks: tasks.map(parseTask),
  });
}

export async function updateProject(params: {
  id: number;
  name?: string;
  color?: string;
  type?: string;
  description?: string;
}) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id) as ProjectRow | undefined;
  if (!existing) return errorResponse('Project not found', 'NOT_FOUND');

  const updates: Record<string, unknown> = {};
  if (params.name !== undefined) updates.name = params.name;
  if (params.color !== undefined) updates.color = params.color;
  if (params.type !== undefined) updates.type = params.type;
  if (params.description !== undefined) updates.description = params.description;

  if (Object.keys(updates).length === 0) {
    return successResponse(existing);
  }

  updates.updated_at = now();
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  db.prepare(`UPDATE projects SET ${setClauses} WHERE id = ?`).run(...vals, params.id);

  logActivity('project_updated', params.name ?? existing.name, { entityType: 'project', entityId: params.id });

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id) as ProjectRow;
  const updatedProject = updated;
  broadcastChange('project', 'project_updated', updatedProject);
  return successResponse(updatedProject);
}

export async function deleteProject(params: { id: number }) {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id) as ProjectRow | undefined;
  if (!project) return errorResponse('Project not found', 'NOT_FOUND');

  // FK ON DELETE SET NULL handles unlinking tasks automatically
  db.prepare('DELETE FROM projects WHERE id = ?').run(params.id);
  logActivity('project_deleted', project.name, { entityType: 'project', entityId: params.id });

  broadcastChange('project', 'project_deleted', { id: params.id });
  return successResponse({ deleted: true, id: params.id });
}

export async function searchProjects(params: { query: string }) {
  const db = getDb();
  const like = `%${params.query}%`;
  const rows = db.prepare(
    `SELECT projects.*, COUNT(tasks.id) AS task_count
     FROM projects
     LEFT JOIN tasks ON tasks.project_id = projects.id
     WHERE projects.name LIKE ? COLLATE NOCASE OR projects.description LIKE ? COLLATE NOCASE
     GROUP BY projects.id`
  ).all(like, like) as Array<ProjectRow & { task_count: number }>;

  return successResponse(rows);
}

// ─── MCP registration ─────────────────────────────────────────────────

export function registerProjectTools(server: McpServer) {
  server.tool(
    'create_project',
    'Create a new project. Projects group related tasks and track time across them.',
    {
      name: z.string(),
      color: z.string().optional(),
      type: ProjectType.optional(),
      description: z.string().optional(),
    },
    async (params) => createProject(params),
  );

  server.tool(
    'list_projects',
    'List all projects with task count. Call this at conversation start to understand the workspace.',
    {},
    async () => listProjects(),
  );

  server.tool(
    'get_project',
    'Get a project by ID with all its tasks. Use this to understand the full scope of a project before starting work.',
    { id: z.number() },
    async (params) => getProject(params),
  );

  server.tool(
    'update_project',
    'Update project fields such as name, color, type, or description.',
    {
      id: z.number(),
      name: z.string().optional(),
      color: z.string().optional(),
      type: ProjectType.optional(),
      description: z.string().optional(),
    },
    async (params) => updateProject(params),
  );

  server.tool(
    'delete_project',
    'Delete a project by ID. Tasks under this project will be unlinked (project_id set to NULL), not deleted.',
    { id: z.number() },
    async (params) => deleteProject(params),
  );

  server.tool(
    'search_projects',
    'Search projects by name or description. Use this to find projects related to your current work.',
    { query: z.string() },
    async (params) => searchProjects(params),
  );
}
