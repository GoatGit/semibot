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
import type { Dirent } from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

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

const runtimeSkillsCliSchema = z.object({
  action: z.enum(['init', 'update', 'find', 'add']),
  query: z.string().min(1).max(200).optional(),
  skill: z.string().min(1).max(200).optional(),
})

const controlPlaneActionParamsSchema = z.object({
  domain: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
})

const controlPlaneActionBodySchema = z.object({
  payload: z.record(z.unknown()).optional(),
  options: z.record(z.unknown()).optional(),
})

const SKILLS_CLI_TIMEOUT_MS = 120_000

function sanitizeSkillName(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (!/^[a-zA-Z0-9._/@-]+$/.test(text)) return ''
  return text
}

function runSkillsCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['skills', ...args], {
      // Run under HOME so skills cli writes into ~/.agents/skills rather than project-local .agents.
      cwd: os.homedir(),
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: 124, stdout, stderr: `${stderr}\nskills cli timeout` })
    }, SKILLS_CLI_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    // Best-effort auto-confirm for interactive prompts in skills cli.
    const autoInput = ['\n', 'a\n', '\n']
    for (let i = 0; i < autoInput.length; i += 1) {
      setTimeout(() => {
        try {
          child.stdin.write(autoInput[i] || '')
        } catch {
          // ignore
        }
      }, 250 * (i + 1))
    }
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: `${stderr}\n${String(err)}` })
    })
  })
}

function candidateAgentsSkillsRoots(): string[] {
  const roots = [
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(process.cwd(), 'apps', 'api', '.agents', 'skills'),
    path.join(process.cwd(), '.agents', 'skills'),
  ]
  return Array.from(new Set(roots))
}

function sanitizeCliText(raw: string): string {
  const text = String(raw || '')
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, 'g')
  const cleaned = text
    // Real ANSI escape codes
    .replace(ansiPattern, '')
    // Broken color fragments without ESC (e.g. "[38;5;145m")
    .replace(/\[[0-9;]{1,20}m/g, '')
    // Box drawing / bullet glyph noise from interactive TUI output
    .replace(/[\u2500-\u257F\u25A0-\u25FF]/g, '')
    .replace(/\[0m/g, '')
  let normalized = ''
  for (const ch of cleaned) {
    const code = ch.charCodeAt(0)
    const isTabOrNewline = code === 0x09 || code === 0x0a || code === 0x0d
    const isControl = (code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f
    if (isControl && !isTabOrNewline) continue
    normalized += ch
  }
  return normalized.trim()
}

function listSkillDirs(root: string): Map<string, string> {
  const resolved = path.resolve(root)
  const found = new Map<string, string>()
  if (!fs.existsSync(resolved)) return found
  const stack: string[] = [resolved]
  while (stack.length > 0) {
    const current = stack.pop() || ''
    if (!current) continue
    let entries: Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    const hasSkillMd = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')
    if (hasSkillMd) {
      const name = path.basename(current)
      if (name && !found.has(name)) {
        found.set(name, current)
      }
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      stack.push(path.join(current, entry.name))
    }
  }
  return found
}

async function syncAgentSkillsToSemibot({
  agentsSkillsRoots,
  semibotSkillsRoot,
}: {
  agentsSkillsRoots: string[]
  semibotSkillsRoot: string
}): Promise<{ synced: string[]; scannedRoots: string[] }> {
  const merged = new Map<string, string>()
  const scannedRoots: string[] = []
  for (const root of agentsSkillsRoots) {
    if (!fs.existsSync(root)) continue
    scannedRoots.push(root)
    const rows = listSkillDirs(root)
    for (const [name, skillPath] of rows.entries()) {
      // Keep first hit by root priority.
      if (!merged.has(name)) merged.set(name, skillPath)
    }
  }
  const synced: string[] = []
  for (const [name, src] of merged.entries()) {
    const dst = path.join(semibotSkillsRoot, name)
    await fs.copy(src, dst, { overwrite: true, errorOnExist: false })
    synced.push(name)
  }
  return { synced, scannedRoots }
}

function extractSkillsCliCandidates(text: string): string[] {
  const pattern = /\b([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*)\b/gi
  const hits = text.match(pattern) || []
  return Array.from(new Set(hits.map((item) => item.trim()).filter(Boolean)))
}

async function postRuntimeJson(baseUrls: string[], endpoint: string, payload: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const errors: string[] = []
  for (const baseUrl of baseUrls) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      clearTimeout(timeout)
      const data = await response.json()
      if (!response.ok) {
        errors.push(`${baseUrl}: ${(data as { detail?: string }).detail || `runtime returned ${response.status}`}`)
        continue
      }
      return { ok: true, data }
    } catch (error) {
      clearTimeout(timeout)
      errors.push(`${baseUrl}: ${stringifyError(error)}`)
    }
  }
  return { ok: false, error: errors.join('; ') || 'runtime unreachable' }
}

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
 * POST /runtime/skills/skills-cli
 * 通过 `npx skills` 安装技能，并同步到 ~/.semibot/skills
 */
router.post(
  '/control/:domain/:action',
  authenticate,
  combinedRateLimit,
  validate(controlPlaneActionParamsSchema, 'params'),
  validate(controlPlaneActionBodySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []
    const params = req.params as z.infer<typeof controlPlaneActionParamsSchema>
    const body = req.body as z.infer<typeof controlPlaneActionBodySchema>
    const runtimePayload = {
      payload: body.payload || {},
      options: body.options || {},
    }

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
      error: {
        code: 'RUNTIME_UNREACHABLE',
        message: errors.join('; ') || 'runtime unreachable',
      },
    })
  })
)

