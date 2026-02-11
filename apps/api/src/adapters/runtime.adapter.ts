/**
 * Runtime Adapter - 适配 API 与 Python Runtime Orchestrator
 *
 * 职责：
 * 1. 将 API 的 chat 请求转换为 runtime state 输入
 * 2. 将 runtime 事件输出映射为 Agent2UI SSE 事件
 * 3. 处理超时与错误回退
 */

import axios, { AxiosInstance } from 'axios'
import { z } from 'zod'
import {
  RUNTIME_SERVICE_URL,
  RUNTIME_EXECUTION_TIMEOUT_MS,
  RUNTIME_HEALTH_CHECK_TIMEOUT_MS,
  RUNTIME_STALL_TIMEOUT_MS,
  RUNTIME_MAX_CONSECUTIVE_PARSE_FAILURES,
} from '../constants/config'
import { SSE_STREAM_ERROR } from '../constants/errorCodes'
import type { SSEConnection } from '../services/chat.service'
import { sendSSEEvent, sendAgent2UIMessage } from '../services/chat.service'
import { createLogger } from '../lib/logger'

const runtimeLogger = createLogger('runtime-adapter')

// ═══════════════════════════════════════════════════════════════
// Zod Schemas
// ═══════════════════════════════════════════════════════════════

const runtimeInputStateSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  org_id: z.string().min(1),
  user_message: z.string().min(1),
  history_messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })).optional(),
  agent_config: z.object({
    system_prompt: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
  }).optional(),
  available_mcp_servers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    endpoint: z.string(),
    transport: z.string(),
    is_connected: z.boolean(),
    auth_config: z.record(z.unknown()).nullable().optional(),
    available_tools: z.array(z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.unknown()),
    })),
  })).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const runtimeEventSchema = z.object({
  event: z.enum([
    'plan_created', 'plan_step_start', 'plan_step_complete', 'plan_step_failed',
    'tool_call_start', 'tool_call_complete', 'skill_call_start', 'skill_call_complete',
    'mcp_call_start', 'mcp_call_complete', 'thinking', 'text_chunk',
    'execution_complete', 'execution_error', 'ping',
  ]),
  data: z.record(z.unknown()),
  timestamp: z.string(),
})

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
  available_mcp_servers?: Array<{
    id: string
    name: string
    endpoint: string
    transport: string
    is_connected: boolean
    auth_config?: Record<string, unknown> | null
    available_tools: Array<{
      name: string
      description: string
      parameters: Record<string, unknown>
    }>
  }>
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
  | 'ping'

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
    // 输入验证
    const parseResult = runtimeInputStateSchema.safeParse(input)
    if (!parseResult.success) {
      runtimeLogger.error('RuntimeInputState 验证失败', undefined, { errors: parseResult.error.issues })
      if (onComplete) {
        onComplete({ success: false, error: `输入验证失败: ${parseResult.error.message}` })
      }
      return
    }

    const startTime = Date.now()
    let fullResponse = ''
    const totalTokens = 0
    let hasError = false
    let errorMessage = ''

    try {
      runtimeLogger.info('开始执行', { sessionId: input.session_id, agentId: input.agent_id })

      // 调用 Runtime API (SSE 流式)
      const response = await this.client.post('/api/v1/execute/stream', input, {
        responseType: 'stream',
        timeout: this.timeoutMs,
      })

      // 处理 SSE 流
      const stream = response.data
      let buffer = '' // 缓冲区用于处理跨 chunk 的数据
      let consecutiveParseFailures = 0

      // Stall 检测
      let stallTimer: NodeJS.Timeout | null = null

      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer)
          stallTimer = null
        }
      }

      const resetStallTimer = () => {
        clearStallTimer()
        stallTimer = setTimeout(() => {
          runtimeLogger.error('SSE 流 stall 超时', {
            sessionId: input.session_id,
            timeoutMs: RUNTIME_STALL_TIMEOUT_MS,
          })
          stream.destroy(new Error('Stream stall timeout'))
        }, RUNTIME_STALL_TIMEOUT_MS)
      }

      resetStallTimer()

      // 等待流完成后再返回，防止函数提前 resolve 导致 Express 关闭响应
      await new Promise<void>((resolve, _reject) => {
        stream.on('data', (chunk: Buffer) => {
          resetStallTimer()
          buffer += chunk.toString()
          const lines = buffer.split('\n')

          // 保留最后一个不完整的行
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue

            try {
              const data = line.slice(6).trim() // 移除 "data: " 前缀和尾部空白
              if (data === '[DONE]') continue

              const parsed = JSON.parse(data)
              const validated = runtimeEventSchema.safeParse(parsed)
              if (!validated.success) {
                consecutiveParseFailures++
                runtimeLogger.warn('SSE 事件验证失败', {
                  errors: validated.error.issues,
                  rawData: data,
                })
                if (consecutiveParseFailures >= RUNTIME_MAX_CONSECUTIVE_PARSE_FAILURES) {
                  runtimeLogger.error('连续解析失败次数过多，中断流', {
                    count: consecutiveParseFailures,
                  })
                  stream.destroy(new Error('Too many consecutive parse failures'))
                }
                continue
              }
              consecutiveParseFailures = 0
              this.handleRuntimeEvent(validated.data as RuntimeEvent, connection, (text) => {
                fullResponse += text
              })
            } catch (err) {
              consecutiveParseFailures++
              runtimeLogger.error('解析事件失败', err as Error, { rawData: line })
              if (consecutiveParseFailures >= RUNTIME_MAX_CONSECUTIVE_PARSE_FAILURES) {
                runtimeLogger.error('连续解析失败次数过多，中断流', {
                  count: consecutiveParseFailures,
                })
                stream.destroy(new Error('Too many consecutive parse failures'))
                break
              }
            }
          }
        })

        stream.on('end', async () => {
          clearStallTimer()

          // 处理缓冲区中剩余的数据
          if (buffer.trim() && buffer.startsWith('data: ')) {
            try {
              const data = buffer.slice(6)
              if (data !== '[DONE]') {
                const event: RuntimeEvent = JSON.parse(data)
                this.handleRuntimeEvent(event, connection, (text) => {
                  fullResponse += text
                })
              }
            } catch (err) {
              runtimeLogger.error('解析最后一行失败', err as Error, { rawData: buffer })
            }
          }

          const latencyMs = Date.now() - startTime
          runtimeLogger.info('执行完成', { sessionId: input.session_id, latencyMs })

          if (onComplete) {
            await onComplete({
              success: !hasError,
              final_response: fullResponse,
              error: hasError ? errorMessage : undefined,
              usage: {
                total_tokens: totalTokens,
                latency_ms: latencyMs,
              },
            })
          }
          resolve()
        })

        stream.on('error', (err: Error) => {
          clearStallTimer()
          hasError = true
          errorMessage = err.message
          runtimeLogger.error('流错误', err)

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
          resolve() // resolve 而非 reject，因为错误已通过 SSE 发送给客户端
        })
      })
    } catch (error) {
      const latencyMs = Date.now() - startTime
      runtimeLogger.error('执行失败', error as Error, { latencyMs })

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

      case 'ping':
        // Keepalive event, no action needed
        break

      default:
        runtimeLogger.warn('未知事件类型', { eventType: event.event })
    }
  }

  private handlePlanCreated(event: RuntimeEvent, connection: SSEConnection): void {
    const { steps } = event.data

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
      const response = await this.client.get('/health', { timeout: RUNTIME_HEALTH_CHECK_TIMEOUT_MS })
      return response.status === 200
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        runtimeLogger.warn('健康检查超时', { timeoutMs: RUNTIME_HEALTH_CHECK_TIMEOUT_MS })
      } else {
        runtimeLogger.error('健康检查失败', error as Error)
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
    runtimeLogger.error('可用性检查失败', error as Error)
    return false
  }
}
