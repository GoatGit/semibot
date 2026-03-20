/**
 * Logs 服务层
 *
 * 执行日志和使用量统计服务（本地文件存储）
 */

import * as local from '../lib/logs-local-store'

export interface ExecutionLog {
  id: string
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
  retryCount: number
  durationMs?: number
  tokensInput: number
  tokensOutput: number
  model?: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface UsageRecord {
  id: string
  userId?: string
  agentId?: string
  periodStart: string
  periodEnd: string
  periodType: 'hourly' | 'daily' | 'monthly'
  tokensInput: number
  tokensOutput: number
  apiCalls: number
  toolCalls: number
  sessionsCount: number
  messagesCount: number
  errorsCount: number
  costUsd: number
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface UsageSummary {
  tokensInput: number
  tokensOutput: number
  tokensTotal: number
  apiCalls: number
  toolCalls: number
  sessionsCount: number
  messagesCount: number
  errorsCount: number
  costUsd: number
}

export interface CreateExecutionLogInput {
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

export interface ListExecutionLogsOptions {
  agentId?: string
  sessionId?: string
  requestId?: string
  state?: string
  errorCode?: string
  page?: number
  limit?: number
  startDate?: string
  endDate?: string
}

export interface ListUsageRecordsOptions {
  userId?: string
  agentId?: string
  periodType?: 'hourly' | 'daily' | 'monthly'
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
}

export interface PaginatedResult<T> {
  data: T[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

function rowToExecutionLog(row: local.LocalExecutionLogRow): ExecutionLog {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    requestId: row.request_id ?? undefined,
    stepId: row.step_id ?? undefined,
    actionId: row.action_id ?? undefined,
    state: row.state,
    actionType: row.action_type ?? undefined,
    actionName: row.action_name ?? undefined,
    actionInput: row.action_input ?? undefined,
    actionOutput: row.action_output ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    retryCount: row.retry_count,
    durationMs: row.duration_ms ?? undefined,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    model: row.model ?? undefined,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

function rowToUsageRecord(row: local.LocalUsageRecordRow): UsageRecord {
  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    periodType: row.period_type as UsageRecord['periodType'],
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    apiCalls: row.api_calls,
    toolCalls: row.tool_calls,
    sessionsCount: row.sessions_count,
    messagesCount: row.messages_count,
    errorsCount: row.errors_count,
    costUsd: row.cost_usd,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function logExecution(input: CreateExecutionLogInput): Promise<ExecutionLog> {
  const row = local.localCreateExecutionLog({
    agentId: input.agentId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    stepId: input.stepId,
    actionId: input.actionId,
    state: input.state,
    actionType: input.actionType,
    actionName: input.actionName,
    actionInput: input.actionInput,
    actionOutput: input.actionOutput,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    retryCount: input.retryCount,
    durationMs: input.durationMs,
    tokensInput: input.tokensInput,
    tokensOutput: input.tokensOutput,
    model: input.model,
    metadata: input.metadata,
  })
  return rowToExecutionLog(row)
}

export async function listExecutionLogs(
  options: ListExecutionLogsOptions = {}
): Promise<PaginatedResult<ExecutionLog>> {
  const result = local.localFindExecutionLogsByAgent({ agentId: options.agentId ?? '', ...options })
  return { data: result.data.map(rowToExecutionLog), meta: result.meta }
}

export async function listUsageRecords(
  options: ListUsageRecordsOptions = {}
): Promise<PaginatedResult<UsageRecord>> {
  const result = local.localFindUsageRecords({ ...options })
  return { data: result.data.map(rowToUsageRecord), meta: result.meta }
}

export async function getUsageSummary(
  _periodType: 'hourly' | 'daily' | 'monthly',
  startDate: string,
  endDate: string
): Promise<UsageSummary> {
  const result = local.localFindUsageRecords({ startDate, endDate })
  const records = result.data
  const summary = {
    tokensInput: records.reduce((s, r) => s + r.tokens_input, 0),
    tokensOutput: records.reduce((s, r) => s + r.tokens_output, 0),
    apiCalls: records.reduce((s, r) => s + r.api_calls, 0),
    toolCalls: records.reduce((s, r) => s + r.tool_calls, 0),
    sessionsCount: records.reduce((s, r) => s + r.sessions_count, 0),
    messagesCount: records.reduce((s, r) => s + r.messages_count, 0),
    errorsCount: records.reduce((s, r) => s + r.errors_count, 0),
    costUsd: records.reduce((s, r) => s + r.cost_usd, 0),
  }
  return { ...summary, tokensTotal: summary.tokensInput + summary.tokensOutput }
}

export async function recordUsage(
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
): Promise<UsageRecord> {
  const row = local.localUpsertUsageRecord({ periodType, periodStart, periodEnd, ...usage })
  return rowToUsageRecord(row)
}

export type { TokenUsageResult } from '../lib/logs-local-store'

export async function getTokenUsage(params: {
  since?: string
  until?: string
  groupBy?: 'model' | 'agent' | 'session' | 'node'
  granularity?: 'hour' | 'day'
}): Promise<local.TokenUsageResult> {
  return local.localAggregateTokenUsage(params)
}
