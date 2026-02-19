/**
 * Chat API 路由 - 支持 SSE 流式响应
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { idempotency } from '../../middleware/idempotency'
import * as chatService from '../../services/chat.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const chatMessageSchema = z.object({
  message: z.string().min(1).max(100000),
  parentMessageId: z.string().uuid().optional(),
})

const startChatSchema = z.object({
  agentId: z.string().uuid(),
  message: z.string().min(1).max(100000),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /chat/sessions/:sessionId - 在已有会话中发送消息 (SSE)
 *
 * 返回 SSE 流，包含以下事件:
 * - message: Agent2UI 消息 (thinking, plan, tool_call, text, etc.)
 * - done: 完成事件，包含 sessionId 和 messageId
 * - error: 错误事件
 * - heartbeat: 心跳事件 (每 30 秒)
 */
router.post(
  '/sessions/:sessionId',
  authenticate,
  combinedRateLimit,
  idempotency(),
  requirePermission('chat:write'),
  validate(chatMessageSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const sessionId = req.params.sessionId
    const input = req.body

    // 处理聊天 (SSE 流式响应)
    await chatService.handleChat(orgId, userId, sessionId, input, res)
  })
)

/**
 * POST /chat/start - 创建新会话并发送消息 (SSE)
 *
 * 自动创建会话并开始对话
 * 返回 SSE 流，事件同上
 */
router.post(
  '/start',
  authenticate,
  combinedRateLimit,
  idempotency(),
  requirePermission('chat:write', 'sessions:write'),
  validate(startChatSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const { agentId, message } = req.body

    // 创建新会话并处理聊天
    await chatService.startNewChat(
      orgId,
      userId,
      agentId,
      { message },
      res
    )
  })
)

export default router
