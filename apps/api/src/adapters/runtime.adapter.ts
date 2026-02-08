/**
 * Runtime Adapter - 适配 API 与 Python Runtime Orchestrator
 *
 * 职责：
 * 1. 将 API 的 chat 请求转换为 runtime state 输入
 * 2. 将 runtime 事件输出映射为 Agent2UI SSE 事件
 * 3. 处理超时与错误回退
 */

import axios, { AxiosInstance } from 'axios'
import { v4 as uuidv4 } from 'uuid'
import type { Response } from 'express'
import type { Agent2UIMessage, Agent2UIType } from '@semibot/shared-types'
import { RUNTIME_SERVICE_URL, RUNTIME_EXECUTION_TIMEOUT_MS, MCP_CONNECTION_TIMEOUT_MS } from '../constants/config'
import { createError } from '../middleware/errorHandler'
import { SSE_STREAM_ERROR } from '../constants/errorCodes'
import type { SSEConnection } from '../services/chat.service'
import { sendSSEEvent, sendAgent2UIMessage } from '../services/chat.service'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * Runtime 输入状态
 */
export interface RuntimeInputState {
  session_id: string
  agent_id: string
  org_id: string
  user_message: string
  history_messages?: Array<{
    role: 'user' | 'assistant' | 'system'
    content: string
  }>
  agent_config?: {
    system_prompt?: string
    model?: string
    temperature?: number
    max_tokens?: number
  }
  metadata?: Record<string, unknown>
}

/**
 * Runtime 事件类型
 */
export type RuntimeEventType =
  | 'plan_created'
  | 'plan_step_start'
  | 'plan_step_complete'
  | 'plan_step_failed'
  | 'tool_call_start'
  | 'tool_call_complete'
  | 'skill_call_start'
  | 'skill_call_complete'
  | 'mcp_call_start'
  | 'mcp_call_complete'
  | 'thinking'
  | 'text_chunk'
  | 'execution_complete'
  | 'execution_error'

/**
 * Runtime 事件
 */
export interface RuntimeEvent {
  event: RuntimeEventType
  data: Record<string, unknown>
  timestamp: string
}

/**
 * Runtime 执行结果
 */
export interface RuntimeExecutionResult {
  success: boolean
  final_response?: string
  error?: string
  usage?: {
    total_tokens: number
    latency_ms: number
  }
  trace_id?: string
}

// ═══════════════════════════════════════════════════════════════
// Runtime Adapter 类
// ═══════════════════════════════════════════════════════════════

export class RuntimeAdapter {
  private client: AxiosInstance
  private timeoutMs: number

  constructor(baseURL: string = RUNTIME_SERVICE_URL, timeoutMs: number = RUNTIME_EXECUTION_TIMEOUT_MS) {
    this.client = axios.create({
      baseURL,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
    })
    this.timeoutMs = timeoutMs
  }

