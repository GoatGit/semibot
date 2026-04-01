/**
 * Session SQLite 存储（仅元数据，消息历史保存在 checkpoints）
 */

import { randomUUID } from 'crypto'
import { ensureLocalDbSchema, getLocalDb } from './db-local'
import { createLogger } from './logger'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

const logger = createLogger('session-local-store')

export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed'
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'
export type RuntimeAttemptStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type RuntimeExecutionMode =
  | 'unknown'
  | 'direct_answer'
  | 'direct_reasoning'
  | 'plan_act'
  | 'delegate'

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
  current_attempt_id: string | null
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
  attempt_id: string | null
  user_message_id: string | null
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

export interface LocalRuntimeAttemptRow {
  id: string
  session_id: string
  user_message_id: string
  agent_id: string
  attempt_seq: number
  execution_mode: RuntimeExecutionMode
  status: RuntimeAttemptStatus
  approval_set_revision: number
  approval_block_count: number
  resume_count: number
  latest_revision: number
  checkpoint_id: string | null
  artifact_message_id: string | null
  terminal_reason: string | null
  leased_by: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  metadata: Record<string, unknown> | null
  started_at: string
  updated_at: string
  ended_at: string | null
}

export interface LocalRuntimeAttemptCheckpointRow {
  checkpoint_id: string
  attempt_id: string
  session_id: string
  user_message_id: string
  status: RuntimeAttemptStatus
  revision: number
  payload: Record<string, unknown> | null
  created_at: string
}

export interface LocalEventOutboxRow {
  id: string
  attempt_id: string
  session_id: string
  user_message_id: string
  revision: number
  event_type: string
  idempotency_key: string
  payload: Record<string, unknown> | null
  status: string
  created_at: string
  delivered_at: string | null
}

export interface LocalCheckpointOutboxRow {
  id: string
  attempt_id: string
  session_id: string
  user_message_id: string
  checkpoint_id: string
  revision: number
  projection_target: string
  payload: Record<string, unknown> | null
  status: string
  created_at: string
  delivered_at: string | null
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
    current_attempt_id: (row.current_attempt_id as string) ?? null,
    title: (row.title as string) ?? null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : null,
    started_at: row.started_at as string,
    ended_at: (row.ended_at as string) ?? null,
    created_at: row.created_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
  }
}

function rowToMessage(row: Record<string, unknown>): LocalMessageRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    attempt_id: (row.attempt_id as string) ?? null,
    user_message_id: (row.user_message_id as string) ?? null,
    parent_id: (row.parent_id as string) ?? null,
    role: row.role as MessageRole,
    content: (row.content as string) ?? '',
    tool_calls: row.tool_calls_json ? JSON.parse(row.tool_calls_json as string) : null,
    tool_call_id: (row.tool_call_id as string) ?? null,
    tokens_used: typeof row.tokens_used === 'number' ? row.tokens_used as number : row.tokens_used == null ? null : Number(row.tokens_used),
    latency_ms: typeof row.latency_ms === 'number' ? row.latency_ms as number : row.latency_ms == null ? null : Number(row.latency_ms),
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : null,
    created_at: row.created_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
    deleted_by: (row.deleted_by as string) ?? null,
  }
}

function rowToRuntimeAttempt(row: Record<string, unknown>): LocalRuntimeAttemptRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    user_message_id: row.user_message_id as string,
    agent_id: row.agent_id as string,
    attempt_seq: Number(row.attempt_seq ?? 0),
    execution_mode: (row.execution_mode as RuntimeExecutionMode) ?? 'unknown',
    status: row.status as RuntimeAttemptStatus,
    approval_set_revision: Number(row.approval_set_revision ?? 0),
    approval_block_count: Number(row.approval_block_count ?? 0),
    resume_count: Number(row.resume_count ?? 0),
    latest_revision: Number(row.latest_revision ?? 0),
    checkpoint_id: (row.checkpoint_id as string) ?? null,
    artifact_message_id: (row.artifact_message_id as string) ?? null,
    terminal_reason: (row.terminal_reason as string) ?? null,
    leased_by: (row.leased_by as string) ?? null,
    lease_expires_at: (row.lease_expires_at as string) ?? null,
    heartbeat_at: (row.heartbeat_at as string) ?? null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : null,
    started_at: row.started_at as string,
    updated_at: row.updated_at as string,
    ended_at: (row.ended_at as string) ?? null,
  }
}

