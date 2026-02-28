/**
 * API v1 路由汇总
 */

import { Router, type Request, type Response } from 'express'
import agentsRouter from './agents'
import sessionsRouter from './sessions'
import chatRouter from './chat'
import authRouter from './auth'
import organizationsRouter from './organizations'
import apiKeysRouter from './api-keys'
import toolsRouter from './tools'
import mcpRouter from './mcp'
import memoryRouter from './memory'
import logsRouter from './logs'
import llmProvidersRouter from './llm-providers'
import usersRouter from './users'
import skillDefinitionsRouter from './skill-definitions'
import evolvedSkillsRouter from './evolved-skills'
import webhooksRouter from './webhooks'
import vmRouter from './vm'
import filesRouter from './files'
import runtimeRouter from './runtime'
import eventsRouter from './events'
import rulesRouter from './rules'
import approvalsRouter from './approvals'
import gatewaysRouter from './gateways'

const router: Router = Router()

// 健康检查
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    },
  })
})

// Auth 路由 (无需认证)
router.use('/auth', authRouter)

// API 路由 (需要认证)
router.use('/agents', agentsRouter)
router.use('/sessions', sessionsRouter)
router.use('/chat', chatRouter)
router.use('/organizations', organizationsRouter)
router.use('/api-keys', apiKeysRouter)
router.use('/tools', toolsRouter)
router.use('/mcp', mcpRouter)
router.use('/memory', memoryRouter)
router.use('/logs', logsRouter)
router.use('/llm-providers', llmProvidersRouter)
router.use('/users', usersRouter)
router.use('/skill-definitions', skillDefinitionsRouter)
router.use('/evolved-skills', evolvedSkillsRouter)
router.use('/webhooks', webhooksRouter)
router.use('/vm', vmRouter)
router.use('/files', filesRouter)
router.use('/runtime', runtimeRouter)
router.use('/events', eventsRouter)
router.use('/rules', rulesRouter)
router.use('/approvals', approvalsRouter)
router.use('/gateways', gatewaysRouter)

export default router
