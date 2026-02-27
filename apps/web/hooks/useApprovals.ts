'use client'

import { useCallback, useState } from 'react'
import { apiClient } from '@/lib/api'
import type { ApprovalRecord } from '@/types'

interface ApprovalQuery {
  status?: ApprovalRecord['status'] | 'all'
  limit?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeApproval(raw: unknown): ApprovalRecord | null {
  if (!isObject(raw)) return null

  const id = readString(raw.id) || readString(raw.approval_id)
  if (!id) return null

  return {
    id,
    eventId: readString(raw.eventId) || readString(raw.event_id) || undefined,
    eventType: readString(raw.eventType) || readString(raw.event_type) || undefined,
    status: (readString(raw.status, 'pending') as ApprovalRecord['status']),
    riskLevel: (readString(raw.riskLevel) || readString(raw.risk_level) || 'medium') as ApprovalRecord['riskLevel'],
    reason: readString(raw.reason) || undefined,
    toolName: readString(raw.toolName) || readString(raw.tool_name) || undefined,
    action: readString(raw.action) || undefined,
    target: readString(raw.target) || undefined,
    summary: readString(raw.summary) || undefined,
    context: isObject(raw.context) ? raw.context : undefined,
    createdAt: readString(raw.createdAt) || readString(raw.created_at) || new Date().toISOString(),
    resolvedAt: readString(raw.resolvedAt) || readString(raw.resolved_at) || undefined,
  }
}

function normalizeApprovalsResponse(raw: unknown): ApprovalRecord[] {
  if (!isObject(raw)) return []

  const items =
    Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(raw.data)
        ? raw.data
        : isObject(raw.data) && Array.isArray((raw.data as Record<string, unknown>).items)
          ? ((raw.data as Record<string, unknown>).items as unknown[])
          : []

  return items
    .map(normalizeApproval)
    .filter((item): item is ApprovalRecord => item !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function getHttpStatus(error: unknown): number | undefined {
  if (!isObject(error)) return undefined
  const response = error.response
  if (!isObject(response)) return undefined
  return typeof response.status === 'number' ? response.status : undefined
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (isObject(error) && typeof error.message === 'string') return error.message
  return fallback
}

export function useApprovals() {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiAvailable, setApiAvailable] = useState(true)

  const loadApprovals = useCallback(async (query: ApprovalQuery = {}) => {
    try {
      setIsLoading(true)
      const response = await apiClient.get<unknown>('/approvals', {
        params: {
          status: query.status && query.status !== 'all' ? query.status : undefined,
          limit: query.limit ?? 50,
        },
      })

      setApprovals(normalizeApprovalsResponse(response))
      setError(null)
      setApiAvailable(true)
    } catch (err) {
      const status = getHttpStatus(err)
      if (status === 404) {
        setApiAvailable(false)
        setError('审批接口尚未接入（/v1/approvals）')
      } else {
        setError(getErrorMessage(err, '加载审批列表失败'))
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'approve' | 'reject',
    reason?: string
  ) => {
    await apiClient.post(`/approvals/${approvalId}/${decision}`, { reason })
  }, [])

  return {
    approvals,
    isLoading,
    error,
    apiAvailable,
    loadApprovals,
    resolveApproval,
  }
}
