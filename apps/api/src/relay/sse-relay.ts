import { createLogger } from '../lib/logger'

const relayLogger = createLogger('sse-relay')

type Sender = (event: string, data: unknown) => boolean

type Closer = () => void

interface RelayConnection {
  connectionId: string
  sessionId: string
  send: Sender
  close: Closer
}

const byConnectionId = new Map<string, RelayConnection>()
const bySessionId = new Map<string, Set<string>>()

export function registerSSEConnection(connectionId: string, sessionId: string, send: Sender, close: Closer): void {
  const connection: RelayConnection = { connectionId, sessionId, send, close }
  byConnectionId.set(connectionId, connection)

  if (!bySessionId.has(sessionId)) {
    bySessionId.set(sessionId, new Set())
  }
  bySessionId.get(sessionId)!.add(connectionId)
}

export function unregisterSSEConnection(connectionId: string): void {
  const existing = byConnectionId.get(connectionId)
  if (!existing) return

  byConnectionId.delete(connectionId)
  const ids = bySessionId.get(existing.sessionId)
  if (!ids) return

  ids.delete(connectionId)
  if (ids.size === 0) {
    bySessionId.delete(existing.sessionId)
  }
}

export function forwardSSE(sessionId: string, event: string, data: unknown): void {
  const connectionIds = bySessionId.get(sessionId)
  if (!connectionIds || connectionIds.size === 0) return

  for (const connectionId of Array.from(connectionIds)) {
    const connection = byConnectionId.get(connectionId)
    if (!connection) {
      connectionIds.delete(connectionId)
      continue
    }

    const ok = connection.send(event, data)
    if (!ok) {
      relayLogger.warn('SSE 发送失败，移除连接', { connectionId, sessionId, event })
      connection.close()
      unregisterSSEConnection(connectionId)
    }
  }
}

export function closeSessionConnections(sessionId: string): void {
  const connectionIds = bySessionId.get(sessionId)
  if (!connectionIds) return

  for (const connectionId of Array.from(connectionIds)) {
    const connection = byConnectionId.get(connectionId)
    if (!connection) continue
    connection.close()
    unregisterSSEConnection(connectionId)
  }
}

export function hasSessionConnections(sessionId: string): boolean {
  const ids = bySessionId.get(sessionId)
  return Boolean(ids && ids.size > 0)
}