function rowToRuntimeAttemptCheckpoint(row: Record<string, unknown>): LocalRuntimeAttemptCheckpointRow {
  return {
    checkpoint_id: row.checkpoint_id as string,
    attempt_id: row.attempt_id as string,
    session_id: row.session_id as string,
    user_message_id: row.user_message_id as string,
    status: row.status as RuntimeAttemptStatus,
    revision: Number(row.revision ?? 1),
    payload: row.payload_json ? JSON.parse(row.payload_json as string) : null,
    created_at: row.created_at as string,
  }
}

function rowToEventOutbox(row: Record<string, unknown>): LocalEventOutboxRow {
  return {
    id: row.id as string,
    attempt_id: row.attempt_id as string,
    session_id: row.session_id as string,
    user_message_id: row.user_message_id as string,
    revision: Number(row.revision ?? 0),
    event_type: row.event_type as string,
    idempotency_key: row.idempotency_key as string,
    payload: row.payload_json ? JSON.parse(row.payload_json as string) : null,
    status: row.status as string,
    created_at: row.created_at as string,
    delivered_at: (row.delivered_at as string) ?? null,
  }
}

function rowToCheckpointOutbox(row: Record<string, unknown>): LocalCheckpointOutboxRow {
  return {
    id: row.id as string,
    attempt_id: row.attempt_id as string,
    session_id: row.session_id as string,
    user_message_id: row.user_message_id as string,
    checkpoint_id: row.checkpoint_id as string,
    revision: Number(row.revision ?? 0),
    projection_target: row.projection_target as string,
    payload: row.payload_json ? JSON.parse(row.payload_json as string) : null,
    status: row.status as string,
    created_at: row.created_at as string,
    delivered_at: (row.delivered_at as string) ?? null,
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

  let where = 'WHERE deleted_at IS NULL AND user_id = ?'
  const binds: unknown[] = [params.userId]
  if (params.agentId) { where += ' AND agent_id = ?'; binds.push(params.agentId) }
  if (params.status) { where += ' AND status = ?'; binds.push(params.status) }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM sessions ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...binds, limit, offset)
  return {
    data: rows.map((r) => rowToSession(r as Record<string, unknown>)),
    meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }
}

