/**
 * Unified Control API route.
 *
 * Proxies control-plane operations to runtime:
 * POST /api/v1/control/:domain/:action -> /v1/control/{domain}/{action}
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'

const router: Router = Router()

const controlParamsSchema = z.object({
  domain: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
})

const controlBodySchema = z.object({
  payload: z.record(z.unknown()).optional(),
  options: z.record(z.unknown()).optional(),
})

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function getRuntimeBaseUrls(): string[] {
  const configured = (process.env.RUNTIME_URL || '')
    .split(',')
    .map((value) => normalizeBaseUrl(value))
    .filter(Boolean)
  if (configured.length > 0) {
    return Array.from(new Set(configured))
  }
  const defaultPort = String(process.env.RUNTIME_PORT || '8765').trim() || '8765'
  return [`http://127.0.0.1:${defaultPort}`]
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'runtime unreachable'
}

router.post(
  '/:domain/:action',
  authenticate,
  combinedRateLimit,
  validate(controlParamsSchema, 'params'),
  validate(controlBodySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const params = req.params as z.infer<typeof controlParamsSchema>
    const body = req.body as z.infer<typeof controlBodySchema>
    const runtimePayload = {
      payload: body.payload || {},
      options: body.options || {},
    }

    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)
      try {
        const response = await fetch(
          `${baseUrl}/v1/control/${encodeURIComponent(params.domain)}/${encodeURIComponent(params.action)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runtimePayload),
            signal: controller.signal,
          }
        )
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail =
            (data as { detail?: { message?: string } | string }).detail ||
            `runtime returned ${response.status}`
          const msg =
            typeof detail === 'string'
              ? detail
              : detail && typeof detail === 'object' && 'message' in detail
                ? String((detail as { message?: string }).message || '')
                : `runtime returned ${response.status}`
          errors.push(`${baseUrl}: ${msg}`)
          continue
        }
        const runtimeData = data as { ok?: boolean; data?: unknown; metadata?: unknown }
        res.json({
          success: true,
          data: runtimeData?.data ?? data,
          metadata: runtimeData?.metadata ?? {},
          runtimeOk: runtimeData?.ok ?? true,
        })
        return
      } catch (error) {
        clearTimeout(timeout)
        errors.push(`${baseUrl}: ${stringifyError(error)}`)
      }
    }

    res.status(502).json({
      success: false,
      error: { code: 'RUNTIME_UNREACHABLE', message: errors.join('; ') || 'runtime unreachable' },
    })
  })
)

export default router
