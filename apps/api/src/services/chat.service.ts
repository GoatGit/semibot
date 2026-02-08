/**
 * Chat 服务层 - 处理对话交互和 SSE 流
 */

import { v4 as uuidv4 } from 'uuid'
import type { Response } from 'express'
import { createError } from '../middleware/errorHandler'
import * as sessionService from './session.service'
import * as agentService from './agent.service'
import * as skillService from './skill.service'
import * as llmService from './llm.service'
import type { LLMMessage, LLMStreamChunk } from './llm.service'
import {
  VALIDATION_MESSAGE_TOO_LONG,
  SSE_STREAM_ERROR,
  LLM_UNAVAILABLE,
} from '../constants/errorCodes'
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_LENGTH,
  CHAT_EXECUTION_MODE,
  CHAT_RUNTIME_ENABLED_ORGS,
  type ChatExecutionMode,
} from '../constants/config'
import {
  getRuntimeAdapter,
  isRuntimeAvailable,
  type RuntimeInputState,
  type RuntimeExecutionResult,
} from '../adapters/runtime.adapter'
import { getRuntimeMonitor } from './runtime-monitor.service'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type Agent2UIType =
  | 'text'
  | 'markdown'
  | 'code'
  | 'table'
  | 'chart'
  | 'image'
  | 'file'
  | 'plan'
  | 'progress'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'thinking'
  | 'report'

