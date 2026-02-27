/**
 * Chat 服务层 - 处理对话交互和 SSE 流
 *
 * 重构后：
 * - API 不再直接调用 Runtime HTTP
 * - 控制平面通过 WebSocket 下发 user_message 到执行平面
 * - 执行平面上行 sse_event，再由控制平面转发到前端 SSE
 */

import { v4 as uuidv4 } from 'uuid'
import type { Response } from 'express'
import fs from 'fs-extra'
import path from 'path'
import { createError } from '../middleware/errorHandler'
import * as sessionService from './session.service'
import * as agentService from './agent.service'
import * as mcpService from './mcp.service'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import {
  VALIDATION_MESSAGE_TOO_LONG,
  SSE_CONNECTION_LIMIT,
  LLM_UNAVAILABLE,
} from '../constants/errorCodes'
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_LENGTH,
  MAX_SSE_CONNECTIONS_PER_USER,
  MAX_SSE_CONNECTIONS_PER_ORG,
  MAX_HISTORY_MESSAGES,
  MAX_SESSION_TITLE_LENGTH,
} from '../constants/config'
import { pushMessage, getMessagesSince } from '../lib/sse-buffer'
import { chatLogger } from '../lib/logger'
import { runtimeRequest } from '../lib/runtime-client'
import type { Agent2UIMessage, Agent2UIType, Agent2UIData } from '@semibot/shared-types'
import type { Agent } from './agent.service'
import type { Session } from './session.service'
import { getWSServer } from '../ws/ws-server'
import { registerSSEConnection, unregisterSSEConnection } from '../relay/sse-relay'
import { ensureUserVM } from '../scheduler/vm-scheduler'

export interface ChatAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  textContent?: string
  base64?: string
  isImage: boolean
}

export interface ChatInput {
  message: string
  parentMessageId?: string
  attachments?: ChatAttachment[]
}

export interface SSEConnection {
  id: string
  res: Response
  sessionId: string
  userId: string
  orgId: string
  heartbeatTimer?: NodeJS.Timeout
  isActive: boolean
}

const sseConnections = new Map<string, SSEConnection>()
const VM_READY_WAIT_MS = Math.max(0, Number(process.env.CHAT_VM_READY_WAIT_MS ?? 5000))
const VM_READY_POLL_MS = Math.max(200, Number(process.env.CHAT_VM_READY_POLL_MS ?? 1000))
const CHAT_DIRECT_RUNTIME = process.env.CHAT_DIRECT_RUNTIME !== 'false'

type ApprovalCommand =
  | { kind: 'approve'; approvalId: string }
  | { kind: 'reject'; approvalId: string }
  | { kind: 'list' }
  | { kind: 'none' }

interface ApprovalCommandResult {
  text: string
  approvalId?: string
}

interface PendingApprovalResumeContext {
  orgId: string
  userId: string
  sessionId: string
  input: ChatInput
  agent: Agent
  createdAt: number
}

type SkillFileInventory = {
  has_skill_md: boolean
  has_scripts: boolean
  has_references: boolean
  script_files: string[]
  reference_files: string[]
}

type SkillRequires = {
  binaries: string[]
  env_vars: string[]
}

const pendingApprovalResumes = new Map<string, PendingApprovalResumeContext>()
const APPROVAL_RESUME_TTL_MS = 24 * 60 * 60 * 1000

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean)
}

function parseApprovalCommand(message: string): ApprovalCommand {
  const trimmed = message.trim()
  if (!trimmed.startsWith('/')) return { kind: 'none' }

  const approve = trimmed.match(/^\/approve\s+([A-Za-z0-9_-]+)$/i)
  if (approve) return { kind: 'approve', approvalId: approve[1] }

  const reject = trimmed.match(/^\/reject\s+([A-Za-z0-9_-]+)$/i)
  if (reject) return { kind: 'reject', approvalId: reject[1] }

  if (/^\/approvals$/i.test(trimmed)) return { kind: 'list' }
  return { kind: 'none' }
}

