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
const gatewayInstanceIdSchema = z.string().min(1).max(128)

const updateGatewaySchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  isDefault: z.boolean().optional(),
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
const createGatewayInstanceSchema = updateGatewaySchema.extend({
  provider: providerSchema,
  instanceKey: z.string().min(1).max(128).optional(),
})
const gatewayBatchSchema = z.object({
  action: z.enum(['enable', 'disable', 'delete']),
  instanceIds: z.array(gatewayInstanceIdSchema).min(1),
  ignoreMissing: z.boolean().optional(),
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
  '/instances',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const rawProvider = req.query.provider
    const provider = rawProvider ? providerSchema.parse(rawProvider) : undefined
    const data = await gatewayService.listGatewayInstances(provider)
    res.json({ success: true, data })
  })
)

router.post(
  '/instances',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(createGatewayInstanceSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await gatewayService.createGatewayInstance(req.body)
    res.status(201).json({ success: true, data })
  })
)

router.post(
  '/instances/batch',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(gatewayBatchSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await gatewayService.batchGatewayInstances(req.body)
    res.json({ success: true, data })
  })
)

router.get(
  '/instances/:instanceId',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = gatewayInstanceIdSchema.parse(req.params.instanceId)
    const data = await gatewayService.getGatewayInstance(instanceId)
    res.json({ success: true, data })
  })
)

router.put(
  '/instances/:instanceId',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updateGatewaySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = gatewayInstanceIdSchema.parse(req.params.instanceId)
    const data = await gatewayService.updateGatewayInstance(instanceId, req.body)
    res.json({ success: true, data })
  })
)

router.delete(
  '/instances/:instanceId',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = gatewayInstanceIdSchema.parse(req.params.instanceId)
    const data = await gatewayService.deleteGatewayInstance(instanceId)
    res.json({ success: true, data })
  })
)

router.post(
  '/instances/:instanceId/test',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(testGatewaySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = gatewayInstanceIdSchema.parse(req.params.instanceId)
    const body = req.body || {}
    const payload = {
      title: body.title,
      content: body.content,
      channel: body.channel,
      text: body.text,
      chat_id: body.chat_id ?? body.chatId,
    } as Record<string, unknown>
    const data = await gatewayService.testGatewayInstance(instanceId, payload)
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
