/**
 * Organization 状态管理 Hook
 *
 * 管理组织信息、成员等
 */

import { useCallback, useState } from 'react'
import type { ApiResponse, UpdateOrganizationInput } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Organization {
  id: string
  name: string
  slug: string
  plan: 'free' | 'pro' | 'enterprise'
  quota: Record<string, unknown>
  settings: Record<string, unknown>
  ownerId: string
  isActive: boolean
  createdAt: string
}

export interface OrganizationMember {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'member'
  joinedAt: string
  lastLoginAt?: string
}

export interface OrganizationState {
  /** 当前组织 */
  organization: Organization | null
  /** 成员列表 */
  members: OrganizationMember[]
  /** 下一页游标 */
  nextCursor: string | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseOrganizationReturn {
  /** 当前状态 */
  state: OrganizationState
  /** 获取当前组织 */
  getCurrentOrganization: () => Promise<Organization>
  /** 更新组织信息 */
  updateOrganization: (input: UpdateOrganizationInput) => Promise<Organization>
  /** 获取成员列表 */
  getMembers: (options?: GetMembersOptions) => Promise<void>
  /** 加载更多成员 */
  loadMoreMembers: () => Promise<void>
}

export interface GetMembersOptions {
  limit?: number
  cursor?: string
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: OrganizationState = {
  organization: null,
  members: [],
  nextCursor: null,
  isLoading: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useOrganization(): UseOrganizationReturn {
  const [state, setState] = useState<OrganizationState>(initialState)

  /**
   * 获取当前组织
   */
  const getCurrentOrganization = useCallback(async (): Promise<Organization> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<Organization>>('/organizations/current')

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? '获取组织信息失败')
      }

      setState((prev) => ({
        ...prev,
        organization: response.data!,
        isLoading: false,
      }))

      return response.data
    } catch (error) {
      const message = error instanceof Error ? error.message : '获取组织信息失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
      throw error
    }
  }, [])

  /**
   * 更新组织信息
   */
  const updateOrganization = useCallback(async (input: UpdateOrganizationInput): Promise<Organization> => {
    const response = await apiClient.put<ApiResponse<Organization>>('/organizations/current', input)

    if (!response.success || !response.data) {
      throw new Error(response.error?.message ?? '更新组织信息失败')
    }

    setState((prev) => ({
      ...prev,
      organization: prev.organization ? { ...prev.organization, ...response.data } : response.data!,
    }))

    return response.data
  }, [])

  /**
   * 获取成员列表
   */
  const getMembers = useCallback(async (options: GetMembersOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<OrganizationMember[]> & { meta?: { nextCursor?: string } }>(
        '/organizations/current/members',
        { params: options as Record<string, unknown> }
      )

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? '获取成员列表失败')
      }

      setState((prev) => ({
        ...prev,
        members: response.data!,
        nextCursor: response.meta?.nextCursor ?? null,
        isLoading: false,
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : '获取成员列表失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 加载更多成员
   */
  const loadMoreMembers = useCallback(async () => {
    if (!state.nextCursor) {
      return
    }

    setState((prev) => ({ ...prev, isLoading: true }))

    try {
      const response = await apiClient.get<ApiResponse<OrganizationMember[]> & { meta?: { nextCursor?: string } }>(
        '/organizations/current/members',
        { params: { cursor: state.nextCursor } }
      )

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          members: [...prev.members, ...response.data!],
          nextCursor: response.meta?.nextCursor ?? null,
          isLoading: false,
        }))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载更多成员失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [state.nextCursor])

  return {
    state,
    getCurrentOrganization,
    updateOrganization,
    getMembers,
    loadMoreMembers,
  }
}

export default useOrganization
