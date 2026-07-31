import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import type { SettingsMap } from '@/types'
import { DEFAULT_SETTINGS } from '@/lib/constants'

export function useSetting<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
  const setting = useLiveQuery(() => db.settings.where('key').equals(key).first(), [key])
  return (setting?.value as SettingsMap[K]) ?? DEFAULT_SETTINGS[key]
}

export async function updateSetting<K extends keyof SettingsMap>(
  key: K,
  value: SettingsMap[K]
) {
  const existing = await db.settings.where('key').equals(key).first()
  if (existing) {
    await db.settings.update(existing.id!, { value })
  } else {
    await db.settings.add({ key, value })
  }
}

const MAX_RECENT_PROJECTS = 10

/** Push a project to the front of the recently-viewed list */
export async function trackRecentProject(projectId: number) {
  const existing = await db.settings.where('key').equals('recentProjectIds').first()
  const current: number[] = (existing?.value as number[]) ?? []
  const updated = [projectId, ...current.filter(id => id !== projectId)].slice(0, MAX_RECENT_PROJECTS)
  if (existing) {
    await db.settings.update(existing.id!, { value: updated })
  } else {
    await db.settings.add({ key: 'recentProjectIds', value: updated })
  }
}
