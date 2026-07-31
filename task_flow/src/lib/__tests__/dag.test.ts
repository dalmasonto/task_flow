import { describe, it, expect } from 'vitest'
import { hasCycle, getBlockers, getDependents } from '../dag'
import type { Task } from '@/types'

const makeTasks = (taskDefs: Array<{ id: number; dependencies: number[]; status?: string }>): Task[] =>
  taskDefs.map(({ id, dependencies, status }) => ({
    id,
    title: `Task ${id}`,
    status: (status ?? 'not_started') as Task['status'],
    priority: 'medium' as const,
    dependencies,
    createdAt: new Date(),
    updatedAt: new Date(),
  }))

describe('hasCycle', () => {
  it('returns false for no dependencies', () => {
    const tasks = makeTasks([{ id: 1, dependencies: [] }])
    expect(hasCycle(tasks, 1, 2)).toBe(false)
  })

  it('returns true for direct cycle', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [2] },
      { id: 2, dependencies: [] },
    ])
    expect(hasCycle(tasks, 2, 1)).toBe(true)
  })

  it('returns true for indirect cycle', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [2] },
      { id: 2, dependencies: [3] },
      { id: 3, dependencies: [] },
    ])
    expect(hasCycle(tasks, 3, 1)).toBe(true)
  })

  it('returns false for valid dependency', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [] },
      { id: 2, dependencies: [1] },
      { id: 3, dependencies: [] },
    ])
    expect(hasCycle(tasks, 3, 1)).toBe(false)
  })
})

describe('getBlockers', () => {
  it('returns empty array when no dependencies', () => {
    const tasks = makeTasks([{ id: 1, dependencies: [] }])
    expect(getBlockers(tasks, 1)).toEqual([])
  })

  it('returns undone dependencies', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [], status: 'not_started' },
      { id: 2, dependencies: [], status: 'done' },
      { id: 3, dependencies: [1, 2], status: 'not_started' },
    ])
    const blockers = getBlockers(tasks, 3)
    expect(blockers).toHaveLength(1)
    expect(blockers[0].id).toBe(1)
  })
})

describe('getDependents', () => {
  it('returns tasks that depend on the given task', () => {
    const tasks = makeTasks([
      { id: 1, dependencies: [] },
      { id: 2, dependencies: [1] },
      { id: 3, dependencies: [1] },
      { id: 4, dependencies: [2] },
    ])
    const dependents = getDependents(tasks, 1)
    expect(dependents.map(t => t.id)).toEqual([2, 3])
  })
})
