/**
 * Studios API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as studioService from '../../services/studio.service'
import * as studioEngine from '../../services/studio-engine.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const agentNodeSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().uuid(),
  position: z.object({ x: z.number(), y: z.number() }),
})

const studioEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
})

const createStudioSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  nodes: z.array(agentNodeSchema).optional(),
  edges: z.array(studioEdgeSchema).optional(),
})

const updateStudioSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  nodes: z.array(agentNodeSchema).optional(),
  edges: z.array(studioEdgeSchema).optional(),
  isActive: z.boolean().optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  search: z.string().max(100).optional(),
})

const triggerRunSchema = z.object({
  inputs: z.record(z.unknown()).optional(),
})

// ═══════════════════════════════════════════════════════════════
// Studio CRUD
// ═══════════════════════════════════════════════════════════════

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await studioService.listStudios(req.query as { page?: number; limit?: number; search?: string })
    res.json({ success: true, ...result })
  })
)

router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(createStudioSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const studio = await studioService.createStudio(req.body)
    res.status(201).json({ success: true, data: studio })
  })
)

router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const studio = await studioService.getStudio(req.params.id)
    res.json({ success: true, data: studio })
  })
)

router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(updateStudioSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const studio = await studioService.updateStudio(req.params.id, req.body)
    res.json({ success: true, data: studio })
  })
)

router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await studioService.deleteStudio(req.params.id)
    res.json({ success: true })
  })
)

// ═══════════════════════════════════════════════════════════════
// Studio Runs
// ═══════════════════════════════════════════════════════════════

router.post(
  '/:id/runs',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(triggerRunSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    // 验证 studio 存在
    await studioService.getStudio(req.params.id)
    const runId = await studioEngine.runStudio(req.params.id, req.body.inputs ?? {})
    res.status(202).json({ success: true, data: { runId } })
  })
)

router.get(
  '/:id/runs',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await studioService.listStudioRuns(req.params.id, req.query as { page?: number; limit?: number })
    res.json({ success: true, ...result })
  })
)

router.get(
  '/:id/runs/:runId',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const run = await studioService.getStudioRun(req.params.id, req.params.runId)
    res.json({ success: true, data: run })
  })
)

router.delete(
  '/:id/runs/:runId',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await studioService.cancelStudioRun(req.params.id, req.params.runId)
    res.json({ success: true })
  })
)

// ═══════════════════════════════════════════════════════════════
// SSE 实时进度
// ═══════════════════════════════════════════════════════════════

router.get(
  '/:id/runs/:runId/stream',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id, runId } = req.params

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const POLL_MS = 1500
    const MAX_DURATION_MS = 35 * 60 * 1000
    const deadline = Date.now() + MAX_DURATION_MS
    let lastStatus = ''

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const poll = async () => {
      if (Date.now() > deadline || res.writableEnded) return

      try {
        const run = await studioService.getStudioRun(id, runId)
        const statusChanged = run.status !== lastStatus
        if (statusChanged) lastStatus = run.status

        sendEvent('progress', {
          status: run.status,
          currentNodeId: run.currentNodeId,
          nodeResults: run.nodeResults,
        })

        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          sendEvent('done', { status: run.status, error: run.error })
          res.end()
          return
        }
      } catch {
        // 忽略轮询错误，继续重试
      }

      setTimeout(poll, POLL_MS)
    }

    req.on('close', () => { if (!res.writableEnded) res.end() })
    await poll()
  })
)

// ═══════════════════════════════════════════════════════════════
// 统一触发入口（供规则管理器调用）
// ═══════════════════════════════════════════════════════════════

router.post(
  '/:id/trigger',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(z.object({
    event_type: z.string().optional(),
    inputs: z.record(z.unknown()).optional(),
    triggered_by: z.string().optional(),
  }), 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await studioService.getStudio(req.params.id)
    const runId = await studioEngine.runStudio(req.params.id, req.body.inputs ?? {})
    res.status(202).json({ success: true, data: { runId } })
  })
)

export default router
