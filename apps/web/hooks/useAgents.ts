/**
 * useAgents Hook
 *
 * 管理 Agents 数据的获取和操作
 */

import { useState, useEffect, useCallback } from 'react'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Agent {
  id: string
  orgId: string
  name: string
  description?: string
  systemPrompt: string
  config: AgentConfig
  skills: string[]
  subAgents: string[]
  version: number
  isActive: boolean
  isPublic: boolean
  createdAt: string
  updatedAt: string
}

export interface AgentConfig {
  model: string
  temperature: number
  maxTokens: number
  timeoutSeconds: number
  retryAttempts?: number
  fallbackModel?: string
}

export interface CreateAgentInput {
  name: string
  description?: string
  systemPrompt: string
  config?: Partial<AgentConfig>
  skills?: string[]
  subAgents?: string[]
  isPublic?: boolean
}

export interface UpdateAgentInput {
  name?: string
  description?: string
  systemPrompt?: string
  config?: Partial<AgentConfig>
  skills?: string[]
  subAgents?: string[]
  isActive?: boolean
  isPublic?: boolean
}

export interface ListAgentsOptions {
  page?: number
  limit?: number
  isActive?: boolean
  search?: string
  [key: string]: unknown
}

interface ApiResponse<T> {
  success: boolean
  data: T
  meta?: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useAgents(options: ListAgentsOptions = {}) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [meta, setMeta] = useState<{ total: number; page: number; limit: number; totalPages: number } | null>(null)

  const fetchAgents = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<ApiResponse<Agent[]>>('/agents', {
        params: options,
      })

      if (response.success) {
        setAgents(response.data)
        if (response.meta) {
          setMeta(response.meta)
        }
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [options.page, options.limit, options.isActive, options.search])

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  const createAgent = useCallback(async (input: CreateAgentInput): Promise<Agent> => {
    const response = await apiClient.post<ApiResponse<Agent>>('/agents', input)
    if (response.success) {
      setAgents((prev) => [...prev, response.data])
      return response.data
    }
    throw new Error('创建 Agent 失败')
  }, [])

  const updateAgent = useCallback(async (id: string, input: UpdateAgentInput): Promise<Agent> => {
    const response = await apiClient.put<ApiResponse<Agent>>(`/agents/${id}`, input)
    if (response.success) {
      setAgents((prev) => prev.map((a) => (a.id === id ? response.data : a)))
      return response.data
    }
    throw new Error('更新 Agent 失败')
  }, [])

  const deleteAgent = useCallback(async (id: string): Promise<void> => {
    await apiClient.delete(`/agents/${id}`)
    setAgents((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const toggleAgent = useCallback(async (id: string): Promise<void> => {
    const agent = agents.find((a) => a.id === id)
    if (agent) {
      await updateAgent(id, { isActive: !agent.isActive })
    }
  }, [agents, updateAgent])

  return {
    agents,
    loading,
    error,
    meta,
    refetch: fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgent,
  }
}

export function useAgent(id: string) {
  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchAgent = useCallback(async () => {
    if (!id) return

    setLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<ApiResponse<Agent>>(`/agents/${id}`)
      if (response.success) {
        setAgent(response.data)
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchAgent()
  }, [fetchAgent])

  return { agent, loading, error, refetch: fetchAgent }
}
