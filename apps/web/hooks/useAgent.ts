/**
 * Agent 状态管理 Hook
 *
 * 管理 Agent 列表、当前 Agent 等状态
 */

import { useCallback, useState } from 'react'
import type { Agent, ApiResponse, PaginationMeta, CreateAgentInput, UpdateAgentInput } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface AgentState {
  /** Agent 列表 */
  agents: Agent[]
  /** 当前 Agent */
  currentAgent: Agent | null
  /** 分页信息 */
  pagination: PaginationMeta | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseAgentReturn {
  /** 当前状态 */
  state: AgentState
  /** 加载 Agent 列表 */
  loadAgents: (options?: LoadAgentsOptions) => Promise<void>
  /** 加载更多 Agent */
  loadMoreAgents: () => Promise<void>
  /** 创建 Agent */
  createAgent: (input: CreateAgentInput) => Promise<Agent>
  /** 获取 Agent 详情 */
  getAgent: (agentId: string) => Promise<Agent>
  /** 选择 Agent */
  selectAgent: (agentId: string) => Promise<void>
  /** 更新 Agent */
  updateAgent: (agentId: string, input: UpdateAgentInput) => Promise<Agent>
  /** 删除 Agent */
  deleteAgent: (agentId: string) => Promise<void>
  /** 清除当前 Agent */
  clearCurrentAgent: () => void
}

export interface LoadAgentsOptions {
  page?: number
  limit?: number
  isActive?: boolean
  search?: string
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: AgentState = {
  agents: [],
  currentAgent: null,
  pagination: null,
  isLoading: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useAgent(): UseAgentReturn {
  const [state, setState] = useState<AgentState>(initialState)

  /**
   * 加载 Agent 列表
   */
  const loadAgents = useCallback(async (options: LoadAgentsOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<Agent[]>>('/agents', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          agents: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载 Agent 列表失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载 Agent 列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 加载更多 Agent
   */
  const loadMoreAgents = useCallback(async () => {
    if (!state.pagination || state.pagination.page >= state.pagination.totalPages) {
      return
    }

    setState((prev) => ({ ...prev, isLoading: true }))

    try {
      const response = await apiClient.get<ApiResponse<Agent[]>>('/agents', {
        params: {
          page: state.pagination.page + 1,
          limit: state.pagination.limit,
        },
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          agents: [...prev.agents, ...response.data!],
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载更多 Agent 失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [state.pagination])

  /**
   * 创建 Agent
   */
  const createAgent = useCallback(async (input: CreateAgentInput): Promise<Agent> => {
    const response = await apiClient.post<ApiResponse<Agent>>('/agents', input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '创建 Agent 失败')
    }

    const agent = response.data

    setState((prev) => ({
      ...prev,
      agents: [agent, ...prev.agents],
      currentAgent: agent,
    }))

    return agent
  }, [])

  /**
   * 获取 Agent 详情
   */
  const getAgent = useCallback(async (agentId: string): Promise<Agent> => {
    const response = await apiClient.get<ApiResponse<Agent>>(`/agents/${agentId}`)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '获取 Agent 失败')
    }

    return response.data
  }, [])

  /**
   * 选择 Agent
   */
  const selectAgent = useCallback(async (agentId: string) => {
    // 先从本地查找
    let agent = state.agents.find((a) => a.id === agentId)

    if (!agent) {
      // 从服务器加载
      agent = await getAgent(agentId)
    }

    setState((prev) => ({
      ...prev,
      currentAgent: agent!,
    }))
  }, [state.agents, getAgent])

  /**
   * 更新 Agent
   */
  const updateAgent = useCallback(async (agentId: string, input: UpdateAgentInput): Promise<Agent> => {
    const response = await apiClient.put<ApiResponse<Agent>>(`/agents/${agentId}`, input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '更新 Agent 失败')
    }

    const updatedAgent = response.data

    setState((prev) => ({
      ...prev,
      agents: prev.agents.map((a) => (a.id === agentId ? updatedAgent : a)),
      currentAgent: prev.currentAgent?.id === agentId ? updatedAgent : prev.currentAgent,
    }))

    return updatedAgent
  }, [])

  /**
   * 删除 Agent
   */
  const deleteAgent = useCallback(async (agentId: string) => {
    await apiClient.delete(`/agents/${agentId}`)

    setState((prev) => ({
      ...prev,
      agents: prev.agents.filter((a) => a.id !== agentId),
      currentAgent: prev.currentAgent?.id === agentId ? null : prev.currentAgent,
    }))
  }, [])

  /**
   * 清除当前 Agent
   */
  const clearCurrentAgent = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentAgent: null,
    }))
  }, [])

  return {
    state,
    loadAgents,
    loadMoreAgents,
    createAgent,
    getAgent,
    selectAgent,
    updateAgent,
    deleteAgent,
    clearCurrentAgent,
  }
}

export default useAgent
