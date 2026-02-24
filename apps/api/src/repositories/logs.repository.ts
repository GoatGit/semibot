/**
 * Logs Repository
 *
 * 处理执行日志和使用量记录的数据库操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ExecutionLogRow {
  id: string
  org_id: string
  agent_id: string
  session_id: string
  request_id: string | null
  step_id: string | null
  action_id: string | null
  state: string
  action_type: string | null
  action_name: string | null
  action_input: Record<string, unknown> | null
  action_output: Record<string, unknown> | null
  error_code: string | null
  error_message: string | null
  retry_count: number
  duration_ms: number | null
  tokens_input: number
  tokens_output: number
  model: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface UsageRecordRow {
  id: string
  org_id: string
  user_id: string | null
  agent_id: string | null
  period_start: string
  period_end: string
  period_type: string
  tokens_input: number
  tokens_output: number
  api_calls: number
  tool_calls: number
  sessions_count: number
  messages_count: number
  errors_count: number
  cost_usd: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CreateExecutionLogData {
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
  retryCount?: number
  durationMs?: number
  tokensInput?: number
  tokensOutput?: number
  model?: string
  metadata?: Record<string, unknown>
}

export interface ListExecutionLogsParams {
  orgId: string
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

export interface ListUsageRecordsParams {
  orgId: string
  userId?: string
  agentId?: string
  periodType?: string
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
// Execution Log Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建执行日志
 */
export async function createExecutionLog(data: CreateExecutionLogData): Promise<ExecutionLogRow> {
  const result = await sql`
    INSERT INTO execution_logs (
      org_id, agent_id, session_id, request_id, step_id, action_id,
      state, action_type, action_name, action_input, action_output,
      error_code, error_message, retry_count, duration_ms,
      tokens_input, tokens_output, model, metadata
    )
    VALUES (
      ${data.orgId},
      ${data.agentId},
      ${data.sessionId},
      ${data.requestId ?? null},
      ${data.stepId ?? null},
      ${data.actionId ?? null},
      ${data.state},
      ${data.actionType ?? null},
      ${data.actionName ?? null},
      ${data.actionInput ? sql.json(data.actionInput as Parameters<typeof sql.json>[0]) : null},
      ${data.actionOutput ? sql.json(data.actionOutput as Parameters<typeof sql.json>[0]) : null},
      ${data.errorCode ?? null},
      ${data.errorMessage ?? null},
      ${data.retryCount ?? 0},
      ${data.durationMs ?? null},
      ${data.tokensInput ?? 0},
      ${data.tokensOutput ?? 0},
      ${data.model ?? null},
      ${sql.json((data.metadata ?? {}) as Parameters<typeof sql.json>[0])}
    )
    RETURNING *
  `

  return result[0] as unknown as ExecutionLogRow
}

/**
 * 列出执行日志（分页）
 */
