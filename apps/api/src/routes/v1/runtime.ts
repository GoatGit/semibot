/**
 * Runtime 监控 API 路由
 */

import { Router } from 'express'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler } from '../../middleware/errorHandler'
import { getRuntimeMonitor } from '../../services/runtime-monitor.service'

const router: Router = Router()

/**
 * GET /runtime/metrics - 获取 Runtime 执行指标
 */
router.get(
  '/metrics',
  authenticate,
  requirePermission('admin:read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const monitor = getRuntimeMonitor()
    const summary = monitor.getSummary()

    res.json({
      success: true,
      data: summary,
    })
  })
)

/**
 * GET /runtime/metrics/:orgId - 获取指定组织的 Runtime 执行指标
 */
router.get(
  '/metrics/:orgId',
  authenticate,
  requirePermission('admin:read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { orgId } = req.params
    const monitor = getRuntimeMonitor()

    const directMetrics = monitor.getMetricsByOrg(orgId, 'direct_llm')
    const runtimeMetrics = monitor.getMetricsByOrg(orgId, 'runtime_orchestrator')

    res.json({
      success: true,
      data: {
        orgId,
        direct: directMetrics,
        runtime: runtimeMetrics,
      },
    })
  })
)

/**
 * POST /runtime/fallback/reset - 手动重置回退状态
 */
router.post(
  '/fallback/reset',
  authenticate,
  requirePermission('admin:write'),
  asyncHandler(async (req: AuthRequest, res) => {
    const monitor = getRuntimeMonitor()
    monitor.resetFallback()

    res.json({
      success: true,
      message: '回退状态已重置',
    })
  })
)

/**
 * GET /runtime/fallback/status - 获取回退状态
 */
router.get(
  '/fallback/status',
  authenticate,
  requirePermission('admin:read'),
  asyncHandler(async (req: AuthRequest, res) => {
    const monitor = getRuntimeMonitor()

    res.json({
      success: true,
      data: {
        fallbackEnabled: monitor.shouldFallback(),
        fallbackReason: monitor.getFallbackReason(),
      },
    })
  })
)

export default router
