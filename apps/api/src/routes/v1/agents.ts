/**
 * Agents API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as agentService from '../../services/agent.service'
import * as mcpService from '../../services/mcp.service'
import * as evolvedSkillService from '../../services/evolved-skill.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  systemPrompt: z.string().max(10000).optional(),
  config: z
    .object({
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().min(1).max(128000).optional(),
      timeoutSeconds: z.number().min(1).max(600).optional(),
      retryAttempts: z.number().min(0).max(5).optional(),
      fallbackModel: z.string().optional(),
    })
    .optional(),
  skills: z.array(z.string()).optional(),
  mcpServerIds: z.array(z.string().uuid()).optional(),
  subAgents: z.array(z.string()).optional(),
  isPublic: z.boolean().optional(),
  runtimeType: z.enum(['semigraph', 'openclaw']).optional(),
  openclawConfig: z.record(z.unknown()).optional(),
})

const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  systemPrompt: z.string().min(1).max(10000).optional(),
  config: z
    .object({
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().min(1).max(128000).optional(),
      timeoutSeconds: z.number().min(1).max(600).optional(),
      retryAttempts: z.number().min(0).max(5).optional(),
      fallbackModel: z.string().optional(),
    })
    .optional(),
  skills: z.array(z.string()).optional(),
  mcpServerIds: z.array(z.string().uuid()).optional(),
  subAgents: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  runtimeType: z.enum(['semigraph', 'openclaw']).optional(),
  openclawConfig: z.record(z.unknown()).optional(),
})

const listAgentsQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  isActive: z.enum(['true', 'false']).optional().transform((val) => val === undefined ? undefined : val === 'true'),
  search: z.string().max(100).optional(),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /agents - 创建 Agent
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(createAgentSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const { mcpServerIds, ...input } = req.body

    const agent = await agentService.createAgent(orgId, input)

    // 保存 MCP Server 关联
    if (mcpServerIds && mcpServerIds.length > 0) {
      await mcpService.setAgentMcpServers(agent.id, mcpServerIds)
    }

    // 返回时附带 mcpServerIds
    res.status(201).json({
      success: true,
      data: { ...agent, mcpServerIds: mcpServerIds || [] },
    })
  })
)

/**
 * GET /agents - 列出 Agents
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(listAgentsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    // req.query 已被 validate 中间件验证并转换
    const options = req.query

    const result = await agentService.listAgents(orgId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * GET /agents/:id - 获取 Agent 详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const agentId = req.params.id

    const agent = await agentService.getAgent(orgId, agentId)
    const mcpServerIds = await mcpService.getAgentMcpServerIds(agentId)

    res.json({
      success: true,
      data: { ...agent, mcpServerIds },
    })
  })
)

/**
 * PUT /agents/:id - 更新 Agent
 */
router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(updateAgentSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const agentId = req.params.id
    const { mcpServerIds, ...input } = req.body

    const agent = await agentService.updateAgent(orgId, agentId, input)

    // 更新 MCP Server 关联（如果传入了 mcpServerIds）
    if (mcpServerIds !== undefined) {
      await mcpService.setAgentMcpServers(agentId, mcpServerIds)
    }

    const currentMcpServerIds = await mcpService.getAgentMcpServerIds(agentId)

    res.json({
      success: true,
      data: { ...agent, mcpServerIds: currentMcpServerIds },
    })
  })
)

/**
 * DELETE /agents/:id - 删除 Agent
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const agentId = req.params.id

    await agentService.deleteAgent(orgId, agentId)

    res.status(204).send()
  })
)

/**
 * GET /agents/:id/evolution/stats - 获取 Agent 进化统计
 */
router.get(
  '/:id/evolution/stats',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const agentId = req.params.id
    const stats = await evolvedSkillService.getStats(agentId, orgId)
    res.json({ success: true, data: stats })
  })
)

export default router
