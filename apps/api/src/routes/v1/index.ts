/**
 * API v1 路由汇总
 */

import { Router } from 'express'
import agentsRouter from './agents.js'
import sessionsRouter from './sessions.js'
import chatRouter from './chat.js'

const router = Router()

// 健康检查
router.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'healthy',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    },
  })
})

// API 路由
router.use('/agents', agentsRouter)
router.use('/sessions', sessionsRouter)
router.use('/chat', chatRouter)

export default router
