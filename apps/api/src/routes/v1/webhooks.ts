/**
 * Webhooks API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as webhookService from '../../services/webhook.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  secret: z.string().min(16).max(256),
  events: z.array(z.string().max(100)).min(1).max(50),
  isActive: z.boolean().optional(),
})

const updateWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  secret: z.string().min(16).max(256).optional(),
  events: z.array(z.string().max(100)).min(1).max(50).optional(),
  isActive: z.boolean().optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

const deliveriesQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /webhooks - 创建 Webhook
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('webhooks:write'),
  validate(createWebhookSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId

    const webhook = await webhookService.createWebhook(orgId, userId, req.body)

    res.status(201).json({ success: true, data: webhook })
  })
)

/**
 * GET /webhooks - 列出 Webhooks
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('webhooks:read'),
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const result = await webhookService.listWebhooks(orgId, req.query as { page?: number; limit?: number })

    res.json({ success: true, data: result.data, meta: result.meta })
  })
)

/**
 * GET /webhooks/:id - 获取 Webhook 详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('webhooks:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const webhook = await webhookService.getWebhook(orgId, req.params.id)

    res.json({ success: true, data: webhook })
  })
)

/**
 * PATCH /webhooks/:id - 更新 Webhook
 */
router.patch(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('webhooks:write'),
  validate(updateWebhookSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId

    const webhook = await webhookService.updateWebhook(orgId, req.params.id, userId, req.body)

    res.json({ success: true, data: webhook })
  })
)

/**
 * DELETE /webhooks/:id - 删除 Webhook
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('webhooks:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId

    await webhookService.deleteWebhook(orgId, req.params.id, userId)

    res.status(204).send()
  })
)

/**
 * POST /webhooks/:id/test - 测试 Webhook
 */
router.post(
  '/:id/test',
  authenticate,
  combinedRateLimit,
  requirePermission('webhooks:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const result = await webhookService.testWebhook(orgId, req.params.id)

    res.json({ success: true, data: result })
  })
)

/**
 * GET /webhooks/:id/deliveries - 获取投递记录
 */
router.get(
  '/:id/deliveries',
  authenticate,
  combinedRateLimit,
  requirePermission('webhooks:read'),
  validate(deliveriesQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    // 先验证 webhook 存在
    await webhookService.getWebhook(orgId, req.params.id)

    const query = req.query as { page?: number; limit?: number }
    const result = await webhookService.getDeliveries(req.params.id, query.page, query.limit)

    res.json({ success: true, data: result.data, meta: result.meta })
  })
)

export default router
