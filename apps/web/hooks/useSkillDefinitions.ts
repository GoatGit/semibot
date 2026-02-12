/**
 * useSkillDefinitions Hook
 *
 * 管理技能定义的 React Hook
 */

import { useState, useCallback } from 'react'
import { apiClient } from '@/lib/api'
import type { SkillDefinition } from '@semibot/shared-types'

interface ApiResponse<T> {
  success: boolean
  data: T
  meta?: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
  message?: string
}

interface UseSkillDefinitionsOptions {
  page?: number
  limit?: number
  search?: string
  category?: string
  isActive?: boolean
}

interface InstallPackageInput {
  sourceType: 'git' | 'url' | 'registry' | 'local' | 'anthropic' | 'upload'
  sourceUrl?: string
  sourceRef?: string
  enableRetry?: boolean
}

export function useSkillDefinitions(options: UseSkillDefinitionsOptions = {}) {
  const [definitions, setDefinitions] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [meta, setMeta] = useState<ApiResponse<any>['meta']>()

  /**
   * 加载技能定义列表
   */
  const fetchDefinitions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const response = await apiClient.get<ApiResponse<SkillDefinition[]>>('/skill-definitions', {
        params: {
          page: options.page || 1,
          limit: options.limit || 20,
          search: options.search,
          category: options.category,
          isActive: options.isActive,
        },
      })

      if (response.success) {
        setDefinitions(response.data || [])
        setMeta(response.meta)
      }
    } catch (err) {
      setError(err as Error)
      throw err
    } finally {
      setLoading(false)
    }
  }, [options.page, options.limit, options.search, options.category, options.isActive])

  /**
   * 获取单个技能定义
   */
  const getDefinition = useCallback(async (id: string): Promise<SkillDefinition> => {
    try {
      const response = await apiClient.get<ApiResponse<SkillDefinition>>(`/skill-definitions/${id}`)

      if (response.success) {
        return response.data
      }

      throw new Error('获取技能定义失败')
    } catch (err) {
      setError(err as Error)
      throw err
    }
  }, [])

  /**
   * 创建技能定义
   */
  const createDefinition = useCallback(
    async (input: {
      skillId: string
      name: string
      description?: string
      triggerKeywords?: string[]
      category?: string
      tags?: string[]
      iconUrl?: string
      author?: string
      homepageUrl?: string
      documentationUrl?: string
    }): Promise<SkillDefinition> => {
      try {
        setLoading(true)
        setError(null)

        const response = await apiClient.post<ApiResponse<SkillDefinition>>('/skill-definitions', input)

        if (response.success) {
          await fetchDefinitions()
          return response.data
        }

        throw new Error('创建技能定义失败')
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [fetchDefinitions]
  )

  /**
   * 更新技能定义
   */
  const updateDefinition = useCallback(
    async (
      id: string,
      input: {
        name?: string
        description?: string
        triggerKeywords?: string[]
        category?: string
        tags?: string[]
        iconUrl?: string
        author?: string
        homepageUrl?: string
        documentationUrl?: string
        isActive?: boolean
      }
    ): Promise<SkillDefinition> => {
      try {
        setLoading(true)
        setError(null)

        const response = await apiClient.put<ApiResponse<SkillDefinition>>(`/skill-definitions/${id}`, input)

        if (response.success) {
          await fetchDefinitions()
          return response.data
        }

        throw new Error('更新技能定义失败')
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [fetchDefinitions]
  )

  /**
   * 删除技能定义
   */
  const deleteDefinition = useCallback(
    async (id: string): Promise<void> => {
      try {
        setLoading(true)
        setError(null)

        await apiClient.delete(`/skill-definitions/${id}`)
        await fetchDefinitions()
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [fetchDefinitions]
  )

  /**
   * 安装技能包
   */
  const installPackage = useCallback(async (definitionId: string, input: InstallPackageInput): Promise<any> => {
    try {
      setLoading(true)
      setError(null)

      const response = await apiClient.post<ApiResponse<any>>(`/skill-definitions/${definitionId}/install`, input)

      if (response.success) {
        return response.data
      }

      throw new Error('安装技能包失败')
    } catch (err) {
      setError(err as Error)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 获取安装日志
   */
  const getInstallLogs = useCallback(async (definitionId: string, limit: number = 50): Promise<any[]> => {
    try {
      const response = await apiClient.get<ApiResponse<any[]>>(`/skill-definitions/${definitionId}/install-logs`, {
        params: { limit },
      })

      if (response.success) {
        return response.data || []
      }

      throw new Error('获取安装日志失败')
    } catch (err) {
      setError(err as Error)
      throw err
    }
  }, [])

  /**
   * 上传安装包并安装
   */
  const uploadAndInstall = useCallback(
    async (
      definitionId: string,
      file: File,
      enableRetry?: boolean
    ): Promise<any> => {
      try {
        setLoading(true)
        setError(null)

        const formData = new FormData()
        formData.append('file', file)
        if (enableRetry) {
          formData.append('enableRetry', 'true')
        }

        const response = await apiClient.upload<ApiResponse<any>>(
          `/skill-definitions/${definitionId}/upload-install`,
          formData
        )

        if (response.success) {
          await fetchDefinitions()
          return response.data
        }

        throw new Error('上传安装失败')
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [fetchDefinitions]
  )

  /**
   * 上传即创建：上传安装包 → 自动创建/更新 definition + 安装 package
   */
  const uploadCreate = useCallback(
    async (file: File, enableRetry?: boolean): Promise<any> => {
      try {
        setLoading(true)
        setError(null)

        const formData = new FormData()
        formData.append('file', file)
        if (enableRetry) {
          formData.append('enableRetry', 'true')
        }

        const response = await apiClient.upload<ApiResponse<any>>(
          `/skill-definitions/upload-create`,
          formData
        )

        if (response.success) {
          await fetchDefinitions()
          return response.data
        }

        throw new Error('上传创建失败')
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [fetchDefinitions]
  )

  /**
   * 从 Anthropic Skill ID 安装
   */
  const installFromAnthropic = useCallback(
    async (skillId: string): Promise<any> => {
      try {
        setLoading(true)
        setError(null)

        const response = await apiClient.post<ApiResponse<any>>('/skill-definitions/install-from-anthropic', {
          skillId,
        })

        if (response.success) {
          await fetchDefinitions()
          return response.data
        }

        throw new Error('从 Anthropic 安装失败')
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [fetchDefinitions]
  )

  return {
    // 状态
    definitions,
    loading,
    error,
    meta,

    // 方法
    fetchDefinitions,
    getDefinition,
    createDefinition,
    updateDefinition,
    deleteDefinition,
    installPackage,
    getInstallLogs,
    installFromAnthropic,
    uploadAndInstall,
    uploadCreate,
  }
}
