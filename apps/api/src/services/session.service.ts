/**
 * Session 服务层
 *
 * 使用数据库持久化实现 Session/Message CRUD
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createError } from '../middleware/errorHandler'
import {
  SESSION_NOT_FOUND,
  SESSION_ALREADY_COMPLETED,
  MESSAGE_LIMIT_EXCEEDED,
  MESSAGE_NOT_FOUND,
} from '../constants/errorCodes'
import { MAX_SESSION_MESSAGES } from '../constants/config'
import { runtimeRequest } from '../lib/runtime-client'
import { getLocalDb } from '../lib/db-local'
import * as sessionRepository from '../repositories/session.repository'
import * as messageRepository from '../repositories/message.repository'
import * as runtimeAttemptRepository from '../repositories/runtime-attempt.repository'
import * as runtimeAttemptCommitService from './runtime-attempt-commit.service'
import { createLogger } from '../lib/logger'

const sessionLogger = createLogger('session')
const SYSTEM_DEFAULT_AGENT_ID = '00000000-0000-0000-0000-000000000001'
const LOCAL_CHECKPOINT_ROOT = path.join(os.homedir(), '.semibot', 'sessions')

// 类型定义
// ═══════════════════════════════════════════════════════════════

export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed'
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface Session {
  id: string
  agentId: string
  userId: string
  status: SessionStatus
  currentAttemptId?: string
  title?: string
  metadata?: Record<string, unknown>
  startedAt: string
  endedAt?: string
  createdAt: string
}

export interface Message {
  id: string
  sessionId: string
  attemptId?: string
  userMessageId?: string
  parentId?: string
  role: MessageRole
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  tokensUsed?: number
  latencyMs?: number
  metadata?: Record<string, unknown>
  createdAt: string
}

export type RuntimeAttemptStatus = runtimeAttemptRepository.RuntimeAttemptStatus
export type RuntimeExecutionMode = runtimeAttemptRepository.RuntimeExecutionMode

export interface RuntimeAttempt {
  id: string
  sessionId: string
  userMessageId: string
  agentId: string
  attemptSeq: number
  executionMode: RuntimeExecutionMode
  status: RuntimeAttemptStatus
  approvalSetRevision: number
  approvalBlockCount: number
  resumeCount: number
  latestRevision: number
  checkpointId?: string
  artifactMessageId?: string
  terminalReason?: string
  leasedBy?: string
  leaseExpiresAt?: string
  heartbeatAt?: string
  metadata?: Record<string, unknown>
  startedAt: string
  updatedAt: string
  endedAt?: string
}

export interface RuntimeAttemptCheckpoint {
  checkpointId: string
  attemptId: string
  sessionId: string
  userMessageId: string
  status: RuntimeAttemptStatus
  revision: number
  payload?: Record<string, unknown>
  createdAt: string
}

export interface SessionNotice {
  kind: 'awaiting_approval' | 'error' | 'warning'
  code: string
  message: string
  approvalIds?: string[]
}

export interface SessionRunStateView {
  sessionId: string
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'idle'
  pendingApprovalIds: string[]
  updatedAt: string
  error?: string
}

export interface SessionProcessTraceView {
  version: 1
  messages: unknown[]
}

export interface SessionView {
  session: Session
  messages: Message[]
  currentAttempt: RuntimeAttempt | null
  attemptsSummary: RuntimeAttempt[]
  runState: SessionRunStateView | null
  notices: SessionNotice[]
  processTrace: SessionProcessTraceView | null
}

export interface RuntimeAttemptView {
  attempt: RuntimeAttempt
  session: Session
  messages: Message[]
  latestCheckpoint: RuntimeAttemptCheckpoint | null
  eventOutbox: Array<{
    id: string
    revision: number
    eventType: string
    status: string
    createdAt: string
    deliveredAt?: string
  }>
  checkpointOutbox: Array<{
    id: string
    checkpointId: string
    revision: number
    projectionTarget: string
    status: string
    createdAt: string
    deliveredAt?: string
  }>
  runState: SessionRunStateView | null
  notices: SessionNotice[]
  processTrace: SessionProcessTraceView | null
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface CreateSessionInput {
  agentId: string
  title?: string
  metadata?: Record<string, unknown>
}

export interface AddMessageInput {
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
}

export interface ListSessionsOptions {
  page?: number
  limit?: number
  agentId?: string
  status?: SessionStatus
}

export interface PaginatedResult<T> {
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

export interface CreateRuntimeAttemptInput {
  userMessageId: string
  agentId: string
  executionMode?: RuntimeExecutionMode
  status?: RuntimeAttemptStatus
  metadata?: Record<string, unknown>
}

export interface UpdateRuntimeAttemptInput {
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

export interface CommitAttemptStateInput {
  attemptId: string
  sessionId: string
  userMessageId: string
  revision?: number
  status: Extract<RuntimeAttemptStatus, 'queued' | 'running' | 'awaiting_approval'>
  approvalBlockCount?: number
  approvalSetRevision?: number
  metadata?: Record<string, unknown>
  checkpointPayload?: Record<string, unknown>
}

export interface CommitAttemptTerminalInput {
  attemptId: string
  sessionId: string
  userMessageId: string
  revision?: number
  status: Extract<RuntimeAttemptStatus, 'completed' | 'failed' | 'cancelled'>
  terminalReason: string
  artifactMessageId?: string
  metadata?: Record<string, unknown>
  checkpointPayload?: Record<string, unknown>
}

export interface ClaimRuntimeAttemptLeaseInput {
  attemptId: string
  leasedBy: string
  leaseDurationMs: number
  expectedStatuses?: RuntimeAttemptStatus[]
}

export interface HeartbeatRuntimeAttemptInput {
  attemptId: string
  leasedBy: string
  leaseDurationMs: number
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 Session 对象
 */
