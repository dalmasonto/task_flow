import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'

export function useProjects() {
  return useLiveQuery(() => db.projects.toArray())
}

export function useProject(id: number | undefined) {
  return useLiveQuery(
    () => (id !== undefined ? db.projects.get(id) : undefined),
    [id]
  )
}
