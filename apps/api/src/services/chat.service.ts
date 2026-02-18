/**
 * Chat 服务层 - 处理对话交互和 SSE 流
 */

import { v4 as uuidv4 } from 'uuid'
import type { Response } from 'express'
import { createError } from '../middleware/errorHandler'
import * as sessionService from './session.service'
import * as agentService from './agent.service'
import * as mcpService from './mcp.service'
import { buildSkillIndex } from './skill-prompt-builder'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
import * as skillPackageRepo from '../repositories/skill-package.repository'
import {
  VALIDATION_MESSAGE_TOO_LONG,
  SSE_STREAM_ERROR,
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
import {
  getRuntimeAdapter,
  isRuntimeAvailable,
  type RuntimeInputState,
  type RuntimeExecutionResult,
} from '../adapters/runtime.adapter'
import { getRuntimeMonitor } from './runtime-monitor.service'
import type { Agent2UIMessage, Agent2UIType, Agent2UIData } from '@semibot/shared-types'
import { chatLogger } from '../lib/logger'
import type { Agent } from './agent.service'
import type { Session } from './session.service'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// SSE 连接管理
// ═══════════════════════════════════════════════════════════════

const sseConnections = new Map<string, SSEConnection>()

/**
 * 创建 SSE 连接
 */
export function createSSEConnection(
  res: Response,
  sessionId: string,
  userId: string,
  orgId: string
): SSEConnection {
  // 检查用户连接数限制
  const userConnections = Array.from(sseConnections.values()).filter(
    (conn) => conn.userId === userId
  ).length

  if (userConnections >= MAX_SSE_CONNECTIONS_PER_USER) {
    chatLogger.warn('用户连接数已达上限', {
      userId,
      current: userConnections,
      limit: MAX_SSE_CONNECTIONS_PER_USER,
    })
    throw createError(SSE_CONNECTION_LIMIT, 'SSE 连接数已达上限，请关闭其他连接后重试')
  }

  // 检查组织连接数限制
  const orgConnections = Array.from(sseConnections.values()).filter(
    (conn) => conn.orgId === orgId
  ).length

  if (orgConnections >= MAX_SSE_CONNECTIONS_PER_ORG) {
    chatLogger.warn('组织连接数已达上限', {
      orgId,
      current: orgConnections,
      limit: MAX_SSE_CONNECTIONS_PER_ORG,
    })
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

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // 启动心跳
  connection.heartbeatTimer = setInterval(() => {
    if (connection.isActive) {
      sendSSEEvent(connection, 'heartbeat', null)
    }
  }, SSE_HEARTBEAT_INTERVAL_MS)

  // 处理连接关闭
  res.on('close', () => {
    closeSSEConnection(connection.id)
  })

  sseConnections.set(connection.id, connection)

  chatLogger.info('SSE 连接已创建', {
    connectionId: connection.id,
    sessionId,
    userConnections: userConnections + 1,
    limit: MAX_SSE_CONNECTIONS_PER_USER,
  })

  return connection
}

/**
 * 关闭 SSE 连接
 */
export function closeSSEConnection(connectionId: string): void {
  const connection = sseConnections.get(connectionId)

  if (!connection) {
    return
  }

  connection.isActive = false

  if (connection.heartbeatTimer) {
    clearInterval(connection.heartbeatTimer)
  }

  sseConnections.delete(connectionId)

  chatLogger.info('SSE 连接已关闭', { connectionId })
}

/**
 * 发送 SSE 事件
 */
export function sendSSEEvent(
  connection: SSEConnection,
  event: string,
  data: unknown
): boolean {
  if (!connection.isActive) {
    return false
  }

  try {
    connection.res.write(`event: ${event}\n`)
    connection.res.write(`data: ${JSON.stringify(data)}\n\n`)
    return true
  } catch (error) {
    chatLogger.error('SSE 发送失败', error as Error, { connectionId: connection.id })
    closeSSEConnection(connection.id)
    return false
  }
}

/**
 * 发送 Agent2UI 消息
 */
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

// ════════════════════════════════════════════════════��══════════
// Chat 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 根据错误信息分类错误类型
 */
function classifyRuntimeError(error: string | undefined): 'transient' | 'permanent' | 'timeout' {
  if (!error) return 'permanent'
  const lower = error.toLowerCase()
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout'
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('network') ||
    lower.includes('unavailable') ||
    lower.includes('stall')
  ) {
    return 'transient'
  }
  return 'permanent'
}

/**
 * 处理聊天消息 (SSE 流式响应)
 * 统一使用 Runtime Orchestrator 模式
 */
export async function handleChat(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  // 验证消息长度
  if (input.message.length > MAX_MESSAGE_LENGTH) {
    chatLogger.warn('消息长度超出限制', {
      length: input.message.length,
      limit: MAX_MESSAGE_LENGTH,
    })
    throw createError(VALIDATION_MESSAGE_TOO_LONG)
  }

  // 获取会话
  const session = await sessionService.getSession(orgId, sessionId)

  // 获取 Agent
  const agent = await agentService.getAgent(orgId, session.agentId)

  chatLogger.info('使用 Runtime Orchestrator 模式', { sessionId, orgId })

  await handleChatWithRuntime(orgId, userId, sessionId, input, res, agent, session)
}

/**
 * 使用 Runtime Orchestrator 处理聊天
 */
async function handleChatWithRuntime(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response,
  agent: Agent,
  _session: Session
): Promise<void> {
  const startTime = Date.now()
  const monitor = getRuntimeMonitor()

  // 检查 Runtime 是否可用（在创建 SSE 连接之前）
  const runtimeReady = await isRuntimeAvailable()
  if (!runtimeReady) {
    chatLogger.error('Runtime 不可用')

    // 记录失败
    monitor.recordExecution({
      sessionId,
      orgId,
      mode: 'runtime_orchestrator',
      success: false,
      error: 'Runtime service unavailable',
      errorType: 'transient',
      latencyMs: Date.now() - startTime,
      timestamp: Date.now(),
    })

    throw createError(LLM_UNAVAILABLE, 'Runtime Orchestrator 服务不可用，请检查 Runtime 是否已启动')
  }

  // 创建 SSE 连接（确认使用 runtime 模式后再创建）
  const connection = createSSEConnection(res, sessionId, userId, orgId)

  try {
    // 立即发送初始 thinking，消除 Runtime 启动延迟期间的空白感
    sendAgent2UIMessage(connection, 'thinking', {
      content: '正在连接执行引擎...',
    })

    // 保存用户消息
    await sessionService.addMessage(orgId, sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
    })

    // 获取历史消息
    const historyMessages = await sessionService.getSessionMessages(orgId, sessionId)

    // 截断历史消息（保留最近 20 条）
    if (historyMessages.length > MAX_HISTORY_MESSAGES) {
      chatLogger.warn('历史消息截断', {
        total: historyMessages.length,
        kept: MAX_HISTORY_MESSAGES,
        dropped: historyMessages.length - MAX_HISTORY_MESSAGES,
      })
    }

    // 构建 Runtime 输入
    const runtimeInput: RuntimeInputState = {
      session_id: sessionId,
      agent_id: agent.id,
      org_id: orgId,
      user_message: input.message,
      history_messages: historyMessages.slice(-MAX_HISTORY_MESSAGES).map((msg) => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      })),
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
      metadata: {
        user_id: userId,
      },
    }

    // 加载 Agent 关联的 Skill 定义，构建 skill index 注入 system prompt
    if (agent.skills && agent.skills.length > 0) {
      try {
        const skillPairs: Array<{ definition: skillDefinitionRepo.SkillDefinition; package: skillPackageRepo.SkillPackage }> = []
        for (const skillDefId of agent.skills) {
          const def = await skillDefinitionRepo.findById(skillDefId)
          if (!def || !def.isActive) continue
          const pkg = await skillPackageRepo.findByDefinition(skillDefId)
          if (!pkg) continue
          skillPairs.push({ definition: def, package: pkg })
        }
        if (skillPairs.length > 0) {
          const skillIndexXml = await buildSkillIndex(skillPairs)
          if (skillIndexXml) {
            runtimeInput.agent_config!.system_prompt += '\n\n' + skillIndexXml
            chatLogger.info('已注入 Skill 索引到 system prompt', {
              agentId: agent.id,
              skillCount: skillPairs.length,
            })
          }
        }
      } catch (err) {
        chatLogger.warn('加载 Skills 失败，继续无 Skill 模式', {
          agentId: agent.id,
          error: (err as Error).message,
        })
      }
    }

    // 加载 Agent 关联的 MCP Servers（系统 Agent 额外合并系统预装 MCP Servers + 组织 MCP Servers）
    try {
      const agentMcpServers = await mcpService.getMcpServersForRuntime(agent.id)

      let mergedServers = agentMcpServers
      if (agent.isSystem) {
        const systemMcpServers = await mcpService.getSystemMcpServersForRuntime()
        const orgMcpServers = await mcpService.getOrgMcpServersForRuntime(orgId)
        const existingIds = new Set(agentMcpServers.map((s: { id: string }) => s.id))
        mergedServers = [
          ...agentMcpServers,
          ...systemMcpServers.filter((s) => !existingIds.has(s.id)),
          ...orgMcpServers.filter((s) => !existingIds.has(s.id) && !systemMcpServers.some((sys) => sys.id === s.id)),
        ]
      }

      if (mergedServers.length > 0) {
        runtimeInput.available_mcp_servers = mergedServers
        chatLogger.info('已加载 MCP Servers', {
          agentId: agent.id,
          isSystem: agent.isSystem,
          serverCount: mergedServers.length,
          toolCount: mergedServers.reduce((sum: number, s: { available_tools: unknown[] }) => sum + s.available_tools.length, 0),
        })
      }
    } catch (err) {
      chatLogger.warn('加载 MCP Servers 失败，继续无 MCP 模式', {
        agentId: agent.id,
        error: (err as Error).message,
      })
    }

    // 加载同组织下其他 Agent 作为委派候选池
    try {
      const candidateSubAgents = await agentService.getCandidateSubAgents(orgId, agent.id)
      if (candidateSubAgents.length > 0) {
        runtimeInput.available_sub_agents = candidateSubAgents
        chatLogger.info('已加载候选 SubAgents', {
          agentId: agent.id,
          candidateCount: candidateSubAgents.length,
        })
      }
    } catch (err) {
      chatLogger.warn('加载候选 SubAgents 失败，继续无委派模式', {
        agentId: agent.id,
        error: (err as Error).message,
      })
    }

    // 执行 Runtime 编排
    const adapter = getRuntimeAdapter()

    // 客户端断开时触发取消
    res.on('close', () => {
      if (!connection.isActive) {
        adapter.cancelExecution(runtimeInput.session_id).catch(() => {})
      }
    })

    let fullContent = ''
    let totalTokens = 0
    let latencyMs = 0

    await adapter.executeWithStreaming(connection, runtimeInput, async (result: RuntimeExecutionResult) => {
      latencyMs = Date.now() - startTime

      if (result.success) {
        fullContent = result.final_response || ''
        totalTokens = result.usage?.total_tokens || 0

        // 记录成功
        monitor.recordExecution({
          sessionId,
          orgId,
          mode: 'runtime_orchestrator',
          success: true,
          latencyMs,
          timestamp: Date.now(),
        })

        // 保存助手消息
        const assistantMessage = await sessionService.addMessage(orgId, sessionId, {
          role: 'assistant',
          content: fullContent,
          tokensUsed: totalTokens,
          latencyMs,
        })

        // 发送完成事件
        sendSSEEvent(connection, 'done', {
          sessionId,
          messageId: assistantMessage.id,
          usage: { tokens: totalTokens, latencyMs },
          executionMode: 'runtime_orchestrator',
        })
      } else {
        chatLogger.error('Runtime 执行失败', undefined, { error: result.error })

        // 记录失败
        monitor.recordExecution({
          sessionId,
          orgId,
          mode: 'runtime_orchestrator',
          success: false,
          error: result.error,
          errorType: classifyRuntimeError(result.error),
          latencyMs,
          timestamp: Date.now(),
        })

        sendSSEEvent(connection, 'error', {
          code: SSE_STREAM_ERROR,
          message: result.error || 'Runtime 执行失败',
        })
      }
    })
  } catch (error) {
    const latencyMs = Date.now() - startTime
    chatLogger.error('Runtime 模式处理失败', error as Error, { sessionId, latencyMs })

    const runtimeError = error instanceof Error ? error.message : '未知错误'

    // 记录失败
    monitor.recordExecution({
      sessionId,
      orgId,
      mode: 'runtime_orchestrator',
      success: false,
      error: runtimeError,
      errorType: classifyRuntimeError(runtimeError),
      latencyMs,
      timestamp: Date.now(),
    })

    sendSSEEvent(connection, 'error', {
      code: SSE_STREAM_ERROR,
      message: runtimeError,
    })
  } finally {
    // 关闭连接
    closeSSEConnection(connection.id)
    res.end()
  }
}

/**
 * 创建新会话并开始对话
 */
export async function startNewChat(
  orgId: string,
  userId: string,
  agentId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  // 验证 Agent
  await agentService.validateAgentForSession(orgId, agentId)

  // 创建会话
  const session = await sessionService.createSession(orgId, userId, {
    agentId,
    title: input.message.slice(0, MAX_SESSION_TITLE_LENGTH), // 使用消息前 N 字符作为标题
  })

  // 处理对话
  await handleChat(orgId, userId, session.id, input, res)
}