export function localFindSessionsByOrg(params: {
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
  fields: { title?: string; status?: SessionStatus; currentAttemptId?: string | null }
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
  if (fields.currentAttemptId !== undefined) {
    sets.push('current_attempt_id = ?'); vals.push(fields.currentAttemptId)
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
  attemptId?: string
  userMessageId?: string
  role: MessageRole
  content: string
  parentId?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  tokensUsed?: number
  latencyMs?: number
  metadata?: Record<string, unknown>
}): LocalMessageRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  const params = [
    id,
    _data.sessionId,
    _data.attemptId ?? null,
    _data.userMessageId ?? null,
    _data.parentId ?? null,
    _data.role,
    _data.content,
    _data.toolCalls ? JSON.stringify(_data.toolCalls) : null,
    _data.toolCallId ?? null,
    _data.tokensUsed ?? null,
    _data.latencyMs ?? null,
    _data.metadata ? JSON.stringify(_data.metadata) : null,
    now,
  ] as const

  try {
    db.prepare(`
      INSERT INTO messages (
        id, session_id, attempt_id, user_message_id, parent_id, role, content, tool_calls_json, tool_call_id,
        tokens_used, latency_ms, metadata_json, created_at, deleted_at, deleted_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(...params)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/messages has no column named (attempt_id|user_message_id)/i.test(message)) {
      const migratedDb = ensureLocalDbSchema()
      migratedDb.prepare(`
        INSERT INTO messages (
          id, session_id, attempt_id, user_message_id, parent_id, role, content, tool_calls_json, tool_call_id,
          tokens_used, latency_ms, metadata_json, created_at, deleted_at, deleted_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(...params)
    } else {
      throw error
    }
  }
  return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindMessageById(id: string): LocalMessageRow | null {
  const row = getLocalDb().prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToMessage(row as Record<string, unknown>) : null
}

export function localFindMessagesBySessionId(_sessionId: string): LocalMessageRow[] {
  const db = getLocalDb()
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
    .all(_sessionId)
  return rows.map((row) => rowToMessage(row as Record<string, unknown>))
}

export function localFindMessagesByAttemptId(_attemptId: string): LocalMessageRow[] {
  const db = getLocalDb()
  const rows = db
    .prepare('SELECT * FROM messages WHERE attempt_id = ? AND deleted_at IS NULL ORDER BY created_at ASC')
    .all(_attemptId)
  return rows.map((row) => rowToMessage(row as Record<string, unknown>))
}

export function localCountMessagesBySessionId(_sessionId: string): number {
  const db = getLocalDb()
  const row = db
    .prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND deleted_at IS NULL')
    .get(_sessionId) as { c: number }
  return Number(row?.c ?? 0)
}

export function localCreateRuntimeAttempt(data: {
  sessionId: string
  userMessageId: string
  agentId: string
  executionMode?: RuntimeExecutionMode
  status?: RuntimeAttemptStatus
  metadata?: Record<string, unknown>
}): LocalRuntimeAttemptRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  const row = db
    .prepare('SELECT COALESCE(MAX(attempt_seq), 0) AS seq FROM runtime_attempts WHERE user_message_id = ?')
    .get(data.userMessageId) as { seq?: number }
  const attemptSeq = Number(row?.seq ?? 0) + 1
  db.prepare(`
    INSERT INTO runtime_attempts (
      id, session_id, user_message_id, agent_id, attempt_seq, execution_mode, status,
      approval_set_revision, approval_block_count, resume_count, checkpoint_id, artifact_message_id,
      terminal_reason, leased_by, lease_expires_at, heartbeat_at, metadata_json, started_at, updated_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)
  `).run(
    id,
    data.sessionId,
    data.userMessageId,
    data.agentId,
    attemptSeq,
    data.executionMode ?? 'unknown',
    data.status ?? 'queued',
    data.metadata ? JSON.stringify(data.metadata) : '{}',
    now,
    now,
  )
  db.prepare('UPDATE sessions SET current_attempt_id = ? WHERE id = ?').run(id, data.sessionId)
  return rowToRuntimeAttempt(db.prepare('SELECT * FROM runtime_attempts WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindRuntimeAttemptById(id: string): LocalRuntimeAttemptRow | null {
  const row = getLocalDb().prepare('SELECT * FROM runtime_attempts WHERE id = ?').get(id)
  return row ? rowToRuntimeAttempt(row as Record<string, unknown>) : null
}

export function localFindCurrentRuntimeAttempt(sessionId: string): LocalRuntimeAttemptRow | null {
  const row = getLocalDb().prepare(`
    SELECT a.*
    FROM sessions s
    JOIN runtime_attempts a ON a.id = s.current_attempt_id
    WHERE s.id = ?
  `).get(sessionId)
  return row ? rowToRuntimeAttempt(row as Record<string, unknown>) : null
}

export function localListRuntimeAttemptsBySessionId(sessionId: string, limit = 20): LocalRuntimeAttemptRow[] {
  const rows = getLocalDb()
    .prepare('SELECT * FROM runtime_attempts WHERE session_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(sessionId, limit)
  return rows.map((row) => rowToRuntimeAttempt(row as Record<string, unknown>))
}

export function localUpdateRuntimeAttempt(
  id: string,
  fields: {
    executionMode?: RuntimeExecutionMode
    status?: RuntimeAttemptStatus
    approvalSetRevision?: number
    approvalBlockCount?: number
    resumeCount?: number
    checkpointId?: string | null
    artifactMessageId?: string | null
    terminalReason?: string | null
    leasedBy?: string | null
    leaseExpiresAt?: string | null
    heartbeatAt?: string | null
    metadata?: Record<string, unknown> | null
    endedAt?: string | null
  }
): LocalRuntimeAttemptRow | null {
  const db = getLocalDb()
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [nowIso()]
  if (fields.executionMode !== undefined) { sets.push('execution_mode = ?'); vals.push(fields.executionMode) }
  if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status) }
  if (fields.approvalSetRevision !== undefined) { sets.push('approval_set_revision = ?'); vals.push(fields.approvalSetRevision) }
  if (fields.approvalBlockCount !== undefined) { sets.push('approval_block_count = ?'); vals.push(fields.approvalBlockCount) }
  if (fields.resumeCount !== undefined) { sets.push('resume_count = ?'); vals.push(fields.resumeCount) }
  if (fields.checkpointId !== undefined) { sets.push('checkpoint_id = ?'); vals.push(fields.checkpointId) }
  if (fields.artifactMessageId !== undefined) { sets.push('artifact_message_id = ?'); vals.push(fields.artifactMessageId) }
  if (fields.terminalReason !== undefined) { sets.push('terminal_reason = ?'); vals.push(fields.terminalReason) }
  if (fields.leasedBy !== undefined) { sets.push('leased_by = ?'); vals.push(fields.leasedBy) }
  if (fields.leaseExpiresAt !== undefined) { sets.push('lease_expires_at = ?'); vals.push(fields.leaseExpiresAt) }
  if (fields.heartbeatAt !== undefined) { sets.push('heartbeat_at = ?'); vals.push(fields.heartbeatAt) }
  if (fields.metadata !== undefined) { sets.push('metadata_json = ?'); vals.push(JSON.stringify(fields.metadata ?? {})) }
  if (fields.endedAt !== undefined) { sets.push('ended_at = ?'); vals.push(fields.endedAt) }
  vals.push(id)
  const result = db.prepare(`UPDATE runtime_attempts SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  if ((result.changes ?? 0) === 0) return null
  return rowToRuntimeAttempt(db.prepare('SELECT * FROM runtime_attempts WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localClaimRuntimeAttemptLease(input: {
  attemptId: string
  leasedBy: string
  leaseDurationMs: number
  expectedStatuses?: RuntimeAttemptStatus[]
}): LocalRuntimeAttemptRow | null {
  const db = getLocalDb()
  const now = nowIso()
  const leaseExpiresAt = new Date(Date.now() + Math.max(1000, input.leaseDurationMs)).toISOString()
  const expectedStatuses = input.expectedStatuses?.length ? input.expectedStatuses : ['queued', 'running']
  const placeholders = expectedStatuses.map(() => '?').join(', ')
  const result = db.prepare(`
    UPDATE runtime_attempts
    SET leased_by = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?, status = CASE WHEN status = 'queued' THEN 'running' ELSE status END
    WHERE id = ?
      AND status IN (${placeholders})
      AND (
        leased_by IS NULL
        OR leased_by = ?
        OR lease_expires_at IS NULL
        OR lease_expires_at < ?
      )
  `).run(
    input.leasedBy,
    leaseExpiresAt,
    now,
    now,
    input.attemptId,
    ...expectedStatuses,
    input.leasedBy,
    now,
  )
  if ((result.changes ?? 0) === 0) return null
  return rowToRuntimeAttempt(db.prepare('SELECT * FROM runtime_attempts WHERE id = ?').get(input.attemptId) as Record<string, unknown>)
}

export function localHeartbeatRuntimeAttempt(input: {
  attemptId: string
  leasedBy: string
  leaseDurationMs: number
}): LocalRuntimeAttemptRow | null {
  const db = getLocalDb()
  const now = nowIso()
  const leaseExpiresAt = new Date(Date.now() + Math.max(1000, input.leaseDurationMs)).toISOString()
  const result = db.prepare(`
    UPDATE runtime_attempts
    SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND leased_by = ?
  `).run(now, leaseExpiresAt, now, input.attemptId, input.leasedBy)
  if ((result.changes ?? 0) === 0) return null
  return rowToRuntimeAttempt(db.prepare('SELECT * FROM runtime_attempts WHERE id = ?').get(input.attemptId) as Record<string, unknown>)
}

export function localListStalledRuntimeAttempts(input?: {
  nowIso?: string
  limit?: number
}): LocalRuntimeAttemptRow[] {
  const now = input?.nowIso ?? nowIso()
  const limit = Math.max(1, input?.limit ?? 100)
  const rows = getLocalDb().prepare(`
    SELECT *
    FROM runtime_attempts
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
    ORDER BY lease_expires_at ASC
    LIMIT ?
  `).all(now, limit)
  return rows.map((row) => rowToRuntimeAttempt(row as Record<string, unknown>))
}

export function localAppendRuntimeAttemptCheckpoint(data: {
  attemptId: string
  sessionId: string
  userMessageId: string
  status: RuntimeAttemptStatus
  payload?: Record<string, unknown>
}): LocalRuntimeAttemptCheckpointRow {
  const db = getLocalDb()
  const createdAt = nowIso()
  const checkpointId = randomUUID()
  const row = db
    .prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM runtime_attempt_checkpoints WHERE attempt_id = ?')
    .get(data.attemptId) as { revision?: number }
  const revision = Number(row?.revision ?? 0) + 1
  db.prepare(`
    INSERT INTO runtime_attempt_checkpoints (
      checkpoint_id, attempt_id, session_id, user_message_id, status, revision, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpointId,
    data.attemptId,
    data.sessionId,
    data.userMessageId,
    data.status,
    revision,
    JSON.stringify(data.payload ?? {}),
    createdAt,
  )
  return rowToRuntimeAttemptCheckpoint(
    db.prepare('SELECT * FROM runtime_attempt_checkpoints WHERE checkpoint_id = ?').get(checkpointId) as Record<string, unknown>
  )
}

export function localListEventOutboxByAttemptId(attemptId: string): LocalEventOutboxRow[] {
  const rows = getLocalDb()
    .prepare('SELECT * FROM event_outbox WHERE attempt_id = ? ORDER BY revision ASC, created_at ASC')
    .all(attemptId)
  return rows.map((row) => rowToEventOutbox(row as Record<string, unknown>))
}

export function localListCheckpointOutboxByAttemptId(attemptId: string): LocalCheckpointOutboxRow[] {
  const rows = getLocalDb()
    .prepare('SELECT * FROM checkpoint_outbox WHERE attempt_id = ? ORDER BY revision ASC, created_at ASC')
    .all(attemptId)
  return rows.map((row) => rowToCheckpointOutbox(row as Record<string, unknown>))
}

export function localListPendingEventOutbox(limit = 100): LocalEventOutboxRow[] {
  const rows = getLocalDb()
    .prepare("SELECT * FROM event_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
    .all(limit)
  return rows.map((row) => rowToEventOutbox(row as Record<string, unknown>))
}

export function localListPendingCheckpointOutbox(limit = 100): LocalCheckpointOutboxRow[] {
  const rows = getLocalDb()
    .prepare("SELECT * FROM checkpoint_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
    .all(limit)
  return rows.map((row) => rowToCheckpointOutbox(row as Record<string, unknown>))
}

export function localMarkEventOutboxDelivered(id: string): LocalEventOutboxRow | null {
  const db = getLocalDb()
  db.prepare("UPDATE event_outbox SET status = 'delivered', delivered_at = ? WHERE id = ?").run(nowIso(), id)
  const row = db.prepare('SELECT * FROM event_outbox WHERE id = ?').get(id)
  return row ? rowToEventOutbox(row as Record<string, unknown>) : null
}

export function localMarkCheckpointOutboxDelivered(id: string): LocalCheckpointOutboxRow | null {
  const db = getLocalDb()
  db.prepare("UPDATE checkpoint_outbox SET status = 'delivered', delivered_at = ? WHERE id = ?").run(nowIso(), id)
  const row = db.prepare('SELECT * FROM checkpoint_outbox WHERE id = ?').get(id)
  return row ? rowToCheckpointOutbox(row as Record<string, unknown>) : null
}
