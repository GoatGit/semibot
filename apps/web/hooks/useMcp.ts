/**
 * MCP Server 状态管理 Hook
 *
 * 管理 MCP Server 列表、CRUD 操作、连接测试等
 */

import { useCallback, useState } from 'react'
import type { ApiResponse, PaginationMeta, CreateMcpServerInput, UpdateMcpServerInput } from '@/types'
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
  transport: 'stdio' | 'http' | 'websocket'
  authType: 'none' | 'api_key' | 'oauth'
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  tools: Array<{
    name: string
    description?: string
    inputSchema?: Record<string, unknown>
  }>
  resources: Array<{
    uri: string
    name: string
    description?: string
    mimeType?: string
  }>
  isActive: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface McpState {
  /** MCP Server 列表 */
  servers: McpServer[]
  /** 当前 Server */
  currentServer: McpServer | null
  /** 分页信息 */
  pagination: PaginationMeta | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 是否正在测试连接 */
  isTesting: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseMcpReturn {
  /** 当前状态 */
  state: McpState
  /** 加载 Server 列表 */
  loadServers: (options?: LoadServersOptions) => Promise<void>
  /** 创建 Server */
  createServer: (input: CreateMcpServerInput) => Promise<McpServer>
  /** 获取 Server 详情 */
  getServer: (serverId: string) => Promise<McpServer>
  /** 更新 Server */
  updateServer: (serverId: string, input: UpdateMcpServerInput) => Promise<McpServer>
  /** 删除 Server */
  deleteServer: (serverId: string) => Promise<void>
  /** 测试连接 */
  testConnection: (serverId: string) => Promise<{ success: boolean; message: string }>
  /** 同步工具和资源 */
  syncToolsAndResources: (serverId: string, tools: unknown[], resources: unknown[]) => Promise<McpServer>
}

export interface LoadServersOptions {
  page?: number
  limit?: number
  search?: string
  status?: 'disconnected' | 'connecting' | 'connected' | 'error'
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: McpState = {
  servers: [],
  currentServer: null,
  pagination: null,
  isLoading: false,
  isTesting: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useMcp(): UseMcpReturn {
  const [state, setState] = useState<McpState>(initialState)

  /**
   * 加载 Server 列表
   */
  const loadServers = useCallback(async (options: LoadServersOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<McpServer[]>>('/mcp', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          servers: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载 MCP Server 列表失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载 MCP Server 列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 创建 Server
   */
  const createServer = useCallback(async (input: CreateMcpServerInput): Promise<McpServer> => {
    const response = await apiClient.post<ApiResponse<McpServer>>('/mcp', input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '创建 MCP Server 失败')
    }

    const server = response.data

    setState((prev) => ({
      ...prev,
      servers: [server, ...prev.servers],
    }))

    return server
  }, [])

  /**
   * 获取 Server 详情
   */
  const getServer = useCallback(async (serverId: string): Promise<McpServer> => {
    const response = await apiClient.get<ApiResponse<McpServer>>(`/mcp/${serverId}`)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '获取 MCP Server 失败')
    }

    setState((prev) => ({
      ...prev,
      currentServer: response.data!,
    }))

    return response.data
  }, [])

  /**
   * 更新 Server
   */
  const updateServer = useCallback(async (serverId: string, input: UpdateMcpServerInput): Promise<McpServer> => {
    const response = await apiClient.put<ApiResponse<McpServer>>(`/mcp/${serverId}`, input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '更新 MCP Server 失败')
    }

    const updatedServer = response.data

    setState((prev) => ({
      ...prev,
      servers: prev.servers.map((s) => (s.id === serverId ? updatedServer : s)),
      currentServer: prev.currentServer?.id === serverId ? updatedServer : prev.currentServer,
    }))

    return updatedServer
  }, [])

  /**
   * 删除 Server
   */
  const deleteServer = useCallback(async (serverId: string) => {
    await apiClient.delete(`/mcp/${serverId}`)

    setState((prev) => ({
      ...prev,
      servers: prev.servers.filter((s) => s.id !== serverId),
      currentServer: prev.currentServer?.id === serverId ? null : prev.currentServer,
    }))
  }, [])

  /**
   * 测试连接
   */
  const testConnection = useCallback(async (serverId: string): Promise<{ success: boolean; message: string }> => {
    setState((prev) => ({ ...prev, isTesting: true }))

    try {
      const response = await apiClient.post<ApiResponse<{ success: boolean; message: string }>>(`/mcp/${serverId}/test`)

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? '测试连接失败')
      }

      return response.data
    } finally {
      setState((prev) => ({ ...prev, isTesting: false }))
    }
  }, [])

  /**
   * 同步工具和资源
   */
  const syncToolsAndResources = useCallback(async (
    serverId: string,
    tools: unknown[],
    resources: unknown[]
  ): Promise<McpServer> => {
    const response = await apiClient.post<ApiResponse<McpServer>>(`/mcp/${serverId}/sync`, {
      tools,
      resources,
    })

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '同步失败')
    }

    const updatedServer = response.data

    setState((prev) => ({
      ...prev,
      servers: prev.servers.map((s) => (s.id === serverId ? updatedServer : s)),
      currentServer: prev.currentServer?.id === serverId ? updatedServer : prev.currentServer,
    }))

    return updatedServer
  }, [])

  return {
    state,
    loadServers,
    createServer,
    getServer,
    updateServer,
    deleteServer,
    testConnection,
    syncToolsAndResources,
  }
}

export default useMcp
