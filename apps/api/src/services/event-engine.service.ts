/**
 * Event Engine 轻量服务
 *
 * 为前端 Events / Rules / Approvals 页面提供最小可用 API。
 * 当前实现基于 PostgreSQL，后续可平滑迁移到 runtime 事件引擎存储。
 */

import { v4 as uuidv4 } from 'uuid'
import { sql } from '../lib/db'

type RiskLevel = 'low' | 'medium' | 'high'
type RuleActionMode = 'ask' | 'suggest' | 'auto' | 'skip'
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface EventRecord {
  id: string
  eventType: string
  source: string
  subject?: string
  payload?: Record<string, unknown>
  riskHint: RiskLevel
  createdAt: string
}

export interface EventRule {
  id: string
  name: string
  eventType: string
  actionMode: RuleActionMode
  riskLevel: RiskLevel
  priority: number
  dedupeWindowSeconds: number
  cooldownSeconds: number
  attentionBudgetPerDay: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface ApprovalRecord {
  id: string
  eventId?: string
  eventType?: string
  status: ApprovalStatus
  riskLevel: RiskLevel
  reason?: string
  createdAt: string
  resolvedAt?: string
}

export interface CreateRuleInput {
  name: string
  eventType: string
  conditions?: Record<string, unknown>
  actionMode: RuleActionMode
  actions: Array<{
    actionType: string
    params?: Record<string, unknown>
  }>
  riskLevel: RiskLevel
  priority: number
  dedupeWindowSeconds: number
  cooldownSeconds: number
  attentionBudgetPerDay: number
  isActive: boolean
}

export interface UpdateRuleInput {
  name?: string
  eventType?: string
  conditions?: Record<string, unknown>
  actionMode?: RuleActionMode
  actions?: Array<{
    actionType: string
    params?: Record<string, unknown>
  }>
  riskLevel?: RiskLevel
  priority?: number
  dedupeWindowSeconds?: number
  cooldownSeconds?: number
  attentionBudgetPerDay?: number
  isActive?: boolean
}

let initPromise: Promise<void> | null = null

async function seedIfEmpty(): Promise<void> {
  const eventCount = await sql<Array<{ count: string }>>`
    SELECT COUNT(*)::text AS count FROM semibot_events
  `
  if (Number(eventCount[0]?.count ?? 0) === 0) {
    await sql`
      INSERT INTO semibot_events (
        id, event_type, source, subject, payload, risk_hint
      )
      VALUES (
        ${`evt_${uuidv4()}`},
        'system.boot.completed',
        'system',
        'node:local',
        ${sql.json({ message: 'Semibot event API ready' } as Parameters<typeof sql.json>[0])},
        'low'
      )
    `
  }

  const ruleCount = await sql<Array<{ count: string }>>`
    SELECT COUNT(*)::text AS count FROM semibot_event_rules
  `
  if (Number(ruleCount[0]?.count ?? 0) === 0) {
    await sql`
      INSERT INTO semibot_event_rules (
        id, name, event_type, conditions, action_mode, actions,
        risk_level, priority, dedupe_window_seconds, cooldown_seconds,
        attention_budget_per_day, is_active
      )
      VALUES (
        ${`rule_${uuidv4()}`},
        'default_system_notice',
        'system.boot.completed',
        ${sql.json({ all: [] } as Parameters<typeof sql.json>[0])},
        'suggest',
        ${sql.json([{ action_type: 'notify', params: { channel: 'chat' } }] as Parameters<typeof sql.json>[0])},
        'low',
        50,
        300,
        600,
        10,
        true
      )
    `
  }

  const approvalCount = await sql<Array<{ count: string }>>`
    SELECT COUNT(*)::text AS count FROM semibot_approval_requests
  `
  if (Number(approvalCount[0]?.count ?? 0) === 0) {
    await sql`
      INSERT INTO semibot_approval_requests (
        id, event_type, status, risk_level, reason
      )
      VALUES (
        ${`appr_${uuidv4()}`},
        'tool.exec.high_risk',
        'pending',
        'high',
        '示例审批：高风险操作需人工确认'
      )
    `
  }
}

async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS semibot_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          source TEXT NOT NULL,
          subject TEXT NULL,
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          risk_hint TEXT NOT NULL DEFAULT 'low',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `

      await sql`
        CREATE TABLE IF NOT EXISTS semibot_event_rules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          event_type TEXT NOT NULL,
          conditions JSONB NOT NULL DEFAULT '{"all":[]}'::jsonb,
          action_mode TEXT NOT NULL,
          actions JSONB NOT NULL DEFAULT '[]'::jsonb,
          risk_level TEXT NOT NULL DEFAULT 'low',
          priority INTEGER NOT NULL DEFAULT 50,
          dedupe_window_seconds INTEGER NOT NULL DEFAULT 300,
          cooldown_seconds INTEGER NOT NULL DEFAULT 600,
          attention_budget_per_day INTEGER NOT NULL DEFAULT 10,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `

      await sql`
        CREATE TABLE IF NOT EXISTS semibot_approval_requests (
          id TEXT PRIMARY KEY,
          event_id TEXT NULL,
          event_type TEXT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          reason TEXT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ NULL
        )
      `

      await seedIfEmpty()
    })()
  }

  await initPromise
}

function mapEventRow(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    eventType: String(row.event_type),
    source: String(row.source),
    subject: row.subject ? String(row.subject) : undefined,
    payload: (row.payload as Record<string, unknown>) ?? {},
    riskHint: String(row.risk_hint) as RiskLevel,
    createdAt: String(row.created_at),
  }
}

function mapRuleRow(row: Record<string, unknown>): EventRule {
  return {
    id: String(row.id),
    name: String(row.name),
    eventType: String(row.event_type),
    actionMode: String(row.action_mode) as RuleActionMode,
    riskLevel: String(row.risk_level) as RiskLevel,
    priority: Number(row.priority),
    dedupeWindowSeconds: Number(row.dedupe_window_seconds),
    cooldownSeconds: Number(row.cooldown_seconds),
    attentionBudgetPerDay: Number(row.attention_budget_per_day),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapApprovalRow(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    eventId: row.event_id ? String(row.event_id) : undefined,
    eventType: row.event_type ? String(row.event_type) : undefined,
    status: String(row.status) as ApprovalStatus,
    riskLevel: String(row.risk_level) as RiskLevel,
    reason: row.reason ? String(row.reason) : undefined,
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
  }
}

export async function listEvents(input: {
  type?: string
  limit?: number
}): Promise<EventRecord[]> {
  await ensureInitialized()
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, event_type, source, subject, payload, risk_hint, created_at
    FROM semibot_events
    WHERE (${input.type ?? null}::text IS NULL OR event_type = ${input.type ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
  return rows.map(mapEventRow)
}

export async function replayEvent(eventId: string): Promise<{ replayId: string }> {
  await ensureInitialized()
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, event_type, source, subject, payload, risk_hint
    FROM semibot_events
    WHERE id = ${eventId}
    LIMIT 1
  `
  const source = rows[0]
  const replayId = `rpl_${uuidv4()}`

