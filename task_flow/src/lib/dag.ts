import type { Task } from '@/types'

export function hasCycle(tasks: Task[], fromTaskId: number, toTaskId: number): boolean {
  const taskMap = new Map(tasks.map(t => [t.id!, t]))
  const visited = new Set<number>()

  function dfs(currentId: number): boolean {
    if (currentId === fromTaskId) return true
    if (visited.has(currentId)) return false
    visited.add(currentId)

    const task = taskMap.get(currentId)
    if (!task) return false

    for (const depId of task.dependencies) {
      if (dfs(depId)) return true
    }
    return false
  }

  return dfs(toTaskId)
}

export function getBlockers(tasks: Task[], taskId: number): Task[] {
  const taskMap = new Map(tasks.map(t => [t.id!, t]))
  const task = taskMap.get(taskId)
  if (!task) return []

  return task.dependencies
    .map(depId => taskMap.get(depId))
    .filter((t): t is Task => t !== undefined && t.status !== 'done')
}

export function getDependents(tasks: Task[], taskId: number): Task[] {
  return tasks.filter(t => t.dependencies.includes(taskId))
}
