/**
 * Sessions API 路由
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler, validate } from '../middleware/errorHandler.js';
import { combinedRateLimit } from '../middleware/rateLimit.js';
import * as sessionService from '../services/session.service.js';
const router = Router();
// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════
const createSessionSchema = z.object({
    agentId: z.string().uuid(),
    title: z.string().max(200).optional(),
    metadata: z.record(z.unknown()).optional(),
});
const updateSessionSchema = z.object({
    title: z.string().max(200).optional(),
    status: z.enum(['active', 'paused', 'completed', 'failed']).optional(),
});
const listSessionsQuerySchema = z.object({
    page: z.coerce.number().min(1).optional(),
    limit: z.coerce.number().min(1).max(100).optional(),
    agentId: z.string().uuid().optional(),
    status: z.enum(['active', 'paused', 'completed', 'failed']).optional(),
});
const addMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().min(1).max(100000),
    parentId: z.string().uuid().optional(),
    toolCalls: z
        .array(z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
            name: z.string(),
            arguments: z.string(),
        }),
    }))
        .optional(),
    toolCallId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
});
// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════
/**
 * POST /sessions - 创建会话
 */
router.post('/', authenticate, combinedRateLimit, requirePermission('sessions:write'), validate(createSessionSchema, 'body'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const userId = req.user.userId;
    const input = req.body;
    const session = await sessionService.createSession(orgId, userId, input);
    res.status(201).json({
        success: true,
        data: session,
    });
}));
/**
 * GET /sessions - 列出会话
 */
router.get('/', authenticate, combinedRateLimit, requirePermission('sessions:read'), validate(listSessionsQuerySchema, 'query'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const userId = req.user.userId;
    const options = req.query;
    const result = await sessionService.listSessions(orgId, userId, options);
    res.json({
        success: true,
        data: result.data,
        meta: result.meta,
    });
}));
/**
 * GET /sessions/:id - 获取会话详情
 */
router.get('/:id', authenticate, combinedRateLimit, requirePermission('sessions:read'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const sessionId = req.params.id;
    const session = await sessionService.getSession(orgId, sessionId);
    res.json({
        success: true,
        data: session,
    });
}));
/**
 * PUT /sessions/:id - 更新会话
 */
router.put('/:id', authenticate, combinedRateLimit, requirePermission('sessions:write'), validate(updateSessionSchema, 'body'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const sessionId = req.params.id;
    const { title, status } = req.body;
    let session = await sessionService.getSession(orgId, sessionId);
    if (title !== undefined) {
        session = await sessionService.updateSessionTitle(orgId, sessionId, title);
    }
    if (status !== undefined) {
        session = await sessionService.updateSessionStatus(orgId, sessionId, status);
    }
    res.json({
        success: true,
        data: session,
    });
}));
/**
 * DELETE /sessions/:id - 删除会话
 */
router.delete('/:id', authenticate, combinedRateLimit, requirePermission('sessions:write'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const sessionId = req.params.id;
    await sessionService.deleteSession(orgId, sessionId);
    res.status(204).send();
}));
/**
 * GET /sessions/:id/messages - 获取会话消息列表
 */
router.get('/:id/messages', authenticate, combinedRateLimit, requirePermission('sessions:read'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const sessionId = req.params.id;
    const messages = await sessionService.getSessionMessages(orgId, sessionId);
    res.json({
        success: true,
        data: messages,
    });
}));
/**
 * POST /sessions/:id/messages - 添加消息
 */
router.post('/:id/messages', authenticate, combinedRateLimit, requirePermission('sessions:write'), validate(addMessageSchema, 'body'), asyncHandler(async (req, res) => {
    const orgId = req.user.orgId;
    const sessionId = req.params.id;
    const input = req.body;
    const message = await sessionService.addMessage(orgId, sessionId, input);
    res.status(201).json({
        success: true,
        data: message,
    });
}));
export default router;
//# sourceMappingURL=sessions.js.map