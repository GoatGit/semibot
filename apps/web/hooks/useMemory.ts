/**
 * Memory 状态管理 Hook
 *
 * 管理 Memory 列表、CRUD 操作、向量搜索等
 */

import { useCallback, useState } from 'react'
import type { Memory, ApiResponse, PaginationMeta, CreateMemoryInput, SearchMemoriesInput } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface MemoryState {
  /** Memory 列表 */
  memories: Memory[]
  /** 搜索结果 */
  searchResults: Array<Memory & { similarity: number }>
  /** 分页信息 */
  pagination: PaginationMeta | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 是否正在搜索 */
  isSearching: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseMemoryReturn {
  /** 当前状态 */
  state: MemoryState
  /** 加载 Memory 列表 */
  loadMemories: (options?: LoadMemoriesOptions) => Promise<void>
  /** 创建 Memory */
  createMemory: (input: CreateMemoryInput) => Promise<Memory>
  /** 获取 Memory 详情 */
  getMemory: (memoryId: string) => Promise<Memory>
  /** 删除 Memory */
  deleteMemory: (memoryId: string) => Promise<void>
  /** 向量搜索 */
  searchSimilar: (input: SearchMemoriesInput) => Promise<Array<Memory & { similarity: number }>>
  /** 清理过期记忆 */
  cleanup: () => Promise<{ deletedCount: number }>
  /** 清除搜索结果 */
  clearSearchResults: () => void
}

export interface LoadMemoriesOptions {
  page?: number
  limit?: number
  agentId?: string
  sessionId?: string
  userId?: string
  memoryType?: 'episodic' | 'semantic' | 'procedural'
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: MemoryState = {
  memories: [],
  searchResults: [],
  pagination: null,
  isLoading: false,
  isSearching: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useMemory(): UseMemoryReturn {
  const [state, setState] = useState<MemoryState>(initialState)

  /**
   * 加载 Memory 列表
   */
  const loadMemories = useCallback(async (options: LoadMemoriesOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<Memory[]>>('/memory', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          memories: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载 Memory 列表失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载 Memory 列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 创建 Memory
   */
  const createMemory = useCallback(async (input: CreateMemoryInput): Promise<Memory> => {
    const response = await apiClient.post<ApiResponse<Memory>>('/memory', input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '创建 Memory 失败')
    }

    const memory = response.data

    setState((prev) => ({
      ...prev,
      memories: [memory, ...prev.memories],
    }))

    return memory
  }, [])

  /**
   * 获取 Memory 详情
   */
  const getMemory = useCallback(async (memoryId: string): Promise<Memory> => {
    const response = await apiClient.get<ApiResponse<Memory>>(`/memory/${memoryId}`)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '获取 Memory 失败')
    }

    return response.data
  }, [])

  /**
   * 删除 Memory
   */
  const deleteMemory = useCallback(async (memoryId: string) => {
    await apiClient.delete(`/memory/${memoryId}`)

    setState((prev) => ({
      ...prev,
      memories: prev.memories.filter((m) => m.id !== memoryId),
      searchResults: prev.searchResults.filter((m) => m.id !== memoryId),
    }))
  }, [])

  /**
   * 向量搜索
   */
  const searchSimilar = useCallback(async (
    input: SearchMemoriesInput
  ): Promise<Array<Memory & { similarity: number }>> => {
    setState((prev) => ({ ...prev, isSearching: true, error: null }))

    try {
      const response = await apiClient.post<ApiResponse<Array<Memory & { similarity: number }>>>('/memory/search', input)

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? '搜索失败')
      }

      setState((prev) => ({
        ...prev,
        searchResults: response.data!,
        isSearching: false,
      }))

      return response.data
    } catch (error) {
      const message = error instanceof Error ? error.message : '搜索失败'
      setState((prev) => ({
        ...prev,
        isSearching: false,
        error: message,
      }))
      throw error
    }
  }, [])

  /**
   * 清理过期记忆
   */
  const cleanup = useCallback(async (): Promise<{ deletedCount: number }> => {
    const response = await apiClient.post<ApiResponse<{ deletedCount: number }>>('/memory/cleanup')

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '清理失败')
    }

    // 重新加载列表
    await loadMemories()

    return response.data
  }, [loadMemories])

  /**
   * 清除搜索结果
   */
  const clearSearchResults = useCallback(() => {
    setState((prev) => ({
      ...prev,
      searchResults: [],
    }))
  }, [])

  return {
    state,
    loadMemories,
    createMemory,
    getMemory,
    deleteMemory,
    searchSimilar,
    cleanup,
    clearSearchResults,
  }
}

export default useMemory
