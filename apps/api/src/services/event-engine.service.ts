/**
 * Event Engine 轻量服务
 *
 * 为前端 Events / Rules / Approvals 页面提供最小可用 API。
 * 单用户模式：数据持久化到 ~/.semibot/events/events.json
 */

import { randomUUID } from 'crypto'
import * as local from '../lib/event-engine-local-store'

type RiskLevel = 'low' | 'medium' | 'high'
type RuleActionMode = 'ask' | 'suggest' | 'auto' | 'skip'
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface EventPresentationDictionary {
  eventTypeLabels: Record<string, string>
  categoryLabels: Record<string, string>
  actionLabels: Record<string, string>
}

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
  actions: Array<{ actionType: string; params?: Record<string, unknown> }>
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
  actions?: Array<{ actionType: string; params?: Record<string, unknown> }>
  riskLevel?: RiskLevel
  priority?: number
  dedupeWindowSeconds?: number
  cooldownSeconds?: number
  attentionBudgetPerDay?: number
  isActive?: boolean
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = String(key || '').trim()
    const safeValue = typeof item === 'string' ? item.trim() : ''
    if (!safeKey || !safeValue) continue
    output[safeKey] = safeValue
  }
  return output
}

function normalizeDictionary(value: unknown): EventPresentationDictionary {
  const raw = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {}
  return {
    eventTypeLabels: readStringMap(raw.eventTypeLabels ?? raw.event_types),
    categoryLabels: readStringMap(raw.categoryLabels ?? raw.categories),
    actionLabels: readStringMap(raw.actionLabels ?? raw.actions),
  }
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

let initialized = false

async function ensureInitialized(): Promise<void> {
  if (initialized) return
  await local.localSeedIfEmpty()
  initialized = true
}

// ─── 服务方法 ─────────────────────────────────────────────────────────────────

export async function getEventPresentationDictionary(): Promise<EventPresentationDictionary> {
  const settings = await local.localGetOrgSettings()
  return normalizeDictionary(settings.eventPresentation)
}

export async function updateEventPresentationDictionary(
  input: Partial<EventPresentationDictionary>
): Promise<EventPresentationDictionary> {
  const current = await getEventPresentationDictionary()
  const next: EventPresentationDictionary = {
    eventTypeLabels: { ...current.eventTypeLabels, ...readStringMap(input.eventTypeLabels) },
    categoryLabels: { ...current.categoryLabels, ...readStringMap(input.categoryLabels) },
    actionLabels: { ...current.actionLabels, ...readStringMap(input.actionLabels) },
  }
  await local.localUpdateOrgSettings({ eventPresentation: next })
  return next
}

export async function listEvents(input: { type?: string; limit?: number }): Promise<EventRecord[]> {
  await ensureInitialized()
  const rows = await local.localListEvents(input.type, input.limit)
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    source: r.source,
    subject: r.subject ?? undefined,
    payload: r.payload,
    riskHint: r.risk_hint,
    createdAt: r.created_at,
  }))
}

export async function replayEvent(eventId: string): Promise<{ replayId: string }> {
  await ensureInitialized()
  const source = await local.localFindEventById(eventId)
  const replayId = `rpl_${randomUUID()}`
  if (source) {
    await local.localCreateEvent({
      id: `evt_${randomUUID()}`,
      event_type: source.event_type,
      source: 'replay',
      subject: source.subject,
      payload: { replay_id: replayId, original_event_id: eventId, original_payload: source.payload },
      risk_hint: source.risk_hint,
    })
  }
  return { replayId }
}

export async function listRules(): Promise<EventRule[]> {
  await ensureInitialized()
  const rows = await local.localListRules()
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    eventType: r.event_type,
    actionMode: r.action_mode,
    riskLevel: r.risk_level,
    priority: r.priority,
    dedupeWindowSeconds: r.dedupe_window_seconds,
    cooldownSeconds: r.cooldown_seconds,
    attentionBudgetPerDay: r.attention_budget_per_day,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export async function createRule(input: CreateRuleInput): Promise<{ id: string }> {
  await ensureInitialized()
  const row = await local.localCreateRule({
    name: input.name,
    event_type: input.eventType,
    conditions: input.conditions ?? { all: [] },
    action_mode: input.actionMode,
    actions: input.actions.map((a) => ({ action_type: a.actionType, params: a.params })),
    risk_level: input.riskLevel,
    priority: input.priority,
    dedupe_window_seconds: input.dedupeWindowSeconds,
    cooldown_seconds: input.cooldownSeconds,
    attention_budget_per_day: input.attentionBudgetPerDay,
    is_active: input.isActive,
  })
  return { id: row.id }
}

export async function updateRule(ruleId: string, input: UpdateRuleInput): Promise<EventRule | null> {
  await ensureInitialized()
  const patch: Parameters<typeof local.localUpdateRule>[1] = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.eventType !== undefined) patch.event_type = input.eventType
  if (input.conditions !== undefined) patch.conditions = input.conditions
  if (input.actionMode !== undefined) patch.action_mode = input.actionMode
  if (input.actions !== undefined) patch.actions = input.actions.map((a) => ({ action_type: a.actionType, params: a.params }))
  if (input.riskLevel !== undefined) patch.risk_level = input.riskLevel
  if (input.priority !== undefined) patch.priority = input.priority
  if (input.dedupeWindowSeconds !== undefined) patch.dedupe_window_seconds = input.dedupeWindowSeconds
  if (input.cooldownSeconds !== undefined) patch.cooldown_seconds = input.cooldownSeconds
  if (input.attentionBudgetPerDay !== undefined) patch.attention_budget_per_day = input.attentionBudgetPerDay
  if (input.isActive !== undefined) patch.is_active = input.isActive

  const row = await local.localUpdateRule(ruleId, patch)
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    eventType: row.event_type,
    actionMode: row.action_mode,
    riskLevel: row.risk_level,
    priority: row.priority,
    dedupeWindowSeconds: row.dedupe_window_seconds,
    cooldownSeconds: row.cooldown_seconds,
    attentionBudgetPerDay: row.attention_budget_per_day,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listApprovals(input: { status?: ApprovalStatus; limit?: number }): Promise<ApprovalRecord[]> {
  await ensureInitialized()
  const rows = await local.localListApprovals(input.status, input.limit)
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id ?? undefined,
    eventType: r.event_type ?? undefined,
    status: r.status,
    riskLevel: r.risk_level,
    reason: r.reason ?? undefined,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? undefined,
  }))
}

export async function resolveApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  reason?: string
): Promise<ApprovalRecord | null> {
  await ensureInitialized()
  const status = decision === 'approve' ? 'approved' : 'rejected'
  const row = await local.localResolveApproval(approvalId, status, reason)
  if (!row) return null
  return {
    id: row.id,
    eventId: row.event_id ?? undefined,
    eventType: row.event_type ?? undefined,
    status: row.status,
    riskLevel: row.risk_level,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  }
}
