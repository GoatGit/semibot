import type { VMConnection } from './vm-connection'

export const WS_HEARTBEAT_TIMEOUT_MS = 30_000

export function startHeartbeatMonitor(
  getConnections: () => Iterable<VMConnection>,
  onTimeout: (conn: VMConnection) => void
): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now()
    for (const conn of getConnections()) {
      if (conn.status !== 'ready') continue
      if (now - conn.lastHeartbeat > WS_HEARTBEAT_TIMEOUT_MS) {
        onTimeout(conn)
      }
    }
  }, 5_000)
}
