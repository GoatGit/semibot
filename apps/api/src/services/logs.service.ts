/**
 * Logs 服务层
 *
 * 执行日志和使用量统计服务
 */

import * as logsRepository from '../repositories/logs.repository'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ExecutionLog {
  id: string
  orgId: string
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
  orgId: string
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
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 ExecutionLog 对象
 */
function rowToExecutionLog(row: logsRepository.ExecutionLogRow): ExecutionLog {
  return {
    id: row.id,
    orgId: row.org_id,
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

/**
 * 将数据库行转换为 UsageRecord 对象
 */
function rowToUsageRecord(row: logsRepository.UsageRecordRow): UsageRecord {
  return {
    id: row.id,
    orgId: row.org_id,
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

// ═══════════════════════════════════════════════════════════════
// 执行日志服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 记录执行日志
 */
export async function logExecution(
  orgId: string,
  input: CreateExecutionLogInput
): Promise<ExecutionLog> {
  const row = await logsRepository.createExecutionLog({
    orgId,
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

/**
 * 列出执行日志
 */
export async function listExecutionLogs(
  orgId: string,
  options: ListExecutionLogsOptions = {}
): Promise<PaginatedResult<ExecutionLog>> {
  const result = await logsRepository.findExecutionLogs({
    orgId,
    agentId: options.agentId,
    sessionId: options.sessionId,
    requestId: options.requestId,
    state: options.state,
    errorCode: options.errorCode,
    page: options.page,
    limit: options.limit,
    startDate: options.startDate,
    endDate: options.endDate,
  })

  return {
    data: result.data.map(rowToExecutionLog),
    meta: result.meta,
  }
}

// ═══════════════════════════════════════════════════════════════
// 使用量统计服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 列出使用量记录
 */
export async function listUsageRecords(
  orgId: string,
  options: ListUsageRecordsOptions = {}
): Promise<PaginatedResult<UsageRecord>> {
  const result = await logsRepository.findUsageRecords({
    orgId,
    userId: options.userId,
    agentId: options.agentId,
    periodType: options.periodType,
    startDate: options.startDate,
    endDate: options.endDate,
    page: options.page,
    limit: options.limit,
  })

  return {
    data: result.data.map(rowToUsageRecord),
    meta: result.meta,
  }
}

/**
 * 获取使用量汇总
 */
export async function getUsageSummary(
  orgId: string,
  periodType: 'hourly' | 'daily' | 'monthly',
  startDate: string,
  endDate: string
): Promise<UsageSummary> {
  const summary = await logsRepository.getUsageSummary(
    orgId,
    periodType,
    startDate,
    endDate
  )

  return {
    ...summary,
    tokensTotal: summary.tokensInput + summary.tokensOutput,
  }
}

/**
 * 记录使用量（增量更新）
 */
export async function recordUsage(
  orgId: string,
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
  const row = await logsRepository.upsertUsageRecord(
    orgId,
    periodType,
    periodStart,
    periodEnd,
    usage
  )

  return rowToUsageRecord(row)
}
