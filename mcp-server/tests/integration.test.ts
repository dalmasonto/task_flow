import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { initDb, closeDb } from '../src/db.js';
import { registerTaskTools, createTask } from '../src/tools/tasks.js';
import { registerProjectTools, createProject } from '../src/tools/projects.js';
import { registerTimerTools, startTimer, stopTimer } from '../src/tools/timer.js';
import { registerAnalyticsTools, getAnalytics } from '../src/tools/analytics.js';
import { registerActivityTools, getActivityLog } from '../src/tools/activity.js';
import { registerNotificationTools } from '../src/tools/notifications.js';
import { registerSettingsTools } from '../src/tools/settings.js';

describe('Integration: Server Entry Point', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('registers all 32 tools on the server', async () => {
    const server = new McpServer({ name: 'taskflow', version: '1.0.0' });

    registerTaskTools(server);
    registerProjectTools(server);
    registerTimerTools(server);
    registerAnalyticsTools(server);
    registerActivityTools(server);
    registerNotificationTools(server);
    registerSettingsTools(server);

    // Access internal tool registry (private field)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registeredTools = (server as any)._registeredTools as Record<string, unknown>;
    const toolNames = Object.keys(registeredTools);

    expect(toolNames.length).toBe(32);

    // Spot-check a tool from each module
    expect(toolNames).toContain('create_task');
    expect(toolNames).toContain('list_tasks');
    expect(toolNames).toContain('get_task');
    expect(toolNames).toContain('update_task');
    expect(toolNames).toContain('update_task_status');
    expect(toolNames).toContain('delete_task');
    expect(toolNames).toContain('bulk_create_tasks');
    expect(toolNames).toContain('search_tasks');
    expect(toolNames).toContain('create_project');
    expect(toolNames).toContain('list_projects');
    expect(toolNames).toContain('get_project');
    expect(toolNames).toContain('update_project');
    expect(toolNames).toContain('delete_project');
    expect(toolNames).toContain('start_timer');
    expect(toolNames).toContain('pause_timer');
    expect(toolNames).toContain('stop_timer');
    expect(toolNames).toContain('list_sessions');
    expect(toolNames).toContain('get_analytics');
    expect(toolNames).toContain('get_timeline');
    expect(toolNames).toContain('get_activity_log');
    expect(toolNames).toContain('clear_activity_log');

    await server.close();
  });

  it('full workflow: project -> task -> timer -> analytics -> activity', async () => {
    // Step 1: Create a project
    const projectResult = await createProject({ name: 'Integration Project', color: '#abc123' });
    expect(projectResult.isError).toBeUndefined();
    const project = JSON.parse(projectResult.content[0].text);
    expect(project.id).toBe(1);
    expect(project.name).toBe('Integration Project');

    // Step 2: Create a task linked to the project
    const taskResult = await createTask({
      title: 'Integration Task',
      project_id: project.id,
    });
    expect(taskResult.isError).toBeUndefined();
    const task = JSON.parse(taskResult.content[0].text);
    expect(task.id).toBe(1);
    expect(task.project_id).toBe(project.id);
    expect(task.status).toBe('not_started');

    // Step 3: Start timer on the task
    const startResult = await startTimer({ task_id: task.id });
    expect(startResult.isError).toBeUndefined();
    const session = JSON.parse(startResult.content[0].text);
    expect(session.task_id).toBe(task.id);
    expect(session.end).toBeNull();

    // Small artificial delay to ensure duration > 0
    await new Promise(resolve => setTimeout(resolve, 5));

    // Step 4: Stop timer (done)
    const stopResult = await stopTimer({ task_id: task.id, final_status: 'done' });
    expect(stopResult.isError).toBeUndefined();
    const stoppedSession = JSON.parse(stopResult.content[0].text);
    expect(stoppedSession.end).not.toBeNull();
    expect(stoppedSession.duration).toBeGreaterThan(0);

    // Step 5: Get analytics — verify total_focused_time > 0, tasks_completed = 1
    const analyticsResult = await getAnalytics({});
    expect(analyticsResult.isError).toBeUndefined();
    const analytics = JSON.parse(analyticsResult.content[0].text);
    expect(analytics.total_focused_time).toBeGreaterThan(0);
    expect(analytics.tasks_completed).toBe(1);

    // Step 6: Check activity log has entries
    const activityResult = await getActivityLog({});
    expect(activityResult.isError).toBeUndefined();
    const activityData = JSON.parse(activityResult.content[0].text);
    expect(Array.isArray(activityData)).toBe(true);
    expect(activityData.length).toBeGreaterThan(0);

    // Verify some expected actions appear in the log
    const actions = activityData.map((entry: { action: string }) => entry.action);
    expect(actions).toContain('project_created');
    expect(actions).toContain('task_created');
    expect(actions).toContain('timer_started');
    expect(actions).toContain('timer_stopped');
    expect(actions).toContain('task_completed');
  });
});