  if (source) {
    const clonedEventId = `evt_${uuidv4()}`
    await sql`
      INSERT INTO semibot_events (
        id, event_type, source, subject, payload, risk_hint
      )
      VALUES (
        ${clonedEventId},
        ${String(source.event_type)},
        'replay',
        ${source.subject ? String(source.subject) : null},
        ${sql.json({
          replay_id: replayId,
          original_event_id: eventId,
          original_payload: source.payload ?? {},
        } as unknown as Parameters<typeof sql.json>[0])},
        ${String(source.risk_hint ?? 'low')}
      )
    `
  }

  return { replayId }
}

export async function listRules(): Promise<EventRule[]> {
  await ensureInitialized()
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT
      id, name, event_type, action_mode, risk_level, priority,
      dedupe_window_seconds, cooldown_seconds, attention_budget_per_day,
      is_active, created_at, updated_at
    FROM semibot_event_rules
    ORDER BY priority DESC, created_at DESC
  `
  return rows.map(mapRuleRow)
}

export async function createRule(input: CreateRuleInput): Promise<{ id: string }> {
  await ensureInitialized()
  const id = `rule_${uuidv4()}`
  await sql`
    INSERT INTO semibot_event_rules (
      id, name, event_type, conditions, action_mode, actions,
      risk_level, priority, dedupe_window_seconds, cooldown_seconds,
      attention_budget_per_day, is_active
    )
    VALUES (
      ${id},
      ${input.name},
      ${input.eventType},
      ${sql.json((input.conditions ?? { all: [] }) as Parameters<typeof sql.json>[0])},
      ${input.actionMode},
      ${sql.json(input.actions as unknown as Parameters<typeof sql.json>[0])},
      ${input.riskLevel},
      ${input.priority},
      ${input.dedupeWindowSeconds},
      ${input.cooldownSeconds},
      ${input.attentionBudgetPerDay},
      ${input.isActive}
    )
  `
  return { id }
}

export async function updateRule(ruleId: string, input: UpdateRuleInput): Promise<EventRule | null> {
  await ensureInitialized()

  const rows = await sql<Array<Record<string, unknown>>>`
    UPDATE semibot_event_rules
    SET
      name = COALESCE(${input.name ?? null}, name),
      event_type = COALESCE(${input.eventType ?? null}, event_type),
      conditions = COALESCE(${input.conditions ? sql.json(input.conditions as Parameters<typeof sql.json>[0]) : null}, conditions),
      action_mode = COALESCE(${input.actionMode ?? null}, action_mode),
      actions = COALESCE(${input.actions ? sql.json(input.actions as unknown as Parameters<typeof sql.json>[0]) : null}, actions),
      risk_level = COALESCE(${input.riskLevel ?? null}, risk_level),
      priority = COALESCE(${input.priority ?? null}, priority),
      dedupe_window_seconds = COALESCE(${input.dedupeWindowSeconds ?? null}, dedupe_window_seconds),
      cooldown_seconds = COALESCE(${input.cooldownSeconds ?? null}, cooldown_seconds),
      attention_budget_per_day = COALESCE(${input.attentionBudgetPerDay ?? null}, attention_budget_per_day),
      is_active = COALESCE(${input.isActive ?? null}, is_active),
      updated_at = NOW()
    WHERE id = ${ruleId}
    RETURNING
      id, name, event_type, action_mode, risk_level, priority,
      dedupe_window_seconds, cooldown_seconds, attention_budget_per_day,
      is_active, created_at, updated_at
  `

  return rows[0] ? mapRuleRow(rows[0]) : null
}

export async function listApprovals(input: {
  status?: ApprovalStatus
  limit?: number
}): Promise<ApprovalRecord[]> {
  await ensureInitialized()
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT
      id, event_id, event_type, status, risk_level, reason, created_at, resolved_at
    FROM semibot_approval_requests
    WHERE (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
  return rows.map(mapApprovalRow)
}

export async function resolveApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  reason?: string
): Promise<ApprovalRecord | null> {
  await ensureInitialized()
  const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'rejected'
  const rows = await sql<Array<Record<string, unknown>>>`
    UPDATE semibot_approval_requests
    SET
      status = ${status},
      reason = COALESCE(${reason ?? null}, reason),
      resolved_at = NOW()
    WHERE id = ${approvalId}
    RETURNING id, event_id, event_type, status, risk_level, reason, created_at, resolved_at
  `
  return rows[0] ? mapApprovalRow(rows[0]) : null
}
