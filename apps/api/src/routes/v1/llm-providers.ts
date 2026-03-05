/**
 * LLM Providers API 路由
 *
 * - Provider 状态查询
 * - 本地 .env.local 的 LLM 配置读写（单机场景）
 */

import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requireRole, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { getProviderStatus, reloadProviders } from '../../services/llm.service'
import { getWSServer } from '../../ws/ws-server'
import { createLogger } from '../../lib/logger'

const router: Router = Router()
const llmProviderRouteLogger = createLogger('llm-provider-route')

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google AI',
  kimi: 'Kimi',
  qwen: 'Qwen',
  minimax: 'MiniMax',
  xai: 'xAI',
  custom: '自定义模型',
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..', '..', '..', '..', '..')
const envLocalPath = resolve(projectRoot, '.env.local')
const REDACTED_VALUE = '__SEMIBOT_REDACTED__'
const CUSTOM_ENV_SENSITIVE_KEYS_VAR = 'SEMIBOT_ENV_SENSITIVE_KEYS'

const DEFAULT_BASE_URLS = {
  OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
  ANTHROPIC_API_BASE_URL: 'https://api.anthropic.com/v1',
  GOOGLE_AI_API_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
  KIMI_API_BASE_URL: 'https://api.moonshot.cn/v1',
  QWEN_API_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  MINIMAX_API_BASE_URL: 'https://api.minimax.chat/v1',
  XAI_API_BASE_URL: 'https://api.x.ai/v1',
  CUSTOM_LLM_API_BASE_URL: '',
}

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  clearApiKey: z.boolean().optional(),
})

const updateLlmConfigSchema = z.object({
  defaultModel: z.string().optional(),
  fallbackModel: z.string().optional(),
  providers: z.record(providerConfigSchema).optional(),
})

const upsertEnvVarSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Z_][A-Z0-9_]*$/, 'invalid env var name'),
  value: z.string().max(10000).optional(),
  clear: z.boolean().optional(),
  isSensitive: z.boolean().optional(),
})

const updateEnvVarSchema = z.object({
  value: z.string().max(10000).optional(),
  clear: z.boolean().optional(),
  isSensitive: z.boolean().optional(),
})

type CustomProviderConfig = {
  type: 'openai' | 'anthropic' | 'google' | 'kimi' | 'qwen' | 'minimax' | 'xai' | 'custom'
  id: string
  displayName?: string
  apiKey?: string
  baseUrl?: string
}

function keyPreview(value?: string): string | null {
  if (!value) return null
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value)
}

function isManagedLlmEnvKey(key: string): boolean {
  return [
    'OPENAI_API_KEY',
    'OPENAI_API_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_API_BASE_URL',
    'GOOGLE_AI_API_KEY',
    'GOOGLE_AI_API_BASE_URL',
    'KIMI_API_KEY',
    'KIMI_API_BASE_URL',
    'QWEN_API_KEY',
    'QWEN_API_BASE_URL',
    'MINIMAX_API_KEY',
    'MINIMAX_API_BASE_URL',
    'XAI_API_KEY',
    'XAI_API_BASE_URL',
    'CUSTOM_LLM_API_KEY',
    'CUSTOM_LLM_API_BASE_URL',
    'DEFAULT_LLM_MODEL',
    'FALLBACK_LLM_MODEL',
    'LLM_PROVIDER_INSTANCES',
    'CUSTOM_LLM_PROVIDERS',
    CUSTOM_ENV_SENSITIVE_KEYS_VAR,
  ].includes(key)
}

function parseEnvValue(raw: string): string {
  const value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value) as string
      } catch {
        return value.slice(1, -1)
      }
    }
    return value.slice(1, -1)
  }
  return value
}

async function readEnvLocalMap(): Promise<Record<string, string>> {
  await ensureEnvLocalFile()
  const content = await fs.readFile(envLocalPath, 'utf8')
  const map: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const matched = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!matched) continue
    const key = matched[1] || ''
    const rawValue = matched[2] || ''
    if (!key) continue
    map[key] = parseEnvValue(rawValue)
  }
  return map
}

function parseSensitiveEnvKeys(map: Record<string, string>): Set<string> {
  const raw = map[CUSTOM_ENV_SENSITIVE_KEYS_VAR] || ''
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
  )
}

function defaultSensitiveEnvKey(name: string): boolean {
  return /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)/i.test(name)
}