function rowToSession(row: sessionRepository.SessionRow): Session {
  return {
    id: row.id,
    agentId: row.agent_id,
    userId: row.user_id,
    status: row.status,
    currentAttemptId: row.current_attempt_id ?? undefined,
    title: row.title ?? undefined,
    metadata: row.metadata ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    createdAt: row.created_at,
  }
}

/**
 * 将数据库行转换为 Message 对象
 */
function rowToMessage(row: messageRepository.MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    attemptId: row.attempt_id ?? undefined,
    userMessageId: row.user_message_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    tokensUsed: row.tokens_used ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at,
  }
}

function rowToRuntimeAttempt(row: runtimeAttemptRepository.RuntimeAttemptRow): RuntimeAttempt {
  return {
    id: row.id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    agentId: row.agent_id,
    attemptSeq: row.attempt_seq,
    executionMode: row.execution_mode,
    status: row.status,
    approvalSetRevision: row.approval_set_revision,
    approvalBlockCount: row.approval_block_count,
    resumeCount: row.resume_count,
    latestRevision: row.latest_revision,
    checkpointId: row.checkpoint_id ?? undefined,
    artifactMessageId: row.artifact_message_id ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
    leasedBy: row.leased_by ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    metadata: row.metadata ?? undefined,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
  }
}

type RuntimeSessionListResponse = {
  items?: Array<{
    session_id?: string
    last_seen_at?: string
    title?: string
    current_date?: string
    current_weekday?: string
    current_timezone?: string
  }>
}