export async function findExecutionLogs(params: ListExecutionLogsParams): Promise<PaginatedResult<ExecutionLogRow>> {
  const { orgId, agentId, sessionId, requestId, state, errorCode, page = 1, limit = DEFAULT_PAGE_SIZE, startDate, endDate } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 构建 WHERE 条件
  let whereClause = sql`org_id = ${orgId}`

  if (agentId) {
    whereClause = sql`${whereClause} AND agent_id = ${agentId}`
  }

  if (sessionId) {
    whereClause = sql`${whereClause} AND session_id = ${sessionId}`
  }

  if (requestId) {
    whereClause = sql`${whereClause} AND request_id = ${requestId}`
  }

  if (state) {
    whereClause = sql`${whereClause} AND state = ${state}`
  }

  if (errorCode) {
    whereClause = sql`${whereClause} AND error_code = ${errorCode}`
  }

  if (startDate) {
    whereClause = sql`${whereClause} AND created_at >= ${startDate}::timestamptz`
  }

  if (endDate) {
    whereClause = sql`${whereClause} AND created_at <= ${endDate}::timestamptz`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM execution_logs WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM execution_logs
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  const data = dataResult as unknown as ExecutionLogRow[]

  return {
    data,
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}

// ═══════════════════════════════════════════════════════════════
// Usage Record Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 列出使用量记录（分页）
 */
export async function findUsageRecords(params: ListUsageRecordsParams): Promise<PaginatedResult<UsageRecordRow>> {
  const { orgId, userId, agentId, periodType, startDate, endDate, page = 1, limit = DEFAULT_PAGE_SIZE } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 构建 WHERE 条件
  let whereClause = sql`org_id = ${orgId}`

  if (userId) {
    whereClause = sql`${whereClause} AND user_id = ${userId}`
  }

  if (agentId) {
    whereClause = sql`${whereClause} AND agent_id = ${agentId}`
  }

  if (periodType) {
    whereClause = sql`${whereClause} AND period_type = ${periodType}`
  }

  if (startDate) {
    whereClause = sql`${whereClause} AND period_start >= ${startDate}::timestamptz`
  }

  if (endDate) {
    whereClause = sql`${whereClause} AND period_end <= ${endDate}::timestamptz`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM usage_records WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM usage_records
    WHERE ${whereClause}
    ORDER BY period_start DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  const data = dataResult as unknown as UsageRecordRow[]

  return {
    data,
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}

/**
 * 获取组织使用量汇总
 */
export async function getUsageSummary(
  orgId: string,
  periodType: string,
  startDate: string,
  endDate: string
): Promise<{
  tokensInput: number
  tokensOutput: number
  apiCalls: number
  toolCalls: number
  sessionsCount: number
  messagesCount: number
  errorsCount: number
  costUsd: number
}> {
  const result = await sql`
    SELECT
      COALESCE(SUM(tokens_input), 0)::INTEGER as tokens_input,
      COALESCE(SUM(tokens_output), 0)::INTEGER as tokens_output,
      COALESCE(SUM(api_calls), 0)::INTEGER as api_calls,
      COALESCE(SUM(tool_calls), 0)::INTEGER as tool_calls,
      COALESCE(SUM(sessions_count), 0)::INTEGER as sessions_count,
      COALESCE(SUM(messages_count), 0)::INTEGER as messages_count,
      COALESCE(SUM(errors_count), 0)::INTEGER as errors_count,
      COALESCE(SUM(cost_usd), 0)::FLOAT as cost_usd
    FROM usage_records
    WHERE org_id = ${orgId}
      AND period_type = ${periodType}
      AND period_start >= ${startDate}::timestamptz
      AND period_end <= ${endDate}::timestamptz
      AND user_id IS NULL
      AND agent_id IS NULL
  `

  const row = result[0] as Record<string, number>
  return {
    tokensInput: row.tokens_input ?? 0,
    tokensOutput: row.tokens_output ?? 0,
    apiCalls: row.api_calls ?? 0,
    toolCalls: row.tool_calls ?? 0,
    sessionsCount: row.sessions_count ?? 0,
    messagesCount: row.messages_count ?? 0,
    errorsCount: row.errors_count ?? 0,
    costUsd: row.cost_usd ?? 0,
  }
}

/**
 * 增量更新或创建使用量记录
 */
export async function upsertUsageRecord(
  orgId: string,
  periodType: string,
  periodStart: string,
  periodEnd: string,
  updates: Partial<{
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
): Promise<UsageRecordRow> {
  const userId = updates.userId ?? null
  const agentId = updates.agentId ?? null

  const insertPrefix = sql`
    INSERT INTO usage_records (
      org_id, user_id, agent_id, period_type, period_start, period_end,
      tokens_input, tokens_output, api_calls, tool_calls,
      sessions_count, messages_count, errors_count, cost_usd
    )
    VALUES (
      ${orgId},
      ${userId},
      ${agentId},
      ${periodType},
      ${periodStart}::timestamptz,
      ${periodEnd}::timestamptz,
      ${updates.tokensInput ?? 0},
      ${updates.tokensOutput ?? 0},
      ${updates.apiCalls ?? 0},
      ${updates.toolCalls ?? 0},
      ${updates.sessionsCount ?? 0},
      ${updates.messagesCount ?? 0},
      ${updates.errorsCount ?? 0},
      ${updates.costUsd ?? 0}
    )
  `

  let result
  if (agentId) {
    result = await sql`
      ${insertPrefix}
      ON CONFLICT (org_id, agent_id, period_type, period_start)
      WHERE agent_id IS NOT NULL
      DO UPDATE SET
        tokens_input = usage_records.tokens_input + EXCLUDED.tokens_input,
        tokens_output = usage_records.tokens_output + EXCLUDED.tokens_output,
        api_calls = usage_records.api_calls + EXCLUDED.api_calls,
        tool_calls = usage_records.tool_calls + EXCLUDED.tool_calls,
        sessions_count = usage_records.sessions_count + EXCLUDED.sessions_count,
        messages_count = usage_records.messages_count + EXCLUDED.messages_count,
        errors_count = usage_records.errors_count + EXCLUDED.errors_count,
        cost_usd = usage_records.cost_usd + EXCLUDED.cost_usd,
        updated_at = NOW()
      RETURNING *
    `
  } else if (userId) {
    result = await sql`
      ${insertPrefix}
      ON CONFLICT (org_id, user_id, period_type, period_start)
      WHERE user_id IS NOT NULL AND agent_id IS NULL
      DO UPDATE SET
        tokens_input = usage_records.tokens_input + EXCLUDED.tokens_input,
        tokens_output = usage_records.tokens_output + EXCLUDED.tokens_output,
        api_calls = usage_records.api_calls + EXCLUDED.api_calls,
        tool_calls = usage_records.tool_calls + EXCLUDED.tool_calls,
        sessions_count = usage_records.sessions_count + EXCLUDED.sessions_count,
        messages_count = usage_records.messages_count + EXCLUDED.messages_count,
        errors_count = usage_records.errors_count + EXCLUDED.errors_count,
        cost_usd = usage_records.cost_usd + EXCLUDED.cost_usd,
        updated_at = NOW()
      RETURNING *
    `
  } else {
    result = await sql`
      ${insertPrefix}
      ON CONFLICT (org_id, period_type, period_start)
      WHERE user_id IS NULL AND agent_id IS NULL
      DO UPDATE SET
        tokens_input = usage_records.tokens_input + EXCLUDED.tokens_input,
        tokens_output = usage_records.tokens_output + EXCLUDED.tokens_output,
        api_calls = usage_records.api_calls + EXCLUDED.api_calls,
        tool_calls = usage_records.tool_calls + EXCLUDED.tool_calls,
        sessions_count = usage_records.sessions_count + EXCLUDED.sessions_count,
        messages_count = usage_records.messages_count + EXCLUDED.messages_count,
        errors_count = usage_records.errors_count + EXCLUDED.errors_count,
        cost_usd = usage_records.cost_usd + EXCLUDED.cost_usd,
        updated_at = NOW()
      RETURNING *
    `
  }

  return result[0] as unknown as UsageRecordRow
}
