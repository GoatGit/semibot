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
  custom: '自定义模型',
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..', '..', '..', '..', '..')
const envLocalPath = resolve(projectRoot, '.env.local')

const DEFAULT_BASE_URLS = {
  OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
  ANTHROPIC_API_BASE_URL: 'https://api.anthropic.com/v1',
  GOOGLE_AI_API_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
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

type CustomProviderConfig = {
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

function parseCustomProvidersFromEnv(): CustomProviderConfig[] {
  const raw = process.env.CUSTOM_LLM_PROVIDERS
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const items: CustomProviderConfig[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const id = String(row.id || '').trim()
      if (!id) continue
      items.push({
        id,
        displayName: String(row.displayName || '').trim() || undefined,
        apiKey: String(row.apiKey || '').trim() || undefined,
        baseUrl: String(row.baseUrl || '').trim() || undefined,
      })
    }
    return items
  } catch {
    llmProviderRouteLogger.warn('解析 CUSTOM_LLM_PROVIDERS 失败，已忽略')
    return []
  }
}

function getProviderDisplayName(providerName: string, displayName?: string): string {
  if (displayName) return displayName
  if (PROVIDER_DISPLAY_NAMES[providerName]) return PROVIDER_DISPLAY_NAMES[providerName]
  if (providerName.startsWith('custom:')) {
    return providerName.replace(/^custom:/, '')
  }
  return providerName
}

function buildProviderConfig() {
  const customProviders = parseCustomProvidersFromEnv()
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
    custom: {
      apiKeyConfigured: Boolean(process.env.CUSTOM_LLM_API_KEY),
      apiKeyPreview: keyPreview(process.env.CUSTOM_LLM_API_KEY),
      baseUrl: process.env.CUSTOM_LLM_API_BASE_URL || DEFAULT_BASE_URLS.CUSTOM_LLM_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.custom,
    },
  }

  for (const custom of customProviders) {
    const key = `custom:${custom.id}`
    providers[key] = {
      apiKeyConfigured: Boolean(custom.apiKey),
      apiKeyPreview: keyPreview(custom.apiKey),
      baseUrl: custom.baseUrl || '',
      displayName: custom.displayName || custom.id,
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
    custom: {
      base_url: process.env.CUSTOM_LLM_API_BASE_URL || DEFAULT_BASE_URLS.CUSTOM_LLM_API_BASE_URL,
    },
  }

  for (const item of parseCustomProvidersFromEnv()) {
    providers[`custom:${item.id}`] = {
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
    custom: process.env.CUSTOM_LLM_API_KEY ?? '',
  }
  for (const item of parseCustomProvidersFromEnv()) {
    payload[`custom:${item.id}`] = item.apiKey || ''
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
    mapProvider(body.providers?.custom, 'CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_API_BASE_URL')

    const nextCustomProviders = parseCustomProvidersFromEnv()
    const customProviderById = new Map(nextCustomProviders.map((item) => [item.id, item] as const))
    let hasCustomDynamicProviderUpdates = false
    for (const [providerKey, providerConfig] of Object.entries(body.providers || {})) {
      if (!providerKey.startsWith('custom:') || providerKey === 'custom') continue
      hasCustomDynamicProviderUpdates = true
      const id = providerKey.replace(/^custom:/, '').trim()
      if (!id) continue
      const current = customProviderById.get(id) || { id }

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
      customProviderById.set(id, current)
    }

    if (hasCustomDynamicProviderUpdates) {
      const customProvidersForEnv = Array.from(customProviderById.values())
        .map((item) => ({
          id: item.id,
          ...(item.displayName ? { displayName: item.displayName } : {}),
          ...(item.apiKey ? { apiKey: item.apiKey } : {}),
          ...(item.baseUrl ? { baseUrl: item.baseUrl } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))

      updates.CUSTOM_LLM_PROVIDERS = customProvidersForEnv.length > 0
        ? JSON.stringify(customProvidersForEnv)
        : null
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
