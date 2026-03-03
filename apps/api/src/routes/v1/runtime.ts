/**
 * Runtime 聚合路由
 *
 * 将 Python Runtime 暴露的只读能力信息聚合到 API 层，便于 Web UI 获取。
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { handleFileUpload, type UploadRequest } from '../../middleware/upload'
import fs from 'fs-extra'

const router: Router = Router()

interface RuntimeSkillsPayload {
  tools?: string[]
  skills?: string[]
  metadata?: Array<Record<string, unknown>>
}

interface RuntimeGatewayConversationsPayload {
  data?: Array<{
    conversation_id?: string
    provider?: string
    gateway_key?: string
    status?: string
    updated_at?: string
  }>
}

interface RuntimeGatewayRunsPayload {
  data?: Array<{
    run_id?: string
    runtime_session_id?: string
    snapshot_version?: number
    status?: string
    result_summary?: string
    updated_at?: string
  }>
}

interface RuntimeGatewayContextPayload {
  conversation_id?: string
  messages?: Array<{
    id?: string
    context_version?: number
    role?: string
    content?: string
    metadata?: Record<string, unknown>
    created_at?: string
  }>
}

interface RuntimeCronJobsPayload {
  data?: Array<{
    name?: string
    event_type?: string
    schedule?: string
    source?: string
    subject?: string | null
    payload?: Record<string, unknown>
  }>
}

interface RuntimeSkillsInstallPayload {
  ok?: boolean
  action?: string
  installed_path?: string
  skill_name?: string
  source_type?: string
  registered_in_runtime?: boolean
  refresh?: {
    registered?: string[]
    skipped?: Array<{ name?: string; reason?: string }>
  }
  reindex?: Record<string, unknown>
}

const listGatewayConversationsSchema = z.object({
  provider: z.string().max(32).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

const listGatewayRunsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
})

const listGatewayContextSchema = z.object({
  limit: z.coerce.number().min(1).max(200).optional(),
})

const upsertCronJobSchema = z.object({
  name: z.string().min(1).max(120),
  schedule: z.string().min(1).max(120),
  eventType: z.string().min(1).max(160).default('cron.job.tick'),
  source: z.string().min(1).max(160).default('system.cron'),
  subject: z.string().max(160).nullable().optional(),
  payload: z.record(z.unknown()).optional(),
})

const runtimeSkillInstallSchema = z.object({
  sourcePath: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  skillName: z.string().min(1).max(120).optional(),
  force: z.boolean().optional(),
})

const runtimeReindexSchema = z.object({
  scope: z.enum(['incremental', 'full']).optional(),
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
            metadata: Array.isArray(payload.metadata) ? payload.metadata : [],
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
        metadata: [],
        source: baseUrls[0] || '',
        error: errors.join('; ') || 'runtime unreachable',
      },
    })
    return
  })
)

router.post(
  '/skills/install',
  authenticate,
  combinedRateLimit,
  validate(runtimeSkillInstallSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const body = req.body as z.infer<typeof runtimeSkillInstallSchema>
    const payload = {
      source_path: body.sourcePath,
      source_url: body.sourceUrl,
      skill_name: body.skillName,
      force: body.force === true,
    }

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      try {
        const response = await fetch(`${baseUrl}/v1/skills/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = (await response.json()) as RuntimeSkillsInstallPayload | { detail?: string }
        if (!response.ok) {
          errors.push(`${baseUrl}: ${(data as { detail?: string }).detail || `runtime returned ${response.status}`}`)
          continue
        }
        res.status(201).json({ success: true, data })
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

router.post(
  '/skills/install/upload',
  authenticate,
  combinedRateLimit,
  handleFileUpload,
  asyncHandler(async (req: UploadRequest & AuthRequest, res: Response) => {
    if (!req.uploadedFile) {
      res.status(400).json({
        success: false,
        error: { code: 'SKILL_UPLOAD_NO_FILE', message: '未检测到上传文件' },
      })
      return
    }

    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const fields = req.uploadFields || {}
    const force = String(fields.force || '').trim().toLowerCase()
    const skillName = String(fields.skillName || fields.skill_name || '').trim()
    const fileBuffer = await fs.readFile(req.uploadedFile.tempPath)

    try {
      for (const baseUrl of baseUrls) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 45000)
        try {
          const formData = new FormData()
          const fileName = req.uploadedFile.originalName || 'skill.zip'
          const mimeType = req.uploadedFile.mimeType || 'application/zip'
          formData.append('archive', new Blob([fileBuffer], { type: mimeType }), fileName)
          if (skillName) formData.append('skill_name', skillName)
          if (force) formData.append('force', force)

          const response = await fetch(`${baseUrl}/v1/skills/install`, {
            method: 'POST',
            body: formData,
            signal: controller.signal,
          })
          clearTimeout(timeout)
          const data = (await response.json()) as RuntimeSkillsInstallPayload | { detail?: string }
          if (!response.ok) {
            errors.push(`${baseUrl}: ${(data as { detail?: string }).detail || `runtime returned ${response.status}`}`)
            continue
          }
          res.status(201).json({ success: true, data })
          return
        } catch (error) {
          clearTimeout(timeout)
          errors.push(`${baseUrl}: ${stringifyError(error)}`)
        }
      }
    } finally {
      await fs.remove(req.uploadedFile.tempPath).catch(() => undefined)
    }

    res.status(502).json({
      success: false,
      error: { code: 'RUNTIME_UNREACHABLE', message: errors.join('; ') || 'runtime unreachable' },
    })
  })
)

router.post(
  '/skills/reindex',
  authenticate,
  combinedRateLimit,
  validate(runtimeReindexSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const body = req.body as z.infer<typeof runtimeReindexSchema>
    const payload = { scope: body.scope || 'incremental' }

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(`${baseUrl}/v1/skills/reindex`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json()
        if (!response.ok) {
          const detail = (data as { detail?: string }).detail || `runtime returned ${response.status}`
          errors.push(`${baseUrl}: ${detail}`)
          continue
        }
        res.json({ success: true, data })
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

router.post(
  '/skills/refresh-runtime',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined
    const payload = sessionId ? { session_id: sessionId } : {}

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(`${baseUrl}/v1/skills/refresh-runtime`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json()
        if (!response.ok) {
          const detail = (data as { detail?: string }).detail || `runtime returned ${response.status}`
          errors.push(`${baseUrl}: ${detail}`)
          continue
        }
        res.json({ success: true, data })
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

/**
 * GET /runtime/gateway/conversations
 * 聚合 runtime gateway conversations（telegram/feishu 等）
 */
