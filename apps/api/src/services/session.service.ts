/**
 * Session 服务层
 *
 * 使用数据库持久化实现 Session/Message CRUD
 */

import { randomUUID } from 'crypto'
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
import * as sessionRepository from '../repositories/session.repository'
import * as messageRepository from '../repositories/message.repository'
import { createLogger } from '../lib/logger'
import { mapRuntimeEventToAgent2UI } from '../ws/message-router'

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
  subject?: string
  payload?: Record<string, unknown>
  timestamp?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRuntimeEventForHistory(input: RuntimeEventRecord): Record<string, unknown> | null {
  const eventName = String(input.event_type || '').trim()
  if (!eventName) return null

  const data = isRecord(input.payload) ? input.payload : {}
  const get = (key: string): unknown => data[key] ?? (input as Record<string, unknown>)[key]

  switch (eventName) {
    case 'thinking':
      return {
        type: 'thinking',
        content: String(get('content') || ''),
        stage: get('stage'),
      }
    case 'plan_created':
    case 'plan_version':
      return {
        type: eventName,
        steps: Array.isArray(get('steps')) ? get('steps') : [],
      }
    case 'plan.step.started':
      return {
        type: 'plan_step_start',
        step_id: get('step_id') ?? get('stepId') ?? get('id'),
        title: get('title') ?? get('step_title') ?? get('action'),
        tool: get('tool') ?? get('tool_name'),
        params: get('params'),
      }
    case 'plan.step.completed':
      return {
        type: 'plan_step_complete',
        step_id: get('step_id') ?? get('stepId') ?? get('id'),
        title: get('title') ?? get('step_title') ?? get('action'),
        result: get('result'),
        duration_ms: get('duration_ms') ?? get('duration'),
      }
    case 'plan.step.failed':
      return {
        type: 'plan_step_failed',
        step_id: get('step_id') ?? get('stepId') ?? get('id'),
        title: get('title') ?? get('step_title') ?? get('action'),
        error: get('error'),
      }
    case 'tool.exec.started':
      return {
        type: 'tool_call_start',
        tool_name: get('tool_name') ?? input.subject,
        arguments: get('params') ?? get('arguments') ?? {},
      }
    case 'tool.exec.completed':
    case 'tool.exec.failed':
      return {
        type: 'tool_call_complete',
        tool_name: get('tool_name') ?? input.subject,
        result: get('result'),
        success: eventName === 'tool.exec.completed' ? get('success') ?? true : false,
        error: get('error'),
        duration: get('duration_ms') ?? get('duration'),
      }
    case 'skill_orchestration_trace':
      return {
        type: 'skill_orchestration_trace',
        ...data,
        observe_outcome: get('observe_outcome') ?? get('observeOutcome'),
        observe_reason: get('observe_reason') ?? get('observeReason'),
      }
    case 'act_decision':
      return {
        type: 'act_decision',
        step_id: get('step_id') ?? get('stepId') ?? get('id'),
        title: get('title') ?? get('step_title') ?? get('action'),
        planner_phase: get('planner_phase') ?? get('plannerPhase'),
        planner_intent: get('planner_intent') ?? get('plannerIntent'),
        planner_required_resources: get('planner_required_resources') ?? get('plannerRequiredResources') ?? [],
        planner_expected_outputs: get('planner_expected_outputs') ?? get('plannerExpectedOutputs') ?? [],
        planner_completion_criteria: get('planner_completion_criteria') ?? get('plannerCompletionCriteria') ?? [],
        decision: get('decision'),
        tool_name: get('tool_name') ?? get('selectedTool'),
        arguments: get('arguments') ?? {},
        artifact_result_text: get('artifact_result_text') ?? get('artifactResultText'),
        artifact_type: get('artifact_type') ?? get('artifactType'),
        artifact_medium: get('artifact_medium') ?? get('artifactMedium'),
        artifact_format: get('artifact_format') ?? get('artifactFormat'),
        artifact_name: get('artifact_name') ?? get('artifactName'),
        artifact_purpose: get('artifact_purpose') ?? get('artifactPurpose'),
        completion_text: get('completion_text') ?? get('completionText'),
        selected_skill: get('selected_skill') ?? get('selectedSkill'),
      }
    case 'text_chunk':
    case 'text':
      return {
        type: eventName,
        content: String(get('content') || ''),
      }
    case 'file_created':
      return {
        type: 'file_created',
        url: get('url'),
        filename: get('filename'),
        mime_type: get('mime_type') ?? get('mimeType'),
        size: get('size'),
      }
    default:
      return null
  }
}

