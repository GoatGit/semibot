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
import * as contextPolicyService from './context-policy.service'
import * as evolutionCapabilityService from './evolution-capability.service'
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
  SINGLE_USER_ORG_ID,
} from '../constants/config'
import { pushMessage, getMessagesSince } from '../lib/sse-buffer'
import { chatLogger } from '../lib/logger'
import { runtimeRequest } from '../lib/runtime-client'
import type { Agent2UIMessage, Agent2UIType, Agent2UIData } from '@semibot/shared-types'
import type { Agent } from './agent.service'
import type { Session } from './session.service'
import { getWSServer } from '../ws/ws-server'
import { mapRuntimeEventToAgent2UI } from '../ws/message-router'
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
  heartbeatTimer?: NodeJS.Timeout
  isActive: boolean
}

const sseConnections = new Map<string, SSEConnection>()
const VM_READY_WAIT_MS = Math.max(0, Number(process.env.CHAT_VM_READY_WAIT_MS ?? 5000))
const VM_READY_POLL_MS = Math.max(200, Number(process.env.CHAT_VM_READY_POLL_MS ?? 1000))

function isAuthDisabledForChat(): boolean {
  const enableAuth = process.env.SEMIBOT_ENABLE_AUTH
  const disableAuth = process.env.SEMIBOT_DISABLE_AUTH
  if (enableAuth !== undefined) return enableAuth !== 'true'
  if (disableAuth !== undefined) return disableAuth !== 'false'
  return true
}

function shouldUseDirectRuntime(): boolean {
  const configured = process.env.CHAT_DIRECT_RUNTIME
  if (configured !== undefined) return configured === 'true'
  return isAuthDisabledForChat()
}

// 单用户无鉴权模式默认走共享 runtime HTTP。
// 仅在显式设置 CHAT_DIRECT_RUNTIME=false 时才走 execution-plane / VM 调度。
const CHAT_DIRECT_RUNTIME = shouldUseDirectRuntime()

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

type RuntimeSkillMetadata = {
  skill_id?: string
  name?: string
  description?: string
  version?: string
  source?: string
  skill_md_path?: string
  scripts_dir?: string
  entry_script?: string
  status?: string
  enabled?: boolean
  requires?: {
    binaries?: string[]
    env_vars?: string[]
  }
}

type SkillIndexEntry = Record<string, unknown>

const RUNTIME_SKILL_METADATA_TIMEOUT_MS = Math.max(1500, Number(process.env.RUNTIME_SKILL_METADATA_TIMEOUT_MS ?? 4000))
const runtimeSkillMetadataCache = new Map<string, { expiresAt: number; rows: RuntimeSkillMetadata[] }>()
const RUNTIME_SKILL_METADATA_CACHE_TTL_MS = Math.max(5000, Number(process.env.RUNTIME_SKILL_METADATA_CACHE_TTL_MS ?? 30000))

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
    items?: Array<{
      approval_id?: string
      status?: string
      risk_level?: string
      event_id?: string
      summary?: string
      tool_name?: string
      action?: string
      target?: string
    }>
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
    const summary = item.summary || [item.tool_name, item.action, item.target].filter(Boolean).join(' ')
    const eventId = item.event_id || 'unknown'
    return `- ${id} | risk=${risk} | ${summary || `event=${eventId}`}`
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
    const record = event as { event?: string; data?: { approval_id?: string }; approval_id?: string }
    const eventName = String(record.event || '')
    if (eventName !== 'approval.requested' && eventName !== 'tool.exec.pending_approval') continue
    const approvalId = record.data?.approval_id ?? record.approval_id
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

function normalizeSkillKey(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('runtime:')) {
    return value.slice('runtime:'.length)
  }
  return value
}

function toRuntimeSkillPrompt(metadata: RuntimeSkillMetadata[]): string {
  if (metadata.length === 0) return ''
  const rows = metadata.map((item) => {
    const name = String(item.name || item.skill_id || '').trim()
    if (!name) return ''
    const desc = String(item.description || '').trim()
    return desc ? `- ${name}: ${desc}` : `- ${name}`
  }).filter(Boolean)
  if (rows.length === 0) return ''
  return [
    '<available_skills>',
    ...rows,
    '</available_skills>',
    '技能使用约束：先读取目标技能的 SKILL.md，再按文档执行；已有能力可完成时禁止安装新技能。',
    '当用户明确要求“使用某技能”时，必须实际执行该技能流程并给出过程与结果，禁止仅回复将要执行。',
  ].join('\n')
}