router.get(
  '/gateway/conversations',
  authenticate,
  combinedRateLimit,
  validate(listGatewayConversationsSchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const query = req.query as z.infer<typeof listGatewayConversationsSchema>

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)

      try {
        const url = new URL(`${baseUrl}/v1/gateway/conversations`)
        if (query.provider) url.searchParams.set('provider', query.provider)
        if (query.limit) url.searchParams.set('limit', String(query.limit))

        const response = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          errors.push(`${baseUrl}: runtime returned ${response.status}`)
          continue
        }

        const payload = (await response.json()) as RuntimeGatewayConversationsPayload
        const items = Array.isArray(payload.data) ? payload.data : []
        res.json({
          success: true,
          data: {
            available: true,
            conversations: items
              .map((item) => ({
                conversationId: item.conversation_id || '',
                provider: item.provider || 'gateway',
                gatewayKey: item.gateway_key || '',
                status: item.status || 'active',
                updatedAt: item.updated_at || new Date().toISOString(),
              }))
              .filter((item) => item.conversationId),
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
        conversations: [],
        source: baseUrls[0] || '',
        error: errors.join('; ') || 'runtime unreachable',
      },
    })
    return
  })
)

/**
 * GET /runtime/gateway/conversations/:conversationId/runs
 * 代理 runtime 会话运行记录
 */
