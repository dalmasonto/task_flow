import Dexie, { type Table } from 'dexie'
import type { Task, Project, Session, Setting, AppNotification } from '@/types'

export class TaskFlowDB extends Dexie {
  tasks!: Table<Task>
  projects!: Table<Project>
  sessions!: Table<Session>
  settings!: Table<Setting>
  notifications!: Table<AppNotification>

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
  }
}

export const db = new TaskFlowDB()
