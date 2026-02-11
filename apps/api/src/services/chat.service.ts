/**
 * Chat 服务层 - 处理对话交互和 SSE 流
 */

import { v4 as uuidv4 } from 'uuid'
import type { Response } from 'express'
import { createError } from '../middleware/errorHandler'
import * as sessionService from './session.service'
import * as agentService from './agent.service'
import * as skillService from './skill.service'
import * as mcpService from './mcp.service'
import * as llmService from './llm.service'
import type { LLMMessage, LLMStreamChunk } from './llm.service'
import type { ToolCall } from './llm/index'
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
  CHAT_EXECUTION_MODE,
  CHAT_RUNTIME_ENABLED_ORGS,
  MAX_HISTORY_MESSAGES,
  MAX_SESSION_TITLE_LENGTH,
  type ChatExecutionMode,
} from '../constants/config'
import {
  getRuntimeAdapter,
  isRuntimeAvailable,
  type RuntimeInputState,
  type RuntimeExecutionResult,
} from '../adapters/runtime.adapter'
import { getRuntimeMonitor } from './runtime-monitor.service'
import type { RuntimeErrorType } from './runtime-monitor.service'
import type { Agent2UIMessage, Agent2UIType, Agent2UIData, McpCallData } from '@semibot/shared-types'
import { chatLogger } from '../lib/logger'

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
function classifyRuntimeError(error: string | undefined): RuntimeErrorType {
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
 * 决定使用哪种执行模式
 */
function determineExecutionMode(orgId: string): ChatExecutionMode {
  const monitor = getRuntimeMonitor()

  // 检查是否触发自动回退
  if (monitor.shouldFallback()) {
    chatLogger.warn('自动回退到 direct 模式', { reason: monitor.getFallbackReason() })
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

  // 决定执行模式
  const executionMode = determineExecutionMode(orgId)

  chatLogger.info('执行模式已确定', { executionMode, sessionId, orgId })

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
  const connection = createSSEConnection(res, sessionId, userId, orgId)
  const startTime = Date.now()
  const monitor = getRuntimeMonitor()

  try {
    // 检查 Runtime 是否可用
    const runtimeReady = await isRuntimeAvailable()
    if (!runtimeReady) {
      chatLogger.warn('Runtime 不可用，回退到 direct 模式')

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
        system_prompt: agent.systemPrompt || `你是 ${agent.name}，一个有帮助的 AI 助手。`,
        model: agent.config?.model,
        temperature: agent.config?.temperature ?? 0.7,
        max_tokens: agent.config?.maxTokens ?? 4096,
      },
      metadata: {
        user_id: userId,
      },
    }

    // 加载 Agent 关联的 MCP Servers
    try {
      const mcpServers = await mcpService.getMcpServersForRuntime(agent.id)
      if (mcpServers.length > 0) {
        runtimeInput.available_mcp_servers = mcpServers
        chatLogger.info('已加载 MCP Servers', {
          agentId: agent.id,
          serverCount: mcpServers.length,
          toolCount: mcpServers.reduce((sum, s) => sum + s.available_tools.length, 0),
        })
      }
    } catch (err) {
      chatLogger.warn('加载 MCP Servers 失败，继续无 MCP 模式', {
        agentId: agent.id,
        error: (err as Error).message,
      })
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
 * 使用 Direct LLM 处理聊天（原有逻辑）
 */
async function handleChatDirect(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response,
  agent: any,
  _session: any
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

  // 加载 Agent 关联的 MCP 工具
  let mcpTools: mcpService.McpToolForLLM[] = []
  const mcpToolMap = new Map<string, mcpService.McpToolForLLM>()
  try {
    mcpTools = await mcpService.getMcpToolsForAgent(agent.id)
    for (const tool of mcpTools) {
      mcpToolMap.set(tool.function.name, tool)
    }
  } catch (err) {
    chatLogger.warn('加载 MCP 工具失败，继续无工具模式', { agentId: agent.id, error: (err as Error).message })
  }

  // 构建 tools 参数（MCP 工具，不含 _mcpMeta）
  const toolDefinitions = mcpTools.map(({ _mcpMeta: _, ...rest }) => rest)

  // 创建 SSE 连接
  const connection = createSSEConnection(res, sessionId, userId, orgId)

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

    // 截断历史消息（保留最近 N 条）
    if (historyMessages.length > MAX_HISTORY_MESSAGES) {
      chatLogger.warn('历史消息截断', {
        total: historyMessages.length,
        kept: MAX_HISTORY_MESSAGES,
        dropped: historyMessages.length - MAX_HISTORY_MESSAGES,
      })
    }

    // 构建 LLM 消息
    const llmMessages: LLMMessage[] = [
      {
        role: 'system',
        content: agent.systemPrompt || `你是 ${agent.name}，一个有帮助的 AI 助手。`,
      },
      ...historyMessages.slice(-MAX_HISTORY_MESSAGES).map((msg) => ({
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
      chatLogger.warn('LLM 服务不可用，终止本次请求')

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

    const llmConfig = {
      model: agent.config?.model ?? undefined,
      temperature: agent.config?.temperature ?? 0.7,
      maxTokens: agent.config?.maxTokens ?? 4096,
      container: anthropicContainerSkills.length > 0 ? { skills: anthropicContainerSkills } : undefined,
      tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
      toolChoice: toolDefinitions.length > 0 ? 'auto' as const : undefined,
    }

    // 调用 LLM 流式生成
    let fullContent = ''
    let totalTokens = 0
    const pendingToolCalls: ToolCall[] = []

    await llmService.generateStream(
      llmMessages,
      llmConfig,
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
              pendingToolCalls.push(chunk.toolCall)
              sendAgent2UIMessage(connection, 'tool_call', {
                toolName: chunk.toolCall.function.name,
                arguments: JSON.parse(chunk.toolCall.function.arguments || '{}'),
                status: 'calling',
              })
            }
            break

          case 'done':
            if (chunk.usage) {
              totalTokens += chunk.usage.totalTokens
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

    // MCP 工具调用循环（最多 10 轮）
    const MAX_TOOL_ROUNDS = 10
    let toolRound = 0

    while (pendingToolCalls.length > 0 && toolRound < MAX_TOOL_ROUNDS && connection.isActive) {
      toolRound++
      chatLogger.info('执行 MCP 工具调用', { round: toolRound, toolCount: pendingToolCalls.length })

      // 将 assistant 的 tool_calls 消息加入上下文
      const assistantMsg: LLMMessage = {
        role: 'assistant',
        content: fullContent || '',
        toolCalls: [...pendingToolCalls],
      }
      llmMessages.push(assistantMsg)

      // 执行每个工具调用
      for (const toolCall of pendingToolCalls) {
        const mcpTool = mcpToolMap.get(toolCall.function.name)
        let toolResult: string

        if (mcpTool) {
          try {
            const toolArgs = JSON.parse(toolCall.function.arguments || '{}')

            sendAgent2UIMessage(connection, 'mcp_call', {
              serverId: mcpTool._mcpMeta.serverId,
              toolName: toolCall.function.name,
              arguments: toolArgs,
              status: 'calling',
            } as McpCallData)

            const result = await mcpService.callMcpTool(
              mcpTool._mcpMeta.serverId,
              orgId,
              mcpTool._mcpMeta.originalToolName,
              toolArgs
            )
            toolResult = typeof result === 'string' ? result : JSON.stringify(result)

            sendAgent2UIMessage(connection, 'mcp_call', {
              serverId: mcpTool._mcpMeta.serverId,
              toolName: toolCall.function.name,
              arguments: toolArgs,
              result: toolResult,
              status: 'success',
            } as McpCallData)
          } catch (err) {
            toolResult = `工具调用失败: ${(err as Error).message}`
            chatLogger.error('MCP 工具调用失败', err as Error, {
              toolName: toolCall.function.name,
              serverId: mcpTool._mcpMeta.serverId,
            })

            sendAgent2UIMessage(connection, 'mcp_call', {
              serverId: mcpTool._mcpMeta.serverId,
              toolName: toolCall.function.name,
              arguments: JSON.parse(toolCall.function.arguments || '{}'),
              error: (err as Error).message,
              status: 'error',
            } as McpCallData)
          }
        } else {
          toolResult = `未知工具: ${toolCall.function.name}`
        }

        // 将工具结果加入上下文
        llmMessages.push({
          role: 'tool',
          content: toolResult,
          toolCallId: toolCall.id,
        })
      }

      // 清空待处理工具调用，准备下一轮
      pendingToolCalls.length = 0
      fullContent = ''

      // 用工具结果继续调用 LLM
      sendAgent2UIMessage(connection, 'thinking', {
        content: '正在根据工具结果生成回答...',
      })

      await llmService.generateStream(
        llmMessages,
        llmConfig,
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
                pendingToolCalls.push(chunk.toolCall)
                sendAgent2UIMessage(connection, 'tool_call', {
                  toolName: chunk.toolCall.function.name,
                  arguments: JSON.parse(chunk.toolCall.function.arguments || '{}'),
                  status: 'calling',
                })
              }
              break

            case 'done':
              if (chunk.usage) {
                totalTokens += chunk.usage.totalTokens
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
    }

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
    chatLogger.error('处理失败', error as Error, { sessionId, userId, agentId: agent.id, latencyMs })

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
    title: input.message.slice(0, MAX_SESSION_TITLE_LENGTH), // 使用消息前 N 字符作为标题
  })

  // 处理对话
  await handleChat(orgId, userId, session.id, input, res)
}