async function ensureEnvLocalFile(): Promise<void> {
  try {
    await fs.access(envLocalPath)
  } catch {
    await fs.writeFile(envLocalPath, '', 'utf8')
  }
}

async function applyEnvUpdates(updates: Record<string, string | null>): Promise<void> {
  await ensureEnvLocalFile()
  const content = await fs.readFile(envLocalPath, 'utf8')
  const lines = content.split(/\r?\n/)

  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line))

    if (value === null) {
      if (idx >= 0) lines.splice(idx, 1)
      continue
    }

    const nextLine = `${key}=${quoteEnvValue(value)}`
    if (idx >= 0) {
      lines[idx] = nextLine
    } else {
      lines.push(nextLine)
    }
  }

  const normalized = lines.join('\n').replace(/\n*$/, '\n')
  await fs.writeFile(envLocalPath, normalized, 'utf8')
}

function applyProcessEnvUpdates(updates: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function parseProviderInstancesFromEnv(): CustomProviderConfig[] {
  const items: CustomProviderConfig[] = []
  const raw = process.env.LLM_PROVIDER_INSTANCES
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue
          const row = item as Record<string, unknown>
          const typeValue = String(row.type || '').trim()
          if (!['openai', 'anthropic', 'google', 'kimi', 'qwen', 'minimax', 'xai', 'custom'].includes(typeValue)) continue
          const id = String(row.id || '').trim()
          if (!id) continue
          items.push({
            type: typeValue as 'openai' | 'anthropic' | 'google' | 'kimi' | 'qwen' | 'minimax' | 'xai' | 'custom',
            id,
            displayName: String(row.displayName || '').trim() || undefined,
            apiKey: String(row.apiKey || '').trim() || undefined,
            baseUrl: String(row.baseUrl || '').trim() || undefined,
          })
        }
      }
    } catch {
      llmProviderRouteLogger.warn('解析 LLM_PROVIDER_INSTANCES 失败，已忽略')
    }
  }

  const legacyRaw = process.env.CUSTOM_LLM_PROVIDERS
  if (!legacyRaw) return items
  try {
    const parsed = JSON.parse(legacyRaw) as unknown
    if (!Array.isArray(parsed)) return items
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const id = String(row.id || '').trim()
      if (!id) continue
      if (items.some((entry) => entry.type === 'custom' && entry.id === id)) continue
      items.push({
        type: 'custom',
        id,
        displayName: String(row.displayName || '').trim() || undefined,
        apiKey: String(row.apiKey || '').trim() || undefined,
        baseUrl: String(row.baseUrl || '').trim() || undefined,
      })
    }
    return items
  } catch {
    llmProviderRouteLogger.warn('解析 CUSTOM_LLM_PROVIDERS 失败，已忽略')
    return items
  }
}

function getProviderDisplayName(providerName: string, displayName?: string): string {
  if (displayName) return displayName
  if (PROVIDER_DISPLAY_NAMES[providerName]) return PROVIDER_DISPLAY_NAMES[providerName]
  const prefixMatched = providerName.match(/^(openai|anthropic|google|kimi|qwen|minimax|xai|custom):(.+)$/)
  if (prefixMatched) {
    const base = PROVIDER_DISPLAY_NAMES[prefixMatched[1]] || prefixMatched[1]
    return `${base} (${prefixMatched[2]})`
  }
  return providerName
}

