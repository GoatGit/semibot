/**
 * Logs SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

export interface LocalExecutionLogRow {
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

export interface LocalUsageRecordRow {
  id: string
  org_id: string
  user_id: string | null
  agent_id: string | null
  period_start: string
  period_end: string
  period_type: 'hourly' | 'daily' | 'monthly'
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

function nowIso(): string {
  return new Date().toISOString()
}

function rowToLog(row: Record<string, unknown>): LocalExecutionLogRow {
  return {
    id: row.id as string,
    org_id: 'local',
    agent_id: row.agent_id as string,
    session_id: row.session_id as string,
    request_id: (row.request_id as string) ?? null,
    step_id: (row.step_id as string) ?? null,
    action_id: (row.action_id as string) ?? null,
    state: row.state as string,
    action_type: (row.action_type as string) ?? null,
    action_name: (row.action_name as string) ?? null,
    action_input: row.action_input_json ? JSON.parse(row.action_input_json as string) : null,
    action_output: row.action_output_json ? JSON.parse(row.action_output_json as string) : null,
    error_code: (row.error_code as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    retry_count: (row.retry_count as number) ?? 0,
    duration_ms: (row.duration_ms as number) ?? null,
    tokens_input: (row.tokens_input as number) ?? 0,
    tokens_output: (row.tokens_output as number) ?? 0,
    model: (row.model as string) ?? null,
    metadata: JSON.parse((row.metadata_json as string) ?? '{}'),
    created_at: row.created_at as string,
  }
}

function rowToUsage(row: Record<string, unknown>): LocalUsageRecordRow {
  return {
    id: row.id as string,
    org_id: 'local',
    user_id: null,
    agent_id: (row.agent_id as string) ?? null,
    period_start: row.period_start as string,
    period_end: row.period_end as string,
    period_type: row.period_type as LocalUsageRecordRow['period_type'],
    tokens_input: (row.tokens_input as number) ?? 0,
    tokens_output: (row.tokens_output as number) ?? 0,
    api_calls: (row.api_calls as number) ?? 0,
    tool_calls: (row.tool_calls as number) ?? 0,
    sessions_count: (row.sessions_count as number) ?? 0,
    messages_count: (row.messages_count as number) ?? 0,
    errors_count: (row.errors_count as number) ?? 0,
    cost_usd: (row.cost_usd as number) ?? 0,
    metadata: JSON.parse((row.metadata_json as string) ?? '{}'),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

export function localCreateExecutionLog(data: {
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
}): LocalExecutionLogRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO execution_logs
      (id, agent_id, session_id, request_id, step_id, action_id, state, action_type, action_name,
       action_input_json, action_output_json, error_code, error_message, retry_count, duration_ms,
       tokens_input, tokens_output, model, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.agentId, data.sessionId, data.requestId ?? null, data.stepId ?? null, data.actionId ?? null,
    data.state, data.actionType ?? null, data.actionName ?? null,
    data.actionInput ? JSON.stringify(data.actionInput) : null,
    data.actionOutput ? JSON.stringify(data.actionOutput) : null,
    data.errorCode ?? null, data.errorMessage ?? null,
    data.retryCount ?? 0, data.durationMs ?? null,
    data.tokensInput ?? 0, data.tokensOutput ?? 0,
    data.model ?? null, JSON.stringify(data.metadata ?? {}), now
  )
  return rowToLog(db.prepare('SELECT * FROM execution_logs WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindExecutionLogsBySession(sessionId: string, limit = 100): LocalExecutionLogRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM execution_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(sessionId, limit)
  return rows.map((r) => rowToLog(r as Record<string, unknown>))
}

export function localFindExecutionLogsByAgent(params: {
  agentId: string
  page?: number
  limit?: number
  state?: string
  startDate?: string
  endDate?: string
}): { data: LocalExecutionLogRow[]; meta: { total: number; page: number; limit: number; totalPages: number } } {
  const db = getLocalDb()
  let where = 'WHERE agent_id = ?'
  const binds: unknown[] = [params.agentId]
  if (params.state) { where += ' AND state = ?'; binds.push(params.state) }
  if (params.startDate) { where += ' AND created_at >= ?'; binds.push(params.startDate) }
  if (params.endDate) { where += ' AND created_at <= ?'; binds.push(params.endDate) }
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const total = (db.prepare(`SELECT COUNT(*) as c FROM execution_logs ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM execution_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...binds, limit, (page - 1) * limit)
  return { data: rows.map((r) => rowToLog(r as Record<string, unknown>)), meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } }
}

export function localUpsertUsageRecord(data: {
  userId?: string
  agentId?: string
  periodStart: string
  periodEnd: string
  periodType: 'hourly' | 'daily' | 'monthly'
  tokensInput?: number
  tokensOutput?: number
  apiCalls?: number
  toolCalls?: number
  sessionsCount?: number
  messagesCount?: number
  errorsCount?: number
  costUsd?: number
}): LocalUsageRecordRow {
  const db = getLocalDb()
  const now = nowIso()
  const existing = db.prepare(
    'SELECT * FROM usage_records WHERE agent_id IS ? AND period_start = ? AND period_type = ?'
  ).get(data.agentId ?? null, data.periodStart, data.periodType) as Record<string, unknown> | undefined

  if (existing) {
    db.prepare(`
      UPDATE usage_records SET
        tokens_input = tokens_input + ?, tokens_output = tokens_output + ?,
        api_calls = api_calls + ?, tool_calls = tool_calls + ?,
        sessions_count = sessions_count + ?, messages_count = messages_count + ?,
        errors_count = errors_count + ?, cost_usd = cost_usd + ?, updated_at = ?
      WHERE id = ?
    `).run(
      data.tokensInput ?? 0, data.tokensOutput ?? 0, data.apiCalls ?? 0, data.toolCalls ?? 0,
      data.sessionsCount ?? 0, data.messagesCount ?? 0, data.errorsCount ?? 0, data.costUsd ?? 0,
      now, existing.id
    )
    return rowToUsage(db.prepare('SELECT * FROM usage_records WHERE id = ?').get(existing.id) as Record<string, unknown>)
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO usage_records
      (id, agent_id, period_start, period_end, period_type, tokens_input, tokens_output,
       api_calls, tool_calls, sessions_count, messages_count, errors_count, cost_usd, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `).run(
    id, data.agentId ?? null, data.periodStart, data.periodEnd, data.periodType,
    data.tokensInput ?? 0, data.tokensOutput ?? 0, data.apiCalls ?? 0, data.toolCalls ?? 0,
    data.sessionsCount ?? 0, data.messagesCount ?? 0, data.errorsCount ?? 0, data.costUsd ?? 0,
    now, now
  )
  return rowToUsage(db.prepare('SELECT * FROM usage_records WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindUsageRecords(params: {
  agentId?: string
  periodType?: string
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
}): { data: LocalUsageRecordRow[]; meta: { total: number; page: number; limit: number; totalPages: number } } {
  const db = getLocalDb()
  let where = 'WHERE 1=1'
  const binds: unknown[] = []
  if (params.agentId) { where += ' AND agent_id = ?'; binds.push(params.agentId) }
  if (params.periodType) { where += ' AND period_type = ?'; binds.push(params.periodType) }
  if (params.startDate) { where += ' AND period_start >= ?'; binds.push(params.startDate) }
  if (params.endDate) { where += ' AND period_end <= ?'; binds.push(params.endDate) }
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const total = (db.prepare(`SELECT COUNT(*) as c FROM usage_records ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM usage_records ${where} ORDER BY period_start DESC LIMIT ? OFFSET ?`).all(...binds, limit, (page - 1) * limit)
  return { data: rows.map((r) => rowToUsage(r as Record<string, unknown>)), meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } }
}

// ═══════════════════════════════════════════════════════════════
// Token 用量聚合（从 execution_logs 实时统计）
// ═══════════════════════════════════════════════════════════════

export interface TokenUsageTotals {
  call_count: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface TokenBreakdownItem {
  key: string
  call_count: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface TokenTrendItem {
  day: string
  total_tokens: number
  call_count: number
  segments: Record<string, number>
}

export interface TokenUsageResult {
  totals: TokenUsageTotals
  breakdown: TokenBreakdownItem[]
  trend: TokenTrendItem[]
}

/**
 * 从 execution_logs 实时聚合 token 用量
 *
 * @param since  起始时间 ISO 字符串（含）
 * @param until  结束时间 ISO 字符串（含）
 * @param groupBy 分组维度
 * @param granularity 趋势粒度：hour 按小时，day 按天
 */
