import Dexie, { type Table } from 'dexie'
import type { Task, Project, Session, Setting } from '@/types'

export class TaskFlowDB extends Dexie {
  tasks!: Table<Task>
  projects!: Table<Project>
  sessions!: Table<Session>
  settings!: Table<Setting>

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
  }
}

export const db = new TaskFlowDB()
