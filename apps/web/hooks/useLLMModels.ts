/**
 * useLLMModels Hook
 *
 * 获取环境变量配置的 LLM 模型列表
 */

import { useState, useEffect, useCallback } from 'react'
import { apiClient } from '@/lib/api'
import { cachedFetch, invalidateCache } from '@/lib/query-cache'

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

// LLM 模型列表变化频率极低，缓存 5 分钟
const MODELS_CACHE_KEY = 'llm-providers/models'
const PROVIDERS_CACHE_KEY = 'llm-providers'
const CACHE_TTL_MS = 5 * 60_000

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useLLMModels() {
  const [models, setModels] = useState<LLMModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchModels = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)

    try {
      if (forceRefresh) invalidateCache(MODELS_CACHE_KEY)
      const response = await cachedFetch(
        MODELS_CACHE_KEY,
        () => apiClient.get<ApiResponse<LLMModel[]>>('/llm-providers/models'),
        CACHE_TTL_MS
      )
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
    refetch: () => fetchModels(true),
  }
}

export function useLLMProviders() {
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchProviders = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)

    try {
      if (forceRefresh) invalidateCache(PROVIDERS_CACHE_KEY)
      const response = await cachedFetch(
        PROVIDERS_CACHE_KEY,
        () => apiClient.get<ApiResponse<LLMProvider[]>>('/llm-providers'),
        CACHE_TTL_MS
      )
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
    refetch: () => fetchProviders(true),
  }
}
