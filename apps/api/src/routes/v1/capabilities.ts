import { Router, type Response } from 'express'
import { z } from 'zod'

import { authenticate, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'

const router: Router = Router()

const missingCapabilitySchema = z.object({
  type: z.string().optional(),
  version: z.string().optional(),
  intent: z.string().min(1),
  reason: z.string().min(1),
  requiredCapabilities: z.array(z.string()).optional(),
  required_capabilities: z.array(z.string()).optional(),
  preferredSources: z.array(z.string()).optional(),
  preferred_sources: z.array(z.string()).optional(),
})

const capabilityInstallSchema = z.object({
  missingCapability: missingCapabilitySchema,
  registryName: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  taskText: z.string().min(1).optional(),
  currentShortlistToolIds: z.array(z.string()).optional(),
})

const capabilityApproveSchema = z.object({
  installRequestId: z.string().min(1),
  approved: z.boolean().optional(),
})

const capabilityRetrySchema = z.object({
  installRequestId: z.string().min(1),
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

async function proxyRuntimeJson(
  path: string,
  initFactory: (signal: AbortSignal) => RequestInit,
  {
    timeoutMs,
    errorCode,
  }: {
    timeoutMs: number
    errorCode: string
  }
): Promise<
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; data?: unknown; detail?: { code?: string; message?: string } | string }
  | { ok: false; status: 502; errors: string[] }
> {
  const baseUrls = getRuntimeBaseUrls()
  const errors: string[] = []

  for (const baseUrl of baseUrls) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl}${path}`, initFactory(controller.signal))
      clearTimeout(timeout)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail =
          (data as { detail?: { code?: string; message?: string } | string }).detail || `runtime returned ${response.status}`
        if (typeof detail === 'object' && detail) {
          return { ok: false, status: response.status, data, detail }
        }
        errors.push(`${baseUrl}: ${String(detail)}`)
        continue
      }
      return { ok: true, status: response.status, data: (data as { data?: unknown }).data ?? data }
    } catch (error) {
      clearTimeout(timeout)
      errors.push(`${baseUrl}: ${stringifyError(error)}`)
    }
  }

  return { ok: false, status: 502, errors: errors.length > 0 ? errors : [errorCode] }
}

router.post(
  '/resolve-missing',
  authenticate,
  combinedRateLimit,
  validate(capabilityInstallSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof capabilityInstallSchema>
    const baseUrls = getRuntimeBaseUrls()
    const payload = {
      missingCapability: body.missingCapability,
      registryName: body.registryName,
      query: body.query,
      taskId: body.taskId,
      sessionId: body.sessionId,
      taskText: body.taskText,
      currentShortlistToolIds: body.currentShortlistToolIds,
    }
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000)
      try {
        const response = await fetch(`${baseUrl}/v1/capabilities/resolve-missing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail =
            (data as { detail?: { code?: string; message?: string } | string }).detail || `runtime returned ${response.status}`
          if (typeof detail === 'object' && detail) {
            res.status(response.status).json({
              success: false,
              error: {
                code: detail.code || 'CAPABILITY_INSTALL_FAILED',
                message: detail.message || `runtime returned ${response.status}`,
              },
              data,
            })
            return
          }
          errors.push(`${baseUrl}: ${String(detail)}`)
          continue
        }
        const resultData = (data as { data?: Record<string, unknown> }).data
        res.status(200).json({
          success: true,
          data: resultData ?? data,
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

router.post(
  '/approve-install',
  authenticate,
  combinedRateLimit,
  validate(capabilityApproveSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof capabilityApproveSchema>
    const baseUrls = getRuntimeBaseUrls()
    const payload = {
      installRequestId: body.installRequestId,
      approved: body.approved ?? true,
    }
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000)
      try {
        const response = await fetch(`${baseUrl}/v1/capabilities/approve-install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail =
            (data as { detail?: { code?: string; message?: string } | string }).detail || `runtime returned ${response.status}`
          if (typeof detail === 'object' && detail) {
            res.status(response.status).json({
              success: false,
              error: {
                code: detail.code || 'CAPABILITY_INSTALL_FAILED',
                message: detail.message || `runtime returned ${response.status}`,
              },
              data,
            })
            return
          }
          errors.push(`${baseUrl}: ${String(detail)}`)
          continue
        }
        res.status(200).json({
          success: true,
          data: (data as { data?: Record<string, unknown> }).data ?? data,
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

router.get(
  '/install-history',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const sessionId = String(req.query.sessionId || req.query.session_id || '').trim()
    const taskId = String(req.query.taskId || req.query.task_id || '').trim()
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 20) || 20))
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      try {
        const url = new URL(`${baseUrl}/v1/capabilities/install-history`)
        if (sessionId) url.searchParams.set('session_id', sessionId)
        if (taskId) url.searchParams.set('task_id', taskId)
        url.searchParams.set('limit', String(limit))
        const response = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail =
            (data as { detail?: { code?: string; message?: string } | string }).detail || `runtime returned ${response.status}`
          if (typeof detail === 'object' && detail) {
            res.status(response.status).json({
              success: false,
              error: {
                code: detail.code || 'INSTALL_HISTORY_FAILED',
                message: detail.message || `runtime returned ${response.status}`,
              },
              data,
            })
            return
          }
          errors.push(`${baseUrl}: ${String(detail)}`)
          continue
        }
        res.status(200).json({
          success: true,
          data: (data as { data?: Record<string, unknown> }).data ?? data,
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

router.get(
  '/install-status/:installRequestId',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const installRequestId = String(req.params.installRequestId || '').trim()
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      try {
        const response = await fetch(`${baseUrl}/v1/capabilities/install-status/${encodeURIComponent(installRequestId)}`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail =
            (data as { detail?: { code?: string; message?: string } | string }).detail || `runtime returned ${response.status}`
          if (typeof detail === 'object' && detail) {
            res.status(response.status).json({
              success: false,
              error: {
                code: detail.code || 'INSTALL_REQUEST_NOT_FOUND',
                message: detail.message || `runtime returned ${response.status}`,
              },
              data,
            })
            return
          }
          errors.push(`${baseUrl}: ${String(detail)}`)
          continue
        }
        res.status(200).json({
          success: true,
          data: (data as { data?: Record<string, unknown> }).data ?? data,
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

router.post(
  '/retry-task',
  authenticate,
  combinedRateLimit,
  validate(capabilityRetrySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof capabilityRetrySchema>
    const baseUrls = getRuntimeBaseUrls()
    const payload = { installRequestId: body.installRequestId }
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000)
      try {
        const response = await fetch(`${baseUrl}/v1/capabilities/retry-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail =
            (data as { detail?: { code?: string; message?: string } | string }).detail || `runtime returned ${response.status}`
          if (typeof detail === 'object' && detail) {
            res.status(response.status).json({
              success: false,
              error: {
                code: detail.code || 'RETRY_TASK_FAILED',
                message: detail.message || `runtime returned ${response.status}`,
              },
              data,
            })
            return
          }
          errors.push(`${baseUrl}: ${String(detail)}`)
          continue
        }
        res.status(200).json({
          success: true,
          data: (data as { data?: Record<string, unknown> }).data ?? data,
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

router.post(
  '/install',
  authenticate,
  combinedRateLimit,
  validate(capabilityInstallSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof capabilityInstallSchema>
    const result = await proxyRuntimeJson(
      '/v1/capabilities/install',
      (signal) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          missingCapability: body.missingCapability,
          registryName: body.registryName,
          query: body.query,
          taskId: body.taskId,
          sessionId: body.sessionId,
          taskText: body.taskText,
          currentShortlistToolIds: body.currentShortlistToolIds,
        }),
        signal,
      }),
      { timeoutMs: 60000, errorCode: 'CAPABILITY_INSTALL_FAILED' }
    )
    if (!result.ok) {
      if ('detail' in result && typeof result.detail === 'object' && result.detail) {
        res.status(result.status).json({
          success: false,
          error: {
            code: result.detail.code || 'CAPABILITY_INSTALL_FAILED',
            message: result.detail.message || `runtime returned ${result.status}`,
          },
          data: result.data,
        })
        return
      }
      res.status(result.status).json({
        success: false,
        error: {
          code: result.status === 502 ? 'RUNTIME_UNREACHABLE' : 'CAPABILITY_INSTALL_FAILED',
          message: 'errors' in result ? result.errors.join('; ') : 'runtime unreachable',
        },
      })
      return
    }
    res.status(200).json({
      success: true,
      data: result.data,
    })
  })
)

export default router
