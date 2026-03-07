/**
 * Session 服务层
 *
 * 使用数据库持久化实现 Session/Message CRUD
 */

import { randomUUID } from 'crypto'
import { createError } from '../middleware/errorHandler'
import {
  SESSION_NOT_FOUND,
  SESSION_ALREADY_COMPLETED,
  MESSAGE_LIMIT_EXCEEDED,
  MESSAGE_NOT_FOUND,
} from '../constants/errorCodes'
import { MAX_SESSION_MESSAGES } from '../constants/config'
import { runtimeRequest } from '../lib/runtime-client'
import { isDatabaseUnavailable, isSingleUserMode } from '../lib/local-mode'
import * as sessionRepository from '../repositories/session.repository'
import * as messageRepository from '../repositories/message.repository'
import { createLogger } from '../lib/logger'

const sessionLogger = createLogger('session')
const localSessions = new Map<string, Session>()
const localMessages = new Map<string, Message[]>()
const SYSTEM_DEFAULT_AGENT_ID = '00000000-0000-0000-0000-000000000001'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed'
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface Session {
  id: string
  orgId: string
  agentId: string
  userId: string
  status: SessionStatus
  title?: string
  metadata?: Record<string, unknown>
  runtimeType?: 'semigraph'
  startedAt: string
  endedAt?: string
  createdAt: string
}

export interface Message {
  id: string
  sessionId: string
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
  runtimeType?: 'semigraph'
}

