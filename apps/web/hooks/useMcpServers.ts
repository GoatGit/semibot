/**
 * useMcpServers Hook
 *
 * 管理 MCP Servers 数据的获取和操作
 */

import { useState, useEffect, useCallback } from 'react'
import { apiClient } from '@/lib/api'
import { cachedFetch, invalidateCache, invalidateCacheByPrefix } from '@/lib/query-cache'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface McpServer {
  id: string
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

// MCP 服务器列表缓存 2 分钟（状态字段会变，不宜太长）
const MCP_CACHE_TTL_MS = 2 * 60_000

function mcpCacheKey(options: ListMcpServersOptions): string {
  return `mcp:${JSON.stringify(options)}`
}

export function useMcpServers(options: ListMcpServersOptions = {}) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [meta, setMeta] = useState<{ total: number; page: number; limit: number; totalPages: number } | null>(null)
  const optionsKey = JSON.stringify(options)
  const stableOptions = JSON.parse(optionsKey) as ListMcpServersOptions

  const fetchServers = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)

    try {
      const cacheKey = mcpCacheKey(stableOptions)
      if (forceRefresh) invalidateCache(cacheKey)
      const response = await cachedFetch(
        cacheKey,
        () => apiClient.get<ApiResponse<McpServer[]>>('/mcp', { params: stableOptions }),
        MCP_CACHE_TTL_MS
      )

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
  }, [optionsKey])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  const createServer = useCallback(async (input: CreateMcpServerInput): Promise<McpServer> => {
    const response = await apiClient.post<ApiResponse<{ item?: McpServer }>>('/control/mcp/create', {
      payload: {
        name: input.name,
        description: input.description,
        endpoint: input.endpoint,
        transport: input.transport,
        auth_type: input.authType,
        auth_config: input.authConfig,
      },
    })
    if (response.success && response.data?.item) {
      invalidateCacheByPrefix('mcp:')
      setServers((prev) => [...prev, response.data.item!])
      return response.data.item
    }
    throw new Error('创建 MCP Server 失败')
  }, [])

  const updateServer = useCallback(async (id: string, input: UpdateMcpServerInput): Promise<McpServer> => {
    const response = await apiClient.post<ApiResponse<{ item?: McpServer }>>('/control/mcp/update', {
      payload: {
        server_id: id,
        patch: {
          name: input.name,
          description: input.description,
          endpoint: input.endpoint,
          transport: input.transport,
          auth_type: input.authType,
          auth_config: input.authConfig,
          is_active: input.isActive,
        },
      },
    })
    if (response.success && response.data?.item) {
      invalidateCacheByPrefix('mcp:')
      setServers((prev) => prev.map((s) => (s.id === id ? response.data.item! : s)))
      return response.data.item
    }
    throw new Error('更新 MCP Server 失败')
  }, [])

  const deleteServer = useCallback(async (id: string): Promise<void> => {
    await apiClient.post('/control/mcp/delete', {
      payload: { server_id: id },
    })
    invalidateCacheByPrefix('mcp:')
    setServers((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const testConnection = useCallback(async (id: string): Promise<{ success: boolean; tools: McpTool[]; resources: McpResource[] }> => {
    const response = await apiClient.post<ApiResponse<{ success: boolean; tools: McpTool[]; resources: McpResource[] }>>('/control/mcp/test', {
      payload: { server_id: id },
    })
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
    refetch: () => fetchServers(true),
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
