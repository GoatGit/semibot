/**
 * Session 状态管理 Hook
 *
 * 管理会话列表、当前会话、消息等状态
 */

import { useCallback, useState } from 'react'
import type { Session, Message, ApiResponse, PaginationMeta } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface SessionState {
  /** 会话列表 */
  sessions: Session[]
  /** 当前会话 */
  currentSession: Session | null
  /** 当前会话的消息列表 */
  messages: Message[]
  /** 分页信息 */
  pagination: PaginationMeta | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseSessionReturn {
  /** 当前状态 */
  state: SessionState
  /** 加载会话列表 */
  loadSessions: (options?: LoadSessionsOptions) => Promise<void>
  /** 加载更多会话 */
  loadMoreSessions: () => Promise<void>
  /** 创建会话 */
  createSession: (agentId: string, title?: string) => Promise<Session>
  /** 选择会话 */
  selectSession: (sessionId: string) => Promise<void>
  /** 更新会话 */
  updateSession: (sessionId: string, updates: Partial<Session>) => Promise<void>
  /** 删除会话 */
  deleteSession: (sessionId: string) => Promise<void>
  /** 加载会话消息 */
  loadMessages: (sessionId: string) => Promise<void>
  /** 添加消息 (本地) */
  addMessage: (message: Message) => void
  /** 更新消息 (本地) */
  updateMessage: (messageId: string, updates: Partial<Message>) => void
  /** 清除当前会话 */
  clearCurrentSession: () => void
}

export interface LoadSessionsOptions {
  page?: number
  limit?: number
  agentId?: string
  status?: Session['status']
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: SessionState = {
  sessions: [],
  currentSession: null,
  messages: [],
  pagination: null,
  isLoading: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useSession(): UseSessionReturn {
  const [state, setState] = useState<SessionState>(initialState)

  /**
   * 加载会话列表
   */
  const loadSessions = useCallback(async (options: LoadSessionsOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<Session[]>>('/sessions', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          sessions: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载会话列表失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载会话列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 加载更多会话
   */
  const loadMoreSessions = useCallback(async () => {
    if (!state.pagination || state.pagination.page >= state.pagination.totalPages) {
      return
    }

    setState((prev) => ({ ...prev, isLoading: true }))

    try {
      const response = await apiClient.get<ApiResponse<Session[]>>('/sessions', {
        params: {
          page: state.pagination.page + 1,
          limit: state.pagination.limit,
        },
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          sessions: [...prev.sessions, ...response.data!],
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载更多会话失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [state.pagination])

  /**
   * 创建会话
   */
  const createSession = useCallback(async (agentId: string, title?: string): Promise<Session> => {
    const response = await apiClient.post<ApiResponse<Session>>('/sessions', {
      agentId,
      title,
    })

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '创建会话失败')
    }

    const session = response.data

    setState((prev) => ({
      ...prev,
      sessions: [session, ...prev.sessions],
      currentSession: session,
      messages: [],
    }))

    return session
  }, [])

  /**
   * 选择会话
   */
  const selectSession = useCallback(async (sessionId: string) => {
    // 先从本地查找
    let session = state.sessions.find((s) => s.id === sessionId)

    if (!session) {
      // 从服务器加载
      const response = await apiClient.get<ApiResponse<Session>>(`/sessions/${sessionId}`)

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? '加载会话失败')
      }

      session = response.data
    }

    setState((prev) => ({
      ...prev,
      currentSession: session!,
      messages: [],
    }))

    // 加载消息
    await loadMessages(sessionId)
  }, [state.sessions])

  /**
   * 更新会话
   */
  const updateSession = useCallback(async (sessionId: string, updates: Partial<Session>) => {
    const response = await apiClient.put<ApiResponse<Session>>(`/sessions/${sessionId}`, updates)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '更新会话失败')
    }

    const updatedSession = response.data

    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) => (s.id === sessionId ? updatedSession : s)),
      currentSession:
        prev.currentSession?.id === sessionId ? updatedSession : prev.currentSession,
    }))
  }, [])

  /**
   * 删除会话
   */
  const deleteSession = useCallback(async (sessionId: string) => {
    await apiClient.delete(`/sessions/${sessionId}`)

    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.filter((s) => s.id !== sessionId),
      currentSession: prev.currentSession?.id === sessionId ? null : prev.currentSession,
      messages: prev.currentSession?.id === sessionId ? [] : prev.messages,
    }))
  }, [])

  /**
   * 加载会话消息
   */
  const loadMessages = useCallback(async (sessionId: string) => {
    const response = await apiClient.get<ApiResponse<Message[]>>(`/sessions/${sessionId}/messages`)

    if (!response.success) {
      throw new Error(response.error?.message ?? '加载消息失败')
    }

    setState((prev) => ({
      ...prev,
      messages: response.data ?? [],
    }))
  }, [])

  /**
   * 添加消息 (本地)
   */
  const addMessage = useCallback((message: Message) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, message],
    }))
  }, [])

  /**
   * 更新消息 (本地)
   */
  const updateMessage = useCallback((messageId: string, updates: Partial<Message>) => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((m) =>
        m.id === messageId ? { ...m, ...updates } : m
      ),
    }))
  }, [])

  /**
   * 清除当前会话
   */
  const clearCurrentSession = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentSession: null,
      messages: [],
    }))
  }, [])

  return {
    state,
    loadSessions,
    loadMoreSessions,
    createSession,
    selectSession,
    updateSession,
    deleteSession,
    loadMessages,
    addMessage,
    updateMessage,
    clearCurrentSession,
  }
}

export default useSession