async function executeApprovalCommand(command: ApprovalCommand): Promise<ApprovalCommandResult> {
  if (command.kind === 'none') return { text: '' }
  if (command.kind === 'approve') {
    const result = await runtimeRequest<{ approval_id: string; status: string }>(
      `/v1/approvals/${encodeURIComponent(command.approvalId)}/approve`,
      { method: 'POST' }
    )
    return {
      text: `审批已通过：${result.approval_id}（${result.status}）`,
      approvalId: result.approval_id,
    }
  }
  if (command.kind === 'reject') {
    const result = await runtimeRequest<{ approval_id: string; status: string }>(
      `/v1/approvals/${encodeURIComponent(command.approvalId)}/reject`,
      { method: 'POST' }
    )
    return {
      text: `审批已拒绝：${result.approval_id}（${result.status}）`,
      approvalId: result.approval_id,
    }
  }

  const list = await runtimeRequest<{
    items?: Array<{ approval_id?: string; status?: string; risk_level?: string; event_id?: string }>
  }>('/v1/approvals', {
    method: 'GET',
    query: { status: 'pending', limit: 20 },
  })
  const items = Array.isArray(list.items) ? list.items : []
  if (items.length === 0) {
    return { text: '当前没有待审批项。' }
  }
  const lines = items.map((item) => {
    const id = item.approval_id || 'unknown'
    const risk = item.risk_level || 'unknown'
    const eventId = item.event_id || 'unknown'
    return `- ${id} | risk=${risk} | event=${eventId}`
  })
  return {
    text: `待审批列表（${items.length}）：\n${lines.join('\n')}\n可执行：/approve <id> 或 /reject <id>`,
  }
}

function extractApprovalIds(runtimeEvents: unknown): string[] {
  const events = Array.isArray(runtimeEvents) ? runtimeEvents : []
  const approvalIds = new Set<string>()
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const record = event as { event?: string; data?: { approval_id?: string } }
    if (record.event !== 'approval.requested') continue
    const approvalId = record.data?.approval_id
    if (approvalId) approvalIds.add(String(approvalId))
  }
  return Array.from(approvalIds)
}

function cleanupPendingApprovalResumes(): void {
  const now = Date.now()
  for (const [approvalId, entry] of pendingApprovalResumes.entries()) {
    if (now - entry.createdAt > APPROVAL_RESUME_TTL_MS) {
      pendingApprovalResumes.delete(approvalId)
    }
  }
}

function rememberPendingApprovalResumes(
  approvalIds: string[],
  context: Omit<PendingApprovalResumeContext, 'createdAt'>
): void {
  if (approvalIds.length === 0) return
  cleanupPendingApprovalResumes()
  const payload: PendingApprovalResumeContext = {
    ...context,
    createdAt: Date.now(),
  }
  for (const approvalId of approvalIds) {
    pendingApprovalResumes.set(approvalId, payload)
  }
}

function consumePendingApprovalResume(
  approvalId: string,
  expectedSessionId?: string
): PendingApprovalResumeContext | undefined {
  cleanupPendingApprovalResumes()
  const context = pendingApprovalResumes.get(approvalId)
  if (!context) return undefined
  if (expectedSessionId && context.sessionId !== expectedSessionId) {
    return undefined
  }
  pendingApprovalResumes.delete(approvalId)
  return context
}

function removePendingApprovalResume(approvalId: string): void {
  pendingApprovalResumes.delete(approvalId)
}

function appendApprovalHints(
  finalResponse: string,
  runtimeEvents: unknown
): string {
  const approvalIds = extractApprovalIds(runtimeEvents)
  if (approvalIds.length === 0) return finalResponse

  const hint = `\n\n发现待审批操作：${approvalIds.join(', ')}。\n可在聊天中执行：/approve <id> 或 /reject <id>`
  if (finalResponse.trim()) return `${finalResponse}${hint}`
  return `操作需要人工审批。${hint}`
}

