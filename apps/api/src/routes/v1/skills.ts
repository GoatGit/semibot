import { Router, type Response } from 'express'

import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'

const router: Router = Router()

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function getRuntimeBaseUrls(): string[] {
  const configured = (process.env.RUNTIME_URL || '')
    .split(',')
    .map((value) => normalizeBaseUrl(value))
    .filter(Boolean)
  if (configured.length > 0) return Array.from(new Set(configured))
  const defaultPort = String(process.env.RUNTIME_PORT || '8765').trim() || '8765'
  return [`http://127.0.0.1:${defaultPort}`]
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'runtime unreachable'
}

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      try {
        const response = await fetch(`${baseUrl}/v1/skills`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail = (data as { detail?: string }).detail || `runtime returned ${response.status}`
          errors.push(`${baseUrl}: ${detail}`)
          continue
        }
        res.json({
          success: true,
          data: {
            skills: Array.isArray((data as { skills?: unknown[] }).skills)
              ? (data as { skills: unknown[] }).skills
              : [],
            metadata: Array.isArray((data as { metadata?: unknown[] }).metadata)
              ? (data as { metadata: unknown[] }).metadata
              : [],
            source: baseUrl,
          },
        })
        return
      } catch (error) {
        clearTimeout(timeout)
        errors.push(`${baseUrl}: ${stringifyError(error)}`)
      }
    }

    res.status(502).json({
      success: false,
      error: {
        code: 'RUNTIME_UNREACHABLE',
        message: errors.join('; ') || 'runtime unreachable',
      },
    })
  })
)

export default router