type RuntimeEventRecord = {
  event_id?: string
  event_type?: string
  source?: string
  subject?: string
  payload?: Record<string, unknown>
  risk_hint?: 'low' | 'medium' | 'high'
  timestamp?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type RuntimeTerminalSnapshot = {
  status: SessionStatus
  endedAt?: string
  eventType?: string
}

function _runtimeEventIndicatesPendingApproval(event: RuntimeEventRecord): boolean {
  const payload = isRecord(event.payload) ? event.payload : {}
  const ids = payload.pending_approval_ids
  if (Array.isArray(ids) && ids.some((item) => String(item || '').trim())) {
    return true
  }

  const finalResponse = String(payload.final_response || '').trim()
  if (!finalResponse) return false
  return (
    finalResponse.includes('操作需要人工审批后继续') ||
    finalResponse.includes('待审批 ID:') ||
    finalResponse.toLowerCase().includes('pending approval')
  )
}

async function buildRuntimeSessionTerminalMap(limit = 500): Promise<Map<string, RuntimeTerminalSnapshot>> {
  const events = await listRuntimeEvents(limit)
  const terminalMap = new Map<string, RuntimeTerminalSnapshot>()

  for (const event of events) {
    const eventType = String(event.event_type || '').trim()
    if (!['task.completed', 'task.failed', 'task.cancelled'].includes(eventType)) continue
    if (eventType === 'task.completed' && _runtimeEventIndicatesPendingApproval(event)) continue
    const payload = isRecord(event.payload) ? event.payload : {}
    const sessionId = String(payload.session_id || '').trim()
    if (!sessionId || terminalMap.has(sessionId)) continue
    terminalMap.set(sessionId, {
      status: eventType === 'task.completed' ? 'completed' : 'failed',
      endedAt: String(event.timestamp || '').trim() || undefined,
      eventType,
    })
  }

  return terminalMap
}

async function listRuntimeSessions(): Promise<Session[]> {
  const response = await runtimeRequest<RuntimeSessionListResponse>('/v1/sessions', {
    method: 'GET',
    query: { limit: 200 },
    timeoutMs: 5000,
  })
  const items = Array.isArray(response.items) ? response.items : []
  const terminalMap = await buildRuntimeSessionTerminalMap(500).catch(() => new Map<string, RuntimeTerminalSnapshot>())
  return items
    .map((item) => {
      const id = String(item.session_id || '').trim()
      if (!id) return null
      const seenAt = String(item.last_seen_at || new Date().toISOString())
      const terminal = terminalMap.get(id)
      return {
        id,
        agentId: SYSTEM_DEFAULT_AGENT_ID,
        userId: '22222222-2222-2222-2222-222222222222',
        status: terminal?.status || ('active' as SessionStatus),
        title: item.title || undefined,
        metadata: {
          current_date: String(item.current_date || '').trim() || undefined,
          current_weekday: String(item.current_weekday || '').trim() || undefined,
          current_timezone: String(item.current_timezone || '').trim() || undefined,
          ...(terminal?.eventType ? { runtime_terminal_event_type: terminal.eventType } : {}),
        },
        startedAt: seenAt,
        endedAt: terminal?.endedAt,
        createdAt: seenAt,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
}

async function getRuntimeSessionOrThrow(sessionId: string): Promise<Session> {
  const sessions = await listRuntimeSessions()
  const session = sessions.find((item) => item.id === sessionId)
  if (!session) {
    const checkpointSummary = await getLatestCheckpointSessionSummary(sessionId).catch(() => null)
    if (!checkpointSummary) {
      throw createError(SESSION_NOT_FOUND)
    }
    const terminalMap = await buildRuntimeSessionTerminalMap(500).catch(() => new Map<string, RuntimeTerminalSnapshot>())
    const terminal = terminalMap.get(sessionId)
    const createdAt = checkpointSummary.createdAt || new Date().toISOString()
    const status: SessionStatus =
      terminal?.status
      || 'active'
    const synthesized: Session = {
      id: sessionId,
      agentId: SYSTEM_DEFAULT_AGENT_ID,
      userId: '22222222-2222-2222-2222-222222222222',
      status,
      title: checkpointSummary.title || '未命名会话',
      metadata: {
        ...(terminal?.eventType ? { runtime_terminal_event_type: terminal.eventType } : {}),
      },
      startedAt: createdAt,
      endedAt: terminal?.endedAt,
      createdAt,
    }
    return synthesized
  }
  return session
}

async function listRuntimeEvents(limit = 500, sessionId?: string): Promise<RuntimeEventRecord[]> {
  try {
    const response = await runtimeRequest<{ items?: RuntimeEventRecord[] }>('/v1/events', {
      method: 'GET',
      query: { limit, ...(sessionId ? { session_id: sessionId } : {}) },
      timeoutMs: 4000,
    })
    const items = Array.isArray(response.items) ? response.items : []
    if (items.length > 0 || !sessionId) return items
    sessionLogger.info('runtime returned no session events, falling back to local sqlite events', {
      sessionId,
      limit,
    })
    return listLocalRuntimeEvents(limit, sessionId)
  } catch (error) {
    sessionLogger.warn('runtime events unavailable, falling back to local sqlite events', {
      sessionId,
      limit,
      error: error instanceof Error ? error.message : String(error),
    })
    return listLocalRuntimeEvents(limit, sessionId)
  }
}

function listLocalRuntimeEvents(limit = 500, sessionId?: string): RuntimeEventRecord[] {
  const db = getLocalDb()
  const binds: Array<string | number> = []
  let where = ''
  if (sessionId) {
    where = 'WHERE (subject = ? OR instr(payload, ?) > 0)'
    binds.push(sessionId, sessionId)
  }
  const rows = db
    .prepare(
      `
        SELECT id, event_type, source, subject, payload, risk_hint, created_at
        FROM events
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(...binds, limit) as Array<Record<string, unknown>>

  return rows.map((row) => {
    let payload: Record<string, unknown> | undefined
    if (typeof row.payload === 'string' && row.payload.trim()) {
      try {
        const parsed = JSON.parse(row.payload)
        if (isRecord(parsed)) payload = parsed
      } catch {
        payload = undefined
      }
    }
    return {
      event_id: typeof row.id === 'string' ? row.id : undefined,
      event_type: typeof row.event_type === 'string' ? row.event_type : undefined,
      source: typeof row.source === 'string' ? row.source : undefined,
      subject: typeof row.subject === 'string' ? row.subject : undefined,
      payload,
      risk_hint:
        row.risk_hint === 'low' || row.risk_hint === 'medium' || row.risk_hint === 'high'
          ? row.risk_hint
          : undefined,
      timestamp: typeof row.created_at === 'string' ? row.created_at : undefined,
    }
  })
}

function readPendingApprovalIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

async function filterLivePendingApprovalIds(approvalIds: string[]): Promise<string[]> {
  if (approvalIds.length === 0) return []
  try {
    const payload = await runtimeRequest<{ items?: unknown[] }>('/v1/approvals', {
      method: 'GET',
      query: { status: 'pending', limit: 1000 },
      timeoutMs: 2000,
    })
    const pendingIds = new Set(
      (Array.isArray(payload.items) ? payload.items : [])
        .map((item) => (isRecord(item) ? String(item.id || item.approval_id || '').trim() : ''))
        .filter(Boolean),
    )
    return approvalIds.filter((item) => pendingIds.has(String(item || '').trim()))
  } catch (error) {
    sessionLogger.warn('读取 runtime pending approvals 失败，回退为保留原 pending 集合', {
      approvalIds,
      error: error instanceof Error ? error.message : String(error),
    })
    return approvalIds
  }
}

async function buildRuntimeAttemptProjection(
  attempt: RuntimeAttempt,
  latestCheckpoint: RuntimeAttemptCheckpoint | null,
): Promise<RuntimeSessionProjection> {
  const checkpointPayload = isRecord(latestCheckpoint?.payload) ? latestCheckpoint.payload : {}
  const metadata = isRecord(checkpointPayload.metadata) ? checkpointPayload.metadata : {}
  const checkpointProcessTrace = isRecord(checkpointPayload.processTrace)
    ? checkpointPayload.processTrace
    : isRecord(checkpointPayload.execution_process)
      ? checkpointPayload.execution_process
      : null
  const processMessages = Array.isArray((checkpointProcessTrace as { messages?: unknown[] } | null)?.messages)
    ? ((checkpointProcessTrace as { messages?: unknown[] }).messages as unknown[])
    : []
  const pendingApprovalIds = attempt.status === 'awaiting_approval'
    ? await filterLivePendingApprovalIds(
      readPendingApprovalIds(checkpointPayload.pending_approval_ids),
    )
    : []
  const waitingMessage =
    typeof checkpointPayload.awaiting_approval_message === 'string'
      ? checkpointPayload.awaiting_approval_message.trim()
      : typeof metadata.awaiting_approval_message === 'string'
        ? metadata.awaiting_approval_message.trim()
        : ''

  const runState: SessionRunStateView = {
    sessionId: attempt.sessionId,
    status: attempt.status as SessionRunStateView['status'],
    pendingApprovalIds,
    updatedAt: latestCheckpoint?.createdAt ?? attempt.updatedAt,
    ...(attempt.terminalReason ? { error: attempt.terminalReason } : {}),
  }

  const notices: SessionNotice[] = []
  if (attempt.status === 'awaiting_approval' && pendingApprovalIds.length > 0) {
    notices.push({
      kind: 'awaiting_approval',
      code: 'AWAITING_APPROVAL',
      message: waitingMessage || '该请求包含待审批操作，等待审批后继续。',
      approvalIds: pendingApprovalIds,
    })
  } else if (attempt.status === 'failed' && attempt.terminalReason) {
    notices.push({
      kind: 'error',
      code: 'RUN_FAILED',
      message: attempt.terminalReason,
    })
  }

  return {
    runState,
    notices,
    processTrace: processMessages.length > 0 ? { version: 1, messages: processMessages } : null,
  }
}

function getLatestRuntimeAttemptCheckpoint(attempt: RuntimeAttempt): RuntimeAttemptCheckpoint | null {
  if (!attempt.checkpointId) return null
  const found = getLocalDb()
    .prepare('SELECT * FROM runtime_attempt_checkpoints WHERE checkpoint_id = ?')
    .get(attempt.checkpointId) as Record<string, unknown> | undefined
  if (!found) return null
  return {
    checkpointId: String(found.checkpoint_id || ''),
    attemptId: String(found.attempt_id || ''),
    sessionId: String(found.session_id || ''),
    userMessageId: String(found.user_message_id || ''),
    status: String(found.status || '') as RuntimeAttemptStatus,
    revision: Number(found.revision ?? 0),
    payload: typeof found.payload_json === 'string' && found.payload_json
      ? JSON.parse(String(found.payload_json))
      : undefined,
    createdAt: String(found.created_at || ''),
  }
}

type RuntimeSessionProjection = {
  runState: SessionRunStateView | null
  notices: SessionNotice[]
  processTrace: SessionProcessTraceView | null
}

type CheckpointSessionSummary = {
  title: string
  createdAt: string
}

async function getLatestCheckpointSessionSummary(sessionId: string): Promise<CheckpointSessionSummary | null> {
  const checkpointDir = path.join(LOCAL_CHECKPOINT_ROOT, sessionId, 'checkpoints')
  let files: string[] = []
  try {
    files = (await fs.readdir(checkpointDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return null
  }

  const latest = files[0]
  if (!latest) return null

  try {
    const raw = await fs.readFile(path.join(checkpointDir, latest), 'utf-8')
    const checkpoint = JSON.parse(raw) as Record<string, unknown>
    const createdAt = new Date(
      typeof checkpoint.updated_at === 'number' ? checkpoint.updated_at * 1000 : Date.now()
    ).toISOString()
    const title =
      (typeof checkpoint.last_user_message === 'string' && checkpoint.last_user_message.trim()) ||
      (typeof checkpoint.title === 'string' && checkpoint.title.trim()) ||
      '未命名会话'
    return {
      title: title.slice(0, 100),
      createdAt,
    }
  } catch {
    return null
  }
}

async function listCheckpointSessions(): Promise<Session[]> {
  let sessionDirs: string[] = []
  try {
    sessionDirs = await fs.readdir(LOCAL_CHECKPOINT_ROOT)
  } catch {
    return []
  }

  // Cap at 200 to avoid unbounded parallel I/O when many sessions exist.
  const capped = sessionDirs.slice(0, 200)

  const sessions: Array<Session | null> = await Promise.all(
    capped.map(async (sessionId) => {
      const checkpointDir = path.join(LOCAL_CHECKPOINT_ROOT, sessionId, 'checkpoints')
      let files: string[] = []
      try {
        files = (await fs.readdir(checkpointDir))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .reverse()
      } catch {
        return null
      }
      const latest = files[0]
      if (!latest) return null
      try {
        const raw = await fs.readFile(path.join(checkpointDir, latest), 'utf-8')
        const checkpoint = JSON.parse(raw) as Record<string, unknown>
        const createdAt = new Date(
          typeof checkpoint.updated_at === 'number' ? checkpoint.updated_at * 1000 : Date.now()
        ).toISOString()
        const title =
          (typeof checkpoint.last_user_message === 'string' && checkpoint.last_user_message.trim()) ||
          (typeof checkpoint.title === 'string' && checkpoint.title.trim()) ||
          '未命名会话'

        return {
          id: sessionId,
          agentId: SYSTEM_DEFAULT_AGENT_ID,
          userId: '22222222-2222-2222-2222-222222222222',
          status: 'active' as SessionStatus,
          title: title.slice(0, 100),
          metadata: undefined,
          startedAt: createdAt,
          endedAt: undefined,
          createdAt,
        } satisfies Session
      } catch {
        return null
      }
    })
  )

  return sessions.filter((item): item is Session => item !== null)
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建会话
 */
export async function createSession(
  userId: string,
  input: CreateSessionInput
): Promise<Session> {
  const row = await sessionRepository.create({
    agentId: input.agentId,
    userId,
    title: input.title,
    metadata: input.metadata,
  })
  return rowToSession(row)
}

/**
 * 获取会话
 */
export async function getSession(sessionId: string): Promise<Session> {
  const row = await sessionRepository.findByIdAndOrg(sessionId)
  if (!row) {
    return getRuntimeSessionOrThrow(sessionId)
  }
  const session = rowToSession(row)
  if (session.status !== 'active') {
    return session
  }

  const terminalMap = await buildRuntimeSessionTerminalMap(500).catch(
    () => new Map<string, RuntimeTerminalSnapshot>()
  )
  const terminal = terminalMap.get(sessionId)
  if (!terminal) {
    return session
  }

  return {
    ...session,
    status: terminal.status,
    endedAt: terminal.endedAt ?? session.endedAt,
    metadata: {
      ...(session.metadata ?? {}),
      ...(terminal.eventType ? { runtime_terminal_event_type: terminal.eventType } : {}),
    },
  }
}

/**
 * 列出会话
 */
export async function listSessions(
  userId: string,
  options: ListSessionsOptions = {}
): Promise<PaginatedResult<Session>> {
  const result = await sessionRepository.findByUserAndOrg({
    userId,
    page: options.page,
    limit: options.limit,
    agentId: options.agentId,
    status: options.status,
  })

  const dbSessions = result.data.map(rowToSession)
  const [runtimeSessions, checkpointSessions] = await Promise.all([
    listRuntimeSessions().catch(() => [] as Session[]),
    listCheckpointSessions().catch(() => [] as Session[]),
  ])
  const merged = [...dbSessions, ...runtimeSessions, ...checkpointSessions]
  const seen = new Set<string>()
  const all = merged.filter((session) => {
    if (seen.has(session.id)) return false
    seen.add(session.id)
    return (
      session.userId === userId &&
      (!options.agentId || session.agentId === options.agentId) &&
      (!options.status || session.status === options.status)
    )
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const limit = options.limit || 20
  const page = options.page || 1
  const offset = (page - 1) * limit
  const data = all.slice(offset, offset + limit)
  return {
    data,
    meta: {
      total: all.length,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(all.length / limit)),
    },
  }
}

/**
 * 更新会话状态
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<Session> {
  const { row, alreadyEnded } = await sessionRepository.updateStatusIfActive(sessionId, status)
  if (alreadyEnded) throw createError(SESSION_ALREADY_COMPLETED)
  if (!row) throw createError(SESSION_NOT_FOUND)
  return rowToSession(row)
}

/**
 * 更新会话标题
 */
export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<Session> {
  const row = await sessionRepository.updateTitle(sessionId, title)
  if (!row) throw createError(SESSION_NOT_FOUND)
  return rowToSession(row)
}

/**
 * 同时更新会话标题和/或状态（单次 DB 往返）
 */
export async function updateSession(
  sessionId: string,
  fields: { title?: string; status?: SessionStatus }
): Promise<Session> {
  const row = await sessionRepository.updateFields(sessionId, fields)
  if (!row) throw createError(SESSION_NOT_FOUND)
  return rowToSession(row)
}

/**
 * 删除会话
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await getSession(sessionId)
  await messageRepository.softDeleteBySessionId(sessionId)
  const deleted = await sessionRepository.softDelete(sessionId)
  if (!deleted) throw createError(SESSION_NOT_FOUND)
}

export async function getSessionMessages(
  sessionId: string
): Promise<Message[]> {
  const rows = await messageRepository.findBySessionId(sessionId)
  return rows.map(rowToMessage)
}

export async function getSessionView(sessionId: string): Promise<SessionView> {
  const session = await getSession(sessionId)
  const rows = await messageRepository.findBySessionId(sessionId)
  const [currentAttemptRow, attemptsSummaryRows] = await Promise.all([
    runtimeAttemptRepository.findCurrentBySessionId(sessionId).catch(() => null),
    runtimeAttemptRepository.listBySessionId(sessionId, 10).catch(() => []),
  ])
  const messages = rows.map(rowToMessage)
  const currentAttempt = currentAttemptRow ? rowToRuntimeAttempt(currentAttemptRow) : null
  const latestCheckpoint = currentAttempt ? getLatestRuntimeAttemptCheckpoint(currentAttempt) : null
  const runtimeProjection = currentAttempt
    ? await buildRuntimeAttemptProjection(currentAttempt, latestCheckpoint)
    : { runState: null, notices: [], processTrace: null }
  const projectedStatus =
    session.status === 'active'
      ? runtimeProjection.runState?.status === 'completed'
        ? 'completed'
        : runtimeProjection.runState?.status === 'failed' || runtimeProjection.runState?.status === 'cancelled'
          ? 'failed'
          : runtimeProjection.runState?.status === 'awaiting_approval' && runtimeProjection.runState.pendingApprovalIds.length === 0
            ? 'completed'
          : session.status
      : session.status
  const projectedSession =
    projectedStatus !== session.status
      ? { ...session, status: projectedStatus }
      : session

  return {
    session: projectedSession,
    messages,
    currentAttempt,
    attemptsSummary: attemptsSummaryRows.map(rowToRuntimeAttempt),
    runState: runtimeProjection.runState,
    notices: runtimeProjection.notices,
    processTrace: runtimeProjection.processTrace,
  }
}

/**
 * 添加消息到会话
 */
export async function addMessage(
  sessionId: string,
  input: AddMessageInput
): Promise<Message> {
  const session = await getSession(sessionId)
  if (session.status === 'completed' || session.status === 'failed') {
    throw createError(SESSION_ALREADY_COMPLETED)
  }

  const messageCount = await messageRepository.countBySessionId(sessionId)
  if (messageCount >= MAX_SESSION_MESSAGES) {
    sessionLogger.warn('会话消息数已达上限', { sessionId, current: messageCount, limit: MAX_SESSION_MESSAGES })
    throw createError(MESSAGE_LIMIT_EXCEEDED)
  }

  const row = await messageRepository.create({
    sessionId,
    attemptId: input.attemptId,
    userMessageId: input.userMessageId,
    role: input.role,
    content: input.content,
    parentId: input.parentId,
    toolCalls: input.toolCalls,
    toolCallId: input.toolCallId,
    tokensUsed: input.tokensUsed,
    latencyMs: input.latencyMs,
    metadata: input.metadata,
  })

  return rowToMessage(row)
}

export async function createRuntimeAttempt(
  sessionId: string,
  input: CreateRuntimeAttemptInput
): Promise<RuntimeAttempt> {
  await getSession(sessionId)
  const row = await runtimeAttemptRepository.create({
    sessionId,
    userMessageId: input.userMessageId,
    agentId: input.agentId,
    executionMode: input.executionMode,
    status: input.status,
    metadata: input.metadata,
  })
  await sessionRepository.updateFields(sessionId, { currentAttemptId: row.id })
  return rowToRuntimeAttempt(row)
}

export async function getRuntimeAttempt(attemptId: string): Promise<RuntimeAttempt | null> {
  const row = await runtimeAttemptRepository.findById(attemptId)
  return row ? rowToRuntimeAttempt(row) : null
}

export async function getRuntimeAttemptView(attemptId: string): Promise<RuntimeAttemptView> {
  const attempt = await getRuntimeAttempt(attemptId)
  if (!attempt) {
    throw createError(SESSION_NOT_FOUND)
  }
  const [session, messagesRows, eventOutboxRows, checkpointOutboxRows] = await Promise.all([
    getSession(attempt.sessionId),
    messageRepository.findByAttemptId(attemptId),
    runtimeAttemptRepository.listEventOutboxByAttemptId(attemptId),
    runtimeAttemptRepository.listCheckpointOutboxByAttemptId(attemptId),
  ])
  const messages = messagesRows.map(rowToMessage)
  const latestCheckpoint = getLatestRuntimeAttemptCheckpoint(attempt)
  const attemptProjection = await buildRuntimeAttemptProjection(attempt, latestCheckpoint)
  return {
    attempt,
    session,
    messages,
    latestCheckpoint,
    eventOutbox: eventOutboxRows.map((item) => ({
      id: item.id,
      revision: item.revision,
      eventType: item.event_type,
      status: item.status,
      createdAt: item.created_at,
      deliveredAt: item.delivered_at ?? undefined,
    })),
    checkpointOutbox: checkpointOutboxRows.map((item) => ({
      id: item.id,
      checkpointId: item.checkpoint_id,
      revision: item.revision,
      projectionTarget: item.projection_target,
      status: item.status,
      createdAt: item.created_at,
      deliveredAt: item.delivered_at ?? undefined,
    })),
    runState: attemptProjection.runState,
    notices: attemptProjection.notices,
    processTrace: attemptProjection.processTrace,
  }
}

export async function getCurrentRuntimeAttempt(sessionId: string): Promise<RuntimeAttempt | null> {
  const row = await runtimeAttemptRepository.findCurrentBySessionId(sessionId)
  return row ? rowToRuntimeAttempt(row) : null
}

export async function updateRuntimeAttempt(
  attemptId: string,
  input: UpdateRuntimeAttemptInput
): Promise<RuntimeAttempt | null> {
  const row = await runtimeAttemptRepository.update(attemptId, input)
  return row ? rowToRuntimeAttempt(row) : null
}

export async function claimRuntimeAttemptLease(
  input: ClaimRuntimeAttemptLeaseInput
): Promise<RuntimeAttempt | null> {
  const row = await runtimeAttemptRepository.claimLease(input)
  return row ? rowToRuntimeAttempt(row) : null
}

export async function heartbeatRuntimeAttempt(
  input: HeartbeatRuntimeAttemptInput
): Promise<RuntimeAttempt | null> {
  const row = await runtimeAttemptRepository.heartbeat(input)
  return row ? rowToRuntimeAttempt(row) : null
}

export async function listStalledRuntimeAttempts(limit = 100): Promise<RuntimeAttempt[]> {
  const rows = await runtimeAttemptRepository.listStalled(limit)
  return rows.map(rowToRuntimeAttempt)
}

export async function appendRuntimeAttemptCheckpoint(
  attemptId: string,
  input: {
    sessionId: string
    userMessageId: string
    status: RuntimeAttemptStatus
    payload?: Record<string, unknown>
  }
): Promise<RuntimeAttemptCheckpoint> {
  return runtimeAttemptCommitService.appendRuntimeAttemptCheckpointCommitted(attemptId, input)
}

export async function commitAttemptState(
  input: CommitAttemptStateInput
): Promise<RuntimeAttempt> {
  return runtimeAttemptCommitService.commitAttemptState(input)
}

export async function commitAttemptTerminal(
  input: CommitAttemptTerminalInput
): Promise<RuntimeAttempt> {
  return runtimeAttemptCommitService.commitAttemptTerminal(input)
}

/**
 * 更新消息
 */
export async function updateMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<Pick<Message, 'content' | 'tokensUsed' | 'latencyMs' | 'metadata'>>
): Promise<Message> {
  // 先验证会话存在
  await getSession(sessionId)

  const row = await messageRepository.update(messageId, {
    content: updates.content,
    tokensUsed: updates.tokensUsed,
    latencyMs: updates.latencyMs,
    metadata: updates.metadata,
  })

  if (!row) {
    throw createError(MESSAGE_NOT_FOUND)
  }

  return rowToMessage(row)
}
