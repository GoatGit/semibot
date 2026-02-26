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
  providers: z
    .object({
      openai: providerConfigSchema.optional(),
      anthropic: providerConfigSchema.optional(),
      google: providerConfigSchema.optional(),
      custom: providerConfigSchema.optional(),
    })
    .optional(),
})

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

function buildProviderConfig() {
  return {
    defaultModel: process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o',
    fallbackModel: process.env.FALLBACK_LLM_MODEL ?? 'gpt-3.5-turbo',
    providers: {
      openai: {
        apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
        apiKeyPreview: keyPreview(process.env.OPENAI_API_KEY),
        baseUrl: process.env.OPENAI_API_BASE_URL || DEFAULT_BASE_URLS.OPENAI_API_BASE_URL,
      },
      anthropic: {
        apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
        apiKeyPreview: keyPreview(process.env.ANTHROPIC_API_KEY),
        baseUrl: process.env.ANTHROPIC_API_BASE_URL || DEFAULT_BASE_URLS.ANTHROPIC_API_BASE_URL,
      },
      google: {
        apiKeyConfigured: Boolean(process.env.GOOGLE_AI_API_KEY),
        apiKeyPreview: keyPreview(process.env.GOOGLE_AI_API_KEY),
        baseUrl: process.env.GOOGLE_AI_API_BASE_URL || DEFAULT_BASE_URLS.GOOGLE_AI_API_BASE_URL,
      },
      custom: {
        apiKeyConfigured: Boolean(process.env.CUSTOM_LLM_API_KEY),
        apiKeyPreview: keyPreview(process.env.CUSTOM_LLM_API_KEY),
        baseUrl: process.env.CUSTOM_LLM_API_BASE_URL || DEFAULT_BASE_URLS.CUSTOM_LLM_API_BASE_URL,
      },
    },
  }
}

function buildRuntimeLlmConfigPayload() {
  return {
    default_model: process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o',
    fallback_model: process.env.FALLBACK_LLM_MODEL ?? 'gpt-3.5-turbo',
    providers: {
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
    },
  }
}

function buildRuntimeApiKeysPayload(): Record<string, string> {
  return {
    openai: process.env.OPENAI_API_KEY ?? '',
    anthropic: process.env.ANTHROPIC_API_KEY ?? '',
    google: process.env.GOOGLE_AI_API_KEY ?? '',
    custom: process.env.CUSTOM_LLM_API_KEY ?? '',
  }
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
        displayName: PROVIDER_DISPLAY_NAMES[p.name] || p.name,
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
          providerName: PROVIDER_DISPLAY_NAMES[provider.name] || provider.name,
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
      displayName: PROVIDER_DISPLAY_NAMES[p.name] || p.name,
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
