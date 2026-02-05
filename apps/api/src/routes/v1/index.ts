/**
 * API v1 路由汇总
 */

import { Router, type Request, type Response } from 'express'
import agentsRouter from './agents'
import sessionsRouter from './sessions'
import chatRouter from './chat'

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

// API 路由
router.use('/agents', agentsRouter)
router.use('/sessions', sessionsRouter)
router.use('/chat', chatRouter)

export default router
