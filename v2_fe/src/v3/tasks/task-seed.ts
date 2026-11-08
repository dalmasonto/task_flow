/// A task drafted from somewhere else (a design comment, a chat message), handed
/// to the new-task page. sessionStorage, so a reload on the way keeps it; read
/// once, then cleared. Plain text only: it is the person's own words.
import { messageToTask, type MessageTask } from "@/lib/message-to-task"

const KEY = "taskflow.v3.taskSeed"

export function seedTaskFrom(body: string): boolean {
  const parsed = messageToTask(body)
  if (!parsed) return false
  try {
    sessionStorage.setItem(KEY, JSON.stringify(parsed))
  } catch {
    return false
  }
  return true
}

export function takeTaskSeed(): MessageTask | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return raw ? (JSON.parse(raw) as MessageTask) : null
  } catch {
    return null
  }
}
