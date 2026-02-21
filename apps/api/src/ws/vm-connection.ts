export interface VMWebSocket {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  on: (event: string, handler: (...args: unknown[]) => void) => void
  once: (event: string, handler: (...args: unknown[]) => void) => void
}

export interface VMConnection {
  ws: VMWebSocket
  userId: string
  orgId: string
  status: 'initializing' | 'ready' | 'disconnected'
  lastHeartbeat: number
  activeSessions: Set<string>
  requestResults: Map<
    string,
    {
      status: 'completed' | 'failed'
      data?: unknown
      error?: { code: string; message: string }
      updatedAt: number
    }
  >
}