async function resolveSkillMetadata(pkg: skillPackageRepo.SkillPackage): Promise<{
  fileInventory: SkillFileInventory
  requires: SkillRequires
}> {
  const validationResult = (pkg.validationResult ?? {}) as Record<string, unknown>
  const config = (pkg.config ?? {}) as Record<string, unknown>

  const fromValidation = (validationResult.file_inventory ?? validationResult.fileInventory) as Record<string, unknown> | undefined
  const fromConfig = (config.file_inventory ?? config.fileInventory) as Record<string, unknown> | undefined
  const rawInventory = fromValidation ?? fromConfig ?? {}

  const scriptFilesFromMeta = normalizeStringArray(
    rawInventory.script_files ?? rawInventory.scriptFiles
  )
  const referenceFilesFromMeta = normalizeStringArray(
    rawInventory.reference_files ?? rawInventory.referenceFiles
  )

  let scriptFiles = scriptFilesFromMeta
  let referenceFiles = referenceFilesFromMeta
  let hasSkillMd = Boolean(rawInventory.has_skill_md ?? rawInventory.hasSkillMd)
  let hasScripts = Boolean(rawInventory.has_scripts ?? rawInventory.hasScripts)
  let hasReferences = Boolean(rawInventory.has_references ?? rawInventory.hasReferences)

  const pkgPath = pkg.packagePath
  if (pkgPath && await fs.pathExists(pkgPath)) {
    const skillMdPath = path.join(pkgPath, 'SKILL.md')
    hasSkillMd = hasSkillMd || await fs.pathExists(skillMdPath)

    const scriptsDir = path.join(pkgPath, 'scripts')
    if (await fs.pathExists(scriptsDir)) {
      hasScripts = true
      if (scriptFiles.length === 0) {
        const entries = await fs.readdir(scriptsDir, { withFileTypes: true })
        scriptFiles = entries.filter((e) => e.isFile()).map((e) => path.posix.join('scripts', e.name)).slice(0, 50)
      }
    }

    const referencesDir = path.join(pkgPath, 'references')
    if (await fs.pathExists(referencesDir)) {
      hasReferences = true
      if (referenceFiles.length === 0) {
        const entries = await fs.readdir(referencesDir, { withFileTypes: true })
        referenceFiles = entries.filter((e) => e.isFile()).map((e) => path.posix.join('references', e.name)).slice(0, 50)
      }
    }
  }

  const fromValidationReq = (validationResult.requires ?? {}) as Record<string, unknown>
  const fromConfigReq = (config.requires ?? {}) as Record<string, unknown>
  const rawRequires = Object.keys(fromValidationReq).length > 0 ? fromValidationReq : fromConfigReq

  const requires: SkillRequires = {
    binaries: normalizeStringArray(rawRequires.binaries),
    env_vars: normalizeStringArray(rawRequires.env_vars ?? rawRequires.envVars),
  }

  return {
    fileInventory: {
      has_skill_md: hasSkillMd,
      has_scripts: hasScripts || scriptFiles.length > 0,
      has_references: hasReferences || referenceFiles.length > 0,
      script_files: scriptFiles,
      reference_files: referenceFiles,
    },
    requires,
  }
}

