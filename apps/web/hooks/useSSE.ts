/**
 * SSE 连接 Hook
 *
 * 支持断线重连、指数退避、心跳检测
 * 参考 ARCHITECTURE.md 7.3 节设计
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent2UIMessage, SSEEvent, SSEDoneData, SSEErrorData } from '@/types'

// ═══════════════════════════════════════════════════════════════
// 常量配置 (与后端 config.ts 保持一致)
// ═══════════════════════════════════════════════════════════════

/** SSE 最大重试次数 */
const SSE_MAX_RETRIES = 5

/** SSE 重连基础延迟 (毫秒) */
const SSE_RECONNECT_BASE_DELAY_MS = 1000

/** SSE 重连最大延迟 (毫秒) */
const SSE_RECONNECT_MAX_DELAY_MS = 30000

/** 心跳超时阈值 (毫秒) - 超过此时间未收到心跳则认为断线 */
const HEARTBEAT_TIMEOUT_MS = 45000

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type SSEState =
  | 'idle'          // 未连接
  | 'connecting'    // 连接中
  | 'connected'     // 已连接
  | 'reconnecting'  // 重连中
  | 'disconnected'  // 已断开
  | 'failed'        // 重连失败

export interface SSEConfig {
  /** SSE 端点 URL */
  url: string
  /** 请求方法 */
  method?: 'GET' | 'POST'
  /** 请求体 (POST 时使用) */
  body?: unknown
  /** 认证 Token */
  token?: string
  /** 是否自动重连 */
  autoReconnect?: boolean
  /** 最大重试次数 */
  maxRetries?: number
  /** 消息处理回调 */
  onMessage?: (message: Agent2UIMessage) => void
  /** 完成回调 */
  onDone?: (data: SSEDoneData) => void
  /** 错误回调 */
  onError?: (error: SSEErrorData) => void
  /** 状态变更回调 */
  onStateChange?: (state: SSEState) => void
}

