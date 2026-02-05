/**
 * Session 服务层
 */

import { v4 as uuidv4 } from 'uuid'
import { createError } from '../middleware/errorHandler'
import {
  SESSION_NOT_FOUND,
  SESSION_ALREADY_COMPLETED,
  MESSAGE_LIMIT_EXCEEDED,
  MESSAGE_NOT_FOUND,
} from '../constants/errorCodes'
import {
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_SESSION_MESSAGES,
} from '../constants/config'

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
// 模拟数据存储 (开发用，生产环境使用数据库)
// ═══════════════════════════════════════════════════════════════

const sessionsStore = new Map<string, Session>()
const messagesStore = new Map<string, Message[]>()

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
  const now = new Date().toISOString()

  const session: Session = {
    id: uuidv4(),
    orgId,
    agentId: input.agentId,
    userId,
    status: 'active',
    title: input.title,
    metadata: input.metadata,
    startedAt: now,
    createdAt: now,
  }

  sessionsStore.set(session.id, session)
  messagesStore.set(session.id, [])

  return session
}

/**
 * 获取会话
 */
export async function getSession(orgId: string, sessionId: string): Promise<Session> {
  const session = sessionsStore.get(sessionId)

  if (!session || session.orgId !== orgId) {
    throw createError(SESSION_NOT_FOUND)
  }

  return session
}

/**
 * 列出会话
 */
export async function listSessions(
  orgId: string,
  userId: string,
  options: ListSessionsOptions = {}
): Promise<PaginatedResult<Session>> {
  const {
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
    agentId,
    status,
  } = options

  // 限制分页大小
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  if (limit > MAX_PAGE_SIZE) {
    console.warn(
      `[SessionService] 分页大小超出限制，已截断 - 请求: ${limit}, 限制: ${MAX_PAGE_SIZE}`
    )
  }

  let sessions = Array.from(sessionsStore.values()).filter(
    (s) => s.orgId === orgId && s.userId === userId
  )

  // 按 Agent 筛选
  if (agentId) {
    sessions = sessions.filter((s) => s.agentId === agentId)
  }

  // 按状态筛选
  if (status) {
    sessions = sessions.filter((s) => s.status === status)
  }

  // 排序 (按创建时间倒序)
  sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  // 分页
  const total = sessions.length
  const totalPages = Math.ceil(total / actualLimit)
  const offset = (page - 1) * actualLimit
  const data = sessions.slice(offset, offset + actualLimit)

  return {
    data,
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages,
    },
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
  const session = await getSession(orgId, sessionId)

  if (session.status === 'completed' || session.status === 'failed') {
    throw createError(SESSION_ALREADY_COMPLETED)
  }

  const updatedSession: Session = {
    ...session,
    status,
    ...(status === 'completed' || status === 'failed'
      ? { endedAt: new Date().toISOString() }
      : {}),
  }

  sessionsStore.set(sessionId, updatedSession)

  return updatedSession
}

/**
 * 更新会话标题
 */
export async function updateSessionTitle(
  orgId: string,
  sessionId: string,
  title: string
): Promise<Session> {
  const session = await getSession(orgId, sessionId)

  const updatedSession: Session = {
    ...session,
    title,
  }

  sessionsStore.set(sessionId, updatedSession)

  return updatedSession
}

/**
 * 删除会话
 */
export async function deleteSession(orgId: string, sessionId: string): Promise<void> {
  await getSession(orgId, sessionId) // 验证会话存在

  sessionsStore.delete(sessionId)
  messagesStore.delete(sessionId)
}

/**
 * 获取会话消息列表
 */
export async function getSessionMessages(
  orgId: string,
  sessionId: string
): Promise<Message[]> {
  await getSession(orgId, sessionId) // 验证会话存在

  return messagesStore.get(sessionId) ?? []
}

/**
 * 添加消息到会话
 */
export async function addMessage(
  orgId: string,
  sessionId: string,
  input: AddMessageInput
): Promise<Message> {
  await getSession(orgId, sessionId) // 验证会话存在

  const messages = messagesStore.get(sessionId) ?? []

  // 检查消息数量限制
  if (messages.length >= MAX_SESSION_MESSAGES) {
    console.warn(
      `[SessionService] 会话消息数已达上限 - 会话: ${sessionId}, 当前: ${messages.length}, 限制: ${MAX_SESSION_MESSAGES}`
    )
    throw createError(MESSAGE_LIMIT_EXCEEDED)
  }

  const message: Message = {
    id: uuidv4(),
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

  messages.push(message)
  messagesStore.set(sessionId, messages)

  return message
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
  await getSession(orgId, sessionId)

  const messages = messagesStore.get(sessionId) ?? []
  const messageIndex = messages.findIndex((m) => m.id === messageId)

  if (messageIndex === -1) {
    throw createError(MESSAGE_NOT_FOUND)
  }

  const updatedMessage: Message = {
    ...messages[messageIndex],
    ...updates,
  }

  messages[messageIndex] = updatedMessage
  messagesStore.set(sessionId, messages)

  return updatedMessage
}
