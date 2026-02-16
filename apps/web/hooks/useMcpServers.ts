/**
 * useMcpServers Hook
 *
 * 管理 MCP Servers 数据的获取和操作
 */

import { useState, useEffect, useCallback } from 'react'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface McpServer {
  id: string
  orgId: string
  name: string
  description?: string
  endpoint: string
  transport: 'stdio' | 'sse' | 'streamable_http'
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: McpAuthConfig
  tools: McpTool[]
  resources: McpResource[]
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  lastConnectedAt?: string
  isActive: boolean
  isSystem?: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface McpAuthConfig {
  apiKey?: string
  oauthClientId?: string
  oauthClientSecret?: string
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface CreateMcpServerInput {
  name: string
  description?: string
  endpoint: string
  transport: 'stdio' | 'sse' | 'streamable_http'
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: McpAuthConfig
}

export interface UpdateMcpServerInput {
  name?: string
  description?: string
  endpoint?: string
  transport?: 'stdio' | 'sse' | 'streamable_http'
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: McpAuthConfig
  isActive?: boolean
}

export interface ListMcpServersOptions {
  page?: number
  limit?: number
  search?: string
  status?: string
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

export function useMcpServers(options: ListMcpServersOptions = {}) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [meta, setMeta] = useState<{ total: number; page: number; limit: number; totalPages: number } | null>(null)

  const fetchServers = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<ApiResponse<McpServer[]>>('/mcp', {
        params: options,
      })

      if (response.success) {
        setServers(response.data)
        if (response.meta) {
          setMeta(response.meta)
        }
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [options.page, options.limit, options.search, options.status])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  const createServer = useCallback(async (input: CreateMcpServerInput): Promise<McpServer> => {
    const response = await apiClient.post<ApiResponse<McpServer>>('/mcp', input)
    if (response.success) {
      setServers((prev) => [...prev, response.data])
      return response.data
    }
    throw new Error('创建 MCP Server 失败')
  }, [])

  const updateServer = useCallback(async (id: string, input: UpdateMcpServerInput): Promise<McpServer> => {
    const response = await apiClient.put<ApiResponse<McpServer>>(`/mcp/${id}`, input)
    if (response.success) {
      setServers((prev) => prev.map((s) => (s.id === id ? response.data : s)))
      return response.data
    }
    throw new Error('更新 MCP Server 失败')
  }, [])

  const deleteServer = useCallback(async (id: string): Promise<void> => {
    await apiClient.delete(`/mcp/${id}`)
    setServers((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const testConnection = useCallback(async (id: string): Promise<{ success: boolean; tools: McpTool[]; resources: McpResource[] }> => {
    const response = await apiClient.post<ApiResponse<{ success: boolean; tools: McpTool[]; resources: McpResource[] }>>(`/mcp/${id}/test`)
    if (response.success) {
      // 更新本地状态
      setServers((prev) =>
        prev.map((s) =>
          s.id === id
            ? { ...s, status: 'connected' as const, lastConnectedAt: new Date().toISOString() }
            : s
        )
      )
      return response.data
    }
    throw new Error('连接测试失败')
  }, [])

  return {
    servers,
    loading,
    error,
    meta,
    refetch: fetchServers,
    createServer,
    updateServer,
    deleteServer,
    testConnection,
  }
}

export function useMcpServer(id: string) {
  const [server, setServer] = useState<McpServer | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!id) return

    const fetchServer = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await apiClient.get<ApiResponse<McpServer>>(`/mcp/${id}`)
        if (response.success) {
          setServer(response.data)
        }
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    fetchServer()
  }, [id])

  return { server, loading, error }
}
