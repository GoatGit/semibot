/**
 * Channels API 路由（V2）
 *
 * 约定仅使用 /channels/* 资源风格接口：
 * - GET /channels
 * - POST /channels
 * - GET /channels/:instanceId
 * - PUT /channels/:instanceId
 * - DELETE /channels/:instanceId
 * - POST /channels/:instanceId/test
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as channelService from '../../services/gateway.service'

const router: Router = Router()

const providerSchema = z.enum(['feishu', 'telegram'])
const channelInstanceIdSchema = z.string().min(1).max(128)

const updateChannelSchema = z.object({
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
const createChannelInstanceSchema = updateChannelSchema.extend({
  provider: providerSchema,
  instanceKey: z.string().min(1).max(128).optional(),
})
const channelBatchSchema = z.object({
  action: z.enum(['enable', 'disable', 'delete']),
  instanceIds: z.array(channelInstanceIdSchema).min(1),
  ignoreMissing: z.boolean().optional(),
})

const testChannelSchema = z.object({
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
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const rawProvider = req.query.provider
    const provider = rawProvider ? providerSchema.parse(rawProvider) : undefined
    const data = await channelService.listGatewayInstances(provider)
    res.json({ success: true, data })
  })
)

router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(createChannelInstanceSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await channelService.createGatewayInstance(req.body)
    res.status(201).json({ success: true, data })
  })
)

router.post(
  '/batch',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(channelBatchSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = await channelService.batchGatewayInstances(req.body)
    res.json({ success: true, data })
  })
)

router.get(
  '/:instanceId',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = channelInstanceIdSchema.parse(req.params.instanceId)
    const data = await channelService.getGatewayInstance(instanceId)
    res.json({ success: true, data })
  })
)

router.put(
  '/:instanceId',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updateChannelSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = channelInstanceIdSchema.parse(req.params.instanceId)
    const data = await channelService.updateGatewayInstance(instanceId, req.body)
    res.json({ success: true, data })
  })
)

router.delete(
  '/:instanceId',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = channelInstanceIdSchema.parse(req.params.instanceId)
    const data = await channelService.deleteGatewayInstance(instanceId)
    res.json({ success: true, data })
  })
)

router.post(
  '/:instanceId/test',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(testChannelSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const instanceId = channelInstanceIdSchema.parse(req.params.instanceId)
    const body = req.body || {}
    const payload = {
      title: body.title,
      content: body.content,
      channel: body.channel,
      text: body.text,
      chat_id: body.chat_id ?? body.chatId,
    } as Record<string, unknown>
    const data = await channelService.testGatewayInstance(instanceId, payload)
    res.json({ success: true, data })
  })
)

export default router
