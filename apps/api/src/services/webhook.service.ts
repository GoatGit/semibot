/**
 * Webhook Service
 *
 * Webhook 订阅管理、事件分发、重试机制
 */

import crypto from 'node:crypto'
import { createLogger } from '../lib/logger'
import { createError } from '../middleware/errorHandler'
import {
  WEBHOOK_NOT_FOUND,
  WEBHOOK_LIMIT_EXCEEDED,
  WEBHOOK_DISABLED,
} from '../constants/errorCodes'
import {
  MAX_WEBHOOKS_PER_ORG,
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_MAX_FAILURE_COUNT,
  WEBHOOK_RETRY_BASE_DELAY_MS,
} from '../constants/config'
import * as local from '../lib/webhook-local-store'
import type { LocalWebhookRow } from '../lib/webhook-local-store'

export type { LocalWebhookRow as WebhookRow }

const logger = createLogger('webhook-service')

// ═══════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════

export async function createWebhook(
  userId: string,
  input: { url: string; secret: string; events: string[]; isActive?: boolean }
): Promise<LocalWebhookRow> {
  const count = local.localCountWebhooksByOrg()
  if (count >= MAX_WEBHOOKS_PER_ORG) throw createError(WEBHOOK_LIMIT_EXCEEDED)
  return local.localCreateWebhook({ url: input.url, secret: input.secret, events: input.events, isActive: input.isActive, createdBy: userId })
}

export async function getWebhook(id: string): Promise<LocalWebhookRow> {
  const webhook = local.localFindWebhookById(id)
  if (!webhook) throw createError(WEBHOOK_NOT_FOUND)
  return webhook
}

export async function listWebhooks(options: { page?: number; limit?: number }) {
  return local.localFindWebhooksByOrg(options)
}

export async function updateWebhook(
  id: string,
  userId: string,
  input: { url?: string; secret?: string; events?: string[]; isActive?: boolean }
): Promise<LocalWebhookRow> {
  const webhook = local.localUpdateWebhook(id, { ...input, updatedBy: userId })
  if (!webhook) throw createError(WEBHOOK_NOT_FOUND)
  return webhook
}

export async function deleteWebhook(id: string, userId: string): Promise<void> {
  const deleted = local.localSoftDeleteWebhook(id, userId)
  if (!deleted) throw createError(WEBHOOK_NOT_FOUND)
}

export async function getDeliveries(webhookId: string, page?: number, limit?: number) {
  return local.localFindDeliveriesByWebhook(webhookId, page, limit)
}

// ═══════════════════════════════════════════════════════════════
// 事件分发
// ═══════════════════════════════════════════════════════════════

export function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

export async function dispatch(
  event: { type: string; timestamp: string; data: Record<string, unknown> }
): Promise<void> {
  const webhooks = local.localFindActiveWebhooksByOrgAndEvent(event.type)

  if (webhooks.length === 0) return

  logger.info('[Webhook] 分发事件', { type: event.type, targets: webhooks.length })

  await Promise.allSettled(
    webhooks.map((webhook) => deliverWithRetry(webhook, event))
  )
}

async function deliverWithRetry(
  webhook: LocalWebhookRow,
  event: { type: string; timestamp: string; data: Record<string, unknown> }
): Promise<void> {
  const payloadStr = JSON.stringify(event)
  const signature = signPayload(payloadStr, webhook.secret)

  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Event': event.type,
          'X-Webhook-Delivery-Attempt': String(attempt),
        },
        body: payloadStr,
        signal: controller.signal,
      })

      clearTimeout(timeout)

      local.localCreateDelivery({
        webhookId: webhook.id,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        responseStatus: response.status,
        responseBody: await response.text().catch(() => ''),
        attempt,
        status: response.ok ? 'success' : 'failed',
      })

      if (response.ok) {
        local.localResetWebhookFailureCount(webhook.id)
        return
      }

      logger.warn('[Webhook] 推送失败', { webhookId: webhook.id, attempt, status: response.status })
    } catch (error) {
      local.localCreateDelivery({
        webhookId: webhook.id,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        attempt,
        status: 'failed',
      })

      logger.warn('[Webhook] 推送异常', { webhookId: webhook.id, attempt, error: (error as Error).message })
    }

    if (attempt < WEBHOOK_MAX_RETRIES) {
      await sleep(WEBHOOK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1))
    }
  }

  local.localIncrementWebhookFailureCount(webhook.id)

  const updated = local.localFindWebhookById(webhook.id)
  if (updated && updated.failure_count >= WEBHOOK_MAX_FAILURE_COUNT) {
    local.localDisableWebhook(webhook.id)
    logger.warn('[Webhook] 自动禁用', { webhookId: webhook.id, failureCount: updated.failure_count })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ═══════════════════════════════════════════════════════════════
// 测试端点
// ═══════════════════════════════════════════════════════════════

export async function testWebhook(id: string): Promise<{ success: boolean; status?: number; error?: string }> {
  const webhook = local.localFindWebhookById(id)
  if (!webhook) throw createError(WEBHOOK_NOT_FOUND)
  if (!webhook.is_active) throw createError(WEBHOOK_DISABLED)

  const testEvent = {
    type: 'webhook.test',
    timestamp: new Date().toISOString(),
    data: { message: 'This is a test webhook delivery' },
  }

  const payloadStr = JSON.stringify(testEvent)
  const signature = signPayload(payloadStr, webhook.secret)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': 'webhook.test',
      },
      body: payloadStr,
      signal: controller.signal,
    })

    clearTimeout(timeout)
    return { success: response.ok, status: response.status }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}
