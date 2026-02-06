/**
 * Logs 状态管理 Hook
 *
 * 管理执行日志、使用量记录等
 */

import { useCallback, useState } from 'react'
import type { ExecutionLog, ApiResponse, PaginationMeta } from '@/types'
import { apiClient } from '@/lib/api'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface UsageRecord {
  id: string
  orgId: string
  userId?: string
  agentId?: string
  periodType: 'hourly' | 'daily' | 'monthly'
  periodStart: string
  periodEnd: string
  totalRequests: number
  totalTokensInput: number
  totalTokensOutput: number
  totalDurationMs: number
  totalCost: number
  metadata: Record<string, unknown>
  createdAt: string
}

export interface UsageSummary {
  totalRequests: number
  totalTokensInput: number
  totalTokensOutput: number
  totalDurationMs: number
  totalCost: number
  periodBreakdown: Array<{
    period: string
    requests: number
    tokensInput: number
    tokensOutput: number
    cost: number
  }>
}

export interface LogsState {
  /** 执行日志列表 */
  executionLogs: ExecutionLog[]
  /** 使用量记录列表 */
  usageRecords: UsageRecord[]
  /** 使用量汇总 */
  usageSummary: UsageSummary | null
  /** 分页信息 */
  pagination: PaginationMeta | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

export interface UseLogsReturn {
  /** 当前状态 */
  state: LogsState
  /** 加载执行日志 */
  loadExecutionLogs: (options?: LoadExecutionLogsOptions) => Promise<void>
  /** 加载使用量记录 */
  loadUsageRecords: (options?: LoadUsageRecordsOptions) => Promise<void>
  /** 获取使用量汇总 */
  getUsageSummary: (options: GetUsageSummaryOptions) => Promise<UsageSummary>
}

export interface LoadExecutionLogsOptions {
  page?: number
  limit?: number
  agentId?: string
  sessionId?: string
  requestId?: string
  state?: string
  errorCode?: string
  startDate?: string
  endDate?: string
}

export interface LoadUsageRecordsOptions {
  page?: number
  limit?: number
  userId?: string
  agentId?: string
  periodType?: 'hourly' | 'daily' | 'monthly'
  startDate?: string
  endDate?: string
}

export interface GetUsageSummaryOptions {
  periodType: 'hourly' | 'daily' | 'monthly'
  startDate: string
  endDate: string
}

// ═══════════════════════════════════════════════════════════════
// 初始状态
// ═══════════════════════════════════════════════════════════════

const initialState: LogsState = {
  executionLogs: [],
  usageRecords: [],
  usageSummary: null,
  pagination: null,
  isLoading: false,
  error: null,
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useLogs(): UseLogsReturn {
  const [state, setState] = useState<LogsState>(initialState)

  /**
   * 加载执行日志
   */
  const loadExecutionLogs = useCallback(async (options: LoadExecutionLogsOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<ExecutionLog[]>>('/logs/executions', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          executionLogs: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载执行日志失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载执行日志失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 加载使用量记录
   */
  const loadUsageRecords = useCallback(async (options: LoadUsageRecordsOptions = {}) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<UsageRecord[]>>('/logs/usage', {
        params: options as Record<string, unknown>,
      })

      if (response.success && response.data) {
        setState((prev) => ({
          ...prev,
          usageRecords: response.data!,
          pagination: response.meta ?? null,
          isLoading: false,
        }))
      } else {
        throw new Error(response.error?.message ?? '加载使用量记录失败')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载使用量记录失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
    }
  }, [])

  /**
   * 获取使用量汇总
   */
  const getUsageSummary = useCallback(async (options: GetUsageSummaryOptions): Promise<UsageSummary> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiClient.get<ApiResponse<UsageSummary>>('/logs/usage/summary', {
        params: {
          periodType: options.periodType,
          startDate: options.startDate,
          endDate: options.endDate,
        },
      })

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? '获取使用量汇总失败')
      }

      setState((prev) => ({
        ...prev,
        usageSummary: response.data!,
        isLoading: false,
      }))

      return response.data
    } catch (error) {
      const message = error instanceof Error ? error.message : '获取使用量汇总失败'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
      throw error
    }
  }, [])

  return {
    state,
    loadExecutionLogs,
    loadUsageRecords,
    getUsageSummary,
  }
}

export default useLogs