export function createSSEConnection(
  res: Response,
  sessionId: string,
  userId: string,
  orgId: string
): SSEConnection {
  const userConnections = Array.from(sseConnections.values()).filter((conn) => conn.userId === userId).length
  if (userConnections >= MAX_SSE_CONNECTIONS_PER_USER) {
    throw createError(SSE_CONNECTION_LIMIT, 'SSE 连接数已达上限，请关闭其他连接后重试')
  }

  const orgConnections = Array.from(sseConnections.values()).filter((conn) => conn.orgId === orgId).length
  if (orgConnections >= MAX_SSE_CONNECTIONS_PER_ORG) {
    throw createError(SSE_CONNECTION_LIMIT, '组织连接数已达上限，请稍后重试')
  }

  const connection: SSEConnection = {
    id: uuidv4(),
    res,
    sessionId,
    userId,
    orgId,
    isActive: true,
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const lastEventIdHeader = res.req?.headers['last-event-id'] as string | undefined
  if (lastEventIdHeader) {
    const lastEventId = parseInt(lastEventIdHeader, 10)
    if (!isNaN(lastEventId)) {
      const missed = getMessagesSince(sessionId, lastEventId)
      for (const msg of missed) {
        res.write(`id: ${msg.eventId}\n`)
        res.write(`event: ${msg.event}\n`)
        res.write(`data: ${msg.data}\n\n`)
      }
    }
  }

  connection.heartbeatTimer = setInterval(() => {
    if (connection.isActive) {
      sendSSEEvent(connection, 'heartbeat', null)
    }
  }, SSE_HEARTBEAT_INTERVAL_MS)

  res.on('close', () => {
    closeSSEConnection(connection.id)
  })

  sseConnections.set(connection.id, connection)

  registerSSEConnection(
    connection.id,
    connection.sessionId,
    (event, data) => sendSSEEvent(connection, event, data),
    () => closeSSEConnection(connection.id)
  )

  return connection
}

export function closeSSEConnection(connectionId: string): void {
  const connection = sseConnections.get(connectionId)
  if (!connection) return

  connection.isActive = false
  if (connection.heartbeatTimer) {
    clearInterval(connection.heartbeatTimer)
  }

  unregisterSSEConnection(connectionId)
  sseConnections.delete(connectionId)

  // Ensure clients can terminate promptly when runtime reports completion/error.
  if (!connection.res.writableEnded) {
    connection.res.end()
  }
}

export function sendSSEEvent(
  connection: SSEConnection,
  event: string,
  data: unknown
): boolean {
  if (!connection.isActive) return false

  try {
    const eventId = pushMessage(connection.sessionId, event, data)
    connection.res.write(`id: ${eventId}\n`)
    connection.res.write(`event: ${event}\n`)
    connection.res.write(`data: ${JSON.stringify(data)}\n\n`)
    return true
  } catch (error) {
    chatLogger.error('SSE 发送失败', error as Error, { connectionId: connection.id })
    closeSSEConnection(connection.id)
    return false
  }
}

export function sendAgent2UIMessage(
  connection: SSEConnection,
  type: Agent2UIType,
  data: Agent2UIData,
  metadata?: Record<string, unknown>
): boolean {
  const message: Agent2UIMessage = {
    id: uuidv4(),
    type,
    data,
    timestamp: new Date().toISOString(),
    metadata,
  }

  return sendSSEEvent(connection, 'message', message)
}

export async function handleChat(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  if (input.message.length > MAX_MESSAGE_LENGTH) {
    throw createError(VALIDATION_MESSAGE_TOO_LONG)
  }

  const session = await sessionService.getSession(orgId, sessionId)
  const approvalCommand = parseApprovalCommand(input.message)
  if (approvalCommand.kind !== 'none') {
    const connection = createSSEConnection(res, sessionId, userId, orgId)
    await sessionService.addMessage(orgId, sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
    })

    try {
      const commandResult = await executeApprovalCommand(approvalCommand)
      const assistant = await sessionService.addMessage(orgId, sessionId, {
        role: 'assistant',
        content: commandResult.text,
      })
      sendAgent2UIMessage(connection, 'text', { content: commandResult.text })

      let doneMessageId = assistant.id
      if (approvalCommand.kind === 'approve' && commandResult.approvalId) {
        const pending = consumePendingApprovalResume(commandResult.approvalId, sessionId)
        if (pending) {
          const resumeResult = await dispatchRuntimeChatResult({
            orgId: pending.orgId,
            userId: pending.userId,
            sessionId: pending.sessionId,
            input: pending.input,
            agent: pending.agent,
            connection,
            persistUserMessage: false,
            runtimeErrorMode: 'assistant_message',
          })
          if (resumeResult.assistantMessageId) {
            doneMessageId = resumeResult.assistantMessageId
          }
        }
      }
      if (approvalCommand.kind === 'reject' && commandResult.approvalId) {
        removePendingApprovalResume(commandResult.approvalId)
      }

      sendSSEEvent(connection, 'done', { sessionId, messageId: doneMessageId })
    } catch (error) {
      sendSSEEvent(connection, 'error', {
        code: 'APPROVAL_COMMAND_FAILED',
        message: (error as Error).message,
      })
    } finally {
      closeSSEConnection(connection.id)
    }
    return
  }

  const agent = await agentService.getAgent(orgId, session.agentId)

  if (CHAT_DIRECT_RUNTIME) {
    await handleChatViaRuntimeHttp(orgId, userId, sessionId, input, res, agent)
    return
  }

  await handleChatViaExecutionPlane(orgId, userId, sessionId, input, res, agent, session)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function handleChatViaExecutionPlane(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response,
  agent: Agent,
  _session: Session
): Promise<void> {
  const wsServer = getWSServer()
  const wsReady = wsServer.isUserReady(userId)
  let vmState = await ensureUserVM(userId, orgId, { wsReady })

  if (!vmState.ready && (vmState.status === 'starting' || vmState.status === 'provisioning') && VM_READY_WAIT_MS > 0) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < VM_READY_WAIT_MS) {
      await sleep(VM_READY_POLL_MS)
      vmState = await ensureUserVM(userId, orgId, { wsReady: wsServer.isUserReady(userId) })
      if (vmState.ready) break
      if (vmState.status === 'failed' || vmState.status === 'terminated') break
    }
  }

  if (!vmState.ready) {
    const retryHint = vmState.retryAfterMs ? `，建议 ${Math.ceil(vmState.retryAfterMs / 1000)} 秒后重试` : ''
    throw createError(LLM_UNAVAILABLE, `执行平面未就绪（状态: ${vmState.status}）${retryHint}`)
  }

  const connection = createSSEConnection(res, sessionId, userId, orgId)

  // 先写入用户消息（附件元信息存入 metadata，不含 textContent/base64）
  const messageMetadata: Record<string, unknown> = {}
  if (input.attachments && input.attachments.length > 0) {
    messageMetadata.attachments = input.attachments.map((att) => ({
      id: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      isImage: att.isImage,
    }))
  }

  await sessionService.addMessage(orgId, sessionId, {
    role: 'user',
    content: input.message,
    parentId: input.parentMessageId,
    ...(Object.keys(messageMetadata).length > 0 ? { metadata: messageMetadata } : {}),
  })

  const historyMessages = await sessionService.getSessionMessages(orgId, sessionId)
  const history = historyMessages.slice(-MAX_HISTORY_MESSAGES).map((msg) => ({
    role: msg.role,
    content: msg.content,
  }))

  let mcpServers: Array<{ id: string; name: string; endpoint: string; transport: string; is_connected: boolean; available_tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }> = []
  try {
    mcpServers = await mcpService.getMcpServersForRuntime(agent.id)
  } catch (error) {
    chatLogger.warn('加载 MCP 配置失败，继续无 MCP 模式', {
      agentId: agent.id,
      error: (error as Error).message,
    })
  }

  const skillIndex: Array<Record<string, unknown>> = []
  for (const skillDefId of agent.skills ?? []) {
    const def = await skillDefinitionRepo.findById(skillDefId)
    if (!def || !def.isActive) continue
    const pkg = await skillPackageRepo.findByDefinition(skillDefId)
    if (!pkg) continue
    const { fileInventory, requires } = await resolveSkillMetadata(pkg)
    skillIndex.push({
      id: def.skillId,
      name: def.name,
      description: def.description ?? '',
      version: 'current',
      source: pkg.sourceType,
      file_inventory: fileInventory,
      requires,
    })
  }

  const sessionRuntimeType = (_session.runtimeType ?? '').toLowerCase()
  const agentRuntimeType = (agent.runtimeType ?? '').toLowerCase()
  const runtimeType: 'semigraph' | 'openclaw' =
    (sessionRuntimeType === 'openclaw' || agentRuntimeType === 'openclaw') ? 'openclaw' : 'semigraph'

  wsServer.sendStartSession(userId, {
    session_id: sessionId,
    runtime_type: runtimeType,
    agent_id: agent.id,
    openclaw_config: agent.openclawConfig ?? {},
    agent_config: {
      system_prompt: (() => {
        const n = new Date()
        const d = `${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日`
        const base = agent.systemPrompt || `你是 ${agent.name}，一个有帮助的 AI 助手。`
        return `${base}\n\n当前日期: ${d}`
      })(),
      model: agent.config?.model,
      temperature: agent.config?.temperature ?? 0.7,
      max_tokens: agent.config?.maxTokens ?? 4096,
    },
    mcp_servers: mcpServers,
    skill_index: skillIndex,
    sub_agents: [],
  })

  // 构造增强消息：将文件内容拼接到发送给 Runtime 的 message 中
  let enhancedMessage = input.message
  const imageAttachments: Array<{ filename: string; base64: string; mimeType: string }> = []

  if (input.attachments && input.attachments.length > 0) {
    const textParts: string[] = []
    for (const att of input.attachments) {
      if (att.isImage && att.base64) {
        imageAttachments.push({
          filename: att.filename,
          base64: att.base64,
          mimeType: att.mimeType,
        })
        textParts.push(`[图片: ${att.filename} (${formatBytes(att.size)})]`)
      } else if (att.textContent) {
        textParts.push(`--- 📎 文件: ${att.filename} (${formatBytes(att.size)}) ---\n${att.textContent}`)
      } else {
        textParts.push(`[附件: ${att.filename} (${formatBytes(att.size)}) - 无法提取内容]`)
      }
    }
    if (textParts.length > 0) {
      enhancedMessage = `${input.message}\n\n${textParts.join('\n---\n')}`
    }
  }

  wsServer.sendUserMessage(userId, sessionId, {
    message: enhancedMessage,
    history,
    metadata: {
      org_id: orgId,
      user_id: userId,
      connection_id: connection.id,
      ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
    },
  })

  res.on('close', () => {
    if (connection.isActive) {
      try {
        wsServer.sendCancel(userId, sessionId)
      } catch {
        // ignore disconnect race
      }
    }
  })
}

