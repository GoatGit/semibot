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

interface VersionHistoryItem {
  version: string
  status: string
  isCurrent: boolean
  installedAt?: string
  installedBy?: string
  sourceType: string
  sourceUrl?: string
  checksumSha256: string
  fileSizeBytes?: number
  deprecatedAt?: string
  deprecatedReason?: string
}

interface InstallPackageInput {
  version: string
  sourceType: 'git' | 'url' | 'registry' | 'local' | 'anthropic'
  sourceUrl?: string
  sourceRef?: string
  manifestUrl?: string
  enableRetry?: boolean
}

interface RollbackInput {
  targetVersion: string
  reason?: string
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
   * 发布新版本
   */
  const publishVersion = useCallback(
    async (
      definitionId: string,
      input: {
        version: string
        sourceType: 'git' | 'url' | 'registry' | 'local' | 'anthropic'
        sourceUrl?: string
        sourceRef?: string
        manifestUrl?: string
        releaseNotes?: string
      }
    ): Promise<any> => {
      try {
        setLoading(true)
        setError(null)

        const response = await apiClient.post<ApiResponse<any>>(`/skill-definitions/${definitionId}/publish`, input)

        if (response.success) {
          return response.data
        }

        throw new Error('发布版本失败')
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    []
  )

  /**
   * 获取版本历史
   */
  const getVersionHistory = useCallback(async (definitionId: string): Promise<VersionHistoryItem[]> => {
    try {
      const response = await apiClient.get<ApiResponse<VersionHistoryItem[]>>(
        `/skill-definitions/${definitionId}/versions`
      )

      if (response.success) {
        return response.data || []
      }

      throw new Error('获取版本历史失败')
    } catch (err) {
      setError(err as Error)
      throw err
    }
  }, [])

  /**
   * 获取特定版本详情
   */
  const getVersion = useCallback(async (definitionId: string, version: string): Promise<any> => {
    try {
      const response = await apiClient.get<ApiResponse<any>>(
        `/skill-definitions/${definitionId}/versions/${version}`
      )

      if (response.success) {
        return response.data
      }

      throw new Error('获取版本详情失败')
    } catch (err) {
      setError(err as Error)
      throw err
    }
  }, [])

  /**
   * 回滚版本
   */
  const rollbackVersion = useCallback(async (definitionId: string, input: RollbackInput): Promise<any> => {
    try {
      setLoading(true)
      setError(null)

      const response = await apiClient.post<ApiResponse<any>>(`/skill-definitions/${definitionId}/rollback`, input)

      if (response.success) {
        return response.data
      }

      throw new Error('回滚版本失败')
    } catch (err) {
      setError(err as Error)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 回滚到上一个版本
   */
  const rollbackToPrevious = useCallback(
    async (definitionId: string, reason?: string): Promise<any> => {
      try {
        setLoading(true)
        setError(null)

        const response = await apiClient.post<ApiResponse<any>>(
          `/skill-definitions/${definitionId}/rollback-previous`,
          { reason }
        )

        if (response.success) {
          return response.data
        }

        throw new Error('回滚到上一版本失败')
      } catch (err) {
        setError(err as Error)
        throw err
      } finally {
        setLoading(false)
      }
    },
    []
  )

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
   * 从 Anthropic Skill ID 安装
   */
  const installFromAnthropic = useCallback(
    async (skillId: string, version?: string): Promise<any> => {
      try {
        setLoading(true)
        setError(null)

        const response = await apiClient.post<ApiResponse<any>>('/skill-definitions/install/anthropic', {
          skillId,
          version,
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

  /**
   * 从 Manifest URL 安装
   */
  const installFromManifest = useCallback(
    async (manifestUrl: string): Promise<any> => {
      try {
        setLoading(true)
        setError(null)

        const response = await apiClient.post<ApiResponse<any>>('/skill-definitions/install/manifest', {
          manifestUrl,
        })

        if (response.success) {
          await fetchDefinitions()
          return response.data
        }

        throw new Error('从 Manifest 安装失败')
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
    publishVersion,
    getVersionHistory,
    getVersion,
    rollbackVersion,
    rollbackToPrevious,
    getInstallLogs,
    installFromAnthropic,
    installFromManifest,
  }
}
