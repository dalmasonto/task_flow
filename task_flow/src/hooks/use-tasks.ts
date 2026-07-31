import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import type { TaskStatus } from '@/types'

export function useTasks(filter?: { status?: TaskStatus; projectId?: number }) {
  return useLiveQuery(() => {
    let query = db.tasks.toCollection()
    if (filter?.status) {
      query = db.tasks.where('status').equals(filter.status)
    }
    return query.toArray().then(tasks => {
      if (filter?.projectId !== undefined) {
        return tasks.filter(t => t.projectId === filter.projectId)
      }
      return tasks
    })
  }, [filter?.status, filter?.projectId])
}

export function useTask(id: number | undefined) {
  return useLiveQuery(
    () => (id !== undefined ? db.tasks.get(id) : undefined),
    [id]
  )
}