router.post(
  '/skills/skills-cli',
  authenticate,
  combinedRateLimit,
  validate(runtimeSkillsCliSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof runtimeSkillsCliSchema>
    const action = body.action
    const agentsSkillsRoots = candidateAgentsSkillsRoots()
    const semibotSkillsRoot = path.join(os.homedir(), '.semibot', 'skills')
    for (const root of agentsSkillsRoots) {
      await fs.ensureDir(root)
    }
    await fs.ensureDir(semibotSkillsRoot)

    let commandArgs: string[] = []
    if (action === 'init') {
      commandArgs = ['init', '--yes']
    } else if (action === 'update') {
      commandArgs = ['update', '--yes']
    } else if (action === 'find') {
      if (!body.query) {
        res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'query is required for find' } })
        return
      }
      commandArgs = ['find', body.query]
    } else if (action === 'add') {
      const skill = sanitizeSkillName(body.skill || '')
      if (!skill) {
        res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'skill is required for add' } })
        return
      }
      commandArgs = ['add', skill, '--yes']
    }

    let run = await runSkillsCli(commandArgs)
    if (
      run.code !== 0 &&
      /unknown option|unknown argument|invalid option|Unknown option/i.test(`${run.stderr}\n${run.stdout}`) &&
      commandArgs.includes('--yes')
    ) {
      run = await runSkillsCli(commandArgs.filter((arg) => arg !== '--yes'))
    }
    if (run.code !== 0) {
      res.status(502).json({
        success: false,
        error: {
          code: 'SKILLS_CLI_FAILED',
          message: sanitizeCliText(run.stderr || run.stdout) || `skills cli failed: ${run.code}`,
        },
        data: { code: run.code, stdout: sanitizeCliText(run.stdout), stderr: sanitizeCliText(run.stderr) },
      })
      return
    }

    const cleanedStdout = sanitizeCliText(run.stdout)
    const cleanedStderr = sanitizeCliText(run.stderr)
    const candidates = action === 'find' ? extractSkillsCliCandidates(`${cleanedStdout}\n${cleanedStderr}`) : []
    let synced: string[] = []
    let scannedRoots: string[] = []
    if (action === 'add' || action === 'update' || action === 'init') {
      const syncResult = await syncAgentSkillsToSemibot({
        agentsSkillsRoots,
        semibotSkillsRoot,
      })
      synced = syncResult.synced
      scannedRoots = syncResult.scannedRoots
    }

    const baseUrls = getRuntimeBaseUrls()
    const reindex = await postRuntimeJson(baseUrls, '/v1/skills/reindex', { scope: 'incremental' })
    const refresh = await postRuntimeJson(baseUrls, '/v1/skills/refresh-runtime', {})

    res.json({
      success: true,
      data: {
        action,
        command: ['npx', 'skills', ...commandArgs],
        stdout: cleanedStdout,
        stderr: cleanedStderr,
        candidates,
        agentsSkillsRoots: scannedRoots.length > 0 ? scannedRoots : agentsSkillsRoots,
        syncedSkills: synced,
        reindex,
        refresh,
      },
    })
  })
)

/**
 * GET /runtime/channels/conversations
 * 聚合 runtime channel conversations（telegram/feishu 等）
 */
router.get(
  '/channels/conversations',
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
                provider: item.provider || 'channel',
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
 * GET /runtime/channels/conversations/:conversationId/runs
 * 代理 runtime 会话运行记录
 */
router.get(
  '/channels/conversations/:conversationId/runs',
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
 * GET /runtime/channels/conversations/:conversationId/context
 * 代理 runtime 会话上下文消息
 */
router.get(
  '/channels/conversations/:conversationId/context',
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
