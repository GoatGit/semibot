/**
 * MCP Servers API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as mcpService from '../../services/mcp.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createMcpServerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  endpoint: z.string().min(1).max(500),
  transport: z.enum(['stdio', 'sse', 'streamable_http']),
  authType: z.enum(['none', 'api_key', 'oauth']).optional(),
  authConfig: z
    .object({
      apiKey: z.string().max(500).optional(),
      oauthClientId: z.string().max(200).optional(),
      oauthClientSecret: z.string().max(200).optional(),
    })
    .optional(),
})

const updateMcpServerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  endpoint: z.string().min(1).max(500).optional(),
  transport: z.enum(['stdio', 'sse', 'streamable_http']).optional(),
  authType: z.enum(['none', 'api_key', 'oauth']).optional(),
  authConfig: z
    .object({
      apiKey: z.string().max(500).optional(),
      oauthClientId: z.string().max(200).optional(),
      oauthClientSecret: z.string().max(200).optional(),
    })
    .optional(),
  isActive: z.boolean().optional(),
})

const listMcpServersQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  search: z.string().max(100).optional(),
  status: z.enum(['disconnected', 'connecting', 'connected', 'error']).optional(),
})

const syncToolsSchema = z.object({
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(1000).optional(),
        inputSchema: z.record(z.unknown()).optional(),
      })
    )
    .max(100),
  resources: z
    .array(
      z.object({
        uri: z.string().min(1).max(500),
        name: z.string().min(1).max(100),
        description: z.string().max(1000).optional(),
        mimeType: z.string().max(100).optional(),
      })
    )
    .max(100),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /mcp - 创建 MCP Server
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('mcp:write'),
  validate(createMcpServerSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const input = req.body

    const server = await mcpService.createMcpServer(orgId, userId, input)

    res.status(201).json({
      success: true,
      data: server,
    })
  })
)

/**
 * GET /mcp - 列出 MCP Servers
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('mcp:read'),
  validate(listMcpServersQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const options = req.query

    const result = await mcpService.listMcpServers(orgId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * GET /mcp/:id - 获取 MCP Server 详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('mcp:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const serverId = req.params.id

    const server = await mcpService.getMcpServer(orgId, serverId)

    res.json({
      success: true,
      data: server,
    })
  })
)

/**
 * PUT /mcp/:id - 更新 MCP Server
 */
router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('mcp:write'),
  validate(updateMcpServerSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const serverId = req.params.id
    const input = req.body

    const server = await mcpService.updateMcpServer(orgId, serverId, input)

    res.json({
      success: true,
      data: server,
    })
  })
)

/**
 * DELETE /mcp/:id - 删除 MCP Server
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('mcp:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const serverId = req.params.id

    await mcpService.deleteMcpServer(orgId, serverId)

    res.status(204).send()
  })
)

/**
 * POST /mcp/:id/test - 测试 MCP Server 连接
 */
router.post(
  '/:id/test',
  authenticate,
  combinedRateLimit,
  requirePermission('mcp:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const serverId = req.params.id

    const result = await mcpService.testConnection(orgId, serverId)

    res.json({
      success: true,
      data: result,
    })
  })
)

/**
 * POST /mcp/:id/sync - 同步 MCP Server 的工具和资源
 */
router.post(
  '/:id/sync',
  authenticate,
  combinedRateLimit,
  requirePermission('mcp:write'),
  validate(syncToolsSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const serverId = req.params.id
    const { tools, resources } = req.body

    const server = await mcpService.syncToolsAndResources(orgId, serverId, tools, resources)

    res.json({
      success: true,
      data: server,
    })
  })
)

export default router
