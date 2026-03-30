import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'

export function useAgentMessages(agentFilter?: string) {
  return useLiveQuery(() => {
    const query = db.agentMessages.orderBy('createdAt').reverse()
    if (!agentFilter || agentFilter === 'all') return query.toArray()
    return query.filter(m =>
      m.senderName === agentFilter || m.recipientName === agentFilter
    ).toArray()
  }, [agentFilter])
}

export function usePendingCount(agentFilter?: string) {
  return useLiveQuery(async () => {
    if (!agentFilter || agentFilter === 'all') {
      return db.agentMessages.where('status').equals('pending').count()
    }
    const all = await db.agentMessages.where('status').equals('pending').toArray()
    return all.filter(m => m.senderName === agentFilter || m.recipientName === agentFilter).length
  }, [agentFilter])
}

export function useAgentRegistry() {
  return useLiveQuery(
    () => db.agentRegistry.orderBy('connectedAt').reverse().toArray()
  )
}

export function useLiveAgents() {
  return useLiveQuery(
    () => db.agentRegistry.where('status').equals('connected').toArray()
  )
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

export async function dismissMessage(id: number, port: number) {
  const res = await fetch(`http://localhost:${port}/api/agent-messages/${id}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to dismiss')
  }
  return res.json()
}

export async function sendToAgent(recipient: string, message: string, port: number, projectId?: number) {
  const res = await fetch(`http://localhost:${port}/api/agent-messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient, message, projectId }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to send')
  }
  return res.json()
}
