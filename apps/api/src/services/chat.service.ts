/**
 * Chat 服务层 - 处理对话交互和 SSE 流
 */

import { v4 as uuidv4 } from 'uuid'
import type { Response } from 'express'
import { createError } from '../middleware/errorHandler'
import * as sessionService from './session.service'
import * as agentService from './agent.service'
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
} from '../constants/config'

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

// ═══════════════════════════════════════════════════════════════
// Chat 服务方法
// ═══════════════════════════════════════════════════════════════

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
      sendSSEEvent(connection, 'error', {
        code: LLM_UNAVAILABLE,
        message: '当前没有可用的 LLM Provider，请先完成模型服务配置',
      })
      return
    }

    // 调用 LLM 流式生成
    let fullContent = ''
    let totalTokens = 0
    const startTime = Date.now()

    await llmService.generateStream(
      llmMessages,
      {
        model: agent.config?.model ?? undefined,
        temperature: agent.config?.temperature ?? 0.7,
        maxTokens: agent.config?.maxTokens ?? 4096,
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

    // 发送完成事件
    sendSSEEvent(connection, 'done', {
      sessionId,
      messageId: assistantMessage.id,
      usage: { tokens: totalTokens, latencyMs },
    })
  } catch (error) {
    console.error(`[Chat] 处理失败 - Session: ${sessionId}, User: ${userId}, Agent: ${agent.id}`, error)

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