function buildProviderConfig() {
  const providerInstances = parseProviderInstancesFromEnv()
  const providers: Record<string, {
    apiKeyConfigured: boolean
    apiKeyPreview: string | null
    baseUrl: string
    displayName?: string
  }> = {
    openai: {
      apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
      apiKeyPreview: keyPreview(process.env.OPENAI_API_KEY),
      baseUrl: process.env.OPENAI_API_BASE_URL || DEFAULT_BASE_URLS.OPENAI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.openai,
    },
    anthropic: {
      apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      apiKeyPreview: keyPreview(process.env.ANTHROPIC_API_KEY),
      baseUrl: process.env.ANTHROPIC_API_BASE_URL || DEFAULT_BASE_URLS.ANTHROPIC_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.anthropic,
    },
    google: {
      apiKeyConfigured: Boolean(process.env.GOOGLE_AI_API_KEY),
      apiKeyPreview: keyPreview(process.env.GOOGLE_AI_API_KEY),
      baseUrl: process.env.GOOGLE_AI_API_BASE_URL || DEFAULT_BASE_URLS.GOOGLE_AI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.google,
    },
    kimi: {
      apiKeyConfigured: Boolean(process.env.KIMI_API_KEY),
      apiKeyPreview: keyPreview(process.env.KIMI_API_KEY),
      baseUrl: process.env.KIMI_API_BASE_URL || DEFAULT_BASE_URLS.KIMI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.kimi,
    },
    qwen: {
      apiKeyConfigured: Boolean(process.env.QWEN_API_KEY),
      apiKeyPreview: keyPreview(process.env.QWEN_API_KEY),
      baseUrl: process.env.QWEN_API_BASE_URL || DEFAULT_BASE_URLS.QWEN_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.qwen,
    },
    minimax: {
      apiKeyConfigured: Boolean(process.env.MINIMAX_API_KEY),
      apiKeyPreview: keyPreview(process.env.MINIMAX_API_KEY),
      baseUrl: process.env.MINIMAX_API_BASE_URL || DEFAULT_BASE_URLS.MINIMAX_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.minimax,
    },
    xai: {
      apiKeyConfigured: Boolean(process.env.XAI_API_KEY),
      apiKeyPreview: keyPreview(process.env.XAI_API_KEY),
      baseUrl: process.env.XAI_API_BASE_URL || DEFAULT_BASE_URLS.XAI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.xai,
    },
    custom: {
      apiKeyConfigured: Boolean(process.env.CUSTOM_LLM_API_KEY),
      apiKeyPreview: keyPreview(process.env.CUSTOM_LLM_API_KEY),
      baseUrl: process.env.CUSTOM_LLM_API_BASE_URL || DEFAULT_BASE_URLS.CUSTOM_LLM_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.custom,
    },
  }

  for (const item of providerInstances) {
    const key = `${item.type}:${item.id}`
    providers[key] = {
      apiKeyConfigured: Boolean(item.apiKey),
      apiKeyPreview: keyPreview(item.apiKey),
      baseUrl: item.baseUrl || '',
      displayName: item.displayName || item.id,
    }
  }

  return {
    defaultModel: process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o',
    fallbackModel: process.env.FALLBACK_LLM_MODEL ?? 'gpt-3.5-turbo',
    providers,
  }
}

function buildRuntimeLlmConfigPayload() {
  const providers: Record<string, { base_url: string }> = {
    openai: {
      base_url: process.env.OPENAI_API_BASE_URL || DEFAULT_BASE_URLS.OPENAI_API_BASE_URL,
    },
    anthropic: {
      base_url: process.env.ANTHROPIC_API_BASE_URL || DEFAULT_BASE_URLS.ANTHROPIC_API_BASE_URL,
    },
    google: {
      base_url: process.env.GOOGLE_AI_API_BASE_URL || DEFAULT_BASE_URLS.GOOGLE_AI_API_BASE_URL,
    },
    kimi: {
      base_url: process.env.KIMI_API_BASE_URL || DEFAULT_BASE_URLS.KIMI_API_BASE_URL,
    },
    qwen: {
      base_url: process.env.QWEN_API_BASE_URL || DEFAULT_BASE_URLS.QWEN_API_BASE_URL,
    },
    minimax: {
      base_url: process.env.MINIMAX_API_BASE_URL || DEFAULT_BASE_URLS.MINIMAX_API_BASE_URL,
    },
    xai: {
      base_url: process.env.XAI_API_BASE_URL || DEFAULT_BASE_URLS.XAI_API_BASE_URL,
    },
    custom: {
      base_url: process.env.CUSTOM_LLM_API_BASE_URL || DEFAULT_BASE_URLS.CUSTOM_LLM_API_BASE_URL,
    },
  }

  for (const item of parseProviderInstancesFromEnv()) {
    providers[`${item.type}:${item.id}`] = {
      base_url: item.baseUrl || '',
    }
  }

  return {
    default_model: process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o',
    fallback_model: process.env.FALLBACK_LLM_MODEL ?? 'gpt-3.5-turbo',
    providers,
  }
}

