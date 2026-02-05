/**
 * Chat 交互 Hook
 *
 * 整合 SSE 连接和 Agent2UI 消息处理，提供完整的对话交互能力
 */

import { useCallback, useState } from 'react'
import { useSSE, type SSEState } from './useSSE'
import { useAgent2UI } from './useAgent2UI'
import { useSessionStore } from '@/stores/sessionStore'
import type { Agent2UIMessage, SSEDoneData, SSEErrorData } from '@/types'
import { getApiBaseUrl } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/** 获取认证 Token (从 localStorage 或其他来源) */
function getAuthToken(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return localStorage.getItem('auth_token') ?? undefined
}

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface UseChatOptions {
  /** 会话 ID (已有会话时传入) */
  sessionId?: string
  /** Agent ID (创建新会话时传入) */
  agentId?: string
  /** 消息处理回调 */
  onMessage?: (message: Agent2UIMessage) => void
  /** 完成回调 */
  onComplete?: (data: SSEDoneData) => void
  /** 错误回调 */
  onError?: (error: SSEErrorData) => void
}

export interface UseChatReturn {
  /** SSE 连接状态 */
  connectionState: SSEState
  /** Agent2UI 状态 */
  agent2uiState: ReturnType<typeof useAgent2UI>['state']
  /** 是否正在发送 */
  isSending: boolean
  /** 发送消息 */
  sendMessage: (message: string, parentMessageId?: string) => Promise<void>
  /** 停止生成 */
  stopGeneration: () => void
  /** 重试最后一条消息 */
  retry: () => void
  /** 重置状态 */
  reset: () => void
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { sessionId, agentId, onMessage, onComplete, onError } = options

  const [isSending, setIsSending] = useState(false)
  const [lastMessage, setLastMessage] = useState<string>('')
  const [lastParentMessageId, setLastParentMessageId] = useState<string | undefined>()

  // Session Store
  const {
    addMessage,
    setIsThinking,
    setThinkingContent,
    setExecutionSteps,
    addToolCall,
    updateToolCall,
  } = useSessionStore()

  // Agent2UI 状态管理
  const agent2ui = useAgent2UI()

  /**
   * 处理 Agent2UI 消息
   */
  const handleMessage = useCallback((message: Agent2UIMessage) => {
    // 更新 Agent2UI 状态
    agent2ui.handleMessage(message)

    // 更新 Session Store (用于 UI 组件)
    switch (message.type) {
      case 'thinking':
        setIsThinking(true)
        setThinkingContent((message.data as { content: string }).content)
        break

      case 'plan':
        setIsThinking(false)
        setExecutionSteps((message.data as { steps: unknown[] }).steps as never[])
        break

      case 'tool_call': {
        const toolCall = message.data as {
          toolName: string
          arguments: Record<string, unknown>
          status: 'calling' | 'success' | 'error'
          result?: unknown
          duration?: number
        }
        if (toolCall.status === 'calling') {
          addToolCall({
            id: message.id,
            toolName: toolCall.toolName,
            arguments: toolCall.arguments,
            status: toolCall.status,
          })
        } else {
          updateToolCall(message.id, {
            status: toolCall.status,
            result: toolCall.result,
            duration: toolCall.duration,
          })
        }
        break
      }

      case 'text':
      case 'markdown':
        setIsThinking(false)
        break
    }

    // 调用外部回调
    onMessage?.(message)
  }, [agent2ui, setIsThinking, setThinkingContent, setExecutionSteps, addToolCall, updateToolCall, onMessage])

  /**
   * 处理完成事件
   */
  const handleDone = useCallback((data: SSEDoneData) => {
    setIsSending(false)
    setIsThinking(false)

    // 将累积的流式文本作为助手消息添加
    if (agent2ui.state.streamingText) {
      addMessage({
        id: data.messageId,
        sessionId: data.sessionId,
        role: 'assistant',
        content: agent2ui.state.streamingText,
        createdAt: new Date().toISOString(),
      })
      agent2ui.clearStreamingText()
    }

    onComplete?.(data)
  }, [agent2ui, addMessage, setIsThinking, onComplete])

  /**
   * 处理错误事件
   */
  const handleError = useCallback((error: SSEErrorData) => {
    setIsSending(false)
    setIsThinking(false)
    console.error('[Chat] 错误:', error)
    onError?.(error)
  }, [setIsThinking, onError])

  // SSE 连接 (初始不连接，发送消息时建立)
  const sse = useSSE({
    url: '', // 动态设置
    method: 'POST',
    token: getAuthToken(),
    autoReconnect: false, // 对话模式不自动重连
    onMessage: handleMessage,
    onDone: handleDone,
    onError: handleError,
  })

  /**
   * 发送消息
   */
  const sendMessage = useCallback(async (message: string, parentMessageId?: string) => {
    if (!message.trim() || isSending) {
      return
    }

    // 保存消息用于重试
    setLastMessage(message)
    setLastParentMessageId(parentMessageId)

    // 重置状态
    agent2ui.reset()
    setIsSending(true)

    // 添加用户消息到本地
    const userMessageId = `user-${Date.now()}`
    addMessage({
      id: userMessageId,
      sessionId: sessionId ?? '',
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    })

    // 构建 SSE URL 和请求体
    const baseUrl = getApiBaseUrl()
    let url: string
    let body: unknown

    if (sessionId) {
      // 在已有会话中发送
      url = `${baseUrl}/chat/sessions/${sessionId}`
      body = { message, parentMessageId }
    } else if (agentId) {
      // 创建新会话并发送
      url = `${baseUrl}/chat/start`
      body = { agentId, message }
    } else {
      console.error('[Chat] 缺少 sessionId 或 agentId')
      setIsSending(false)
      return
    }

    // 发起 SSE 请求
    try {
      const token = getAuthToken()
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error?.message ?? `HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error('响应体为空')
      }

      // 读取 SSE 流
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        // 解析 SSE 事件
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        let currentEvent = ''
        let currentData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            currentData = line.slice(5).trim()
          } else if (line === '' && currentData) {
            try {
              const data = JSON.parse(currentData)

              switch (currentEvent) {
                case 'message':
                  handleMessage(data)
                  break
                case 'done':
                  handleDone(data)
                  break
                case 'error':
                  handleError(data)
                  break
              }
            } catch (e) {
              console.error('[Chat] 解析事件失败:', e)
            }

            currentEvent = ''
            currentData = ''
          }
        }
      }
    } catch (error) {
      const errorData: SSEErrorData = {
        code: 'CHAT_ERROR',
        message: error instanceof Error ? error.message : '发送消息失败',
      }
      handleError(errorData)
    }
  }, [sessionId, agentId, isSending, agent2ui, addMessage, handleMessage, handleDone, handleError])

  /**
   * 停止生成
   */
  const stopGeneration = useCallback(() => {
    sse.disconnect()
    setIsSending(false)
    setIsThinking(false)
  }, [sse, setIsThinking])

  /**
   * 重试最后一条消息
   */
  const retry = useCallback(() => {
    if (lastMessage) {
      sendMessage(lastMessage, lastParentMessageId)
    }
  }, [lastMessage, lastParentMessageId, sendMessage])

  /**
   * 重置状态
   */
  const reset = useCallback(() => {
    sse.disconnect()
    agent2ui.reset()
    setIsSending(false)
    setLastMessage('')
    setLastParentMessageId(undefined)
  }, [sse, agent2ui])

  return {
    connectionState: sse.state,
    agent2uiState: agent2ui.state,
    isSending,
    sendMessage,
    stopGeneration,
    retry,
    reset,
  }
}

export default useChat
