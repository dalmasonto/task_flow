import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/database'
import { getApiBaseUrl, getAuthHeaders } from '@/lib/connection'

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
    // Query from Dexie index, only count messages FROM agents TO the user
    const pending = await db.agentMessages.where('status').equals('pending').toArray()
    const forUser = pending.filter(m => m.senderName !== 'user' && m.recipientName === 'user')

    if (!agentFilter || agentFilter === 'all') {
      return forUser.length
    }
    return forUser.filter(m => m.senderName === agentFilter).length
  }, [agentFilter])
}

export function useAgentPendingCount(agentName: string) {
  return useLiveQuery(async () => {
    // Count pending messages FROM this specific agent TO the user
    const pending = await db.agentMessages
      .where('status').equals('pending')
      .filter(m => m.senderName === agentName && m.recipientName === 'user')
      .count()
    return pending
  }, [agentName])
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

export async function respondToMessage(id: number, response: string, _port: number) {
  const res = await fetch(`${getApiBaseUrl()}/api/agent-messages/${id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ response }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to respond')
  }
  return res.json()
}

export async function dismissMessage(id: number, _port: number) {
  const res = await fetch(`${getApiBaseUrl()}/api/agent-messages/${id}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to dismiss')
  }
  return res.json()
}

export async function sendToAgent(recipient: string, message: string, _port: number, projectId?: number) {
  const res = await fetch(`${getApiBaseUrl()}/api/agent-messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ recipient, message, projectId }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error ?? 'Failed to send')
  }
  return res.json()
}