export function localAggregateTokenUsage(params: {
  since?: string
  until?: string
  groupBy?: 'model' | 'agent' | 'session' | 'node'
  granularity?: 'hour' | 'day'
}): TokenUsageResult {
  const db = getLocalDb()
  let where = 'WHERE 1=1'
  const binds: unknown[] = []
  if (params.since) { where += ' AND created_at >= ?'; binds.push(params.since) }
  if (params.until) { where += ' AND created_at <= ?'; binds.push(params.until) }

  // --- totals ---
  const totalsRow = db.prepare(`
    SELECT
      COUNT(*) as call_count,
      COALESCE(SUM(tokens_input), 0) as prompt_tokens,
      COALESCE(SUM(tokens_output), 0) as completion_tokens,
      COALESCE(SUM(tokens_input + tokens_output), 0) as total_tokens
    FROM execution_logs ${where}
  `).get(...binds) as Record<string, number>

  const totals: TokenUsageTotals = {
    call_count: totalsRow.call_count ?? 0,
    prompt_tokens: totalsRow.prompt_tokens ?? 0,
    completion_tokens: totalsRow.completion_tokens ?? 0,
    total_tokens: totalsRow.total_tokens ?? 0,
  }

  // --- breakdown ---
  const groupCol = params.groupBy === 'model' ? 'model'
    : params.groupBy === 'agent' ? 'agent_id'
    : params.groupBy === 'session' ? 'session_id'
    : 'action_type'

  const breakdownRows = db.prepare(`
    SELECT
      COALESCE(${groupCol}, 'unknown') as grp,
      COUNT(*) as call_count,
      COALESCE(SUM(tokens_input), 0) as prompt_tokens,
      COALESCE(SUM(tokens_output), 0) as completion_tokens,
      COALESCE(SUM(tokens_input + tokens_output), 0) as total_tokens
    FROM execution_logs ${where}
    GROUP BY grp
    ORDER BY total_tokens DESC
  `).all(...binds) as Array<Record<string, unknown>>

  const breakdown: TokenBreakdownItem[] = breakdownRows.map((r) => ({
    key: String(r.grp),
    call_count: (r.call_count as number) ?? 0,
    prompt_tokens: (r.prompt_tokens as number) ?? 0,
    completion_tokens: (r.completion_tokens as number) ?? 0,
    total_tokens: (r.total_tokens as number) ?? 0,
  }))

  // --- trend (按 bucket + group 双维度聚合) ---
  const granularity = params.granularity ?? 'day'
  const timeFmt = granularity === 'hour'
    ? "strftime('%Y-%m-%d %H:00', created_at)"
    : "DATE(created_at)"

  const trendRows = db.prepare(`
    SELECT
      ${timeFmt} as bucket,
      COALESCE(${groupCol}, 'unknown') as grp,
      COALESCE(SUM(tokens_input + tokens_output), 0) as total_tokens,
      COUNT(*) as call_count
    FROM execution_logs ${where}
    GROUP BY bucket, grp
    ORDER BY bucket
  `).all(...binds) as Array<Record<string, unknown>>

  // 按 bucket 聚合，构建 segments
  const trendMap = new Map<string, { total_tokens: number; call_count: number; segments: Record<string, number> }>()
  for (const r of trendRows) {
    const bucket = String(r.bucket)
    const grp = String(r.grp)
    const tokens = (r.total_tokens as number) ?? 0
    const calls = (r.call_count as number) ?? 0
    const existing = trendMap.get(bucket)
    if (existing) {
      existing.total_tokens += tokens
      existing.call_count += calls
      existing.segments[grp] = (existing.segments[grp] ?? 0) + tokens
    } else {
      trendMap.set(bucket, { total_tokens: tokens, call_count: calls, segments: { [grp]: tokens } })
    }
  }

  const trend: TokenTrendItem[] = Array.from(trendMap.entries()).map(([bucket, v]) => ({
    day: bucket,
    total_tokens: v.total_tokens,
    call_count: v.call_count,
    segments: v.segments,
  }))

  return { totals, breakdown, trend }
}
