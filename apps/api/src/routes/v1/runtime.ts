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

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function getRuntimeBaseUrls(): string[] {
  const fallbackUrls = ['http://localhost:8765', 'http://localhost:8901', 'http://localhost:8801']
  const configured = (process.env.RUNTIME_URL || '')
    .split(',')
    .map((value) => normalizeBaseUrl(value))
    .filter(Boolean)

  // Prefer configured runtime URL(s), but keep local fallback ports for resilience.
  return Array.from(new Set([...configured, ...fallbackUrls]))
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'runtime unreachable'
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
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)

      try {
        const response = await fetch(`${baseUrl}/v1/skills`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          errors.push(`${baseUrl}: runtime returned ${response.status}`)
          continue
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
        errors.push(`${baseUrl}: ${stringifyError(error)}`)
      }
    }

    res.json({
      success: true,
      data: {
        available: false,
        tools: [],
        skills: [],
        source: baseUrls[0] || '',
        error: errors.join('; ') || 'runtime unreachable',
      },
    })
    return
  })
)

export default router
