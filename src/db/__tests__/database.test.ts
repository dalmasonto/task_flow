import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../database'

describe('TaskFlowDB', () => {
  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('should create a task', async () => {
    const id = await db.tasks.add({
      title: 'Test task',
      status: 'not_started',
      priority: 'medium',
      dependencies: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const task = await db.tasks.get(id)
    expect(task?.title).toBe('Test task')
  })

  it('should create a project', async () => {
    const id = await db.projects.add({
      name: 'Test project',
      color: '#de8eff',
      createdAt: new Date(),
    })
    const project = await db.projects.get(id)
    expect(project?.name).toBe('Test project')
  })

  it('should create a session', async () => {
    const taskId = await db.tasks.add({
      title: 'Timer task',
      status: 'in_progress',
      priority: 'medium',
      dependencies: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const sessionId = await db.sessions.add({
      taskId,
      start: new Date(),
    })
    const session = await db.sessions.get(sessionId)
    expect(session?.taskId).toBe(taskId)
    expect(session?.end).toBeUndefined()
  })

  it('should query tasks by status', async () => {
    await db.tasks.bulkAdd([
      { title: 'A', status: 'not_started', priority: 'low', dependencies: [], createdAt: new Date(), updatedAt: new Date() },
      { title: 'B', status: 'in_progress', priority: 'high', dependencies: [], createdAt: new Date(), updatedAt: new Date() },
      { title: 'C', status: 'not_started', priority: 'medium', dependencies: [], createdAt: new Date(), updatedAt: new Date() },
    ])
    const notStarted = await db.tasks.where('status').equals('not_started').toArray()
    expect(notStarted).toHaveLength(2)
  })
})
