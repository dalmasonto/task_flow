import { z } from 'zod';

export const TaskStatus = z.enum([
  'not_started', 'in_progress', 'paused', 'blocked', 'partial_done', 'done'
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['low', 'medium', 'high', 'critical']);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const ProjectType = z.enum(['active_project', 'project_idea']);
export type ProjectType = z.infer<typeof ProjectType>;

export const NotificationType = z.enum(['info', 'success', 'warning', 'error']);
export type NotificationType = z.infer<typeof NotificationType>;

export const AgentMessageStatus = z.enum(['pending', 'answered', 'dismissed']);
export type AgentMessageStatus = z.infer<typeof AgentMessageStatus>;

export const AgentStatus = z.enum(['connected', 'disconnected']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const ActivityAction = z.enum([
  'task_created', 'task_deleted', 'task_status_changed', 'task_completed',
  'task_partial_done', 'timer_started', 'timer_paused', 'timer_stopped',
  'project_created', 'project_deleted', 'project_updated',
  'tasks_bulk_created', 'settings_saved', 'data_seeded', 'data_cleared',
  'task_linked', 'task_unlinked', 'dependency_added', 'dependency_removed',
  'link_added', 'tag_added', 'tag_removed', 'debug_log',
  'agent_question', 'agent_question_answered', 'agent_broadcast',
  'agent_connected', 'agent_disconnected', 'agent_renamed',
  'terminal_send_keys', 'terminal_captured',
  'compaction_summary', 'activity_compacted',
]);
export type ActivityAction = z.infer<typeof ActivityAction>;

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  not_started: ['in_progress', 'blocked'],
  in_progress: ['paused', 'blocked', 'partial_done', 'done'],
  paused: ['in_progress', 'blocked', 'partial_done', 'done'],
  blocked: ['not_started', 'in_progress'],
  partial_done: ['in_progress', 'done'],
  done: ['in_progress'],
};

export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'VALIDATION_ERROR'
  | 'CYCLE_DETECTED'
  | 'SESSION_ALREADY_ACTIVE'
  | 'NO_ACTIVE_SESSION'
  | 'ALREADY_ANSWERED';

export const LinkSchema = z.object({ label: z.string(), url: z.string() });
