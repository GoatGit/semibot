/**
 * Event Engine 本地文件存储
 *
 * 单用户模式下将 events / rules / approvals 持久化到
 * ~/.semibot/events/events.json
 */

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createLogger } from './logger'

const logger = createLogger('event-engine-local-store')
const LOCAL_DIR = path.join(os.homedir(), '.semibot', 'events')
const LOCAL_FILE = path.join(LOCAL_DIR, 'events.json')

type RiskLevel = 'low' | 'medium' | 'high'
type RuleActionMode = 'ask' | 'suggest' | 'auto' | 'skip'
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface LocalEventRow {
  id: string
  event_type: string
  source: string
  subject: string | null
  payload: Record<string, unknown>
  risk_hint: RiskLevel
  created_at: string
}

export interface LocalRuleRow {
  id: string
  name: string
  event_type: string
  conditions: Record<string, unknown>
  action_mode: RuleActionMode
  actions: Array<{ action_type: string; params?: Record<string, unknown> }>
  risk_level: RiskLevel
  priority: number
  dedupe_window_seconds: number
  cooldown_seconds: number
  attention_budget_per_day: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface LocalApprovalRow {
  id: string
  event_id: string | null
  event_type: string | null
  status: ApprovalStatus
  risk_level: RiskLevel
  reason: string | null
  created_at: string
  resolved_at: string | null
}

interface LocalStore {
  events: LocalEventRow[]
  rules: LocalRuleRow[]
  approvals: LocalApprovalRow[]
  org_settings: Record<string, Record<string, unknown>> // orgId → settings
}

async function readStore(): Promise<LocalStore> {
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf-8')
    return JSON.parse(raw) as LocalStore
  } catch {
    return { events: [], rules: [], approvals: [], org_settings: {} }
  }
}

async function writeStore(store: LocalStore): Promise<void> {
  await fs.mkdir(LOCAL_DIR, { recursive: true })
  await fs.writeFile(LOCAL_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

function nowIso(): string {
  return new Date().toISOString()
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function localListEvents(type?: string, limit = 50): Promise<LocalEventRow[]> {
  const store = await readStore()
  let events = store.events
  if (type) events = events.filter((e) => e.event_type === type)
  return events
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.min(limit, 200))
}

export async function localFindEventById(id: string): Promise<LocalEventRow | null> {
  const store = await readStore()
  return store.events.find((e) => e.id === id) ?? null
}

export async function localCreateEvent(data: Omit<LocalEventRow, 'created_at'>): Promise<LocalEventRow> {
  const store = await readStore()
  const row: LocalEventRow = { ...data, created_at: nowIso() }
  store.events.push(row)
  // 保留最近 1000 条
  if (store.events.length > 1000) store.events = store.events.slice(-1000)
  await writeStore(store)
  return row
}

// ─── Rules ────────────────────────────────────────────────────────────────────

export async function localListRules(): Promise<LocalRuleRow[]> {
  const store = await readStore()
  return store.rules.sort((a, b) => b.priority - a.priority || b.created_at.localeCompare(a.created_at))
}

export async function localCreateRule(data: Omit<LocalRuleRow, 'id' | 'created_at' | 'updated_at'>): Promise<LocalRuleRow> {
  const store = await readStore()
  const row: LocalRuleRow = {
    ...data,
    id: `rule_${randomUUID()}`,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  store.rules.push(row)
  await writeStore(store)
  logger.info('本地创建规则', { id: row.id, name: data.name })
  return row
}

export async function localUpdateRule(
  id: string,
  patch: Partial<Omit<LocalRuleRow, 'id' | 'created_at'>>
): Promise<LocalRuleRow | null> {
  const store = await readStore()
  const idx = store.rules.findIndex((r) => r.id === id)
  if (idx === -1) return null
  store.rules[idx] = { ...store.rules[idx], ...patch, updated_at: nowIso() }
  await writeStore(store)
  return store.rules[idx]
}

// ─── Approvals ────────────────────────────────────────────────────────────────

export async function localListApprovals(status?: ApprovalStatus, limit = 50): Promise<LocalApprovalRow[]> {
  const store = await readStore()
  let approvals = store.approvals
  if (status) approvals = approvals.filter((a) => a.status === status)
  return approvals
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.min(limit, 200))
}

export async function localCreateApproval(data: Omit<LocalApprovalRow, 'created_at' | 'resolved_at'>): Promise<LocalApprovalRow> {
  const store = await readStore()
  const row: LocalApprovalRow = { ...data, created_at: nowIso(), resolved_at: null }
  store.approvals.push(row)
  await writeStore(store)
  return row
}

export async function localResolveApproval(
  id: string,
  status: 'approved' | 'rejected',
  reason?: string
): Promise<LocalApprovalRow | null> {
  const store = await readStore()
  const idx = store.approvals.findIndex((a) => a.id === id)
  if (idx === -1) return null
  store.approvals[idx] = {
    ...store.approvals[idx],
    status,
    reason: reason ?? store.approvals[idx].reason,
    resolved_at: nowIso(),
  }
  await writeStore(store)
  return store.approvals[idx]
}

// ─── Org Settings ─────────────────────────────────────────────────────────────

export async function localGetOrgSettings(): Promise<Record<string, unknown>> {
  const store = await readStore()
  return store.org_settings['local'] ?? {}
}

export async function localUpdateOrgSettings(
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const store = await readStore()
  store.org_settings['local'] = { ...(store.org_settings['local'] ?? {}), ...patch }
  await writeStore(store)
  return store.org_settings['local']
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

export async function localSeedIfEmpty(): Promise<void> {
  const store = await readStore()
  if (store.events.length === 0) {
    store.events.push({
      id: `evt_${randomUUID()}`,
      event_type: 'system.boot.completed',
      source: 'system',
      subject: 'node:local',
      payload: { message: 'Semibot event API ready' },
      risk_hint: 'low',
      created_at: nowIso(),
    })
  }
  if (store.rules.length === 0) {
    store.rules.push({
      id: `rule_${randomUUID()}`,
      name: 'default_system_notice',
      event_type: 'system.boot.completed',
      conditions: { all: [] },
      action_mode: 'suggest',
      actions: [{ action_type: 'notify', params: { channel: 'chat' } }],
      risk_level: 'low',
      priority: 50,
      dedupe_window_seconds: 300,
      cooldown_seconds: 600,
      attention_budget_per_day: 10,
      is_active: true,
      created_at: nowIso(),
      updated_at: nowIso(),
    })
  }
  if (store.approvals.length === 0) {
    store.approvals.push({
      id: `appr_${randomUUID()}`,
      event_id: null,
      event_type: 'tool.exec.high_risk',
      status: 'pending',
      risk_level: 'high',
      reason: '示例审批：高风险操作需人工确认',
      created_at: nowIso(),
      resolved_at: null,
    })
  }
  await writeStore(store)
}
