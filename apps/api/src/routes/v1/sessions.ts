/**
 * Sessions API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as sessionService from '../../services/session.service'
import { resolveDocumentChunk } from '../../services/document-context.service'

type Session = Awaited<ReturnType<typeof sessionService.getSession>>

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createSessionSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const updateSessionSchema = z.object({
  title: z.string().max(200).optional(),
  status: z.enum(['active', 'paused', 'completed', 'failed']).optional(),
})

const listSessionsQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  agentId: z.string().uuid().optional(),
  status: z.enum(['active', 'paused', 'completed', 'failed']).optional(),
})

const addMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().min(1).max(100000),
  parentId: z.string().uuid().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      })
    )
    .optional(),
  toolCallId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const documentChunkQuerySchema = z.object({
  docId: z.string().min(1).optional(),
  version: z.coerce.number().int().min(1).optional(),
  chunkId: z.string().regex(/^c\d{3,}$/i),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /sessions - 创建会话
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:write'),
  validate(createSessionSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId
    const input = req.body

    const session = await sessionService.createSession(userId, input)

    res.status(201).json({
      success: true,
      data: session,
    })
  })
)

/**
 * GET /sessions - 列出会话
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:read'),
  validate(listSessionsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId
    const options = req.query as z.infer<typeof listSessionsQuerySchema>

    const result = await sessionService.listSessions(userId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * GET /sessions/:id - 获取会话详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const sessionId = req.params.id

    const session = await sessionService.getSession(sessionId)

    res.json({
      success: true,
      data: session,
    })
  })
)

/**
 * PUT /sessions/:id - 更新会话
 */
router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:write'),
  validate(updateSessionSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const sessionId = req.params.id
    const { title, status } = req.body

    let session: Session

    if (title !== undefined || status !== undefined) {
      session = await sessionService.updateSession(sessionId, { title, status })
    } else {
      session = await sessionService.getSession(sessionId)
    }

    res.json({
      success: true,
      data: session,
    })
  })
)

/**
 * DELETE /sessions/:id - 删除会话
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const sessionId = req.params.id

    await sessionService.deleteSession(sessionId)

    res.status(204).send()
  })
)

/**
 * GET /sessions/:id/messages - 获取会话消息列表
 */
router.get(
  '/attempts/:attemptId',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const attemptId = req.params.attemptId
    const view = await sessionService.getRuntimeAttemptView(attemptId)
    res.json({
      success: true,
      data: view,
    })
  })
)

router.get(
  '/:id/view',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const sessionId = req.params.id

    const view = await sessionService.getSessionView(sessionId)

    res.json({
      success: true,
      data: view,
    })
  })
)

/**
 * GET /sessions/:id/messages - 获取会话消息列表
 */
router.get(
  '/:id/messages',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const sessionId = req.params.id

    const messages = await sessionService.getSessionMessages(sessionId)

    res.json({
      success: true,
      data: messages,
    })
  })
)

/**
 * POST /sessions/:id/messages - 添加消息
 */
router.post(
  '/:id/messages',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:write'),
  validate(addMessageSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const sessionId = req.params.id
    const input = req.body

    const message = await sessionService.addMessage(sessionId, input)

    res.status(201).json({
      success: true,
      data: message,
    })
  })
)

router.get(
  '/:id/document-chunk',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:read'),
  validate(documentChunkQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const sessionId = req.params.id
    const { docId, version, chunkId } = req.query as unknown as z.infer<typeof documentChunkQuerySchema>

    const resolution = await resolveDocumentChunk({
      sessionId,
      ...(docId ? { docId } : {}),
      ...(version ? { version } : {}),
      chunkId: chunkId.toLowerCase(),
    })

    if (resolution.kind === 'ambiguous') {
      res.status(409).json({
        success: false,
        error: {
          code: 'DOCUMENT_CHUNK_AMBIGUOUS',
          message: 'document chunk is ambiguous',
          details: {
            references: resolution.references,
          },
        },
      })
      return
    }

    if (resolution.kind === 'not_found') {
      res.status(404).json({
        success: false,
        error: {
          code: 'DOCUMENT_CHUNK_NOT_FOUND',
          message: 'document chunk not found',
          details: {
            references: resolution.references,
          },
        },
      })
      return
    }

    res.json({
      success: true,
      data: resolution.chunk,
    })
  })
)

export default router