export interface AddMessageInput {
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

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 Session 对象
 */
function rowToSession(row: sessionRepository.SessionRow): Session {
  const rawRuntimeType = String(row.runtime_type ?? '').toLowerCase()
  if (rawRuntimeType === 'openclaw') {
    sessionLogger.warn('检测到已弃用 runtimeType=openclaw 会话，已自动降级为 semigraph', { sessionId: row.id })
  }
  return {
    id: row.id,
    orgId: row.org_id,
    agentId: row.agent_id,
    userId: row.user_id,
    status: row.status,
    title: row.title ?? undefined,
    metadata: row.metadata ?? undefined,
    runtimeType: 'semigraph',
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

function buildLocalSession(orgId: string, userId: string, input: CreateSessionInput): Session {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    orgId,
    agentId: input.agentId,
    userId,
    status: 'active',
    title: input.title ?? undefined,
    metadata: input.metadata ?? undefined,
    runtimeType: 'semigraph',
    startedAt: now,
    createdAt: now,
  }
}

function getLocalSessionOrThrow(orgId: string, sessionId: string): Session {
  const session = localSessions.get(sessionId)
  if (!session || session.orgId !== orgId) throw createError(SESSION_NOT_FOUND)
  return session
}

type RuntimeSessionListResponse = {
  items?: Array<{ session_id?: string; last_seen_at?: string }>
}

type RuntimeEventRecord = {
  event_id?: string
  event_type?: string
  subject?: string
  payload?: Record<string, unknown>
  timestamp?: string
}

async function listRuntimeSessions(): Promise<Session[]> {
  const response = await runtimeRequest<RuntimeSessionListResponse>('/v1/sessions', {
    method: 'GET',
    query: { limit: 200 },
    timeoutMs: 4000,
  })
  const items = Array.isArray(response.items) ? response.items : []
  return items
    .map((item) => {
      const id = String(item.session_id || '').trim()
      if (!id) return null
      const seenAt = String(item.last_seen_at || new Date().toISOString())
      return {
        id,
        orgId: process.env.SEMIBOT_SINGLE_ORG_ID || '11111111-1111-1111-1111-111111111111',
        agentId: SYSTEM_DEFAULT_AGENT_ID,
        userId: '22222222-2222-2222-2222-222222222222',
        status: 'active' as SessionStatus,
        title: undefined,
        metadata: undefined,
        runtimeType: 'semigraph' as const,
        startedAt: seenAt,
        endedAt: undefined,
        createdAt: seenAt,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
}

async function getRuntimeSessionOrThrow(orgId: string, sessionId: string): Promise<Session> {
  const sessions = await listRuntimeSessions()
  const session = sessions.find((item) => item.id === sessionId && item.orgId === orgId)
  if (!session) throw createError(SESSION_NOT_FOUND)
  return session
}

async function listRuntimeEvents(limit = 500): Promise<RuntimeEventRecord[]> {
  const response = await runtimeRequest<{ items?: RuntimeEventRecord[] }>('/v1/events', {
    method: 'GET',
    query: { limit },
    timeoutMs: 4000,
  })
  return Array.isArray(response.items) ? response.items : []
}

async function getRuntimeSessionMessages(sessionId: string): Promise<Message[]> {
  const events = await listRuntimeEvents(500)
  const items = events
    .filter((event) => {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
      return String((payload as Record<string, unknown>).session_id || '') === sessionId
    })
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))

  const messages: Message[] = []
  for (const event of items) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const eventType = String(event.event_type || '')
    const createdAt = String(event.timestamp || new Date().toISOString())
    if (eventType === 'chat.message.received') {
      const content = String((payload as Record<string, unknown>).message || '')
      if (!content) continue
      messages.push({
        id: String(event.event_id || randomUUID()),
        sessionId,
        role: 'user',
        content,
        createdAt,
      })
      continue
    }
    if (eventType === 'task.completed' || eventType === 'task.failed') {
      const content = String((payload as Record<string, unknown>).final_response || (payload as Record<string, unknown>).error || '')
      if (!content) continue
      messages.push({
        id: String(event.event_id || randomUUID()),
        sessionId,
        role: 'assistant',
        content,
        metadata: {
          status: (payload as Record<string, unknown>).status,
          error: (payload as Record<string, unknown>).error,
        },
        createdAt,
      })
    }
  }
  return messages
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建会话
 */
export async function createSession(
  orgId: string,
  userId: string,
  input: CreateSessionInput
): Promise<Session> {
  try {
    const row = await sessionRepository.create({
      orgId,
      agentId: input.agentId,
      userId,
      title: input.title,
      metadata: input.metadata,
      runtimeType: 'semigraph',
    })

    return rowToSession(row)
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const session = buildLocalSession(orgId, userId, input)
      localSessions.set(session.id, session)
      localMessages.set(session.id, [])
      return session
    }
    throw error
  }
}

/**
 * 获取会话
 */
export async function getSession(orgId: string, sessionId: string): Promise<Session> {
  try {
    const row = await sessionRepository.findByIdAndOrg(sessionId, orgId)

    if (!row) {
      throw createError(SESSION_NOT_FOUND)
    }

    return rowToSession(row)
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const local = localSessions.get(sessionId)
      if (local && local.orgId === orgId) return local
      return getRuntimeSessionOrThrow(orgId, sessionId)
    }
    throw error
  }
}

/**
 * 列出会话
 */
export async function listSessions(
  orgId: string,
  userId: string,
  options: ListSessionsOptions = {}
): Promise<PaginatedResult<Session>> {
  try {
    const result = await sessionRepository.findByUserAndOrg({
      orgId,
      userId,
      page: options.page,
      limit: options.limit,
      agentId: options.agentId,
      status: options.status,
    })

    return {
      data: result.data.map(rowToSession),
      meta: result.meta,
    }
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const runtimeSessions = await listRuntimeSessions().catch(() => [] as Session[])
      const merged = [...runtimeSessions, ...Array.from(localSessions.values())]
      const all = merged.filter((session, index) => (
        merged.findIndex((item) => item.id === session.id) === index &&
        session.orgId === orgId &&
        session.userId === userId &&
        (!options.agentId || session.agentId === options.agentId) &&
        (!options.status || session.status === options.status)
      )).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
    throw error
  }
}

/**
 * 更新会话状态
 */
export async function updateSessionStatus(
  orgId: string,
  sessionId: string,
  status: SessionStatus
): Promise<Session> {
  try {
    const session = await getSession(orgId, sessionId)

    if (session.status === 'completed' || session.status === 'failed') {
      throw createError(SESSION_ALREADY_COMPLETED)
    }

    const row = await sessionRepository.updateStatus(sessionId, orgId, status)

    if (!row) {
      throw createError(SESSION_NOT_FOUND)
    }

    return rowToSession(row)
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const session = getLocalSessionOrThrow(orgId, sessionId)
      if (session.status === 'completed' || session.status === 'failed') {
        throw createError(SESSION_ALREADY_COMPLETED)
      }
      const updated: Session = {
        ...session,
        status,
        endedAt: status === 'completed' || status === 'failed' ? new Date().toISOString() : session.endedAt,
      }
      localSessions.set(sessionId, updated)
      return updated
    }
    throw error
  }
}

