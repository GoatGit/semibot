/**
 * Agent2UI 消息处理 Hook
 *
 * 处理 SSE 流中的 Agent2UI 消息，更新 UI 状态
 */

import { useCallback, useState } from 'react'
import type {
  Agent2UIMessage,
  Agent2UIType,
  PlanData,
  PlanStepData,
  ToolCallData,
  ThinkingData,
  TextData,
  MarkdownData,
  TableData,
  ChartData,
  ReportData,
  ErrorData,
  ProgressData,
} from '@/types'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Agent2UIState {
  /** 执行计划 */
  plan: PlanData | null
  /** 工具调用列表 */
  toolCalls: ToolCallData[]
  /** 思考内容 */
  thinking: ThinkingData | null
  /** 是否正在思考 */
  isThinking: boolean
  /** 流式文本内容 (逐步累积) */
  streamingText: string
  /** 进度信息 */
  progress: ProgressData | null
  /** 所有消息列表 */
  messages: Agent2UIMessage[]
  /** 详情内容 (用于 Detail Canvas) */
  detailContent: Agent2UIMessage | null
  /** 错误信息 */
  error: ErrorData | null
}

export interface UseAgent2UIReturn {
  /** 当前状态 */
  state: Agent2UIState
  /** 处理消息 */
  handleMessage: (message: Agent2UIMessage) => void
  /** 重置状态 */
  reset: () => void
  /** 清除流式文本 */
  clearStreamingText: () => void
  /** 设置详情内容 */
  setDetailContent: (content: Agent2UIMessage | null) => void
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: Agent2UIState = {
  plan: null,
  toolCalls: [],
  thinking: null,
  isThinking: false,
  streamingText: '',
  progress: null,
  messages: [],
  detailContent: null,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useAgent2UI(): UseAgent2UIReturn {
  const [state, setState] = useState<Agent2UIState>(initialState)

  /**
   * 处理 Agent2UI 消息
   */
  const handleMessage = useCallback((message: Agent2UIMessage) => {
    setState((prev) => {
      // 添加到消息列表
      const messages = [...prev.messages, message]

      // 根据消息类型更新状态
      switch (message.type) {
        case 'thinking': {
          const data = message.data as ThinkingData
          return {
            ...prev,
            messages,
            thinking: data,
            isThinking: true,
          }
        }

        case 'plan': {
          const data = message.data as PlanData
          return {
            ...prev,
            messages,
            plan: data,
            isThinking: false,
          }
        }

        case 'plan_step': {
          const data = message.data as PlanStepData
          // Update the matching step's status in the existing plan
          if (prev.plan) {
            const updatedSteps = prev.plan.steps.map((step) =>
              step.id === data.stepId
                ? { ...step, status: data.status === 'running' ? 'running' as const : data.status === 'completed' ? 'completed' as const : data.status === 'failed' ? 'failed' as const : step.status }
                : step
            )
            return {
              ...prev,
              messages,
              plan: {
                ...prev.plan,
                steps: updatedSteps,
                currentStep: data.status === 'running' ? data.stepId : prev.plan.currentStep,
              },
            }
          }
          return { ...prev, messages }
        }

        case 'tool_call': {
          const data = message.data as ToolCallData
          // 更新或添加工具调用
          const existingIndex = prev.toolCalls.findIndex(
            (tc) => tc.toolName === data.toolName && tc.status === 'calling'
          )

          let toolCalls: ToolCallData[]
          if (existingIndex >= 0 && data.status !== 'calling') {
            // 更新已有的工具调用状态
            toolCalls = [...prev.toolCalls]
            toolCalls[existingIndex] = data
          } else {
            // 添加新的工具调用
            toolCalls = [...prev.toolCalls, data]
          }

          return {
            ...prev,
            messages,
            toolCalls,
          }
        }

        case 'tool_result': {
          // Update the matching tool call with result
          const data = message.data as { toolName: string; result?: unknown; success: boolean; error?: string; duration?: number }
          const toolCalls = prev.toolCalls.map((tc) =>
            tc.toolName === data.toolName && tc.status === 'calling'
              ? { ...tc, status: (data.success ? 'success' : 'error') as ToolCallData['status'], result: data.result, error: data.error, duration: data.duration }
              : tc
          )
          return { ...prev, messages, toolCalls }
        }

        case 'mcp_call': {
          // Treat MCP calls like tool calls for UI display
          const data = message.data as { toolName: string; arguments: Record<string, unknown> }
          const toolCalls = [...prev.toolCalls, {
            toolName: data.toolName,
            arguments: data.arguments,
            status: 'calling' as const,
          }]
          return { ...prev, messages, toolCalls }
        }

        case 'mcp_result': {
          // Update the matching MCP call with result
          const data = message.data as { toolName: string; result?: unknown; success: boolean; error?: string; duration?: number }
          const toolCalls = prev.toolCalls.map((tc) =>
            tc.toolName === data.toolName && tc.status === 'calling'
              ? { ...tc, status: (data.success ? 'success' : 'error') as ToolCallData['status'], result: data.result, error: data.error, duration: data.duration }
              : tc
          )
          return { ...prev, messages, toolCalls }
        }

        case 'text': {
          const data = message.data as TextData
          return {
            ...prev,
            messages,
            streamingText: prev.streamingText + data.content,
            isThinking: false,
          }
        }

        case 'markdown': {
          const data = message.data as MarkdownData
          return {
            ...prev,
            messages,
            streamingText: prev.streamingText + data.content,
            isThinking: false,
          }
        }

        case 'progress': {
          const data = message.data as ProgressData
          return {
            ...prev,
            messages,
            progress: data,
          }
        }

        case 'error': {
          const data = message.data as ErrorData
          return {
            ...prev,
            messages,
            error: data,
            isThinking: false,
          }
        }

        case 'table':
        case 'chart':
        case 'report': {
          // 这些类型应该在 Detail Canvas 中展示
          return {
            ...prev,
            messages,
            detailContent: message,
          }
        }

        default:
          return {
            ...prev,
            messages,
          }
      }
    })
  }, [])

  /**
   * 重置状态
   */
  const reset = useCallback(() => {
    setState(initialState)
  }, [])

  /**
   * 清除流式文本
   */
  const clearStreamingText = useCallback(() => {
    setState((prev) => ({
      ...prev,
      streamingText: '',
    }))
  }, [])

  /**
   * 设置详情内容
   */
  const setDetailContent = useCallback((content: Agent2UIMessage | null) => {
    setState((prev) => ({
      ...prev,
      detailContent: content,
    }))
  }, [])

  return {
    state,
    handleMessage,
    reset,
    clearStreamingText,
    setDetailContent,
  }
}

export default useAgent2UI
