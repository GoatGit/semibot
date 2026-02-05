/**
 * Session 服务层
 *
 * 使用数据库持久化实现 Session/Message CRUD
 */

import { createError } from '../middleware/errorHandler'
import {
  SESSION_NOT_FOUND,
  SESSION_ALREADY_COMPLETED,
  MESSAGE_LIMIT_EXCEEDED,
  MESSAGE_NOT_FOUND,
} from '../constants/errorCodes'
import { MAX_SESSION_MESSAGES } from '../constants/config'
import * as sessionRepository from '../repositories/session.repository'
import * as messageRepository from '../repositories/message.repository'

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
  return {
    id: row.id,
    orgId: row.org_id,
    agentId: row.agent_id,
    userId: row.user_id,
    status: row.status,
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
  const row = await sessionRepository.create({
    orgId,
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
export async function getSession(orgId: string, sessionId: string): Promise<Session> {
  const row = await sessionRepository.findByIdAndOrg(sessionId, orgId)

  if (!row) {
    throw createError(SESSION_NOT_FOUND)
  }

  return rowToSession(row)
}

/**
 * 列出会话
 */
export async function listSessions(
  orgId: string,
  userId: string,
  options: ListSessionsOptions = {}
): Promise<PaginatedResult<Session>> {
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
}

/**
 * 更新会话状态
 */
export async function updateSessionStatus(
  orgId: string,
  sessionId: string,
  status: SessionStatus
): Promise<Session> {
  // 先获取会话检查状态
  const session = await getSession(orgId, sessionId)

  if (session.status === 'completed' || session.status === 'failed') {
    throw createError(SESSION_ALREADY_COMPLETED)
  }

  const row = await sessionRepository.updateStatus(sessionId, orgId, status)

  if (!row) {
    throw createError(SESSION_NOT_FOUND)
  }

  return rowToSession(row)
}

/**
 * 更新会话标题
 */
export async function updateSessionTitle(
  orgId: string,
  sessionId: string,
  title: string
): Promise<Session> {
  const row = await sessionRepository.updateTitle(sessionId, orgId, title)

  if (!row) {
    throw createError(SESSION_NOT_FOUND)
  }

  return rowToSession(row)
}

/**
 * 删除会话
 */
export async function deleteSession(orgId: string, sessionId: string): Promise<void> {
  // 先验证会话存在
  await getSession(orgId, sessionId)

  // 删除所有消息
  await messageRepository.deleteBySessionId(sessionId)

  // 删除会话
  const deleted = await sessionRepository.remove(sessionId, orgId)

  if (!deleted) {
    throw createError(SESSION_NOT_FOUND)
  }
}

/**
 * 获取会话消息列表
 */
export async function getSessionMessages(
  orgId: string,
  sessionId: string
): Promise<Message[]> {
  // 先验证会话存在
  await getSession(orgId, sessionId)

  const rows = await messageRepository.findBySessionId(sessionId)

  return rows.map(rowToMessage)
}

/**
 * 添加消息到会话
 */
export async function addMessage(
  orgId: string,
  sessionId: string,
  input: AddMessageInput
): Promise<Message> {
  // 先验证会话存在
  const session = await getSession(orgId, sessionId)

  // 检查会话状态 - 已完成或失败的会话不允许添加消息
  if (session.status === 'completed' || session.status === 'failed') {
    throw createError(SESSION_ALREADY_COMPLETED)
  }

  // 检查消息数量限制
  const messageCount = await messageRepository.countBySessionId(sessionId)

  if (messageCount >= MAX_SESSION_MESSAGES) {
    console.warn(
      `[SessionService] 会话消息数已达上限 - 会话: ${sessionId}, 当前: ${messageCount}, 限制: ${MAX_SESSION_MESSAGES}`
    )
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