function buildRuntimeApiKeysPayload(): Record<string, string> {
  const payload: Record<string, string> = {
    openai: process.env.OPENAI_API_KEY ?? '',
    anthropic: process.env.ANTHROPIC_API_KEY ?? '',
    google: process.env.GOOGLE_AI_API_KEY ?? '',
    kimi: process.env.KIMI_API_KEY ?? '',
    qwen: process.env.QWEN_API_KEY ?? '',
    minimax: process.env.MINIMAX_API_KEY ?? '',
    xai: process.env.XAI_API_KEY ?? '',
    custom: process.env.CUSTOM_LLM_API_KEY ?? '',
  }
  for (const item of parseProviderInstancesFromEnv()) {
    payload[`${item.type}:${item.id}`] = item.apiKey || ''
  }
  return payload
}

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * GET /llm-providers - 获取可用的 LLM Providers 列表
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const providers = await getProviderStatus()

    const data = providers
      .filter((p) => p.available)
      .map((p) => ({
        name: p.name,
        displayName: getProviderDisplayName(p.name, p.displayName),
        available: p.available,
        models: p.models,
      }))

    res.json({
      success: true,
      data,
    })
  })
)

/**
 * GET /llm-providers/models - 获取可用的 LLM 模型列表
 */
router.get(
  '/models',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const providers = await getProviderStatus()

    const models: Array<{
      modelId: string
      displayName: string
      displayNameSource: 'provider' | 'fallback'
      providerName: string
      providerType: string
    }> = []

    for (const provider of providers) {
      if (!provider.available) continue

      for (const modelInfo of provider.modelInfos) {
        const modelId = modelInfo.id
        const displayName = modelInfo.displayName ?? modelId
        models.push({
          modelId,
          displayName,
          displayNameSource: modelInfo.displayName ? 'provider' : 'fallback',
          providerName: getProviderDisplayName(provider.name, provider.displayName),
          providerType: provider.name,
        })
      }
    }

    res.json({
      success: true,
      data: models,
    })
  })
)

/**
 * GET /llm-providers/status - 获取所有 Provider 状态（包括未配置的）
 */
router.get(
  '/status',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const providers = await getProviderStatus()

    const data = providers.map((p) => ({
      name: p.name,
      displayName: getProviderDisplayName(p.name, p.displayName),
      available: p.available,
      models: p.models,
    }))

    res.json({
      success: true,
      data,
    })
  })
)

/**
 * GET /llm-providers/config - 获取可编辑的 LLM 配置（敏感字段仅返回 configured 状态）
 */
router.get(
  '/config',
  authenticate,
  combinedRateLimit,
  requireRole('owner', 'admin'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    res.json({
      success: true,
      data: buildProviderConfig(),
    })
  })
)

/**
 * GET /llm-providers/env-vars - 获取自定义环境变量（敏感值脱敏）
 */
router.get(
  '/env-vars',
  authenticate,
  combinedRateLimit,
  requireRole('owner', 'admin'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const envMap = await readEnvLocalMap()
    const sensitiveKeys = parseSensitiveEnvKeys(envMap)
    const items = Object.entries(envMap)
      .filter(([key]) => !isManagedLlmEnvKey(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => {
        const explicitSensitive = sensitiveKeys.has(name.toUpperCase())
        const isSensitive = explicitSensitive || defaultSensitiveEnvKey(name)
        return {
          name,
          value: isSensitive ? REDACTED_VALUE : value,
          hasValue: String(value || '').length > 0,
          isSensitive,
        }
      })

    res.json({
      success: true,
      data: items,
    })
  })
)

/**
 * POST /llm-providers/env-vars - 新增/覆盖自定义环境变量
 */
router.post(
  '/env-vars',
  authenticate,
  combinedRateLimit,
  requireRole('owner', 'admin'),
  validate(upsertEnvVarSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof upsertEnvVarSchema>
    const name = body.name.trim().toUpperCase()
    const clear = body.clear === true
    const nextValue = clear ? null : (body.value ?? '')

    const envMap = await readEnvLocalMap()
    const sensitiveKeys = parseSensitiveEnvKeys(envMap)
    const isSensitive = body.isSensitive ?? (sensitiveKeys.has(name) || defaultSensitiveEnvKey(name))

    if (clear) sensitiveKeys.delete(name)
    else if (isSensitive) sensitiveKeys.add(name)
    else sensitiveKeys.delete(name)

    const updates: Record<string, string | null> = {
      [name]: nextValue,
      [CUSTOM_ENV_SENSITIVE_KEYS_VAR]:
        sensitiveKeys.size > 0 ? Array.from(sensitiveKeys).sort().join(',') : null,
    }
    await applyEnvUpdates(updates)
    applyProcessEnvUpdates(updates)

    res.status(201).json({
      success: true,
      data: {
        name,
        value: isSensitive ? REDACTED_VALUE : nextValue || '',
        hasValue: Boolean(nextValue),
        isSensitive,
      },
    })
  })
)

