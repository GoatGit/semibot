/**
 * Runtime 聚合路由
 *
 * 将 Python Runtime 暴露的只读能力信息聚合到 API 层，便于 Web UI 获取。
 */

import { Router, type Response } from 'express'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { asyncHandler } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'

const router: Router = Router()

interface RuntimeSkillsPayload {
  tools?: string[]
  skills?: string[]
}

function getRuntimeBaseUrl(): string {
  const raw = process.env.RUNTIME_URL || 'http://localhost:8901'
  return raw.replace(/\/+$/, '')
}

/**
 * GET /runtime/skills
 * 返回 runtime 当前注册的内置 tools/skills（只读）
 */
router.get(
  '/skills',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const baseUrl = getRuntimeBaseUrl()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)

    try {
      const response = await fetch(`${baseUrl}/v1/skills`, {
        method: 'GET',
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!response.ok) {
        res.json({
          success: true,
          data: {
            available: false,
            tools: [],
            skills: [],
            source: baseUrl,
            error: `runtime returned ${response.status}`,
          },
        })
        return
      }

      const payload = (await response.json()) as RuntimeSkillsPayload
      res.json({
        success: true,
        data: {
          available: true,
          tools: Array.isArray(payload.tools) ? payload.tools : [],
          skills: Array.isArray(payload.skills) ? payload.skills : [],
          source: baseUrl,
        },
      })
      return
    } catch (error) {
      clearTimeout(timeout)
      res.json({
        success: true,
        data: {
          available: false,
          tools: [],
          skills: [],
          source: baseUrl,
          error: error instanceof Error ? error.message : 'runtime unreachable',
        },
      })
      return
    }
  })
)

export default router
