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
import type { Agent2UIMessage, Agent2UIType, Agent2UIData } from '@semibot/shared-types'
import type { Agent } from './agent.service'
import type { Session } from './session.service'
import { getWSServer } from '../ws/ws-server'
import { registerSSEConnection, unregisterSSEConnection } from '../relay/sse-relay'
import { ensureUserVM } from '../scheduler/vm-scheduler'

export interface ChatInput {
  message: string
  parentMessageId?: string
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean)
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
  const agent = await agentService.getAgent(orgId, session.agentId)

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

  // 先写入用户消息
  await sessionService.addMessage(orgId, sessionId, {
    role: 'user',
    content: input.message,
    parentId: input.parentMessageId,
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

  wsServer.sendUserMessage(userId, sessionId, {
    message: input.message,
    history,
    metadata: {
      org_id: orgId,
      user_id: userId,
      connection_id: connection.id,
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
