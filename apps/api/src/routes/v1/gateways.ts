/**
 * Gateways API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as gatewayService from '../../services/gateway.service'

const router: Router = Router()

const providerSchema = z.enum(['feishu', 'telegram'])

const updateGatewaySchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  mode: z.string().min(1).max(50).optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  requiresApproval: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  addressingPolicy: z.record(z.unknown()).optional(),
  proactivePolicy: z.record(z.unknown()).optional(),
  contextPolicy: z.record(z.unknown()).optional(),
  clearFields: z.array(z.string().min(1).max(64)).max(50).optional(),
})

const testGatewaySchema = z.object({
  title: z.string().max(100).optional(),
  content: z.string().max(5000).optional(),
  channel: z.string().max(50).optional(),
  text: z.string().max(5000).optional(),
  chatId: z.string().max(200).optional(),
  chat_id: z.string().max(200).optional(),
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const data = await gatewayService.listGateways()
    res.json({ success: true, data })
  })
)

router.get(
  '/:provider',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const provider = providerSchema.parse(req.params.provider)
    const data = await gatewayService.getGateway(provider)
    res.json({ success: true, data })
  })
)

router.put(
  '/:provider',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updateGatewaySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const provider = providerSchema.parse(req.params.provider)
    const input = req.body
    const data = await gatewayService.updateGateway(provider, input)
    res.json({ success: true, data })
  })
)

router.post(
  '/:provider/test',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(testGatewaySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const provider = providerSchema.parse(req.params.provider)
    const body = req.body || {}
    const payload =
      provider === 'telegram'
        ? {
            text: body.text ?? body.content ?? 'Semibot Gateway Test',
            chat_id: body.chat_id ?? body.chatId,
          }
        : {
            title: body.title ?? 'Semibot Gateway Test',
            content: body.content ?? body.text ?? 'Gateway connectivity test',
            channel: body.channel ?? 'default',
          }
    const data = await gatewayService.testGateway(provider, payload)
    res.json({ success: true, data })
  })
)

export default router
