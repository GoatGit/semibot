/**
 * Webhook Repository
 *
 * 处理 Webhook 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface WebhookRow {
  id: string
  org_id: string
  url: string
  secret: string
  events: string[]
  is_active: boolean
  failure_count: number
  last_failure_at: string | null
  version: number
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
  deleted_at: string | null
}

export interface WebhookDeliveryRow {
  id: string
  webhook_id: string
  event_type: string
  payload: Record<string, unknown>
  response_status: number | null
  response_body: string | null
  attempt: number
  status: 'pending' | 'success' | 'failed'
  created_at: string
}

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface CreateWebhookData {
  orgId: string
  url: string
  secret: string
  events: string[]
  isActive?: boolean
  createdBy: string
}

export interface UpdateWebhookData {
  url?: string
  secret?: string
  events?: string[]
  isActive?: boolean
  updatedBy: string
}

export interface ListWebhooksParams {
  orgId: string
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
// Repository 方法
// ═══════════════════════════════════════════════════════════════

export async function create(data: CreateWebhookData): Promise<WebhookRow> {
  const result = await sql`
    INSERT INTO webhooks (org_id, url, secret, events, is_active, created_by, updated_by)
    VALUES (
      ${data.orgId},
      ${data.url},
      ${data.secret},
      ${data.events},
      ${data.isActive ?? true},
      ${data.createdBy},
      ${data.createdBy}
    )
    RETURNING *
  `
  return result[0] as unknown as WebhookRow
}

export async function findById(id: string, orgId: string): Promise<WebhookRow | null> {
  const result = await sql`
    SELECT * FROM webhooks
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
  `
  if (result.length === 0) return null
  return result[0] as unknown as WebhookRow
}

export async function findByOrg(params: ListWebhooksParams): Promise<PaginatedResult<WebhookRow>> {
  const { orgId, page = 1, limit = DEFAULT_PAGE_SIZE } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  logPaginationLimit('WebhookRepository', limit, actualLimit, MAX_PAGE_SIZE)

  const countResult = await sql`
    SELECT COUNT(*) as total FROM webhooks
    WHERE org_id = ${orgId} AND deleted_at IS NULL
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  const dataResult = await sql`
    SELECT * FROM webhooks
    WHERE org_id = ${orgId} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  return {
    data: dataResult as unknown as WebhookRow[],
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}

export async function findActiveByOrgAndEvent(orgId: string, eventType: string): Promise<WebhookRow[]> {
  const result = await sql`
    SELECT * FROM webhooks
    WHERE org_id = ${orgId}
      AND is_active = true
      AND deleted_at IS NULL
      AND ${eventType} = ANY(events)
    ORDER BY created_at ASC
  `
  return result as unknown as WebhookRow[]
}

export async function update(id: string, orgId: string, data: UpdateWebhookData): Promise<WebhookRow | null> {
  const sets: ReturnType<typeof sql>[] = []

  if (data.url !== undefined) sets.push(sql`url = ${data.url}`)
  if (data.secret !== undefined) sets.push(sql`secret = ${data.secret}`)
  if (data.events !== undefined) sets.push(sql`events = ${data.events}`)
  if (data.isActive !== undefined) sets.push(sql`is_active = ${data.isActive}`)

  sets.push(sql`updated_by = ${data.updatedBy}`)
  sets.push(sql`version = version + 1`)
  sets.push(sql`updated_at = NOW()`)

  // 动态拼接 SET 子句
  let setClause = sets[0]
  for (let i = 1; i < sets.length; i++) {
    setClause = sql`${setClause}, ${sets[i]}`
  }

  const result = await sql`
    UPDATE webhooks
    SET ${setClause}
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING *
  `

  if (result.length === 0) return null
  return result[0] as unknown as WebhookRow
}

export async function softDelete(id: string, orgId: string, deletedBy: string): Promise<boolean> {
  const result = await sql`
    UPDATE webhooks
    SET deleted_at = NOW(),
        updated_by = ${deletedBy},
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING id
  `
  return result.length > 0
}

export async function countByOrg(orgId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as total FROM webhooks
    WHERE org_id = ${orgId} AND deleted_at IS NULL
  `
  return parseInt((result[0] as { total: string }).total, 10)
}

export async function incrementFailureCount(id: string): Promise<void> {
  await sql`
    UPDATE webhooks
    SET failure_count = failure_count + 1,
        last_failure_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function resetFailureCount(id: string): Promise<void> {
  await sql`
    UPDATE webhooks
    SET failure_count = 0,
        updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function disableWebhook(id: string): Promise<void> {
  await sql`
    UPDATE webhooks
    SET is_active = false,
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${id}
  `
}

// ═══════════════════════════════════════════════════════════════
// Delivery 记录
// ═══════════════════════════════════════════════════════════════

export async function createDelivery(data: {
  webhookId: string
  eventType: string
  payload: Record<string, unknown>
  responseStatus?: number
  responseBody?: string
  attempt: number
  status: 'pending' | 'success' | 'failed'
}): Promise<WebhookDeliveryRow> {
  const result = await sql`
    INSERT INTO webhook_deliveries (
      webhook_id, event_type, payload,
      response_status, response_body, attempt, status
    )
    VALUES (
      ${data.webhookId},
      ${data.eventType},
      ${sql.json(data.payload as Parameters<typeof sql.json>[0])},
      ${data.responseStatus ?? null},
      ${data.responseBody ?? null},
      ${data.attempt},
      ${data.status}
    )
    RETURNING *
  `
  return result[0] as unknown as WebhookDeliveryRow
}

export async function findDeliveriesByWebhook(
  webhookId: string,
  page: number = 1,
  limit: number = DEFAULT_PAGE_SIZE
): Promise<PaginatedResult<WebhookDeliveryRow>> {
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  const countResult = await sql`
    SELECT COUNT(*) as total FROM webhook_deliveries
    WHERE webhook_id = ${webhookId}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  const dataResult = await sql`
    SELECT * FROM webhook_deliveries
    WHERE webhook_id = ${webhookId}
    ORDER BY created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  return {
    data: dataResult as unknown as WebhookDeliveryRow[],
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}
