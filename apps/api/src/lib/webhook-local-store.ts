/**
 * Webhook SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'

export interface LocalWebhookRow {
  id: string
  org_id: string
  name: string
  url: string
  events: string[]
  secret: string
  is_active: boolean
  failure_count: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface LocalWebhookDeliveryRow {
  id: string
  webhook_id: string
  event_type: string
  payload: Record<string, unknown>
  status: string
  response_status: number | null
  response_body: string | null
  error_message: string | null
  attempt_count: number
  next_retry_at: string | null
  delivered_at: string | null
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToWebhook(row: Record<string, unknown>): LocalWebhookRow {
  return {
    id: row.id as string,
    org_id: 'local',
    name: (row.name as string) ?? '',
    url: row.url as string,
    events: JSON.parse((row.events_json as string) ?? '[]'),
    secret: (row.secret as string) ?? '',
    is_active: (row.is_active as number) === 1,
    failure_count: (row.failure_count as number) ?? 0,
    metadata: JSON.parse((row.metadata_json as string) ?? '{}'),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: (row.deleted_at as string) ?? null,
  }
}

function rowToDelivery(row: Record<string, unknown>): LocalWebhookDeliveryRow {
  return {
    id: row.id as string,
    webhook_id: row.webhook_id as string,
    event_type: row.event_type as string,
    payload: JSON.parse((row.payload_json as string) ?? '{}'),
    status: row.status as string,
    response_status: (row.response_status as number) ?? null,
    response_body: (row.response_body as string) ?? null,
    error_message: (row.error_message as string) ?? null,
    attempt_count: (row.attempt_count as number) ?? 0,
    next_retry_at: (row.next_retry_at as string) ?? null,
    delivered_at: (row.delivered_at as string) ?? null,
    created_at: row.created_at as string,
  }
}

export function localCreateWebhook(data: {
  name?: string
  url: string
  events: string[]
  secret?: string
  isActive?: boolean
  createdBy?: string
  metadata?: Record<string, unknown>
}): LocalWebhookRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO webhooks (id, name, url, events_json, secret, is_active, failure_count, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, data.name ?? '', data.url, JSON.stringify(data.events), data.secret ?? '', data.isActive !== false ? 1 : 0, JSON.stringify(data.metadata ?? {}), now, now)
  return rowToWebhook(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindWebhookById(id: string): LocalWebhookRow | null {
  const row = getLocalDb().prepare('SELECT * FROM webhooks WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToWebhook(row as Record<string, unknown>) : null
}

export function localFindWebhooksByOrg(options: { page?: number; limit?: number } = {}): {
  data: LocalWebhookRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
} {
  const db = getLocalDb()
  const page = Math.max(1, options.page ?? 1)
  const limit = Math.min(options.limit ?? 20, 100)
  const total = (db.prepare('SELECT COUNT(*) as c FROM webhooks WHERE deleted_at IS NULL').get() as { c: number }).c
  const rows = db.prepare('SELECT * FROM webhooks WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, (page - 1) * limit)
  return { data: rows.map((r) => rowToWebhook(r as Record<string, unknown>)), meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } }
}

export function localCountWebhooksByOrg(): number {
  return (getLocalDb().prepare('SELECT COUNT(*) as c FROM webhooks WHERE deleted_at IS NULL').get() as { c: number }).c
}

export function localFindActiveWebhooksByEvent(eventType: string): LocalWebhookRow[] {
  const rows = getLocalDb().prepare(
    "SELECT * FROM webhooks WHERE is_active = 1 AND deleted_at IS NULL AND (events_json LIKE ? OR events_json LIKE '%\"*\"%')"
  ).all(`%"${eventType}"%`)
  return rows.map((r) => rowToWebhook(r as Record<string, unknown>))
}

export function localFindActiveWebhooksByOrgAndEvent(eventType: string): LocalWebhookRow[] {
  return localFindActiveWebhooksByEvent(eventType)
}

export function localUpdateWebhook(id: string, data: {
  name?: string
  url?: string
  events?: string[]
  secret?: string | null
  isActive?: boolean
  updatedBy?: string
  metadata?: Record<string, unknown>
}): LocalWebhookRow | null {
  const db = getLocalDb()
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [nowIso()]
  if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name) }
  if (data.url !== undefined) { sets.push('url = ?'); vals.push(data.url) }
  if (data.events !== undefined) { sets.push('events_json = ?'); vals.push(JSON.stringify(data.events)) }
  if (data.secret !== undefined) { sets.push('secret = ?'); vals.push(data.secret) }
  if (data.isActive !== undefined) { sets.push('is_active = ?'); vals.push(data.isActive ? 1 : 0) }
  if (data.metadata !== undefined) { sets.push('metadata_json = ?'); vals.push(JSON.stringify(data.metadata)) }
  vals.push(id)
  const result = db.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...vals)
  if ((result.changes ?? 0) === 0) return null
  return rowToWebhook(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localSoftDeleteWebhook(id: string, _orgId?: string, _deletedBy?: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE webhooks SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), nowIso(), id)
  return (result.changes ?? 0) > 0
}

export function localIncrementWebhookFailureCount(id: string): void {
  getLocalDb().prepare(
    'UPDATE webhooks SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?'
  ).run(nowIso(), id)
}

export function localResetWebhookFailureCount(id: string): void {
  getLocalDb().prepare(
    'UPDATE webhooks SET failure_count = 0, updated_at = ? WHERE id = ?'
  ).run(nowIso(), id)
}

export function localDisableWebhook(id: string): void {
  getLocalDb().prepare(
    'UPDATE webhooks SET is_active = 0, updated_at = ? WHERE id = ?'
  ).run(nowIso(), id)
}

export function localCreateDelivery(data: {
  webhookId: string
  eventType: string
  payload: Record<string, unknown>
  responseStatus?: number
  responseBody?: string
  attempt: number
  status: string
}): LocalWebhookDeliveryRow {
  return localCreateWebhookDelivery({
    webhookId: data.webhookId,
    eventType: data.eventType,
    payload: data.payload,
  })
}

export function localFindDeliveriesByWebhook(webhookId: string, page = 1, limit = 20): {
  data: LocalWebhookDeliveryRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
} {
  const db = getLocalDb()
  const total = (db.prepare('SELECT COUNT(*) as c FROM webhook_deliveries WHERE webhook_id = ?').get(webhookId) as { c: number }).c
  const rows = db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(webhookId, limit, (page - 1) * limit)
  return { data: rows.map((r) => rowToDelivery(r as Record<string, unknown>)), meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } }
}

export function localCreateWebhookDelivery(data: {
  webhookId: string
  eventType: string
  payload: Record<string, unknown>
}): LocalWebhookDeliveryRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload_json, status, attempt_count, created_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?)
  `).run(id, data.webhookId, data.eventType, JSON.stringify(data.payload), now)
  return rowToDelivery(db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localUpdateWebhookDelivery(id: string, data: {
  status: string
  responseStatus?: number
  responseBody?: string
  errorMessage?: string
  nextRetryAt?: string
  deliveredAt?: string
}): LocalWebhookDeliveryRow | null {
  const db = getLocalDb()
  db.prepare(`
    UPDATE webhook_deliveries SET
      status = ?, response_status = ?, response_body = ?, error_message = ?,
      next_retry_at = ?, delivered_at = ?, attempt_count = attempt_count + 1
    WHERE id = ?
  `).run(data.status, data.responseStatus ?? null, data.responseBody ?? null, data.errorMessage ?? null,
    data.nextRetryAt ?? null, data.deliveredAt ?? null, id)
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id)
  return row ? rowToDelivery(row as Record<string, unknown>) : null
}

export function localFindPendingWebhookDeliveries(limit = 50): LocalWebhookDeliveryRow[] {
  const rows = getLocalDb().prepare(
    "SELECT * FROM webhook_deliveries WHERE status IN ('pending', 'retrying') AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC LIMIT ?"
  ).all(nowIso(), limit)
  return rows.map((r) => rowToDelivery(r as Record<string, unknown>))
}