export interface Agent2UIMessage {
  id: string
  type: Agent2UIType
  data: unknown
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface ChatInput {
  message: string
  parentMessageId?: string
}

export interface SSEConnection {
  id: string
  res: Response
  sessionId: string
  userId: string
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
  userId: string
): SSEConnection {
  const connection: SSEConnection = {
    id: uuidv4(),
    res,
    sessionId,
    userId,
    isActive: true,
  }

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

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

  console.log(`[Chat] SSE 连接已创建 - ID: ${connection.id}, Session: ${sessionId}`)

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

  console.log(`[Chat] SSE 连接已关闭 - ID: ${connectionId}`)
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
    console.error(`[Chat] SSE 发送失败 - ID: ${connection.id}`, error)
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
  data: unknown,
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
 * 决定使用哪种执行模式
 */
function determineExecutionMode(orgId: string): ChatExecutionMode {
  const monitor = getRuntimeMonitor()

  // 检查是否触发自动回退
  if (monitor.shouldFallback()) {
    console.warn(`[Chat] 自动回退到 direct 模式 - 原因: ${monitor.getFallbackReason()}`)
    return 'direct_llm'
  }

  // 检查是否在白名���中
  if (CHAT_RUNTIME_ENABLED_ORGS.includes(orgId)) {
    return 'runtime_orchestrator'
  }

  // 使用默认模式
  return CHAT_EXECUTION_MODE
}

/**
 * 处理聊天消息 (SSE 流式响应)
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
    console.warn(
      `[Chat] 消息长度超出限制 - 长度: ${input.message.length}, 限制: ${MAX_MESSAGE_LENGTH}`
    )
    throw createError(VALIDATION_MESSAGE_TOO_LONG)
  }

  // 获取会话
  const session = await sessionService.getSession(orgId, sessionId)

  // 获取 Agent
  const agent = await agentService.getAgent(orgId, session.agentId)

  // 决定执行模式
  const executionMode = determineExecutionMode(orgId)

  console.log(`[Chat] 执行模式: ${executionMode} - Session: ${sessionId}, Org: ${orgId}`)

  // 根据模式选择执行路径
  if (executionMode === 'runtime_orchestrator') {
    await handleChatWithRuntime(orgId, userId, sessionId, input, res, agent, session)
  } else {
    await handleChatDirect(orgId, userId, sessionId, input, res, agent, session)
  }
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
  agent: any,
  session: any
): Promise<void> {
  // 创建 SSE 连接
  const connection = createSSEConnection(res, sessionId, userId)
  const startTime = Date.now()
  const monitor = getRuntimeMonitor()

  try {
    // 检查 Runtime 是否可用
    const runtimeReady = await isRuntimeAvailable()
    if (!runtimeReady) {
      console.warn('[Chat] Runtime 不可用，回退到 direct 模式')

      // 记录失败
      monitor.recordExecution({
        sessionId,
        orgId,
        mode: 'runtime_orchestrator',
        success: false,
        error: 'Runtime service unavailable',
        latencyMs: Date.now() - startTime,
        timestamp: Date.now(),
      })

      await handleChatDirect(orgId, userId, sessionId, input, res, agent, session)
      return
    }

    // 保存用户消息
    await sessionService.addMessage(orgId, sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
    })

    // 获取历史消息
    const historyMessages = await sessionService.getSessionMessages(orgId, sessionId)

    // 构建 Runtime 输入
    const runtimeInput: RuntimeInputState = {
      session_id: sessionId,
      agent_id: agent.id,
      org_id: orgId,
      user_message: input.message,
      history_messages: historyMessages.slice(-20).map((msg) => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      })),
      agent_config: {
        system_prompt: agent.systemPrompt || `你是 ${agent.name}，一个有帮助的 AI 助手。`,
        model: agent.config?.model,
        temperature: agent.config?.temperature ?? 0.7,
        max_tokens: agent.config?.maxTokens ?? 4096,
      },
      metadata: {
        user_id: userId,
      },
    }

    // 执行 Runtime 编排
    const adapter = getRuntimeAdapter()
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
        console.error('[Chat] Runtime 执行失败，错误:', result.error)

        // 记录失败
        monitor.recordExecution({
          sessionId,
          orgId,
          mode: 'runtime_orchestrator',
          success: false,
          error: result.error,
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
    console.error(`[Chat] Runtime 模式处理失败 - Session: ${sessionId}`, error)

    // 记录失败
    monitor.recordExecution({
      sessionId,
      orgId,
      mode: 'runtime_orchestrator',
      success: false,
      error: error instanceof Error ? error.message : '未知错误',
      latencyMs,
      timestamp: Date.now(),
    })

    sendSSEEvent(connection, 'error', {
      code: SSE_STREAM_ERROR,
      message: error instanceof Error ? error.message : '处理失败',
    })
  } finally {
    // 关闭连接
    closeSSEConnection(connection.id)
    res.end()
  }
}

/**
 * 使用 Direct LLM 处理聊天（原有逻辑）
 */
async function handleChatDirect(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response,
  agent: any,
  session: any
): Promise<void> {
  const startTime = Date.now()
  const monitor = getRuntimeMonitor()

  const boundSkills = await skillService.getActiveSkillsByIds(orgId, agent.skills ?? [])
  const anthropicContainerSkills = boundSkills.flatMap((skill) => {
    const skills = skill.config?.container?.skills
    if (!Array.isArray(skills)) return []
    return skills.filter((entry): entry is skillService.AnthropicContainerSkillRef => {
      return (
        !!entry &&
        (entry.type === 'anthropic' || entry.type === 'custom') &&
        typeof entry.skill_id === 'string' &&
        entry.skill_id.trim().length > 0
      )
    })
  })

  // 创建 SSE 连接
  const connection = createSSEConnection(res, sessionId, userId)

  try {
    // 保存用户消息
    await sessionService.addMessage(orgId, sessionId, {
      role: 'user',
      content: input.message,
      parentId: input.parentMessageId,
    })

    // 发送思考状态
    sendAgent2UIMessage(connection, 'thinking', {
      content: '正在分析您的问题...',
    })

    // 获取历史消息
    const historyMessages = await sessionService.getSessionMessages(orgId, sessionId)

    // 构建 LLM 消息
    const llmMessages: LLMMessage[] = [
      {
        role: 'system',
        content: agent.systemPrompt || `你是 ${agent.name}，一个有帮助的 AI 助手。`,
      },
      ...historyMessages.slice(-20).map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
    ]

    // 发送计划状态
    sendAgent2UIMessage(connection, 'plan', {
      steps: [
        { id: '1', title: '理解问题', status: 'completed' },
        { id: '2', title: '生成回答', status: 'running' },
      ],
      currentStep: '2',
    })

    // 检查 LLM 服务是否可用
    if (!llmService.isLLMAvailable()) {
      console.warn('[Chat] LLM 服务不可用，终止本次请求')

      // 记录失败
      monitor.recordExecution({
        sessionId,
        orgId,
        mode: 'direct_llm',
        success: false,
        error: 'LLM service unavailable',
        latencyMs: Date.now() - startTime,
        timestamp: Date.now(),
      })

      sendSSEEvent(connection, 'error', {
        code: LLM_UNAVAILABLE,
        message: '当前没有可用的 LLM Provider，请先完成模型服务配置',
      })
      return
    }

    // 调用 LLM 流式生成
    let fullContent = ''
    let totalTokens = 0

    await llmService.generateStream(
      llmMessages,
      {
        model: agent.config?.model ?? undefined,
        temperature: agent.config?.temperature ?? 0.7,
        maxTokens: agent.config?.maxTokens ?? 4096,
        container: anthropicContainerSkills.length > 0 ? { skills: anthropicContainerSkills } : undefined,
      },
      (chunk: LLMStreamChunk) => {
        if (!connection.isActive) return

        switch (chunk.type) {
          case 'text':
            if (chunk.content) {
              fullContent += chunk.content
              sendAgent2UIMessage(connection, 'text', { content: chunk.content })
            }
            break

          case 'tool_call':
            if (chunk.toolCall) {
              sendAgent2UIMessage(connection, 'tool_call', {
                toolName: chunk.toolCall.function.name,
                arguments: JSON.parse(chunk.toolCall.function.arguments || '{}'),
                status: 'calling',
              })
            }
            break

          case 'done':
            if (chunk.usage) {
              totalTokens = chunk.usage.totalTokens
            }
            break

          case 'error':
            sendSSEEvent(connection, 'error', {
              code: chunk.error?.code ?? SSE_STREAM_ERROR,
              message: chunk.error?.message ?? '生成失败',
            })
            break
        }
      }
    )

    const latencyMs = Date.now() - startTime

    // 完成计划
    sendAgent2UIMessage(connection, 'plan', {
      steps: [
        { id: '1', title: '理解问题', status: 'completed' },
        { id: '2', title: '生成回答', status: 'completed' },
      ],
      currentStep: '2',
    })

    // 保存助手消息
    const assistantMessage = await sessionService.addMessage(orgId, sessionId, {
      role: 'assistant',
      content: fullContent,
      tokensUsed: totalTokens,
      latencyMs,
    })

    // 记录成功
    monitor.recordExecution({
      sessionId,
      orgId,
      mode: 'direct_llm',
      success: true,
      latencyMs,
      timestamp: Date.now(),
    })

    // 发送完成事件
    sendSSEEvent(connection, 'done', {
      sessionId,
      messageId: assistantMessage.id,
      usage: { tokens: totalTokens, latencyMs },
      executionMode: 'direct_llm',
    })
  } catch (error) {
    const latencyMs = Date.now() - startTime
    console.error(`[Chat] 处理失败 - Session: ${sessionId}, User: ${userId}, Agent: ${agent.id}`, error)

    // 记录失败
    monitor.recordExecution({
      sessionId,
      orgId,
      mode: 'direct_llm',
      success: false,
      error: error instanceof Error ? error.message : '未知错误',
      latencyMs,
      timestamp: Date.now(),
    })

    sendSSEEvent(connection, 'error', {
      code: SSE_STREAM_ERROR,
      message: error instanceof Error ? error.message : '处理失败',
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
    title: input.message.slice(0, 50), // 使用消息前 50 字符作为标题
  })

  // 处理对话
  await handleChat(orgId, userId, session.id, input, res)
}