/**
 * 更新会话标题
 */
export async function updateSessionTitle(
  orgId: string,
  sessionId: string,
  title: string
): Promise<Session> {
  try {
    const row = await sessionRepository.updateTitle(sessionId, orgId, title)

    if (!row) {
      throw createError(SESSION_NOT_FOUND)
    }

    return rowToSession(row)
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const session = getLocalSessionOrThrow(orgId, sessionId)
      const updated = { ...session, title }
      localSessions.set(sessionId, updated)
      return updated
    }
    throw error
  }
}

/**
 * 删除会话
 */
export async function deleteSession(orgId: string, sessionId: string): Promise<void> {
  try {
    await getSession(orgId, sessionId)
    await messageRepository.softDeleteBySessionId(sessionId)
    const deleted = await sessionRepository.softDelete(sessionId, orgId)

    if (!deleted) {
      throw createError(SESSION_NOT_FOUND)
    }
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      getLocalSessionOrThrow(orgId, sessionId)
      localSessions.delete(sessionId)
      localMessages.delete(sessionId)
      return
    }
    throw error
  }
}

/**
 * 获取会话消息列表
 */
export async function getSessionMessages(
  orgId: string,
  sessionId: string
): Promise<Message[]> {
  try {
    await getSession(orgId, sessionId)
    const rows = await messageRepository.findBySessionId(sessionId)
    return rows.map(rowToMessage)
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const local = localSessions.get(sessionId)
      if (local && local.orgId === orgId) {
        return [...(localMessages.get(sessionId) || [])]
      }
      return getRuntimeSessionMessages(sessionId)
    }
    throw error
  }
}

/**
 * 添加消息到会话
 */
export async function addMessage(
  orgId: string,
  sessionId: string,
  input: AddMessageInput
): Promise<Message> {
  try {
    const session = await getSession(orgId, sessionId)
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
  } catch (error) {
    if (isSingleUserMode() && isDatabaseUnavailable(error)) {
      const session = getLocalSessionOrThrow(orgId, sessionId)
      if (session.status === 'completed' || session.status === 'failed') {
        throw createError(SESSION_ALREADY_COMPLETED)
      }
      const items = localMessages.get(sessionId) || []
      if (items.length >= MAX_SESSION_MESSAGES) {
        throw createError(MESSAGE_LIMIT_EXCEEDED)
      }
      const message: Message = {
        id: randomUUID(),
        sessionId,
        parentId: input.parentId,
        role: input.role,
        content: input.content,
        toolCalls: input.toolCalls,
        toolCallId: input.toolCallId,
        tokensUsed: input.tokensUsed,
        latencyMs: input.latencyMs,
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      }
      items.push(message)
      localMessages.set(sessionId, items)
      return message
    }
    throw error
  }
}

/**
 * 更新消息
 */
export async function updateMessage(
  orgId: string,
  sessionId: string,
  messageId: string,
  updates: Partial<Pick<Message, 'content' | 'tokensUsed' | 'latencyMs' | 'metadata'>>
): Promise<Message> {
  // 先验证会话存在
  await getSession(orgId, sessionId)

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