/**
 * PUT /llm-providers/env-vars/:name - 更新环境变量
 */
router.put(
  '/env-vars/:name',
  authenticate,
  combinedRateLimit,
  requireRole('owner', 'admin'),
  validate(updateEnvVarSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const paramName = String(req.params.name || '')
      .trim()
      .toUpperCase()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(paramName)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_ENV_NAME', message: 'invalid env var name' },
      })
      return
    }

    const body = req.body as z.infer<typeof updateEnvVarSchema>
    const clear = body.clear === true
    const nextValue = clear ? null : body.value

    const envMap = await readEnvLocalMap()
    const exists = Object.prototype.hasOwnProperty.call(envMap, paramName)
    if (!exists && nextValue === undefined && !clear) {
      res.status(404).json({
        success: false,
        error: { code: 'ENV_VAR_NOT_FOUND', message: 'env var not found' },
      })
      return
    }

    const sensitiveKeys = parseSensitiveEnvKeys(envMap)
    const nextSensitive =
      body.isSensitive ??
      (sensitiveKeys.has(paramName) || defaultSensitiveEnvKey(paramName))

    if (clear) sensitiveKeys.delete(paramName)
    else if (nextSensitive) sensitiveKeys.add(paramName)
    else sensitiveKeys.delete(paramName)

    const updates: Record<string, string | null> = {
      [CUSTOM_ENV_SENSITIVE_KEYS_VAR]:
        sensitiveKeys.size > 0 ? Array.from(sensitiveKeys).sort().join(',') : null,
    }
    if (clear) {
      updates[paramName] = null
    } else if (nextValue !== undefined) {
      updates[paramName] = String(nextValue)
    }

    await applyEnvUpdates(updates)
    applyProcessEnvUpdates(updates)
    const finalValue = updates[paramName] ?? envMap[paramName] ?? ''
    const isSensitive = sensitiveKeys.has(paramName) || defaultSensitiveEnvKey(paramName)
    res.json({
      success: true,
      data: {
        name: paramName,
        value: isSensitive ? REDACTED_VALUE : finalValue,
        hasValue: String(finalValue || '').length > 0,
        isSensitive,
      },
    })
  })
)

/**
 * DELETE /llm-providers/env-vars/:name - 删除环境变量
 */
router.delete(
  '/env-vars/:name',
  authenticate,
  combinedRateLimit,
  requireRole('owner', 'admin'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const paramName = String(req.params.name || '')
      .trim()
      .toUpperCase()
    if (!/^[A-Z_][A-Z0-9_]*$/.test(paramName)) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_ENV_NAME', message: 'invalid env var name' },
      })
      return
    }
    const envMap = await readEnvLocalMap()
    if (!Object.prototype.hasOwnProperty.call(envMap, paramName)) {
      res.status(404).json({
        success: false,
        error: { code: 'ENV_VAR_NOT_FOUND', message: 'env var not found' },
      })
      return
    }
    const sensitiveKeys = parseSensitiveEnvKeys(envMap)
    sensitiveKeys.delete(paramName)
    const updates: Record<string, string | null> = {
      [paramName]: null,
      [CUSTOM_ENV_SENSITIVE_KEYS_VAR]:
        sensitiveKeys.size > 0 ? Array.from(sensitiveKeys).sort().join(',') : null,
    }
    await applyEnvUpdates(updates)
    applyProcessEnvUpdates(updates)
    res.json({ success: true, data: { deleted: true, name: paramName } })
  })
)

/**
 * PUT /llm-providers/config - 更新 LLM 配置并重载 Provider
 */
