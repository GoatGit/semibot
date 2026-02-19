/**
 * Webhook Service 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('../repositories/webhook.repository')
vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))
vi.mock('../middleware/errorHandler', () => ({
  createError: (code: string, msg?: string) => {
    const err = new Error(msg || code)
    ;(err as any).code = code
    return err
  },
}))

import * as WebhookRepo from '../repositories/webhook.repository'
import {
  createWebhook,
  getWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  signPayload,
  dispatch,
  testWebhook,
} from '../services/webhook.service'
import type { WebhookRow } from '../repositories/webhook.repository'

const mockWebhook: WebhookRow = {
  id: 'wh-001',
  org_id: 'org-001',
  url: 'https://example.com/webhook',
  secret: 'test-secret-1234567890',
  events: ['evolution.skill_created'],
  is_active: true,
  failure_count: 0,
  last_failure_at: null,
  version: 1,
  created_at: '2025-01-01T00:00:00Z',
  created_by: 'user-001',
  updated_at: '2025-01-01T00:00:00Z',
  updated_by: 'user-001',
  deleted_at: null,
}

describe('Webhook Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ═══════════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════════

  describe('createWebhook', () => {
    it('should create webhook when under limit', async () => {
      vi.mocked(WebhookRepo.countByOrg).mockResolvedValue(0)
      vi.mocked(WebhookRepo.create).mockResolvedValue(mockWebhook)

      const result = await createWebhook('org-001', 'user-001', {
        url: 'https://example.com/webhook',
        secret: 'test-secret-1234567890',
        events: ['evolution.skill_created'],
      })

      expect(result).toEqual(mockWebhook)
      expect(WebhookRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-001',
          url: 'https://example.com/webhook',
          createdBy: 'user-001',
        })
      )
    })

    it('should reject when limit exceeded', async () => {
      vi.mocked(WebhookRepo.countByOrg).mockResolvedValue(20)

      await expect(
        createWebhook('org-001', 'user-001', {
          url: 'https://example.com/webhook',
          secret: 'test-secret-1234567890',
          events: ['evolution.skill_created'],
        })
      ).rejects.toThrow()
    })
  })

  describe('getWebhook', () => {
    it('should return webhook', async () => {
      vi.mocked(WebhookRepo.findById).mockResolvedValue(mockWebhook)

      const result = await getWebhook('org-001', 'wh-001')
      expect(result).toEqual(mockWebhook)
    })

    it('should throw when not found', async () => {
      vi.mocked(WebhookRepo.findById).mockResolvedValue(null)

      await expect(getWebhook('org-001', 'wh-999')).rejects.toThrow()
    })
  })

  describe('updateWebhook', () => {
    it('should update and return webhook', async () => {
      const updated = { ...mockWebhook, url: 'https://new.example.com/hook' }
      vi.mocked(WebhookRepo.update).mockResolvedValue(updated)

      const result = await updateWebhook('org-001', 'wh-001', 'user-001', {
        url: 'https://new.example.com/hook',
      })

      expect(result.url).toBe('https://new.example.com/hook')
    })

    it('should throw when not found', async () => {
      vi.mocked(WebhookRepo.update).mockResolvedValue(null)

      await expect(
        updateWebhook('org-001', 'wh-999', 'user-001', { url: 'https://x.com' })
      ).rejects.toThrow()
    })
  })

  describe('deleteWebhook', () => {
    it('should soft delete', async () => {
      vi.mocked(WebhookRepo.softDelete).mockResolvedValue(true)

      await expect(deleteWebhook('org-001', 'wh-001', 'user-001')).resolves.toBeUndefined()
    })

    it('should throw when not found', async () => {
      vi.mocked(WebhookRepo.softDelete).mockResolvedValue(false)

      await expect(deleteWebhook('org-001', 'wh-999', 'user-001')).rejects.toThrow()
    })
  })

  // ═══════════════════════════════════════════════════════════════
  // 签名
  // ═══════════════════════════════════════════════════════════════

  describe('signPayload', () => {
    it('should produce consistent HMAC-SHA256 signature', () => {
      const sig1 = signPayload('{"test":true}', 'secret')
      const sig2 = signPayload('{"test":true}', 'secret')
      expect(sig1).toBe(sig2)
      expect(sig1).toHaveLength(64) // SHA256 hex
    })

    it('should produce different signatures for different secrets', () => {
      const sig1 = signPayload('payload', 'secret-a')
      const sig2 = signPayload('payload', 'secret-b')
      expect(sig1).not.toBe(sig2)
    })
  })

  // ═══════════════════════════════════════════════════════════════
  // 事件分发
  // ═══════════════════════════════════════════════════════════════

  describe('dispatch', () => {
    it('should skip when no active webhooks', async () => {
      vi.mocked(WebhookRepo.findActiveByOrgAndEvent).mockResolvedValue([])

      await dispatch('org-001', {
        type: 'evolution.skill_created',
        timestamp: new Date().toISOString(),
        orgId: 'org-001',
        data: { agentId: 'a1' },
      })

      expect(WebhookRepo.createDelivery).not.toHaveBeenCalled()
    })

    it('should deliver to matching webhooks', async () => {
      vi.mocked(WebhookRepo.findActiveByOrgAndEvent).mockResolvedValue([mockWebhook])

      // Mock successful fetch
      const mockResponse = {
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      }
      global.fetch = vi.fn().mockResolvedValue(mockResponse)
      vi.mocked(WebhookRepo.createDelivery).mockResolvedValue({} as any)
      vi.mocked(WebhookRepo.resetFailureCount).mockResolvedValue()

      await dispatch('org-001', {
        type: 'evolution.skill_created',
        timestamp: '2025-01-01T00:00:00Z',
        orgId: 'org-001',
        data: { agentId: 'a1' },
      })

      expect(global.fetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Webhook-Event': 'evolution.skill_created',
          }),
        })
      )
      expect(WebhookRepo.createDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 'wh-001',
          eventType: 'evolution.skill_created',
          status: 'success',
        })
      )
      expect(WebhookRepo.resetFailureCount).toHaveBeenCalledWith('wh-001')
    })
  })

  // ═══════════════════════════════════════════════════════════════
  // 测试端点
  // ═══════════════════════════════════════════════════════════════

  describe('testWebhook', () => {
    it('should return success for reachable endpoint', async () => {
      vi.mocked(WebhookRepo.findById).mockResolvedValue(mockWebhook)
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })

      const result = await testWebhook('org-001', 'wh-001')
      expect(result.success).toBe(true)
      expect(result.status).toBe(200)
    })

    it('should return error for unreachable endpoint', async () => {
      vi.mocked(WebhookRepo.findById).mockResolvedValue(mockWebhook)
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

      const result = await testWebhook('org-001', 'wh-001')
      expect(result.success).toBe(false)
      expect(result.error).toBe('ECONNREFUSED')
    })

    it('should throw when webhook not found', async () => {
      vi.mocked(WebhookRepo.findById).mockResolvedValue(null)

      await expect(testWebhook('org-001', 'wh-999')).rejects.toThrow()
    })

    it('should throw when webhook disabled', async () => {
      vi.mocked(WebhookRepo.findById).mockResolvedValue({
        ...mockWebhook,
        is_active: false,
      })

      await expect(testWebhook('org-001', 'wh-001')).rejects.toThrow()
    })
  })
})