  /**
   * 执行 Runtime 编排并流式返回事件
   */
  async executeWithStreaming(
    connection: SSEConnection,
    input: RuntimeInputState,
    onComplete?: (result: RuntimeExecutionResult) => void
  ): Promise<void> {
    const startTime = Date.now()
    let fullResponse = ''
    let totalTokens = 0
    let hasError = false
    let errorMessage = ''

    try {
      console.log(`[RuntimeAdapter] 开始执行 - Session: ${input.session_id}, Agent: ${input.agent_id}`)

      // 调用 Runtime API (SSE 流式)
      const response = await this.client.post('/api/v1/execute/stream', input, {
        responseType: 'stream',
        timeout: this.timeoutMs,
      })

      // 处理 SSE 流
      const stream = response.data

      stream.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n')

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue

          try {
            const data = line.slice(6) // 移除 "data: " 前缀
            if (data === '[DONE]') continue

            const event: RuntimeEvent = JSON.parse(data)
            this.handleRuntimeEvent(event, connection, (text) => {
              fullResponse += text
            })
          } catch (err) {
            console.error('[RuntimeAdapter] 解析事件失败:', err, '原始数据:', line)
            sendSSEEvent(connection, 'error', {
              code: SSE_STREAM_ERROR,
              message: 'SSE 流解析失败，请稍后重试',
            })
          }
        }
      })

      stream.on('end', () => {
        const latencyMs = Date.now() - startTime
        console.log(`[RuntimeAdapter] 执行完成 - Session: ${input.session_id}, 耗时: ${latencyMs}ms`)

        if (onComplete) {
          onComplete({
            success: !hasError,
            final_response: fullResponse,
            error: hasError ? errorMessage : undefined,
            usage: {
              total_tokens: totalTokens,
              latency_ms: latencyMs,
            },
          })
        }
      })

      stream.on('error', (err: Error) => {
        hasError = true
        errorMessage = err.message
        console.error('[RuntimeAdapter] 流错误:', err)

        sendSSEEvent(connection, 'error', {
          code: SSE_STREAM_ERROR,
          message: `Runtime 执行失败: ${err.message}`,
        })

        if (onComplete) {
          onComplete({
            success: false,
            error: err.message,
          })
        }
      })
    } catch (error) {
      const latencyMs = Date.now() - startTime
      console.error('[RuntimeAdapter] 执行失败:', error)

      const errorMsg = error instanceof Error ? error.message : '未知错误'

      sendSSEEvent(connection, 'error', {
        code: SSE_STREAM_ERROR,
        message: `Runtime 执行失败: ${errorMsg}`,
      })

      if (onComplete) {
        onComplete({
          success: false,
          error: errorMsg,
          usage: {
            total_tokens: 0,
            latency_ms: latencyMs,
          },
        })
      }
    }
  }

  /**
   * 处理 Runtime 事件并转换为 Agent2UI 消息
   */
  private handleRuntimeEvent(
    event: RuntimeEvent,
    connection: SSEConnection,
    onTextChunk?: (text: string) => void
  ): void {
    switch (event.event) {
      case 'plan_created':
        this.handlePlanCreated(event, connection)
        break

      case 'plan_step_start':
        this.handlePlanStepStart(event, connection)
        break

      case 'plan_step_complete':
        this.handlePlanStepComplete(event, connection)
        break

      case 'plan_step_failed':
        this.handlePlanStepFailed(event, connection)
        break

      case 'tool_call_start':
        this.handleToolCallStart(event, connection)
        break

      case 'tool_call_complete':
        this.handleToolCallComplete(event, connection)
        break

      case 'skill_call_start':
        this.handleSkillCallStart(event, connection)
        break

      case 'skill_call_complete':
        this.handleSkillCallComplete(event, connection)
        break

      case 'mcp_call_start':
        this.handleMcpCallStart(event, connection)
        break

      case 'mcp_call_complete':
        this.handleMcpCallComplete(event, connection)
        break

      case 'thinking':
        this.handleThinking(event, connection)
        break

      case 'text_chunk':
        this.handleTextChunk(event, connection, onTextChunk)
        break

      case 'execution_complete':
        // 完成事件由外部处理
        break

      case 'execution_error':
        this.handleExecutionError(event, connection)
        break

      default:
        console.warn(`[RuntimeAdapter] 未知事件类型: ${event.event}`)
    }
  }

  private handlePlanCreated(event: RuntimeEvent, connection: SSEConnection): void {
    const { goal, steps } = event.data

    sendAgent2UIMessage(connection, 'plan', {
      steps: (steps as Array<{ id: string; title: string }>).map((step) => ({
        id: step.id,
        title: step.title,
        status: 'pending' as const,
      })),
      currentStep: '',
    })
  }

  private handlePlanStepStart(event: RuntimeEvent, connection: SSEConnection): void {
    const { step_id, title, tool, params } = event.data

    sendAgent2UIMessage(connection, 'plan_step', {
      stepId: step_id as string,
      title: title as string,
      status: 'running' as const,
      tool: tool as string | undefined,
      params: params as Record<string, unknown> | undefined,
    })
  }

  private handlePlanStepComplete(event: RuntimeEvent, connection: SSEConnection): void {
    const { step_id, title, result, duration_ms } = event.data

    sendAgent2UIMessage(connection, 'plan_step', {
      stepId: step_id as string,
      title: title as string,
      status: 'completed' as const,
      result,
      durationMs: duration_ms as number | undefined,
    })
  }

  private handlePlanStepFailed(event: RuntimeEvent, connection: SSEConnection): void {
    const { step_id, title, error } = event.data

    sendAgent2UIMessage(connection, 'plan_step', {
      stepId: step_id as string,
      title: title as string,
      status: 'failed' as const,
      error: error as string,
    })
  }

  private handleToolCallStart(event: RuntimeEvent, connection: SSEConnection): void {
    const { tool_name, arguments: args } = event.data

    sendAgent2UIMessage(connection, 'tool_call', {
      toolName: tool_name as string,
      arguments: args as Record<string, unknown>,
      status: 'calling' as const,
    })
  }

  private handleToolCallComplete(event: RuntimeEvent, connection: SSEConnection): void {
    const { tool_name, result, success, error, duration } = event.data

    sendAgent2UIMessage(connection, 'tool_result', {
      toolName: tool_name as string,
      result,
      success: success as boolean,
      error: error as string | undefined,
      duration: duration as number | undefined,
    })
  }

  private handleSkillCallStart(event: RuntimeEvent, connection: SSEConnection): void {
    const { skill_id, skill_name, arguments: args } = event.data

    sendAgent2UIMessage(connection, 'skill_call', {
      skillId: skill_id as string,
      skillName: skill_name as string,
      arguments: args as Record<string, unknown>,
      status: 'calling' as const,
    })
  }

  private handleSkillCallComplete(event: RuntimeEvent, connection: SSEConnection): void {
    const { skill_id, skill_name, result, success, error, duration } = event.data

    sendAgent2UIMessage(connection, 'skill_result', {
      skillId: skill_id as string,
      skillName: skill_name as string,
      result,
      success: success as boolean,
      error: error as string | undefined,
      duration: duration as number | undefined,
    })
  }

  private handleMcpCallStart(event: RuntimeEvent, connection: SSEConnection): void {
    const { server_id, tool_name, arguments: args } = event.data

    sendAgent2UIMessage(connection, 'mcp_call', {
      serverId: server_id as string,
      toolName: tool_name as string,
      arguments: args as Record<string, unknown>,
      status: 'calling' as const,
    })
  }

  private handleMcpCallComplete(event: RuntimeEvent, connection: SSEConnection): void {
    const { server_id, tool_name, result, success, error, duration } = event.data

    sendAgent2UIMessage(connection, 'mcp_result', {
      serverId: server_id as string,
      toolName: tool_name as string,
      result,
      success: success as boolean,
      error: error as string | undefined,
      duration: duration as number | undefined,
    })
  }

  private handleThinking(event: RuntimeEvent, connection: SSEConnection): void {
    const { content, stage } = event.data

    sendAgent2UIMessage(connection, 'thinking', {
      content: content as string,
      stage: stage as 'analyzing' | 'planning' | 'reasoning' | 'concluding' | undefined,
    })
  }

  private handleTextChunk(
    event: RuntimeEvent,
    connection: SSEConnection,
    onTextChunk?: (text: string) => void
  ): void {
    const { content } = event.data

    if (content && typeof content === 'string') {
      sendAgent2UIMessage(connection, 'text', { content })

      if (onTextChunk) {
        onTextChunk(content)
      }
    }
  }

  private handleExecutionError(event: RuntimeEvent, connection: SSEConnection): void {
    const { error, code } = event.data

    sendSSEEvent(connection, 'error', {
      code: code || SSE_STREAM_ERROR,
      message: error as string,
    })
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health', { timeout: MCP_CONNECTION_TIMEOUT_MS })
      return response.status === 200
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        console.warn(
          `[RuntimeAdapter] 健康检查超时 (超时时间: ${MCP_CONNECTION_TIMEOUT_MS}ms)`,
          error
        )
      } else {
        console.error('[RuntimeAdapter] 健康检查失败:', error)
      }
      return false
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 单例实例
// ═══════════════════════════════════════════════════════════════

let runtimeAdapterInstance: RuntimeAdapter | null = null

/**
 * 获取 Runtime Adapter 单例
 */
export function getRuntimeAdapter(): RuntimeAdapter {
  if (!runtimeAdapterInstance) {
    runtimeAdapterInstance = new RuntimeAdapter()
  }
  return runtimeAdapterInstance
}

/**
 * 检查 Runtime 是否可用
 */
export async function isRuntimeAvailable(): Promise<boolean> {
  try {
    const adapter = getRuntimeAdapter()
    return await adapter.healthCheck()
  } catch (error) {
    console.error('[RuntimeAdapter] 可用性检查失败:', error)
    return false
  }
}