router.get(
  '/gateway/conversations/:conversationId/runs',
  authenticate,
  combinedRateLimit,
  validate(listGatewayRunsSchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const query = req.query as z.infer<typeof listGatewayRunsSchema>
    const conversationId = String(req.params.conversationId || '').trim()

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)

      try {
        const url = new URL(`${baseUrl}/v1/gateway/conversations/${encodeURIComponent(conversationId)}/runs`)
        if (query.limit) url.searchParams.set('limit', String(query.limit))

        const response = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          errors.push(`${baseUrl}: runtime returned ${response.status}`)
          continue
        }

        const payload = (await response.json()) as RuntimeGatewayRunsPayload
        const items = Array.isArray(payload.data) ? payload.data : []
        res.json({
          success: true,
          data: {
            available: true,
            runs: items
              .map((item) => ({
                runId: item.run_id || '',
                runtimeSessionId: item.runtime_session_id || '',
                snapshotVersion: item.snapshot_version ?? 0,
                status: item.status || 'unknown',
                resultSummary: item.result_summary || '',
                updatedAt: item.updated_at || new Date().toISOString(),
              }))
              .filter((item) => item.runId),
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
        runs: [],
        source: baseUrls[0] || '',
        error: errors.join('; ') || 'runtime unreachable',
      },
    })
    return
  })
)

/**
 * GET /runtime/gateway/conversations/:conversationId/context
 * 代理 runtime 会话上下文消息
 */
router.get(
  '/gateway/conversations/:conversationId/context',
  authenticate,
  combinedRateLimit,
  validate(listGatewayContextSchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const query = req.query as z.infer<typeof listGatewayContextSchema>
    const conversationId = String(req.params.conversationId || '').trim()

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)

      try {
        const url = new URL(`${baseUrl}/v1/gateway/conversations/${encodeURIComponent(conversationId)}/context`)
        if (query.limit) url.searchParams.set('limit', String(query.limit))

        const response = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          errors.push(`${baseUrl}: runtime returned ${response.status}`)
          continue
        }

        const payload = (await response.json()) as RuntimeGatewayContextPayload
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        res.json({
          success: true,
          data: {
            available: true,
            conversationId: payload.conversation_id || conversationId,
            messages: messages
              .map((item) => ({
                id: item.id || '',
                contextVersion: item.context_version ?? 0,
                role: item.role || 'unknown',
                content: item.content || '',
                metadata: item.metadata || {},
                createdAt: item.created_at || new Date().toISOString(),
              }))
              .filter((item) => item.id),
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
        conversationId,
        messages: [],
        source: baseUrls[0] || '',
        error: errors.join('; ') || 'runtime unreachable',
      },
    })
    return
  })
)

router.get(
  '/scheduler/cron-jobs',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)

      try {
        const response = await fetch(`${baseUrl}/v1/scheduler/cron-jobs`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          errors.push(`${baseUrl}: runtime returned ${response.status}`)
          continue
        }

        const payload = (await response.json()) as RuntimeCronJobsPayload
        const jobs = Array.isArray(payload.data) ? payload.data : []
        res.json({
          success: true,
          data: {
            available: true,
            jobs: jobs
              .map((item) => ({
                name: item.name || '',
                eventType: item.event_type || 'cron.job.tick',
                schedule: item.schedule || '',
                source: item.source || 'system.cron',
                subject: item.subject || null,
                payload: item.payload || {},
              }))
              .filter((item) => item.name && item.schedule),
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
        jobs: [],
        source: baseUrls[0] || '',
        error: errors.join('; ') || 'runtime unreachable',
      },
    })
  })
)

router.post(
  '/scheduler/cron-jobs',
  authenticate,
  combinedRateLimit,
  validate(upsertCronJobSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const body = req.body as z.infer<typeof upsertCronJobSchema>

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)

      try {
        const response = await fetch(`${baseUrl}/v1/scheduler/cron-jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: body.name,
            schedule: body.schedule,
            event_type: body.eventType,
            source: body.source,
            subject: body.subject ?? null,
            payload: body.payload || {},
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          errors.push(`${baseUrl}: runtime returned ${response.status}`)
          continue
        }

        const payload = (await response.json()) as RuntimeCronJobsPayload & { accepted?: boolean }
        const jobs = Array.isArray(payload.data) ? payload.data : []
        res.status(201).json({
          success: true,
          data: {
            accepted: payload.accepted ?? true,
            jobs,
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