function getRuntimeBaseUrls(): string[] {
  const fallbackUrls = ['http://127.0.0.1:8765', 'http://127.0.0.1:8901', 'http://127.0.0.1:8801']
  const configured = (process.env.RUNTIME_URL || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  return Array.from(new Set([...configured, ...fallbackUrls]))
}

function buildEnhancedMessage(input: ChatInput): { text: string } {
  if (!input.attachments || input.attachments.length === 0) {
    return { text: input.message }
  }

  const textParts: string[] = []
  for (const att of input.attachments) {
    if (att.isImage && att.base64) {
      textParts.push(`[图片: ${att.filename} (${formatBytes(att.size)})]`)
    } else if (att.textContent) {
      textParts.push(`--- 📎 文件: ${att.filename} (${formatBytes(att.size)}) ---\n${att.textContent}`)
    } else {
      textParts.push(`[附件: ${att.filename} (${formatBytes(att.size)}) - 无法提取内容]`)
    }
  }
  return {
    text: `${input.message}\n\n${textParts.join('\n---\n')}`,
  }
}

interface RuntimeDispatchOptions {
  orgId: string
  userId: string
  sessionId: string
  input: ChatInput
  agent: Agent
  connection: SSEConnection
  persistUserMessage: boolean
  runtimeErrorMode?: 'sse_error' | 'assistant_message'
}

interface RuntimeDispatchResult {
  ok: boolean
  assistantMessageId?: string
}

async function addAssistantTextMessage(
  orgId: string,
  sessionId: string,
  connection: SSEConnection,
  content: string
): Promise<string> {
  const assistant = await sessionService.addMessage(orgId, sessionId, {
    role: 'assistant',
    content,
  })
  sendAgent2UIMessage(connection, 'text', { content })
  return assistant.id
}

async function dispatchRuntimeChatResult(options: RuntimeDispatchOptions): Promise<RuntimeDispatchResult> {
  const {
    orgId,
    userId,
    sessionId,
    input,
    agent,
    connection,
    persistUserMessage,
    runtimeErrorMode = 'sse_error',
  } = options

  if (persistUserMessage) {
    const messageMetadata: Record<string, unknown> = {}
    if (input.attachments && input.attachments.length > 0) {
      messageMetadata.attachments = input.attachments.map((att) => ({
        id: att.id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        isImage: att.isImage,
      }))
    }

    await sessionService.addMessage(orgId, sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
      ...(Object.keys(messageMetadata).length > 0 ? { metadata: messageMetadata } : {}),
    })
  }

  const enhanced = buildEnhancedMessage(input)
  const runtimeErrors: string[] = []
  let runtimeResult: Record<string, unknown> | null = null

  for (const baseUrl of getRuntimeBaseUrls()) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/chat/sessions/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: enhanced.text,
          agent_id: agent.id,
          model: agent.config?.model,
          system_prompt: agent.systemPrompt,
          stream: false,
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        runtimeErrors.push(`${baseUrl}: HTTP ${response.status}${body ? ` ${body}` : ''}`)
        continue
      }

      runtimeResult = (await response.json()) as Record<string, unknown>
      break
    } catch (error) {
      runtimeErrors.push(`${baseUrl}: ${(error as Error).message}`)
    }
  }

  if (!runtimeResult) {
    const runtimeError = `Runtime 不可用: ${runtimeErrors.join('; ') || 'unknown error'}`
    if (runtimeErrorMode === 'assistant_message') {
      const assistantMessageId = await addAssistantTextMessage(
        orgId,
        sessionId,
        connection,
        `审批已通过，但自动继续执行失败：${runtimeError}`
      )
      return { ok: true, assistantMessageId }
    }
    sendSSEEvent(connection, 'error', {
      code: 'RUNTIME_UNAVAILABLE',
      message: runtimeError,
    })
    return { ok: false }
  }

  const status = String(runtimeResult.status || '')
  const rawFinalResponse = String(runtimeResult.final_response || '')
  const error = runtimeResult.error ? String(runtimeResult.error) : ''
  const runtimeEvents = runtimeResult.runtime_events
  const approvalIds = extractApprovalIds(runtimeEvents)
  const finalResponse = appendApprovalHints(rawFinalResponse, runtimeEvents)

  if (approvalIds.length > 0) {
    rememberPendingApprovalResumes(approvalIds, {
      orgId,
      userId,
      sessionId,
      input,
      agent,
    })
  }

  if ((status !== 'completed' || error) && approvalIds.length === 0) {
    if (runtimeErrorMode === 'assistant_message') {
      const assistantMessageId = await addAssistantTextMessage(
        orgId,
        sessionId,
        connection,
        `审批已通过，但自动继续执行失败：${error || `Runtime 执行失败（status=${status || 'unknown'}）`}`
      )
      return { ok: true, assistantMessageId }
    }
    sendSSEEvent(connection, 'error', {
      code: 'RUNTIME_EXECUTION_ERROR',
      message: error || `Runtime 执行失败（status=${status || 'unknown'}）`,
    })
    return { ok: false }
  }

  const content =
    finalResponse.trim() ||
    (approvalIds.length > 0
      ? `该请求包含高风险操作，等待审批：${approvalIds.join(', ')}。`
      : '任务已执行完成。')

  const assistantMessageId = await addAssistantTextMessage(orgId, sessionId, connection, content)
  return { ok: true, assistantMessageId }
}

async function handleChatViaRuntimeHttp(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response,
  agent: Agent
): Promise<void> {
  const connection = createSSEConnection(res, sessionId, userId, orgId)
  const result = await dispatchRuntimeChatResult({
    orgId,
    userId,
    sessionId,
    input,
    agent,
    connection,
    persistUserMessage: true,
    runtimeErrorMode: 'sse_error',
  })
  if (result.ok && result.assistantMessageId) {
    sendSSEEvent(connection, 'done', {
      sessionId,
      messageId: result.assistantMessageId,
    })
  }
  closeSSEConnection(connection.id)
}

export async function startNewChat(
  orgId: string,
  userId: string,
  agentId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  await agentService.validateAgentForSession(orgId, agentId)

  const session = await sessionService.createSession(orgId, userId, {
    agentId,
    title: input.message.slice(0, MAX_SESSION_TITLE_LENGTH),
  })

  await handleChat(orgId, userId, session.id, input, res)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