type RuntimeTerminalSnapshot = {
  status: SessionStatus
  endedAt?: string
  eventType?: string
}

async function buildRuntimeSessionTerminalMap(limit = 500): Promise<Map<string, RuntimeTerminalSnapshot>> {
  const events = await listRuntimeEvents(limit)
  const terminalMap = new Map<string, RuntimeTerminalSnapshot>()

  for (const event of events) {
    const eventType = String(event.event_type || '').trim()
    if (!['task.completed', 'task.failed', 'task.cancelled'].includes(eventType)) continue
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
    timeoutMs: 2000,
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
    const messages = await getRuntimeSessionMessages(sessionId).catch(() => [] as Message[])
    if (messages.length === 0) {
      throw createError(SESSION_NOT_FOUND)
    }

    const terminalMap = await buildRuntimeSessionTerminalMap(500).catch(() => new Map<string, RuntimeTerminalSnapshot>())
    const terminal = terminalMap.get(sessionId)
    const createdAt = messages[0]?.createdAt || new Date().toISOString()
    const synthesized: Session = {
      id: sessionId,
      agentId: SYSTEM_DEFAULT_AGENT_ID,
      userId: '22222222-2222-2222-2222-222222222222',
      status: terminal?.status || 'active',
      title: messages.find((item) => item.role === 'user')?.content?.slice(0, 100) || '未命名会话',
      metadata: terminal?.eventType ? { runtime_terminal_event_type: terminal.eventType } : undefined,
      startedAt: createdAt,
      endedAt: terminal?.endedAt,
      createdAt,
    }
    return synthesized
  }
  return session
}

async function listRuntimeEvents(limit = 500, sessionId?: string): Promise<RuntimeEventRecord[]> {
  const response = await runtimeRequest<{ items?: RuntimeEventRecord[] }>('/v1/events', {
    method: 'GET',
    query: { limit, ...(sessionId ? { session_id: sessionId } : {}) },
    timeoutMs: 4000,
  })
  return Array.isArray(response.items) ? response.items : []
}

function isGeneratedFileEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.filename === 'string' && typeof record.path === 'string'
}

function collectGeneratedFiles(value: unknown, collected: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectGeneratedFiles(item, collected)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (isGeneratedFileEntry(record)) {
    collected.push(record)
  }
  for (const nested of Object.values(record)) {
    collectGeneratedFiles(nested, collected)
  }
}

function fileMessageFromGeneratedFile(sessionId: string, file: Record<string, unknown>, createdAt: string): Message | null {
  const filename = typeof file.filename === 'string' ? file.filename : null
  const filePath = typeof file.path === 'string' ? file.path : null
  if (!filename || !filePath) return null
  if (file.user_visible === false) return null
  if (typeof file.artifact_role === 'string' && file.artifact_role === 'data_json') return null

  const fileId = typeof file.file_id === 'string' ? file.file_id : randomUUID()
  return {
    id: `file-${fileId}`,
    sessionId,
    role: 'assistant',
    content: '',
    metadata: {
      agent2ui: {
        id: `file-${fileId}`,
        type: 'file',
        data: {
          url: `/api/v1/files/${fileId}`,
          filename,
          mimeType: typeof file.mime_type === 'string' ? file.mime_type : 'application/octet-stream',
          size: typeof file.size === 'number' ? file.size : undefined,
        },
      },
    },
    createdAt,
  }
}

