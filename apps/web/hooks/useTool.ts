/**
 * Tool 状态管理 Hook
 *
 * 管理 Tool 列表、CRUD 操作等
 */

import { useCallback, useState } from 'react'
import type { Tool, ApiResponse, PaginationMeta, CreateToolInput, UpdateToolInput } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ToolState {
  /** Tool 列表 */
  tools: Tool[]
  /** 当前 Tool */
  currentTool: Tool | null
  /** 分页信息 */
  pagination: PaginationMeta | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseToolReturn {
  /** 当前状态 */
  state: ToolState
  /** 加载 Tool 列表 */
  loadTools: (options?: LoadToolsOptions) => Promise<void>
  /** 加载更多 Tool */
  loadMoreTools: () => Promise<void>
  /** 创建 Tool */
  createTool: (input: CreateToolInput) => Promise<Tool>
  /** 获取 Tool 详情 */
  getTool: (toolId: string) => Promise<Tool>
  /** 更新 Tool */
  updateTool: (toolId: string, input: UpdateToolInput) => Promise<Tool>
  /** 删除 Tool */
  deleteTool: (toolId: string) => Promise<void>
}

export interface LoadToolsOptions {
  page?: number
  limit?: number
  search?: string
  type?: string
  includeBuiltin?: boolean
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: ToolState = {
  tools: [],
  currentTool: null,
  pagination: null,
  isLoading: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useTool(): UseToolReturn {
  const [state, setState] = useState<ToolState>(initialState)

  /**
   * 加载 Tool 列表
   */
  const loadTools = useCallback(async (options: LoadToolsOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<Tool[]>>('/tools', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          tools: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载 Tool 列表失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载 Tool 列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 加载更多 Tool
   */
  const loadMoreTools = useCallback(async () => {
    if (!state.pagination || state.pagination.page >= state.pagination.totalPages) {
      return
    }

    setState((prev) => ({ ...prev, isLoading: true }))

    try {
      const response = await apiClient.get<ApiResponse<Tool[]>>('/tools', {
        params: {
          page: state.pagination.page + 1,
          limit: state.pagination.limit,
        },
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          tools: [...prev.tools, ...response.data!],
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载更多 Tool 失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [state.pagination])

  /**
   * 创建 Tool
   */
  const createTool = useCallback(async (input: CreateToolInput): Promise<Tool> => {
    const response = await apiClient.post<ApiResponse<Tool>>('/tools', input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '创建 Tool 失败')
    }

    const tool = response.data

    setState((prev) => ({
      ...prev,
      tools: [tool, ...prev.tools],
    }))

    return tool
  }, [])

  /**
   * 获取 Tool 详情
   */
  const getTool = useCallback(async (toolId: string): Promise<Tool> => {
    const response = await apiClient.get<ApiResponse<Tool>>(`/tools/${toolId}`)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '获取 Tool 失败')
    }

    setState((prev) => ({
      ...prev,
      currentTool: response.data!,
    }))

    return response.data
  }, [])

  /**
   * 更新 Tool
   */
  const updateTool = useCallback(async (toolId: string, input: UpdateToolInput): Promise<Tool> => {
    const response = await apiClient.put<ApiResponse<Tool>>(`/tools/${toolId}`, input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '更新 Tool 失败')
    }

    const updatedTool = response.data

    setState((prev) => ({
      ...prev,
      tools: prev.tools.map((t) => (t.id === toolId ? updatedTool : t)),
      currentTool: prev.currentTool?.id === toolId ? updatedTool : prev.currentTool,
    }))

    return updatedTool
  }, [])

  /**
   * 删除 Tool
   */
  const deleteTool = useCallback(async (toolId: string) => {
    await apiClient.delete(`/tools/${toolId}`)

    setState((prev) => ({
      ...prev,
      tools: prev.tools.filter((t) => t.id !== toolId),
      currentTool: prev.currentTool?.id === toolId ? null : prev.currentTool,
    }))
  }, [])

  return {
    state,
    loadTools,
    loadMoreTools,
    createTool,
    getTool,
    updateTool,
    deleteTool,
  }
}

export default useTool
