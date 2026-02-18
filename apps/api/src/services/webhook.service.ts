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
import * as WebhookRepo from '../repositories/webhook.repository'
import type { WebhookRow } from '../repositories/webhook.repository'

const logger = createLogger('webhook-service')

// ═══════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════

export async function createWebhook(
  orgId: string,
  userId: string,
  input: { url: string; secret: string; events: string[]; isActive?: boolean }
): Promise<WebhookRow> {
  const count = await WebhookRepo.countByOrg(orgId)
  if (count >= MAX_WEBHOOKS_PER_ORG) {
    throw createError(WEBHOOK_LIMIT_EXCEEDED)
  }

  return WebhookRepo.create({
    orgId,
    url: input.url,
    secret: input.secret,
    events: input.events,
    isActive: input.isActive,
    createdBy: userId,
  })
}

export async function getWebhook(orgId: string, id: string): Promise<WebhookRow> {
  const webhook = await WebhookRepo.findById(id, orgId)
  if (!webhook) throw createError(WEBHOOK_NOT_FOUND)
  return webhook
}

export async function listWebhooks(orgId: string, options: { page?: number; limit?: number }) {
  return WebhookRepo.findByOrg({ orgId, ...options })
}

export async function updateWebhook(
  orgId: string,
  id: string,
  userId: string,
  input: { url?: string; secret?: string; events?: string[]; isActive?: boolean }
): Promise<WebhookRow> {
  const webhook = await WebhookRepo.update(id, orgId, { ...input, updatedBy: userId })
  if (!webhook) throw createError(WEBHOOK_NOT_FOUND)
  return webhook
}

export async function deleteWebhook(orgId: string, id: string, userId: string): Promise<void> {
  const deleted = await WebhookRepo.softDelete(id, orgId, userId)
  if (!deleted) throw createError(WEBHOOK_NOT_FOUND)
}

export async function getDeliveries(webhookId: string, page?: number, limit?: number) {
  return WebhookRepo.findDeliveriesByWebhook(webhookId, page, limit)
}

// ═══════════════════════════════════════════════════════════════
// 事件分发
// ═══════════════════════════════════════════════════════════════

export function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

export async function dispatch(
  orgId: string,
  event: { type: string; timestamp: string; orgId: string; data: Record<string, unknown> }
): Promise<void> {
  const webhooks = await WebhookRepo.findActiveByOrgAndEvent(orgId, event.type)

  if (webhooks.length === 0) return

  logger.info('[Webhook] 分发事件', { type: event.type, orgId, targets: webhooks.length })

  await Promise.allSettled(
    webhooks.map((webhook) => deliverWithRetry(webhook, event))
  )
}

async function deliverWithRetry(
  webhook: WebhookRow,
  event: { type: string; timestamp: string; orgId: string; data: Record<string, unknown> }
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

      await WebhookRepo.createDelivery({
        webhookId: webhook.id,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        responseStatus: response.status,
        responseBody: await response.text().catch(() => ''),
        attempt,
        status: response.ok ? 'success' : 'failed',
      })

      if (response.ok) {
        await WebhookRepo.resetFailureCount(webhook.id)
        return
      }

      logger.warn('[Webhook] 推送失败', {
        webhookId: webhook.id,
        attempt,
        status: response.status,
      })
    } catch (error) {
      await WebhookRepo.createDelivery({
        webhookId: webhook.id,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        attempt,
        status: 'failed',
      })

      logger.warn('[Webhook] 推送异常', {
        webhookId: webhook.id,
        attempt,
        error: (error as Error).message,
      })
    }

    // 指数退避
    if (attempt < WEBHOOK_MAX_RETRIES) {
      await sleep(WEBHOOK_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1))
    }
  }

  // 所有重试失败，递增失败计数
  await WebhookRepo.incrementFailureCount(webhook.id)

  // 超过阈值自动禁用
  const updated = await WebhookRepo.findById(webhook.id, webhook.org_id)
  if (updated && updated.failure_count >= WEBHOOK_MAX_FAILURE_COUNT) {
    await WebhookRepo.disableWebhook(webhook.id)
    logger.warn('[Webhook] 自动禁用', { webhookId: webhook.id, failureCount: updated.failure_count })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ═══════════════════════════════════════════════════════════════
// 测试端点
// ═══════════════════════════════════════════════════════════════

export async function testWebhook(orgId: string, id: string): Promise<{ success: boolean; status?: number; error?: string }> {
  const webhook = await WebhookRepo.findById(id, orgId)
  if (!webhook) throw createError(WEBHOOK_NOT_FOUND)
  if (!webhook.is_active) throw createError(WEBHOOK_DISABLED)

  const testEvent = {
    type: 'webhook.test',
    timestamp: new Date().toISOString(),
    orgId,
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