router.put(
  '/config',
  authenticate,
  combinedRateLimit,
  requireRole('owner', 'admin'),
  validate(updateLlmConfigSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof updateLlmConfigSchema>
    const updates: Record<string, string | null> = {}

    if (body.defaultModel !== undefined) {
      const trimmed = body.defaultModel.trim()
      updates.DEFAULT_LLM_MODEL = trimmed || null
    }

    if (body.fallbackModel !== undefined) {
      const trimmed = body.fallbackModel.trim()
      updates.FALLBACK_LLM_MODEL = trimmed || null
    }

    const mapProvider = (
      config: z.infer<typeof providerConfigSchema> | undefined,
      envApiKey: string,
      envBaseUrl: string
    ) => {
      if (!config) return

      if (config.clearApiKey) {
        updates[envApiKey] = null
      } else if (config.apiKey !== undefined) {
        const apiKey = config.apiKey.trim()
        updates[envApiKey] = apiKey || null
      }

      if (config.baseUrl !== undefined) {
        const baseUrl = config.baseUrl.trim()
        updates[envBaseUrl] = baseUrl || null
      }
    }

    mapProvider(body.providers?.openai, 'OPENAI_API_KEY', 'OPENAI_API_BASE_URL')
    mapProvider(body.providers?.anthropic, 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_BASE_URL')
    mapProvider(body.providers?.google, 'GOOGLE_AI_API_KEY', 'GOOGLE_AI_API_BASE_URL')
    mapProvider(body.providers?.kimi, 'KIMI_API_KEY', 'KIMI_API_BASE_URL')
    mapProvider(body.providers?.qwen, 'QWEN_API_KEY', 'QWEN_API_BASE_URL')
    mapProvider(body.providers?.minimax, 'MINIMAX_API_KEY', 'MINIMAX_API_BASE_URL')
    mapProvider(body.providers?.xai, 'XAI_API_KEY', 'XAI_API_BASE_URL')
    mapProvider(body.providers?.custom, 'CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_API_BASE_URL')

    const nextInstances = parseProviderInstancesFromEnv()
    const instancesByKey = new Map(nextInstances.map((item) => [`${item.type}:${item.id}`, item] as const))
    let hasDynamicProviderUpdates = false
    for (const [providerKey, providerConfig] of Object.entries(body.providers || {})) {
      const matched = providerKey.match(/^(openai|anthropic|google|kimi|qwen|minimax|xai|custom):(.+)$/)
      if (!matched) continue
      hasDynamicProviderUpdates = true
      const type = matched[1] as 'openai' | 'anthropic' | 'google' | 'kimi' | 'qwen' | 'minimax' | 'xai' | 'custom'
      const id = matched[2].trim()
      if (!id) continue
      const dynamicKey = `${type}:${id}` as const
      const current = instancesByKey.get(dynamicKey) || { type, id }

      if (providerConfig.clearApiKey) {
        delete current.apiKey
      } else if (providerConfig.apiKey !== undefined) {
        const apiKey = providerConfig.apiKey.trim()
        if (apiKey) current.apiKey = apiKey
        else delete current.apiKey
      }

      if (providerConfig.baseUrl !== undefined) {
        const baseUrl = providerConfig.baseUrl.trim()
        if (baseUrl) current.baseUrl = baseUrl
        else delete current.baseUrl
      }

      if (!current.displayName) current.displayName = id
      instancesByKey.set(dynamicKey, current)
    }

    if (hasDynamicProviderUpdates) {
      const providersForEnv = Array.from(instancesByKey.values())
        .map((item) => ({
          type: item.type,
          id: item.id,
          ...(item.displayName ? { displayName: item.displayName } : {}),
          ...(item.apiKey ? { apiKey: item.apiKey } : {}),
          ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
        }))
        .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))

      updates.LLM_PROVIDER_INSTANCES = providersForEnv.length > 0
        ? JSON.stringify(providersForEnv)
        : null
      // 保留兼容写入：仅写 custom 子集
      const legacyCustom = providersForEnv.filter((item) => item.type === 'custom').map(({ id, displayName, apiKey, baseUrl }) => ({
        id,
        ...(displayName ? { displayName } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      }))
      updates.CUSTOM_LLM_PROVIDERS = legacyCustom.length > 0 ? JSON.stringify(legacyCustom) : null
    }

    if (Object.keys(updates).length > 0) {
      await applyEnvUpdates(updates)
      applyProcessEnvUpdates(updates)
      reloadProviders()

      try {
        const wsServer = getWSServer()
        wsServer.broadcastLLMConfigUpdate({
          llm_config: buildRuntimeLlmConfigPayload(),
          api_keys: buildRuntimeApiKeysPayload(),
        })
      } catch (error) {
        llmProviderRouteLogger.warn('执行平面 LLM 配置广播跳过', {
          reason: (error as Error).message,
        })
      }
    }

    res.json({
      success: true,
      data: buildProviderConfig(),
      meta: {
        updatedKeys: Object.keys(updates),
      },
    })
  })
)

export default router
