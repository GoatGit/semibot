/**
 * useSkills Hook
 *
 * 管理 Skills 数据的获取和操作
 */

import { useState, useEffect, useCallback } from 'react'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Skill {
  id: string
  orgId: string | null
  name: string
  description?: string
  triggerKeywords: string[]
  tools: SkillTool[]
  config: SkillConfig
  isBuiltin: boolean
  isActive: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface SkillTool {
  name: string
  type: 'function' | 'mcp'
  config?: Record<string, unknown>
}

export interface SkillConfig {
  maxExecutionTime?: number
  retryAttempts?: number
  requiresApproval?: boolean
}

export interface CreateSkillInput {
  name: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillTool[]
  config?: SkillConfig
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillTool[]
  config?: SkillConfig
  isActive?: boolean
}

export interface ListSkillsOptions {
  page?: number
  limit?: number
  search?: string
  includeBuiltin?: boolean
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

export function useSkills(options: ListSkillsOptions = {}) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [meta, setMeta] = useState<{ total: number; page: number; limit: number; totalPages: number } | null>(null)

  const fetchSkills = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<ApiResponse<Skill[]>>('/skills', {
        params: options,
      })

      if (response.success) {
        setSkills(response.data)
        if (response.meta) {
          setMeta(response.meta)
        }
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [options.page, options.limit, options.search, options.includeBuiltin])

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  const createSkill = useCallback(async (input: CreateSkillInput): Promise<Skill> => {
    const response = await apiClient.post<ApiResponse<Skill>>('/skills', input)
    if (response.success) {
      setSkills((prev) => [...prev, response.data])
      return response.data
    }
    throw new Error('创建技能失败')
  }, [])

  const updateSkill = useCallback(async (id: string, input: UpdateSkillInput): Promise<Skill> => {
    const response = await apiClient.put<ApiResponse<Skill>>(`/skills/${id}`, input)
    if (response.success) {
      setSkills((prev) => prev.map((s) => (s.id === id ? response.data : s)))
      return response.data
    }
    throw new Error('更新技能失败')
  }, [])

  const deleteSkill = useCallback(async (id: string): Promise<void> => {
    await apiClient.delete(`/skills/${id}`)
    setSkills((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const toggleSkill = useCallback(async (id: string): Promise<void> => {
    const skill = skills.find((s) => s.id === id)
    if (skill) {
      await updateSkill(id, { isActive: !skill.isActive })
    }
  }, [skills, updateSkill])

  return {
    skills,
    loading,
    error,
    meta,
    refetch: fetchSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    toggleSkill,
  }
}

export function useSkill(id: string) {
  const [skill, setSkill] = useState<Skill | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!id) return

    const fetchSkill = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await apiClient.get<ApiResponse<Skill>>(`/skills/${id}`)
        if (response.success) {
          setSkill(response.data)
        }
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    fetchSkill()
  }, [id])

  return { skill, loading, error }
}
