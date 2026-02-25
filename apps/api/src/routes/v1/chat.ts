/**
 * Chat API 路由 - 支持 SSE 流式响应
 *
 * 同时支持 JSON 和 multipart/form-data（带文件上传）两种请求格式
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, createError } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { idempotency } from '../../middleware/idempotency'
import { handleChatUpload, cleanupChatFiles, type ChatUploadRequest } from '../../middleware/chat-upload'
import { extractFileContent } from '../../utils/file-content-extractor'
import * as chatService from '../../services/chat.service'
import type { ChatAttachment } from '../../services/chat.service'
import { createLogger } from '../../lib/logger'

const router: Router = Router()
const chatRouteLogger = createLogger('chat-route')

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
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function isMultipart(req: AuthRequest): boolean {
  return (req.headers['content-type'] || '').includes('multipart/form-data')
}

async function buildAttachments(req: ChatUploadRequest): Promise<ChatAttachment[]> {
  const files = req.chatFiles ?? []
  if (files.length === 0) return []

  const attachments: ChatAttachment[] = []
  for (const file of files) {
    const extracted = await extractFileContent(file.tempPath, file.mimeType, file.originalName)
    attachments.push({
      id: crypto.randomUUID(),
      filename: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      textContent: extracted.text ?? undefined,
      base64: extracted.base64,
      isImage: extracted.isImage,
    })
  }
  return attachments
}

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /chat/sessions/:sessionId - 在已有会话中发送消息 (SSE)
 *
 * 支持两种 Content-Type:
 * - application/json: { message, parentMessageId? }
 * - multipart/form-data: message 字段 + files 文件
 */
router.post(
  '/sessions/:sessionId',
  authenticate,
  combinedRateLimit,
  idempotency(),
  requirePermission('chat:write'),
  asyncHandler(async (req: AuthRequest & ChatUploadRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const sessionId = req.params.sessionId

    let input: chatService.ChatInput

    if (isMultipart(req)) {
      // multipart 模式：先解析上传
      await new Promise<void>((resolve, reject) => {
        handleChatUpload(req, res, (err?: unknown) => {
          if (err) reject(err)
          else resolve()
        })
      })

      const fields = req.chatFields ?? {}
      const message = fields.message
      if (!message || !message.trim()) {
        if (req.chatFiles?.length) await cleanupChatFiles(req.chatFiles)
        throw createError('VALIDATION_FAILED', '消息内容不能为空')
      }

      const attachments = await buildAttachments(req)

      // 清理临时文件
      if (req.chatFiles?.length) {
        cleanupChatFiles(req.chatFiles).catch((err) => {
          chatRouteLogger.warn('清理聊天临时文件失败', { error: (err as Error).message })
        })
      }

      input = {
        message: message.trim(),
        parentMessageId: fields.parentMessageId || undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      }
    } else {
      // JSON 模式
      const parsed = chatMessageSchema.safeParse(req.body)
      if (!parsed.success) {
        throw createError('VALIDATION_FAILED', parsed.error.message)
      }
      input = parsed.data
    }

    await chatService.handleChat(orgId, userId, sessionId, input, res)
  })
)

/**
 * POST /chat/start - 创建新会话并发送消息 (SSE)
 *
 * 支持两种 Content-Type:
 * - application/json: { agentId, message }
 * - multipart/form-data: agentId + message 字段 + files 文件
 */
router.post(
  '/start',
  authenticate,
  combinedRateLimit,
  idempotency(),
  requirePermission('chat:write', 'sessions:write'),
  asyncHandler(async (req: AuthRequest & ChatUploadRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId

    let agentId: string
    let input: chatService.ChatInput

    if (isMultipart(req)) {
      await new Promise<void>((resolve, reject) => {
        handleChatUpload(req, res, (err?: unknown) => {
          if (err) reject(err)
          else resolve()
        })
      })

      const fields = req.chatFields ?? {}
      agentId = fields.agentId ?? ''
      const message = fields.message

      if (!agentId) {
        if (req.chatFiles?.length) await cleanupChatFiles(req.chatFiles)
        throw createError('VALIDATION_FAILED', 'agentId 不能为空')
      }
      if (!message || !message.trim()) {
        if (req.chatFiles?.length) await cleanupChatFiles(req.chatFiles)
        throw createError('VALIDATION_FAILED', '消息内容不能为空')
      }

      const attachments = await buildAttachments(req)

      if (req.chatFiles?.length) {
        cleanupChatFiles(req.chatFiles).catch((err) => {
          chatRouteLogger.warn('清理聊天临时文件失败', { error: (err as Error).message })
        })
      }

      input = {
        message: message.trim(),
        attachments: attachments.length > 0 ? attachments : undefined,
      }
    } else {
      const parsed = startChatSchema.safeParse(req.body)
      if (!parsed.success) {
        throw createError('VALIDATION_FAILED', parsed.error.message)
      }
      agentId = parsed.data.agentId
      input = { message: parsed.data.message }
    }

    await chatService.startNewChat(orgId, userId, agentId, input, res)
  })
)

export default router
