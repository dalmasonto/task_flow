import Dexie, { type Table } from 'dexie'
import type { Task, Project, Session, Setting, AppNotification, ActivityLog, AgentMessage, AgentRegistryEntry } from '@/types'

export class TaskFlowDB extends Dexie {
  tasks!: Table<Task>
  projects!: Table<Project>
  sessions!: Table<Session>
  settings!: Table<Setting>
  notifications!: Table<AppNotification>
  activityLogs!: Table<ActivityLog>
  agentMessages!: Table<AgentMessage>
  agentRegistry!: Table<AgentRegistryEntry>

  constructor() {
    super('TaskFlowDB')
    this.version(1).stores({
      tasks: '++id, projectId, status, *dependencies',
      projects: '++id, name',
      sessions: '++id, taskId, start, end',
      settings: '++id, key',
    })
    this.version(2).stores({
      projects: '++id, name, type',
    }).upgrade(tx => {
      return tx.table('projects').toCollection().modify(project => {
        if (!project.type) {
          project.type = 'active_project'
        }
      })
    })
    this.version(3).stores({
      notifications: '++id, type, read, createdAt',
    })
    this.version(4).stores({
      activityLogs: '++id, action, entityType, createdAt',
    })
    this.version(5).stores({
      agentMessages: '++id, projectId, status, createdAt',
    })
    this.version(6).stores({
      agentRegistry: '++id, name, status, connectedAt',
      agentMessages: '++id, projectId, senderName, recipientName, status, createdAt',
    })
    this.version(7).stores({
      agentMessages: '++id, projectId, senderName, recipientName, status, source, createdAt',
    })
    this.version(8).stores({
      agentMessages: '++id, projectId, senderName, recipientName, status, source, broadcastId, createdAt',
    })
  }
}

export const db = new TaskFlowDB()