async function buildAgentSystemPrompt(agent: Agent): Promise<string> {
  const n = new Date()
  const d = `${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日`
  const base = agent.systemPrompt || `你是 ${agent.name}，一个有帮助的 AI 助手。`
  const withDate = `${base}\n\n当前日期: ${d}`

  try {
    const docs = await contextPolicyService.getActivePolicies()
    const policyBlock = contextPolicyService.buildPolicyInjectionBlock(docs)
    const evolutionDocs = await evolutionCapabilityService.getActiveCapabilities()
    const evolutionBlock = evolutionCapabilityService.buildCapabilityInjectionBlock(evolutionDocs)
    const blocks: string[] = []
    if (policyBlock) {
      blocks.push(`以下为组织级上下文策略，请严格遵循：\n${policyBlock}`)
    }
    if (evolutionBlock) {
      blocks.push(`以下为进化中心能力注入内容，请严格遵循：\n${evolutionBlock}`)
    }
    if (blocks.length === 0) return withDate
    return `${withDate}\n\n${blocks.join('\n\n')}`
  } catch (error) {
    chatLogger.warn('加载 context policy / evolution capabilities 失败，降级为基础 system prompt', {
      agentId: agent.id,
      error: (error as Error).message,
    })
    return withDate
  }
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

async function buildAgentSkillIndex(
  agent: Agent,
  runtimeBaseUrls: string[]
): Promise<{ skillIndex: SkillIndexEntry[]; runtimeSkillMetadata: RuntimeSkillMetadata[] }> {
  const skillIndex: SkillIndexEntry[] = []
  const skillKeys = new Set<string>()

  for (const rawSkillDefId of agent.skills ?? []) {
    const skillDefId = normalizeSkillKey(rawSkillDefId)
    const def = await skillDefinitionRepo.findById(skillDefId) ?? await skillDefinitionRepo.findBySkillId(skillDefId)
    if (!def || !def.isActive) continue
    const pkg = await skillPackageRepo.findByDefinition(def.id)
    if (!pkg) continue
    const { fileInventory, requires } = await resolveSkillMetadata(pkg)
    skillKeys.add(def.skillId)
    skillIndex.push({
      id: def.skillId,
      name: def.name,
      description: def.description ?? '',
      version: 'current',
      source: pkg.sourceType,
      direct_executable: fileInventory.script_files.includes('scripts/main.py'),
      file_inventory: fileInventory,
      requires,
    })
  }

  const runtimeSkillMetadata = agent.isSystem ? await getRuntimeSkillMetadata(runtimeBaseUrls) : []
  if (agent.isSystem) {
    for (const item of runtimeSkillMetadata) {
      const skillId = String(item.skill_id || item.name || '').trim()
      if (!skillId || skillKeys.has(skillId)) continue
      const hasSkillMd = Boolean(item.skill_md_path)
      const hasScripts = Boolean(item.entry_script) || Boolean(item.scripts_dir)
      const entryScript = String(item.entry_script || '').trim()
      skillKeys.add(skillId)
      skillIndex.push({
        id: skillId,
        name: String(item.name || skillId),
        description: String(item.description || ''),
        version: String(item.version || 'current'),
        source: String(item.source || 'runtime'),
        direct_executable: entryScript === 'scripts/main.py',
        file_inventory: {
          has_skill_md: hasSkillMd,
          has_scripts: hasScripts,
          has_references: false,
          script_files: entryScript ? [entryScript] : [],
          reference_files: [],
        },
        requires: {
          binaries: normalizeStringArray(item.requires?.binaries),
          env_vars: normalizeStringArray(item.requires?.env_vars),
        },
      })
    }
  }

  return { skillIndex, runtimeSkillMetadata }
}

export function createSSEConnection(
  res: Response,
  sessionId: string,
  userId: string
): SSEConnection {
  const userConnections = Array.from(sseConnections.values()).filter((conn) => conn.userId === userId).length
  if (userConnections >= MAX_SSE_CONNECTIONS_PER_USER) {
    throw createError(SSE_CONNECTION_LIMIT, 'SSE 连接数已达上限，请关闭其他连接后重试')
  }

  const totalConnections = sseConnections.size
  if (totalConnections >= MAX_SSE_CONNECTIONS_PER_ORG) {
    throw createError(SSE_CONNECTION_LIMIT, '连接数已达上限，请稍后重试')
  }

  const connection: SSEConnection = {
    id: uuidv4(),
    res,
    sessionId,
    userId,
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
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  if (input.message.length > MAX_MESSAGE_LENGTH) {
    throw createError(VALIDATION_MESSAGE_TOO_LONG)
  }

  const session = await sessionService.getSession(sessionId)
  const approvalCommand = parseApprovalCommand(input.message)
  if (approvalCommand.kind !== 'none') {
    const connection = createSSEConnection(res, sessionId, userId)
    await sessionService.addMessage(sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
    })

    try {
      const commandResult = await executeApprovalCommand(approvalCommand)
      const assistant = await sessionService.addMessage(sessionId, {
        role: 'assistant',
        content: commandResult.text,
      })
      sendAgent2UIMessage(connection, 'text', { content: commandResult.text })

      let doneMessageId = assistant.id
      if (approvalCommand.kind === 'approve' && commandResult.approvalId) {
        const pending = consumePendingApprovalResume(commandResult.approvalId, sessionId)
        if (pending) {
          const resumeResult = await dispatchRuntimeChatResult({
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

  const agent = await agentService.getAgent(session.agentId)

  if (CHAT_DIRECT_RUNTIME) {
    await handleChatViaRuntimeHttp(userId, sessionId, input, res, agent)
    return
  }

  await handleChatViaExecutionPlane(userId, sessionId, input, res, agent, session)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function handleChatViaExecutionPlane(
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response,
  agent: Agent,
  _session: Session
): Promise<void> {
  const wsServer = getWSServer()
  const wsReady = wsServer.isUserReady(userId)
  let vmState = await ensureUserVM(userId, SINGLE_USER_ORG_ID, { wsReady })

  if (!vmState.ready && (vmState.status === 'starting' || vmState.status === 'provisioning') && VM_READY_WAIT_MS > 0) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < VM_READY_WAIT_MS) {
      await sleep(VM_READY_POLL_MS)
      vmState = await ensureUserVM(userId, SINGLE_USER_ORG_ID, { wsReady: wsServer.isUserReady(userId) })
      if (vmState.ready) break
      if (vmState.status === 'failed' || vmState.status === 'terminated') break
    }
  }

  if (!vmState.ready) {
    const retryHint = vmState.retryAfterMs ? `，建议 ${Math.ceil(vmState.retryAfterMs / 1000)} 秒后重试` : ''
    throw createError(LLM_UNAVAILABLE, `执行平面未就绪（状态: ${vmState.status}）${retryHint}`)
  }

  const connection = createSSEConnection(res, sessionId, userId)

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

  await sessionService.addMessage(sessionId, {
    role: 'user',
    content: input.message,
    parentId: input.parentMessageId,
    ...(Object.keys(messageMetadata).length > 0 ? { metadata: messageMetadata } : {}),
  })

  const historyMessages = await sessionService.getSessionMessages(sessionId)
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

  const runtimeBaseUrls = getRuntimeBaseUrls()
  const { skillIndex, runtimeSkillMetadata } = await buildAgentSkillIndex(agent, runtimeBaseUrls)

  const runtimeType = 'semigraph' as const
  let systemPrompt = await buildAgentSystemPrompt(agent)
  if (agent.isSystem && runtimeSkillMetadata.length > 0) {
    const runtimeSkillPrompt = toRuntimeSkillPrompt(runtimeSkillMetadata)
    if (runtimeSkillPrompt) {
      systemPrompt = `${systemPrompt}\n\n${runtimeSkillPrompt}`
    }
  }

  wsServer.sendStartSession(userId, {
    session_id: sessionId,
    runtime_type: runtimeType,
    agent_id: agent.id,
    agent_config: {
      system_prompt: systemPrompt,
      model: agent.config?.model,
      model_provider_key: agent.config?.modelProviderKey,
      temperature: agent.config?.temperature ?? 0.7,
      max_tokens: agent.config?.maxTokens ?? 4096,
      fallback_model: agent.config?.fallbackModel,
      fallback_provider_key: agent.config?.fallbackProviderKey,
      model_roles: agent.config?.modelRoles,
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
      user_id: userId,
      connection_id: connection.id,
      ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
    },
  })

  // Do not translate transient HTTP/SSE disconnects into task cancellation.
  // Explicit user stop actions should be the only path that emits runtime cancel.
}

function getRuntimeBaseUrls(): string[] {
  const configured = (process.env.RUNTIME_URL || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  if (configured.length > 0) {
    return Array.from(new Set(configured))
  }
  const defaultPort = String(process.env.RUNTIME_PORT || '8765').trim() || '8765'
  return [`http://127.0.0.1:${defaultPort}`]
}

async function getRuntimeSkillMetadata(baseUrls: string[]): Promise<RuntimeSkillMetadata[]> {
  for (const baseUrl of baseUrls) {
    const cacheKey = `${baseUrl}/v1/skills`
    const cached = runtimeSkillMetadataCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() && cached.rows.length > 0) {
      return cached.rows
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), RUNTIME_SKILL_METADATA_TIMEOUT_MS)
    try {
      const response = await fetch(`${baseUrl}/v1/skills`, {
        method: 'GET',
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const payload = (await response.json()) as { metadata?: RuntimeSkillMetadata[] }
      const rows = Array.isArray(payload.metadata) ? payload.metadata : []
      const filtered = rows.filter((item) => {
        const status = String(item.status || 'active')
        const enabled = item.enabled !== false
        return status === 'active' && enabled
      })
      if (filtered.length > 0) {
        runtimeSkillMetadataCache.set(cacheKey, {
          expiresAt: Date.now() + RUNTIME_SKILL_METADATA_CACHE_TTL_MS,
          rows: filtered,
        })
      }
      return filtered
    } catch (error) {
      clearTimeout(timeout)
      if (cached && cached.rows.length > 0) {
        chatLogger.warn('获取 runtime skills 失败，回退到缓存', {
          baseUrl,
          error: (error as Error).message,
          cachedCount: cached.rows.length,
        })
        return cached.rows
      }
      chatLogger.warn('获取 runtime skills 失败，返回空技能列表', {
        baseUrl,
        error: (error as Error).message,
      })
      continue
    }
  }
  return []
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDirectRuntimeEvent(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null
  if (typeof input.type === 'string' && input.type.trim()) {
    return input
  }

  const eventName = String(input.event || '').trim()
  if (!eventName || eventName === 'start' || eventName === 'done') return null

  const data = isRecord(input.data) ? input.data : {}
  const get = (key: string): unknown => data[key] ?? input[key]

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
    case 'tool.exec.pending_approval':
      return {
        type: 'tool_call_complete',
        tool_name: get('tool_name') ?? input.subject,
        result: {
          approvalId: get('approval_id'),
          status: get('status') ?? 'pending',
          message: get('message'),
        },
        success: false,
        error: 'approval_pending',
        duration: get('duration_ms') ?? get('duration'),
      }
    case 'approval.requested':
      return {
        type: 'tool_call_complete',
        tool_name: 'approval',
        result: {
          approvalId: get('approval_id'),
          ruleId: get('rule_id'),
          riskLevel: get('risk_level'),
          status: get('status') ?? 'pending',
          context: get('context'),
        },
        success: false,
        error: 'approval_pending',
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
    case 'planner.llm_call_started':
    case 'planner.llm_call_completed':
    case 'planner.llm_call_failed':
      return {
        type: 'planner_llm_call',
        event: eventName,
        turn_index: get('turn_index') ?? get('turnIndex'),
        model: get('model'),
        tools_enabled: get('tools_enabled') ?? get('toolsEnabled'),
        compact_mode: get('compact_mode') ?? get('compactMode'),
        duration_ms: get('duration_ms') ?? get('durationMs'),
        finish_reason: get('finish_reason') ?? get('finishReason'),
        usage: get('usage'),
        tool_call_count: get('tool_call_count') ?? get('toolCallCount'),
        content_len: get('content_len') ?? get('contentLen'),
        error: get('error'),
        response_excerpt: get('response_excerpt') ?? get('responseExcerpt'),
      }
    case 'failure_reflection':
      return {
        type: 'failure_reflection',
        content: String(get('content') || ''),
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

function shouldBufferProcessMessage(type: string): boolean {
  return (
    type === 'thinking' ||
    type === 'plan' ||
    type === 'plan_step' ||
    type === 'tool_call' ||
    type === 'tool_result' ||
    type === 'mcp_call' ||
    type === 'mcp_result'
  )
}

async function addAssistantTextMessage(
  sessionId: string,
  connection: SSEConnection,
  content: string,
  metadata?: Record<string, unknown>,
  relayFinalText = true
): Promise<string> {
  const assistant = await sessionService.addMessage(sessionId, {
    role: 'assistant',
    content,
    metadata,
  })
  if (relayFinalText) {
    sendAgent2UIMessage(connection, 'text', { content })
  }
  return assistant.id
}

async function relayRuntimeStreamToSSE(
  connection: SSEConnection,
  response: globalThis.Response,
  sessionId: string,
  agentId?: string
): Promise<{
  status: string
  finalResponse: string
  error: string
  runtimeEvents: Array<Record<string, unknown>>
  processMessages: Agent2UIMessage[]
  streamedFinalText: boolean
}> {
  const relayStartedAt = Date.now()
  let firstFrameAt: number | null = null
  let runtimeFrameCount = 0
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const payload = await response.json() as Record<string, unknown>
    const runtimeEvents = Array.isArray(payload.runtime_events)
      ? payload.runtime_events.filter(isRecord)
      : []
    const processMessages: Agent2UIMessage[] = []
    let streamedFinalText = false

    for (const event of runtimeEvents) {
      runtimeFrameCount += 1
      if (firstFrameAt === null) firstFrameAt = Date.now()
      const normalized = normalizeDirectRuntimeEvent(event)
      const agentMessage = normalized ? mapRuntimeEventToAgent2UI(normalized) : null
      if (!agentMessage) continue
      if (shouldBufferProcessMessage(agentMessage.type)) {
        processMessages.push(agentMessage)
      }
      if (agentMessage.type === 'file') {
        await sessionService.addMessage(sessionId, {
          role: 'assistant',
          content: '',
          metadata: {
            agent2ui: agentMessage,
          },
        })
      }
      if (agentMessage.type === 'text' && String((agentMessage.data as { content?: string }).content || '').trim()) {
        streamedFinalText = true
      }
      sendSSEEvent(connection, 'message', agentMessage)
    }

    chatLogger.info('Direct runtime relay completed (json)', {
      sessionId,
      agentId,
      frameCount: runtimeFrameCount,
      firstFrameDelayMs: firstFrameAt === null ? null : firstFrameAt - relayStartedAt,
      relayDurationMs: Date.now() - relayStartedAt,
      status: String(payload.status || ''),
      hasError: Boolean(payload.error),
    })

    return {
      status: String(payload.status || ''),
      finalResponse: String(payload.final_response || ''),
      error: payload.error ? String(payload.error) : '',
      runtimeEvents,
      processMessages,
      streamedFinalText,
    }
  }

  if (!response.body) {
    throw new Error('runtime stream body missing')
  }

  const runtimeEvents: Array<Record<string, unknown>> = []
  const processMessages: Agent2UIMessage[] = []
  let doneStatus = ''
  let doneFinalResponse = ''
  let doneError = ''
  let streamedFinalText = false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handlePayload = async (payload: Record<string, unknown>) => {
    runtimeFrameCount += 1
    if (firstFrameAt === null) {
      firstFrameAt = Date.now()
      chatLogger.info('Direct runtime first frame received', {
        sessionId,
        agentId,
        firstFrameDelayMs: firstFrameAt - relayStartedAt,
        event: String(payload.event || ''),
      })
    }
    const eventName = String(payload.event || '')
    if (!eventName) return
    if (eventName === 'start') return
    if (eventName === 'done') {
      doneStatus = String(payload.status || '')
      doneFinalResponse = String(payload.final_response || '')
      doneError = payload.error ? String(payload.error) : ''
      return
    }

    runtimeEvents.push(payload)
    const normalized = normalizeDirectRuntimeEvent(payload)
    const agentMessage = normalized ? mapRuntimeEventToAgent2UI(normalized) : null
    if (!agentMessage) return

    if (shouldBufferProcessMessage(agentMessage.type)) {
      processMessages.push(agentMessage)
      if (processMessages.length > 500) {
        processMessages.splice(0, processMessages.length - 500)
      }
    }

    if (agentMessage.type === 'file') {
      await sessionService.addMessage(sessionId, {
        role: 'assistant',
        content: '',
        metadata: {
          agent2ui: agentMessage,
        },
      })
    }

    if (agentMessage.type === 'text' && String((agentMessage.data as { content?: string }).content || '').trim()) {
      streamedFinalText = true
    }

    sendSSEEvent(connection, 'message', agentMessage)
  }

  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const dataLines = chunk
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
      if (dataLines.length > 0) {
        const raw = dataLines.join('\n')
        try {
          const payload = JSON.parse(raw) as Record<string, unknown>
          await handlePayload(payload)
        } catch {
          // ignore malformed streaming frame
        }
      }
      boundary = buffer.indexOf('\n\n')
    }

    if (done) {
      break
    }
  }

  if (buffer.trim()) {
    const dataLines = buffer
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length > 0) {
      try {
        const payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
        await handlePayload(payload)
      } catch {
        // ignore malformed trailing frame
      }
    }
  }

  chatLogger.info('Direct runtime relay completed (sse)', {
    sessionId,
    agentId,
    frameCount: runtimeFrameCount,
    firstFrameDelayMs: firstFrameAt === null ? null : firstFrameAt - relayStartedAt,
    relayDurationMs: Date.now() - relayStartedAt,
    status: doneStatus,
    hasError: Boolean(doneError),
  })

  return {
    status: doneStatus,
    finalResponse: doneFinalResponse,
    error: doneError,
    runtimeEvents,
    processMessages,
    streamedFinalText,
  }
}

async function dispatchRuntimeChatResult(options: RuntimeDispatchOptions): Promise<RuntimeDispatchResult> {
  const {
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

    await sessionService.addMessage(sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
      ...(Object.keys(messageMetadata).length > 0 ? { metadata: messageMetadata } : {}),
    })
  }

  const enhanced = buildEnhancedMessage(input)
  const runtimeBaseUrls = getRuntimeBaseUrls()
  const dispatchStartedAt = Date.now()
  sendAgent2UIMessage(connection, 'thinking', {
    content: '正在准备执行上下文...',
    stage: 'planning',
  })
  const skillIndexStartedAt = Date.now()
  const { skillIndex, runtimeSkillMetadata } = await buildAgentSkillIndex(agent, runtimeBaseUrls)
  const skillIndexDurationMs = Date.now() - skillIndexStartedAt
  const promptStartedAt = Date.now()
  let systemPrompt = await buildAgentSystemPrompt(agent)
  const promptDurationMs = Date.now() - promptStartedAt
  if (agent.isSystem && runtimeSkillMetadata.length > 0) {
    const runtimeSkillPrompt = toRuntimeSkillPrompt(runtimeSkillMetadata)
    if (runtimeSkillPrompt) {
      systemPrompt = `${systemPrompt}\n\n${runtimeSkillPrompt}`
    }
  }
  chatLogger.info('Direct runtime preparation completed', {
    sessionId,
    agentId: agent.id,
    runtimeBaseUrls,
    skillIndexCount: skillIndex.length,
    runtimeSkillMetadataCount: runtimeSkillMetadata.length,
    skillIndexDurationMs,
    promptDurationMs,
    totalPrepareDurationMs: Date.now() - dispatchStartedAt,
  })
  const runtimeErrors: string[] = []
  let runtimeResponse: globalThis.Response | null = null

  for (const baseUrl of runtimeBaseUrls) {
    try {
      const runtimeRequestStartedAt = Date.now()
      chatLogger.info('Direct runtime request started', {
        sessionId,
        agentId: agent.id,
        baseUrl,
      })
      const response = await fetch(`${baseUrl}/api/v1/chat/sessions/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: enhanced.text,
          agent_id: agent.id,
          model: agent.config?.model,
          model_provider_key: agent.config?.modelProviderKey,
          fallback_model: agent.config?.fallbackModel,
          fallback_provider_key: agent.config?.fallbackProviderKey,
          model_roles: agent.config?.modelRoles,
          system_prompt: systemPrompt,
          skill_index: skillIndex,
          stream: true,
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        runtimeErrors.push(`${baseUrl}: HTTP ${response.status}${body ? ` ${body}` : ''}`)
        chatLogger.warn('Direct runtime request failed', {
          sessionId,
          agentId: agent.id,
          baseUrl,
          status: response.status,
          durationMs: Date.now() - runtimeRequestStartedAt,
          bodyPreview: body.slice(0, 500),
        })
        continue
      }

      chatLogger.info('Direct runtime response headers received', {
        sessionId,
        agentId: agent.id,
        baseUrl,
        contentType: response.headers.get('content-type') || '',
        durationMs: Date.now() - runtimeRequestStartedAt,
      })
      runtimeResponse = response
      break
    } catch (error) {
      runtimeErrors.push(`${baseUrl}: ${(error as Error).message}`)
      chatLogger.warn('Direct runtime request threw', {
        sessionId,
        agentId: agent.id,
        baseUrl,
        error: (error as Error).message,
      })
    }
  }

  if (!runtimeResponse) {
    const runtimeError = `Runtime 不可用: ${runtimeErrors.join('; ') || 'unknown error'}`
    if (runtimeErrorMode === 'assistant_message') {
      const assistantMessageId = await addAssistantTextMessage(
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

  let streamOutcome: Awaited<ReturnType<typeof relayRuntimeStreamToSSE>>
  try {
    streamOutcome = await relayRuntimeStreamToSSE(
      connection,
      runtimeResponse,
      sessionId,
      agent.id
    )
  } catch (error) {
    const message = (error as Error).message || 'runtime stream failed'
    chatLogger.error('Direct runtime stream relay failed', error as Error, {
      sessionId,
      agentId: agent.id,
    })
    if (runtimeErrorMode === 'assistant_message') {
      const assistantMessageId = await addAssistantTextMessage(
        sessionId,
        connection,
        `审批已通过，但自动继续执行失败：${message}`
      )
      return { ok: true, assistantMessageId }
    }
    sendSSEEvent(connection, 'error', {
      code: 'RUNTIME_STREAM_ERROR',
      message,
    })
    return { ok: false }
  }
  const status = streamOutcome.status
  const rawFinalResponse = streamOutcome.finalResponse
  const error = streamOutcome.error
  const runtimeEvents = streamOutcome.runtimeEvents
  const approvalIds = extractApprovalIds(runtimeEvents)
  const finalResponse = appendApprovalHints(rawFinalResponse, runtimeEvents)

  if (approvalIds.length > 0) {
    rememberPendingApprovalResumes(approvalIds, {
      userId,
      sessionId,
      input,
      agent,
    })
  }

  if ((status !== 'completed' || error) && approvalIds.length === 0) {
    if (runtimeErrorMode === 'assistant_message') {
      const assistantMessageId = await addAssistantTextMessage(
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

  if (!streamOutcome.streamedFinalText && content.trim()) {
    sendAgent2UIMessage(connection, 'text', { content })
  }
  const assistantMessageId = await addAssistantTextMessage(
    sessionId,
    connection,
    content,
    streamOutcome.processMessages.length > 0
      ? {
          execution_process: {
            version: 1,
            messages: streamOutcome.processMessages,
          },
        }
      : undefined,
    false
  )
  if (status === 'failed') {
    await sessionService.updateSessionStatus(sessionId, status)
  }
  return { ok: true, assistantMessageId }
}

async function handleChatViaRuntimeHttp(
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response,
  agent: Agent
): Promise<void> {
  const connection = createSSEConnection(res, sessionId, userId)
  try {
    const result = await dispatchRuntimeChatResult({
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
  } catch (error) {
    chatLogger.error('Direct runtime chat handling failed', error as Error, {
      sessionId,
      agentId: agent.id,
    })
    sendSSEEvent(connection, 'error', {
      code: 'CHAT_RUNTIME_ERROR',
      message: (error as Error).message || 'direct runtime chat failed',
    })
  } finally {
    closeSSEConnection(connection.id)
  }
}

export async function startNewChat(
  userId: string,
  agentId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  await agentService.validateAgentForSession(agentId)

  const session = await sessionService.createSession(userId, {
    agentId,
    title: input.message.slice(0, MAX_SESSION_TITLE_LENGTH),
  })

  await handleChat(userId, session.id, input, res)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
