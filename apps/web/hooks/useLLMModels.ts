/**
 * useLLMModels Hook
 *
 * 获取环境变量配置的 LLM 模型列表
 */

import { useState, useEffect, useCallback } from 'react'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface LLMModel {
  modelId: string
  displayName: string
  displayNameSource: 'provider' | 'fallback'
  providerName: string
  providerType: string
}

export interface LLMProvider {
  name: string
  displayName: string
  available: boolean
  models: string[]
}

interface ApiResponse<T> {
  success: boolean
  data: T
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useLLMModels() {
  const [models, setModels] = useState<LLMModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchModels = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<ApiResponse<LLMModel[]>>('/llm-providers/models')

      if (response.success) {
        setModels(response.data)
      }
    } catch (err) {
      setError(err as Error)
      setModels([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  return {
    models,
    loading,
    error,
    refetch: fetchModels,
  }
}

export function useLLMProviders() {
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchProviders = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<ApiResponse<LLMProvider[]>>('/llm-providers')

      if (response.success) {
        setProviders(response.data)
      }
    } catch (err) {
      setError(err as Error)
      setProviders([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  return {
    providers,
    loading,
    error,
    refetch: fetchProviders,
  }
}
