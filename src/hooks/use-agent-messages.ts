import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'

export function useAgentMessages() {
  return useLiveQuery(
    () => db.agentMessages.orderBy('createdAt').reverse().toArray()
  )
}

export function usePendingCount() {
  return useLiveQuery(async () => {
    return db.agentMessages.where('status').equals('pending').count()
  })
}

export async function respondToMessage(id: number, response: string, port: number) {
  const res = await fetch(`http://localhost:${port}/api/agent-messages/${id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to respond')
  }
  return res.json()
}