export interface UseSSEReturn {
  /** 当前连接状态 */
  state: SSEState
  /** 重试次数 */
  retryCount: number
  /** 最后一次错误 */
  lastError: SSEErrorData | null
  /** 启动连接 */
  connect: () => void
  /** 关闭连接 */
  disconnect: () => void
  /** 手动重连 */
  reconnect: () => void
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useSSE(config: SSEConfig): UseSSEReturn {
  const {
    url,
    method = 'GET',
    body,
    token,
    autoReconnect = true,
    maxRetries = SSE_MAX_RETRIES,
    onMessage,
    onDone,
    onError,
    onStateChange,
  } = config

  const [state, setState] = useState<SSEState>('idle')
  const [retryCount, setRetryCount] = useState(0)
  const [lastError, setLastError] = useState<SSEErrorData | null>(null)

  // Refs 用于在回调中访问最新值
  const abortControllerRef = useRef<AbortController | null>(null)
  const heartbeatTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const retryCountRef = useRef(0)

  /**
   * 更新状态并触发回调
   */
  const updateState = useCallback((newState: SSEState) => {
    setState(newState)
    onStateChange?.(newState)
  }, [onStateChange])

  /**
   * 重置心跳超时
   */
  const resetHeartbeatTimeout = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current)
    }

    heartbeatTimeoutRef.current = setTimeout(() => {
      console.warn('[SSE] 心跳超时，连接可能已断开')
      handleDisconnect(true)
    }, HEARTBEAT_TIMEOUT_MS)
  }, [])

  /**
   * 清理所有定时器
   */
  const clearTimers = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current)
      heartbeatTimeoutRef.current = null
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
  }, [])

  /**
   * 计算重连延迟 (指数退避)
   */
  const getReconnectDelay = useCallback((attempt: number): number => {
    const delay = Math.min(
      SSE_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt),
      SSE_RECONNECT_MAX_DELAY_MS
    )
    // 添加随机抖动 (±10%)
    const jitter = delay * 0.1 * (Math.random() * 2 - 1)
    return Math.round(delay + jitter)
  }, [])

  /**
   * 处理断线
   */
  const handleDisconnect = useCallback((shouldReconnect: boolean) => {
    abortControllerRef.current?.abort()
    clearTimers()

    if (shouldReconnect && autoReconnect && retryCountRef.current < maxRetries) {
      updateState('reconnecting')
      const delay = getReconnectDelay(retryCountRef.current)

      console.log(
        `[SSE] 准备重连 - 第 ${retryCountRef.current + 1}/${maxRetries} 次，延迟 ${delay}ms`
      )

      reconnectTimeoutRef.current = setTimeout(() => {
        retryCountRef.current += 1
        setRetryCount(retryCountRef.current)
        doConnect()
      }, delay)
    } else if (retryCountRef.current >= maxRetries) {
      console.error(
        `[SSE] 重连失败 - 已达最大重试次数 (${maxRetries})`
      )
      updateState('failed')
    } else {
      updateState('disconnected')
    }
  }, [autoReconnect, maxRetries, clearTimers, getReconnectDelay, updateState])

  /**
   * 执行连接
   */
  const doConnect = useCallback(async () => {
    // 取消之前的连接
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    updateState('connecting')

    try {
      const headers: HeadersInit = {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      }

      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      if (method === 'POST' && body) {
        headers['Content-Type'] = 'application/json'
      }

      const response = await fetch(url, {
        method,
        headers,
        body: method === 'POST' && body ? JSON.stringify(body) : undefined,
        signal: abortControllerRef.current.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error?.message ?? `HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error('响应体为空')
      }

      // 连接成功，重置重试计数
      retryCountRef.current = 0
      setRetryCount(0)
      updateState('connected')
      resetHeartbeatTimeout()

      // 读取 SSE 流
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          console.log('[SSE] 流已结束')
          handleDisconnect(false)
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
            // 空行表示事件结束
            resetHeartbeatTimeout()

            try {
              const data = JSON.parse(currentData)

              switch (currentEvent) {
                case 'message':
                  onMessage?.(data as Agent2UIMessage)
                  break
                case 'done':
                  onDone?.(data as SSEDoneData)
                  break
                case 'error':
                  setLastError(data as SSEErrorData)
                  onError?.(data as SSEErrorData)
                  break
                case 'heartbeat':
                  // 心跳事件，仅重置超时
                  break
                default:
                  console.warn(`[SSE] 未知事件类型: ${currentEvent}`)
              }
            } catch (e) {
              console.error('[SSE] 解析事件失败:', currentData, e)
            }

            currentEvent = ''
            currentData = ''
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.log('[SSE] 连接已取消')
        return
      }

      console.error('[SSE] 连接错误:', error)
      const errorData: SSEErrorData = {
        code: 'SSE_CONNECTION_ERROR',
        message: (error as Error).message,
      }
      setLastError(errorData)
      onError?.(errorData)
      handleDisconnect(true)
    }
  }, [url, method, body, token, updateState, resetHeartbeatTimeout, handleDisconnect, onMessage, onDone, onError])

  /**
   * 启动连接
   */
  const connect = useCallback(() => {
    retryCountRef.current = 0
    setRetryCount(0)
    setLastError(null)
    doConnect()
  }, [doConnect])

  /**
   * 关闭连接
   */
  const disconnect = useCallback(() => {
    abortControllerRef.current?.abort()
    clearTimers()
    retryCountRef.current = 0
    setRetryCount(0)
    updateState('disconnected')
  }, [clearTimers, updateState])

  /**
   * 手动重连
   */
  const reconnect = useCallback(() => {
    disconnect()
    connect()
  }, [disconnect, connect])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      clearTimers()
    }
  }, [clearTimers])

  return {
    state,
    retryCount,
    lastError,
    connect,
    disconnect,
    reconnect,
  }
}

export default useSSE
