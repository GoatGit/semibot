/**
 * Webhook 类型定义
 */

// ═══════════════════════════════════════════════════════════════
// 数据库行类型
// ═══════════════════════════════════════════════════════════════

export interface WebhookRow {
  id: string
  org_id: string
  url: string
  secret: string
  events: string[]
  is_active: boolean
  failure_count: number
  last_triggered_at: string | null
  version: number
  created_at: string
  created_by: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

export interface WebhookLogRow {
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
// 输入类型
// ═══════════════════════════════════════════════════════════════

export interface CreateWebhookInput {
  url: string
  secret: string
  events: string[]
}

export interface UpdateWebhookInput {
  url?: string
  secret?: string
  events?: string[]
  isActive?: boolean
}

// ═══════════════════════════════════════════════════════════════
// 事件类型
// ══════════════════════════���════════════════════════════════════

export const WEBHOOK_EVENT_TYPES = [
  'agent.execution.completed',
  'agent.execution.failed',
  'evolution.skill_created',
  'evolution.skill_promoted',
  'session.created',
  'session.ended',
  'webhook.test',
] as const

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number]
