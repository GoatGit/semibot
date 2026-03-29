/**
 * Chat 交互 Hook
 *
 * 整合 SSE 连接和 Agent2UI 消息处理，提供完整的对话交互能力
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgent2UI } from './useAgent2UI'
import { useSessionStore } from '@/stores/sessionStore'
import type { Agent2UIMessage, SSEDoneData, SSEErrorData } from '@/types'
import { AUTH_DISABLED } from '@/lib/auth-mode'
import { getDirectApiBaseUrlForBrowser } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

/**
 * SSE 请求直连后端地址，绕过 Next.js rewrite proxy 的响应缓冲。
 * Next.js dev server 的 rewrite proxy 会缓冲整个响应体，导致 SSE 事件
 * 无法实时推送到浏览器，表现为"文本一次性蹦出来"。
 */
function getSseBaseUrl(): string {
  return getDirectApiBaseUrlForBrowser()
}

/** 获取认证 Token */
function getAuthToken(): string | undefined {
  if (AUTH_DISABLED) return undefined
  if (typeof window === 'undefined') return undefined
  return localStorage.getItem('auth_token') ?? undefined
}

function getLastEventIdStorageKey(sessionId?: string): string | null {
  return sessionId ? `semibot:last-event-id:${sessionId}` : null
}

function isTransientStreamLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name = String(error.name || '')
  const message = String(error.message || '')
  if (name === 'AbortError') return false
  return (
    message.includes('Load failed') ||
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('fetch failed')
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type StreamTerminalState = 'none' | 'awaiting_approval' | 'completed' | 'failed'

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
  /** Agent2UI 状态 */
  agent2uiState: ReturnType<typeof useAgent2UI>['state']
  /** 是否正在发送 */
  isSending: boolean
  /** 发送消息 */
  sendMessage: (message: string, parentMessageId?: string, files?: File[]) => Promise<void>
  /** 重新订阅当前会话正在进行中的流 */
  resumeSession: () => Promise<void>
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

  // 用于中止正在进行的 SSE 请求
  const abortRef = useRef<AbortController | null>(null)
  // 请求轮次 ID，用于隔离不同轮次的 SSE 消息
  const requestIdRef = useRef<number>(0)
  const isUnmountingRef = useRef(false)

  // 组件卸载时中止进行中的 SSE 请求，防止会话间数据泄漏
  useEffect(() => {
    isUnmountingRef.current = false
    return () => {
      isUnmountingRef.current = true
      requestIdRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

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
  const latestAgent2UIStateRef = useRef(agent2ui.state)
  const latestOnMessageRef = useRef(onMessage)
  const latestOnCompleteRef = useRef(onComplete)
  const latestOnErrorRef = useRef(onError)
  const lastEventIdStorageKey = getLastEventIdStorageKey(sessionId)

  useEffect(() => {
    latestAgent2UIStateRef.current = agent2ui.state
  }, [agent2ui.state])

  useEffect(() => {
    latestOnMessageRef.current = onMessage
  }, [onMessage])

  useEffect(() => {
    latestOnCompleteRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    latestOnErrorRef.current = onError
  }, [onError])

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
    latestOnMessageRef.current?.(message)
  }, [agent2ui, setIsThinking, setThinkingContent, setExecutionSteps, addToolCall, updateToolCall])

  /**
   * 处理完成事件
   */
  const handleDone = useCallback((data: SSEDoneData) => {
    setIsSending(false)
    setIsThinking(false)
    abortRef.current = null

    // 将累积的流式文本作为助手消息添加
    const latestState = latestAgent2UIStateRef.current

    if (latestState.streamingText) {
      addMessage({
        id: data.messageId || `assistant-${Date.now()}`,
        sessionId: data.sessionId,
        role: 'assistant',
        content: latestState.streamingText,
        createdAt: new Date().toISOString(),
      })
      agent2ui.clearStreamingText()
    }

    latestOnCompleteRef.current?.(data)
  }, [agent2ui, addMessage, setIsThinking])

  /**
   * 处理错误事件
   */
  const handleError = useCallback((error: SSEErrorData) => {
    setIsSending(false)
    setIsThinking(false)
    abortRef.current = null
    console.error('[Chat] 错误:', error)
    latestOnErrorRef.current?.(error)
  }, [setIsThinking])

  const persistLastEventId = useCallback((eventId: string | null) => {
    if (typeof window === 'undefined' || !lastEventIdStorageKey) return
    try {
      if (eventId && eventId.trim()) {
        window.sessionStorage.setItem(lastEventIdStorageKey, eventId.trim())
      } else {
        window.sessionStorage.removeItem(lastEventIdStorageKey)
      }
    } catch {
      // ignore storage failures
    }
  }, [lastEventIdStorageKey])

  const readLastEventId = useCallback((): string | null => {
    if (typeof window === 'undefined' || !lastEventIdStorageKey) return null
    try {
      return window.sessionStorage.getItem(lastEventIdStorageKey)
    } catch {
      return null
    }
  }, [lastEventIdStorageKey])

  const openSSEStream = useCallback(async (
    url: string,
    fetchOptions: RequestInit,
    options?: { preserveStreamingState?: boolean }
  ): Promise<{ terminalState: StreamTerminalState }> => {
    const preserveStreamingState = options?.preserveStreamingState === true
    const currentRequestId = requestIdRef.current
    const headers = new Headers(fetchOptions.headers || {})
    const lastEventId = readLastEventId()
    if (lastEventId) {
      headers.set('Last-Event-ID', lastEventId)
    }
    fetchOptions.headers = headers

    let terminalState: StreamTerminalState = 'none'
    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error?.message ?? `HTTP ${response.status}`)
    }

    if (!response.body) {
      throw new Error('响应体为空')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    let currentEvent = ''
    let currentId = ''
    let dataLines: string[] = []

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('id:')) {
          currentId = line.slice(3).trim()
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        } else if (line === '') {
          if (dataLines.length > 0) {
            const rawData = dataLines.join('\n')
            dataLines = []

            try {
              const data = JSON.parse(rawData)
              if (currentId) {
                persistLastEventId(currentId)
              }

              if (currentRequestId !== requestIdRef.current) {
                break
              }

              switch (currentEvent) {
                case 'message':
                  handleMessage(data)
                  break
                case 'done':
                case 'execution_complete':
                  terminalState = String(data?.status || '').trim().toLowerCase() === 'awaiting_approval'
                    ? 'awaiting_approval'
                    : 'completed'
                  persistLastEventId(null)
                  handleDone(data)
                  break
                case 'error':
                case 'execution_error':
                  terminalState = 'failed'
                  handleError(data)
                  break
                default:
                  break
              }
            } catch (e) {
              console.error('[Chat] 解析事件失败:', e, rawData)
            }
          }
          currentEvent = ''
          currentId = ''
        }
      }
    }

    if (terminalState === 'none' && currentRequestId === requestIdRef.current) {
      if (isUnmountingRef.current) {
        return { terminalState }
      }
      if (!preserveStreamingState) {
        handleError({
          code: 'SSE_STREAM_ERROR',
          message: 'SSE stream ended before completion',
        })
      }
    }

    return { terminalState }
  }, [handleDone, handleError, handleMessage, persistLastEventId, readLastEventId])

  /**
   * 发送消息
   */
  const sendMessage = useCallback(async (message: string, parentMessageId?: string, files?: File[]) => {
    if (!message.trim() || isSending) {
      return
    }

    // 先中止上一轮请求，防止旧流数据继续进入
    abortRef.current?.abort()
    abortRef.current = null

    // 递增请求轮次 ID，后续 SSE 回调用此值过滤过期消息
    requestIdRef.current += 1
    const currentRequestId = requestIdRef.current

    // 保存消息用于重试
    setLastMessage(message)
    setLastParentMessageId(parentMessageId)

    // 重置状态
    agent2ui.reset()
    setIsSending(true)

    // 添加用户消息到本地（含附件元信息）
    const userMessageId = `user-${Date.now()}`
    addMessage({
      id: userMessageId,
      sessionId: sessionId ?? '',
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
      metadata: files?.length ? {
        attachments: files.map((f) => ({
          filename: f.name,
          size: f.size,
          mimeType: f.type,
          isImage: f.type.startsWith('image/'),
        })),
      } : undefined,
    })

    // 构建 SSE URL 和请求体（直连后端，绕过 Next.js proxy）
    let url: string
    let fetchOptions: RequestInit

    const hasFiles = files && files.length > 0

    if (hasFiles) {
      // Multipart 模式
      const formData = new FormData()
      formData.append('message', message)
      if (parentMessageId) formData.append('parentMessageId', parentMessageId)

      if (sessionId) {
        url = `${getSseBaseUrl()}/chat/sessions/${sessionId}`
      } else if (agentId) {
        url = `${getSseBaseUrl()}/chat/start`
        formData.append('agentId', agentId)
      } else {
        setIsSending(false)
        return
      }

      files.forEach((f) => formData.append('files', f))

      const token = getAuthToken()
      fetchOptions = {
        method: 'POST',
        headers: {
          'Accept': 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: formData,
      }
    } else {
      // JSON 模式
      let body: unknown
      if (sessionId) {
        url = `${getSseBaseUrl()}/chat/sessions/${sessionId}`
        body = { message, parentMessageId }
      } else if (agentId) {
        url = `${getSseBaseUrl()}/chat/start`
        body = { agentId, message }
      } else {
        setIsSending(false)
        return
      }

      const token = getAuthToken()
      fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }
    }

    // 创建 AbortController 用于中止请求
    const controller = new AbortController()
    abortRef.current = controller
    fetchOptions.signal = controller.signal

    try {
      await openSSEStream(url, fetchOptions)
    } catch (error) {
      // AbortError 是用户主动中止，不需要报错
      if ((error as Error).name === 'AbortError') {
        return
      }
      if (isUnmountingRef.current || currentRequestId !== requestIdRef.current) {
        return
      }

      const errorData: SSEErrorData = {
        code: 'CHAT_ERROR',
        message: error instanceof Error ? error.message : '发送消息失败',
      }
      handleError(errorData)
    }
  }, [sessionId, agentId, isSending, agent2ui, addMessage, handleError, openSSEStream])

  const resumeSession = useCallback(async () => {
    if (!sessionId || isSending) return

    abortRef.current?.abort()
    abortRef.current = null

    requestIdRef.current += 1
    const currentRequestId = requestIdRef.current
    setIsSending(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const token = getAuthToken()

      // 自动重连循环：SSE 流断开后静默重试，直到收到终端事件或组件卸载
      const MAX_RECONNECTS = 30
      for (let reconnect = 0; reconnect < MAX_RECONNECTS; reconnect += 1) {
        if (controller.signal.aborted) break
        if (isUnmountingRef.current || currentRequestId !== requestIdRef.current) return

        try {
          const streamResult = await openSSEStream(
            `${getSseBaseUrl()}/chat/sessions/${sessionId}/stream`,
            {
              method: 'GET',
              headers: {
                Accept: 'text/event-stream',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              signal: controller.signal,
            },
            { preserveStreamingState: true }
          )
          if (
            streamResult.terminalState === 'completed' ||
            streamResult.terminalState === 'failed' ||
            streamResult.terminalState === 'awaiting_approval'
          ) {
            break
          }
          // 流正常结束（无终端事件），可能是服务端断开——等待后重连
        } catch (error) {
          if ((error as Error).name === 'AbortError') throw error
          if (isUnmountingRef.current || currentRequestId !== requestIdRef.current) return
          if (!isTransientStreamLoadError(error)) {
            throw error
          }
          // 瞬态网络错误（Load failed / Failed to fetch），等待后重连
        }

        // 指数退避：500ms, 1s, 2s, 3s, ... 最大 5s
        const delay = Math.min(500 * (reconnect + 1), 5000)
        await sleep(delay)
      }

      // 超过最大重连次数，静默停止
      if (currentRequestId === requestIdRef.current && !isUnmountingRef.current) {
        setIsSending(false)
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      if (isUnmountingRef.current || currentRequestId !== requestIdRef.current) return
      handleError({
        code: 'CHAT_RESUME_ERROR',
        message: error instanceof Error ? error.message : '恢复会话失败',
      })
    }
  }, [handleError, isSending, openSSEStream, sessionId])

  /**
   * 停止生成
   */
  const stopGeneration = useCallback(() => {
    requestIdRef.current += 1  // 使进行中的 SSE 回调失效
    abortRef.current?.abort()
    abortRef.current = null
    setIsSending(false)
    setIsThinking(false)
  }, [setIsThinking])

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
    requestIdRef.current += 1  // 使进行中的 SSE 回调失效
    abortRef.current?.abort()
    abortRef.current = null
    agent2ui.reset()
    setIsSending(false)
    setLastMessage('')
    setLastParentMessageId(undefined)
  }, [agent2ui])

  return {
    agent2uiState: agent2ui.state,
    isSending,
    sendMessage,
    resumeSession,
    stopGeneration,
    retry,
    reset,
  }
}

export default useChat
