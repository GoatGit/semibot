/**
 * Session SQLite 存储（仅元数据，消息历史保存在 checkpoints）
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'
import { createLogger } from './logger'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

const logger = createLogger('session-local-store')

export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed'
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface LocalSessionRow {
  id: string
  org_id: string
  agent_id: string
  user_id: string
  status: SessionStatus
  title: string | null
  metadata: Record<string, unknown> | null
  started_at: string
  ended_at: string | null
  created_at: string
  deleted_at: string | null
  deleted_by: string | null
}

// Messages are stored in checkpoints — this is a stub for API compatibility
export interface LocalMessageRow {
  id: string
  session_id: string
  parent_id: string | null
  role: MessageRole
  content: string
  tool_calls: ToolCall[] | null
  tool_call_id: string | null
  tokens_used: number | null
  latency_ms: number | null
  metadata: Record<string, unknown> | null
  created_at: string
  deleted_at: string | null
  deleted_by: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToSession(row: Record<string, unknown>): LocalSessionRow {
  return {
    id: row.id as string,
    org_id: (row.org_id as string) ?? 'local',
    agent_id: row.agent_id as string,
    user_id: (row.user_id as string) ?? 'local',
    status: row.status as SessionStatus,
    title: (row.title as string) ?? null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : null,
    started_at: row.started_at as string,
    ended_at: (row.ended_at as string) ?? null,
    created_at: row.created_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
  }
}

export function localCreateSession(data: {
  agentId: string
  userId: string
  title?: string
  metadata?: Record<string, unknown>
}): LocalSessionRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO sessions (id, org_id, agent_id, user_id, status, title, metadata_json, started_at, created_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(id, 'local', data.agentId, data.userId, data.title ?? null,
    data.metadata ? JSON.stringify(data.metadata) : null,
    now, now)
  logger.debug('创建 session', { id })
  return rowToSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindSessionById(id: string): LocalSessionRow | null {
  const row = getLocalDb().prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToSession(row as Record<string, unknown>) : null
}

export function localFindSessionByIdAndOrg(id: string): LocalSessionRow | null {
  return localFindSessionById(id)
}

export function localFindSessionsByUserAndOrg(params: {
  userId: string
  page?: number
  limit?: number
  agentId?: string
  status?: SessionStatus
}): { data: LocalSessionRow[]; meta: { total: number; page: number; limit: number; totalPages: number } } {
  const db = getLocalDb()
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const offset = (page - 1) * limit

  let where = 'WHERE deleted_at IS NULL'
  const binds: unknown[] = []
  if (params.agentId) { where += ' AND agent_id = ?'; binds.push(params.agentId) }
  if (params.status) { where += ' AND status = ?'; binds.push(params.status) }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM sessions ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...binds, limit, offset)
  return {
    data: rows.map((r) => rowToSession(r as Record<string, unknown>)),
    meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }
}

export function localUpdateSessionStatus(id: string, status: SessionStatus): LocalSessionRow | null {
  const db = getLocalDb()
  const isEnded = status === 'completed' || status === 'failed'
  const result = db.prepare(
    `UPDATE sessions SET status = ?, ended_at = CASE WHEN ? = 1 AND ended_at IS NULL THEN ? ELSE ended_at END WHERE id = ? AND deleted_at IS NULL`
  ).run(status, isEnded ? 1 : 0, nowIso(), id)
  if ((result.changes ?? 0) === 0) return null
  return rowToSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localUpdateSessionStatusIfActive(
  id: string,
  status: SessionStatus
): { row: LocalSessionRow | null; alreadyEnded: boolean } {
  const db = getLocalDb()
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined
  if (!existing) return { row: null, alreadyEnded: false }
  const currentStatus = existing.status as string
  if (currentStatus === 'completed' || currentStatus === 'failed') return { row: null, alreadyEnded: true }
  const isEnded = status === 'completed' || status === 'failed'
  db.prepare(
    `UPDATE sessions SET status = ?, ended_at = CASE WHEN ? = 1 AND ended_at IS NULL THEN ? ELSE ended_at END WHERE id = ?`
  ).run(status, isEnded ? 1 : 0, nowIso(), id)
  return { row: rowToSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>), alreadyEnded: false }
}

export function localUpdateSessionTitle(id: string, title: string): LocalSessionRow | null {
  const db = getLocalDb()
  const result = db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND deleted_at IS NULL').run(title, id)
  if ((result.changes ?? 0) === 0) return null
  return rowToSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localUpdateSessionFields(
  id: string,
  fields: { title?: string; status?: SessionStatus }
): LocalSessionRow | null {
  const db = getLocalDb()
  const sets: string[] = []
  const vals: unknown[] = []
  if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title) }
  if (fields.status !== undefined) {
    sets.push('status = ?'); vals.push(fields.status)
    const isEnded = fields.status === 'completed' || fields.status === 'failed'
    if (isEnded) { sets.push('ended_at = COALESCE(ended_at, ?)'); vals.push(nowIso()) }
  }
  if (sets.length === 0) return localFindSessionById(id)
  vals.push(id)
  const result = db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...vals)
  if ((result.changes ?? 0) === 0) return null
  return rowToSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localSoftDeleteSession(id: string, deletedBy?: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE sessions SET deleted_at = ?, deleted_by = ?, status = \'completed\', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), deletedBy ?? null, nowIso(), id)
  return (result.changes ?? 0) > 0
}

// ─── Messages (stub — real history is in checkpoints) ─────────

export function localCreateMessage(_data: {
  sessionId: string
  role: MessageRole
  content: string
  parentId?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  tokensUsed?: number
  latencyMs?: number
  metadata?: Record<string, unknown>
}): LocalMessageRow {
  // Messages are stored in checkpoints by the Python runtime.
  // This stub exists for API compatibility only.
  const now = nowIso()
  return {
    id: randomUUID(),
    session_id: _data.sessionId,
    parent_id: _data.parentId ?? null,
    role: _data.role,
    content: _data.content,
    tool_calls: _data.toolCalls ?? null,
    tool_call_id: _data.toolCallId ?? null,
    tokens_used: _data.tokensUsed ?? null,
    latency_ms: _data.latencyMs ?? null,
    metadata: _data.metadata ?? null,
    created_at: now,
    deleted_at: null,
    deleted_by: null,
  }
}

export function localFindMessagesBySessionId(_sessionId: string): LocalMessageRow[] {
  return []
}

export function localCountMessagesBySessionId(_sessionId: string): number {
  return 0
}