async function getCheckpointSessionMessages(sessionId: string): Promise<Message[]> {
  const checkpointDir = path.join(LOCAL_CHECKPOINT_ROOT, sessionId, 'checkpoints')
  let files: string[] = []
  try {
    files = (await fs.readdir(checkpointDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return []
  }

  let latestLastUserMessage: { content: string; createdAt: string; checkpointId: string } | null = null
  let bestMessages: Message[] = []

  for (const name of files) {
    try {
      const raw = await fs.readFile(path.join(checkpointDir, name), 'utf-8')
      const checkpoint = JSON.parse(raw) as Record<string, unknown>
      const history = Array.isArray(checkpoint.history) ? checkpoint.history : []
      const finalResponse =
        typeof checkpoint.final_response === 'string' ? checkpoint.final_response.trim() : ''
      const toolResults = Array.isArray(checkpoint.tool_results) ? checkpoint.tool_results : []

      const createdAt = new Date(
        typeof checkpoint.updated_at === 'number' ? checkpoint.updated_at * 1000 : Date.now()
      ).toISOString()
      const lastUserMessage =
        typeof checkpoint.last_user_message === 'string' ? checkpoint.last_user_message.trim() : ''

      if (!latestLastUserMessage && lastUserMessage) {
        latestLastUserMessage = {
          content: lastUserMessage,
          createdAt,
          checkpointId: name,
        }
      }

      if (history.length === 0 && !finalResponse && toolResults.length === 0) continue

      const messages: Message[] = []
      history.forEach((item, index) => {
        if (!item || typeof item !== 'object') return
        const record = item as Record<string, unknown>
        const role = record.role === 'user' || record.role === 'assistant' ? record.role : null
        const content = typeof record.content === 'string' ? record.content : ''
        if (!role || !content) return
        messages.push({
          id: `${name}-history-${index}`,
          sessionId,
          role,
          content,
          createdAt,
        })
      })

      if (toolResults.length > 0) {
        try {
          const generatedFiles: Record<string, unknown>[] = []
          collectGeneratedFiles(toolResults, generatedFiles)
          const seenFileIds = new Set<string>()
          for (const file of generatedFiles) {
            const fileId = typeof file.file_id === 'string' ? file.file_id : `${file.filename}-${file.path}`
            if (seenFileIds.has(fileId)) continue
            seenFileIds.add(fileId)
            const message = fileMessageFromGeneratedFile(sessionId, file, createdAt)
            if (message) messages.push(message)
          }
        } catch (error) {
          sessionLogger.warn('从 checkpoint 提取 generated_files 失败，已退回为仅恢复 history', {
            sessionId,
            checkpoint: name,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (messages.length > 0) {
        bestMessages = messages
        break
      }
    } catch {
      continue
    }
  }

  if (bestMessages.length > 0) {
    if (
      latestLastUserMessage &&
      !bestMessages.some(
        (message) =>
          message.role === 'user' &&
          message.content.trim() === latestLastUserMessage?.content
      )
    ) {
      bestMessages = [
        ...bestMessages,
        {
          id: `checkpoint-user-${latestLastUserMessage.checkpointId}`,
          sessionId,
          role: 'user',
          content: latestLastUserMessage.content,
          createdAt: latestLastUserMessage.createdAt,
        },
      ]
    }
    return bestMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  if (latestLastUserMessage) {
    return [
      {
        id: `checkpoint-user-${latestLastUserMessage.checkpointId}`,
        sessionId,
        role: 'user',
        content: latestLastUserMessage.content,
        createdAt: latestLastUserMessage.createdAt,
      },
    ]
  }

  return []
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

async function getRuntimeSessionMessagesFromEvents(sessionId: string): Promise<Message[]> {
  // Pass session_id so runtime filters at SQL level — avoids pulling 500 events into Node.js
  const events = await listRuntimeEvents(500, sessionId)
  const items = events
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))

  const messages: Message[] = []
  let currentProcessMessages: unknown[] = []
  for (const event of items) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const eventType = String(event.event_type || '')
    const createdAt = String(event.timestamp || new Date().toISOString())
    if (eventType === 'chat.message.received') {
      currentProcessMessages = []
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
    const normalized = normalizeRuntimeEventForHistory(event)
    const processMessage = normalized ? mapRuntimeEventToAgent2UI(normalized) : null
    if (processMessage) {
      currentProcessMessages.push(processMessage)
      if (processMessage.type === 'file') {
        messages.push({
          id: String(event.event_id || randomUUID()),
          sessionId,
          role: 'assistant',
          content: '',
          metadata: {
            agent2ui: processMessage,
          },
          createdAt,
        })
      }
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
          execution_process: currentProcessMessages.length > 0
            ? {
                version: 1,
                messages: currentProcessMessages,
              }
            : undefined,
        },
        createdAt,
      })
      currentProcessMessages = []
    }
  }
  return messages
}

async function getRuntimeSessionMessages(sessionId: string): Promise<Message[]> {
  const checkpointMessages = await getCheckpointSessionMessages(sessionId).catch(
    () => [] as Message[]
  )
  if (checkpointMessages.length > 0) {
    return checkpointMessages
  }

  const eventMessages = await Promise.race([
    getRuntimeSessionMessagesFromEvents(sessionId).catch(() => [] as Message[]),
    new Promise<Message[]>((resolve) => {
      setTimeout(() => resolve([]), 2000)
    }),
  ])

  return eventMessages
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
  return rowToSession(row)
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

/**
 * 获取会话消息列表
 */
export async function getSessionMessages(
  sessionId: string
): Promise<Message[]> {
  const rows = await messageRepository.findBySessionId(sessionId)
  if (rows.length > 0) return rows.map(rowToMessage)
  return getRuntimeSessionMessages(sessionId)
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
