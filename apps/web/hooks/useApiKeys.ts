/**
 * API Keys 状态管理 Hook
 *
 * 管理 API Key 列表、创建、删除等
 */

import { useCallback, useState } from 'react'
import type { ApiResponse, CreateApiKeyInput } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  permissions: string[]
  lastUsedAt?: string
  expiresAt?: string
  isActive: boolean
}

export interface ApiKeyWithSecret extends ApiKey {
  /** 完整密钥，只在创建时返回 */
  key: string
  createdAt: string
}

export interface ApiKeysState {
  /** API Key 列表 */
  keys: ApiKey[]
  /** 新创建的 Key (含完整密钥) */
  newlyCreatedKey: ApiKeyWithSecret | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseApiKeysReturn {
  /** 当前状态 */
  state: ApiKeysState
  /** 加载 API Key 列表 */
  loadApiKeys: () => Promise<void>
  /** 创建 API Key */
  createApiKey: (input: CreateApiKeyInput) => Promise<ApiKeyWithSecret>
  /** 删除 API Key */
  deleteApiKey: (keyId: string) => Promise<void>
  /** 清除新创建的 Key */
  clearNewlyCreatedKey: () => void
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: ApiKeysState = {
  keys: [],
  newlyCreatedKey: null,
  isLoading: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useApiKeys(): UseApiKeysReturn {
  const [state, setState] = useState<ApiKeysState>(initialState)

  /**
   * 加载 API Key 列表
   */
  const loadApiKeys = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<ApiKey[]>>('/api-keys')

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          keys: response.data!,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载 API Key 列表失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载 API Key 列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 创建 API Key
   */
  const createApiKey = useCallback(async (input: CreateApiKeyInput): Promise<ApiKeyWithSecret> => {
    const response = await apiClient.post<ApiResponse<ApiKeyWithSecret>>('/api-keys', input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '创建 API Key 失败')
    }

    const apiKey = response.data

    setState((prev) => ({
      ...prev,
      keys: [
        {
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          permissions: apiKey.permissions,
          expiresAt: apiKey.expiresAt,
          isActive: true,
        },
        ...prev.keys,
      ],
      newlyCreatedKey: apiKey,
    }))

    return apiKey
  }, [])

  /**
   * 删除 API Key
   */
  const deleteApiKey = useCallback(async (keyId: string) => {
    await apiClient.delete(`/api-keys/${keyId}`)

    setState((prev) => ({
      ...prev,
      keys: prev.keys.filter((k) => k.id !== keyId),
    }))
  }, [])

  /**
   * 清除新创建的 Key
   */
  const clearNewlyCreatedKey = useCallback(() => {
    setState((prev) => ({
      ...prev,
      newlyCreatedKey: null,
    }))
  }, [])

  return {
    state,
    loadApiKeys,
    createApiKey,
    deleteApiKey,
    clearNewlyCreatedKey,
  }
}

export default useApiKeys
