/**
 * API v1 路由汇总
 */

import { Router, type Request, type Response } from 'express'
import agentsRouter from './agents'
import sessionsRouter from './sessions'
import chatRouter from './chat'
import authRouter from './auth'
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
import channelsRouter from './channels'
import controlRouter from './control'
import contextPoliciesRouter from './context-policies'
import evolutionCapabilitiesRouter from './evolution-capabilities'
import statsRouter from './stats'
import studiosRouter from './studios'
import { isChannelsFeatureEnabled, isWebhooksFeatureEnabled } from '../../lib/feature-flags'
import { resolveCurrentVersion, resolveVersionPayload } from '../../lib/version'

const router: Router = Router()
const channelsEnabled = isChannelsFeatureEnabled()
const webhooksEnabled = isWebhooksFeatureEnabled()

// 健康检查
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      version: resolveCurrentVersion(),
      timestamp: new Date().toISOString(),
    },
  })
})

router.get('/version', async (_req: Request, res: Response) => {
  const payload = await resolveVersionPayload()
  res.json({
    success: true,
    data: payload,
  })
})

// 轻量 API 文档索引（用于前端/脚本发现关键路由与迁移信息）
router.get('/docs', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      version: 'v1',
      endpoints: {
        health: '/api/v1/health',
        version: '/api/v1/version',
        chat: '/api/v1/chat',
        sessions: '/api/v1/sessions',
        agents: '/api/v1/agents',
        tools: '/api/v1/tools',
        events: '/api/v1/events',
        rules: '/api/v1/rules',
        approvals: '/api/v1/approvals',
        control: '/api/v1/control',
        evolutionCapabilities: '/api/v1/evolution-capabilities',
        ...(channelsEnabled ? { channels: '/api/v1/channels' } : {}),
        ...(webhooksEnabled ? { webhooks: '/api/v1/webhooks' } : {}),
      },
      deprecated: [
        {
          path: '/api/v1/context-policies',
          successor: '/api/v1/evolution-capabilities',
          sunset: 'Tue, 30 Jun 2026 00:00:00 GMT',
        },
      ],
    },
  })
})

// Auth 路由 (无需认证)
router.use('/auth', authRouter)

// API 路由 (需要认证)
router.use('/agents', agentsRouter)
router.use('/sessions', sessionsRouter)
router.use('/chat', chatRouter)
router.use('/api-keys', apiKeysRouter)
router.use('/tools', toolsRouter)
router.use('/mcp', mcpRouter)
router.use('/memory', memoryRouter)
router.use('/logs', logsRouter)
router.use('/llm-providers', llmProvidersRouter)
router.use('/users', usersRouter)
router.use('/skill-definitions', skillDefinitionsRouter)
router.use('/evolved-skills', evolvedSkillsRouter)
if (webhooksEnabled) {
  router.use('/webhooks', webhooksRouter)
}
router.use('/vm', vmRouter)
router.use('/files', filesRouter)
router.use('/runtime', runtimeRouter)
router.use('/events', eventsRouter)
router.use('/rules', rulesRouter)
router.use('/approvals', approvalsRouter)
if (channelsEnabled) {
  router.use('/channels', channelsRouter)
}
router.use('/control', controlRouter)
router.use('/context-policies', contextPoliciesRouter)
router.use('/evolution-capabilities', evolutionCapabilitiesRouter)
router.use('/stats', statsRouter)
router.use('/studios', studiosRouter)

export default router
