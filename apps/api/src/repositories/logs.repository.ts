/**
 * Logs Repository — SQLite 代理
 */

import * as local from '../lib/logs-local-store'

export type {
  LocalExecutionLogRow as ExecutionLogRow,
  LocalUsageRecordRow as UsageRecordRow,
} from '../lib/logs-local-store'

export interface CreateExecutionLogData {
  agentId: string
  sessionId: string
  requestId?: string
  stepId?: string
  actionId?: string
  state: string
  actionType?: string
  actionName?: string
  actionInput?: Record<string, unknown>
  actionOutput?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  retryCount?: number
  durationMs?: number
  tokensInput?: number
  tokensOutput?: number
  model?: string
  metadata?: Record<string, unknown>
}

export async function createExecutionLog(data: CreateExecutionLogData) {
  return local.localCreateExecutionLog(data)
}

export async function findExecutionLogs(params: {
  agentId?: string
  sessionId?: string
  state?: string
  page?: number
  limit?: number
  startDate?: string
  endDate?: string
}) {
  if (params.sessionId) {
    return { data: local.localFindExecutionLogsBySession(params.sessionId), meta: { total: 0, page: 1, limit: 100, totalPages: 1 } }
  }
  return local.localFindExecutionLogsByAgent({ agentId: '', ...params })
}

export async function upsertUsageRecord(
  periodType: 'hourly' | 'daily' | 'monthly',
  periodStart: string,
  periodEnd: string,
  usage: Partial<{
    userId: string
    agentId: string
    tokensInput: number
    tokensOutput: number
    apiCalls: number
    toolCalls: number
    sessionsCount: number
    messagesCount: number
    errorsCount: number
    costUsd: number
  }>
) {
  return local.localUpsertUsageRecord({ periodType, periodStart, periodEnd, ...usage })
}

export async function findUsageRecords(params: {
  userId?: string
  agentId?: string
  periodType?: string
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
}) {
  return local.localFindUsageRecords(params)
}

export async function getUsageSummary(
  _periodType: string,
  startDate: string,
  endDate: string
) {
  const result = local.localFindUsageRecords({ startDate, endDate })
  const records = result.data
  return {
    totalTokensInput: records.reduce((s, r) => s + r.tokens_input, 0),
    totalTokensOutput: records.reduce((s, r) => s + r.tokens_output, 0),
    totalApiCalls: records.reduce((s, r) => s + r.api_calls, 0),
    totalCostUsd: records.reduce((s, r) => s + r.cost_usd, 0),
  }
}
