/**
 * Skill 状态管理 Hook
 *
 * 管理 Skill 列表、CRUD 操作等
 */

import { useCallback, useState } from 'react'
import type { Skill, ApiResponse, PaginationMeta, CreateSkillInput, UpdateSkillInput } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface SkillState {
  /** Skill 列表 */
  skills: Skill[]
  /** 当前 Skill */
  currentSkill: Skill | null
  /** 分页信息 */
  pagination: PaginationMeta | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseSkillReturn {
  /** 当前状态 */
  state: SkillState
  /** 加载 Skill 列表 */
  loadSkills: (options?: LoadSkillsOptions) => Promise<void>
  /** 加载更多 Skill */
  loadMoreSkills: () => Promise<void>
  /** 创建 Skill */
  createSkill: (input: CreateSkillInput) => Promise<Skill>
  /** 获取 Skill 详情 */
  getSkill: (skillId: string) => Promise<Skill>
  /** 更新 Skill */
  updateSkill: (skillId: string, input: UpdateSkillInput) => Promise<Skill>
  /** 删除 Skill */
  deleteSkill: (skillId: string) => Promise<void>
}

export interface LoadSkillsOptions {
  page?: number
  limit?: number
  search?: string
  includeBuiltin?: boolean
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: SkillState = {
  skills: [],
  currentSkill: null,
  pagination: null,
  isLoading: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useSkill(): UseSkillReturn {
  const [state, setState] = useState<SkillState>(initialState)

  /**
   * 加载 Skill 列表
   */
  const loadSkills = useCallback(async (options: LoadSkillsOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<Skill[]>>('/skills', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          skills: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载 Skill 列表失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载 Skill 列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 加载更多 Skill
   */
  const loadMoreSkills = useCallback(async () => {
    if (!state.pagination || state.pagination.page >= state.pagination.totalPages) {
      return
    }

    setState((prev) => ({ ...prev, isLoading: true }))

    try {
      const response = await apiClient.get<ApiResponse<Skill[]>>('/skills', {
        params: {
          page: state.pagination.page + 1,
          limit: state.pagination.limit,
        },
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          skills: [...prev.skills, ...response.data!],
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载更多 Skill 失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [state.pagination])

  /**
   * 创建 Skill
   */
  const createSkill = useCallback(async (input: CreateSkillInput): Promise<Skill> => {
    const response = await apiClient.post<ApiResponse<Skill>>('/skills', input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '创建 Skill 失败')
    }

    const skill = response.data

    setState((prev) => ({
      ...prev,
      skills: [skill, ...prev.skills],
    }))

    return skill
  }, [])

  /**
   * 获取 Skill 详情
   */
  const getSkill = useCallback(async (skillId: string): Promise<Skill> => {
    const response = await apiClient.get<ApiResponse<Skill>>(`/skills/${skillId}`)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '获取 Skill 失败')
    }

    setState((prev) => ({
      ...prev,
      currentSkill: response.data!,
    }))

    return response.data
  }, [])

  /**
   * 更新 Skill
   */
  const updateSkill = useCallback(async (skillId: string, input: UpdateSkillInput): Promise<Skill> => {
    const response = await apiClient.put<ApiResponse<Skill>>(`/skills/${skillId}`, input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '更新 Skill 失败')
    }

    const updatedSkill = response.data

    setState((prev) => ({
      ...prev,
      skills: prev.skills.map((s) => (s.id === skillId ? updatedSkill : s)),
      currentSkill: prev.currentSkill?.id === skillId ? updatedSkill : prev.currentSkill,
    }))

    return updatedSkill
  }, [])

  /**
   * 删除 Skill
   */
  const deleteSkill = useCallback(async (skillId: string) => {
    await apiClient.delete(`/skills/${skillId}`)

    setState((prev) => ({
      ...prev,
      skills: prev.skills.filter((s) => s.id !== skillId),
      currentSkill: prev.currentSkill?.id === skillId ? null : prev.currentSkill,
    }))
  }, [])

  return {
    state,
    loadSkills,
    loadMoreSkills,
    createSkill,
    getSkill,
    updateSkill,
    deleteSkill,
  }
}

export default useSkill
