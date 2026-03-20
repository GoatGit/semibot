/**
 * Snapshot SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'

export interface LocalSnapshotRow {
  id: string
  session_id: string
  checkpoint_id: string | null
  data: Record<string, unknown>
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToSnapshot(row: Record<string, unknown>): LocalSnapshotRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    checkpoint_id: (row.checkpoint_id as string) ?? null,
    data: JSON.parse((row.data_json as string) ?? '{}'),
    created_at: row.created_at as string,
  }
}

export function localCreateSnapshot(data: {
  sessionId: string
  checkpointId?: string
  data: Record<string, unknown>
}): LocalSnapshotRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare('INSERT INTO snapshots (id, session_id, checkpoint_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, data.sessionId, data.checkpointId ?? null, JSON.stringify(data.data), now
  )
  return rowToSnapshot(db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindLatestSnapshot(sessionId: string): LocalSnapshotRow | null {
  const row = getLocalDb().prepare(
    'SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(sessionId)
  return row ? rowToSnapshot(row as Record<string, unknown>) : null
}

export function localFindSnapshotsBySession(sessionId: string, limit = 20): LocalSnapshotRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(sessionId, limit)
  return rows.map((r) => rowToSnapshot(r as Record<string, unknown>))
}

export function localDeleteSnapshotsBySession(sessionId: string): number {
  const result = getLocalDb().prepare('DELETE FROM snapshots WHERE session_id = ?').run(sessionId)
  return result.changes ?? 0
}
