/**
 * LLM Providers API 路由
 *
 * - Provider 状态查询
 * - 本地 runtime sqlite 的 LLM 配置读写（单机场景）
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
import {
  getRuntimeLlmConfig,
  updateRuntimeLlmConfig,
  applyRuntimeLlmConfigToProcessEnv,
  syncRuntimeLlmConfigToProcessEnv,
  type RuntimeLlmConfig,
} from '../../lib/runtime-config-client'

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
  defaultProviderKey: z.string().optional(),
  fallbackModel: z.string().optional(),
  fallbackProviderKey: z.string().optional(),
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
    'DEFAULT_LLM_PROVIDER_KEY',
    'FALLBACK_LLM_MODEL',
    'FALLBACK_LLM_PROVIDER_KEY',
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

function buildProviderConfig(config: RuntimeLlmConfig) {
  const providerInstances = Object.entries(config.providers || {})
    .filter(([providerKey]) => providerKey.includes(':'))
    .map(([providerKey, item]) => ({
      type: providerKey.split(':', 2)[0] as CustomProviderConfig['type'],
      id: providerKey.split(':', 2)[1] || '',
      displayName: item.display_name,
      apiKey: item.api_key,
      baseUrl: item.base_url,
    }))
  const providers: Record<string, {
    apiKeyConfigured: boolean
    apiKeyPreview: string | null
    baseUrl: string
    displayName?: string
  }> = {
    openai: {
      apiKeyConfigured: Boolean(config.providers?.openai?.api_key),
      apiKeyPreview: keyPreview(config.providers?.openai?.api_key),
      baseUrl: config.providers?.openai?.base_url || DEFAULT_BASE_URLS.OPENAI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.openai,
    },
    anthropic: {
      apiKeyConfigured: Boolean(config.providers?.anthropic?.api_key),
      apiKeyPreview: keyPreview(config.providers?.anthropic?.api_key),
      baseUrl: config.providers?.anthropic?.base_url || DEFAULT_BASE_URLS.ANTHROPIC_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.anthropic,
    },
    google: {
      apiKeyConfigured: Boolean(config.providers?.google?.api_key),
      apiKeyPreview: keyPreview(config.providers?.google?.api_key),
      baseUrl: config.providers?.google?.base_url || DEFAULT_BASE_URLS.GOOGLE_AI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.google,
    },
    kimi: {
      apiKeyConfigured: Boolean(config.providers?.kimi?.api_key),
      apiKeyPreview: keyPreview(config.providers?.kimi?.api_key),
      baseUrl: config.providers?.kimi?.base_url || DEFAULT_BASE_URLS.KIMI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.kimi,
    },
    qwen: {
      apiKeyConfigured: Boolean(config.providers?.qwen?.api_key),
      apiKeyPreview: keyPreview(config.providers?.qwen?.api_key),
      baseUrl: config.providers?.qwen?.base_url || DEFAULT_BASE_URLS.QWEN_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.qwen,
    },
    minimax: {
      apiKeyConfigured: Boolean(config.providers?.minimax?.api_key),
      apiKeyPreview: keyPreview(config.providers?.minimax?.api_key),
      baseUrl: config.providers?.minimax?.base_url || DEFAULT_BASE_URLS.MINIMAX_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.minimax,
    },
    xai: {
      apiKeyConfigured: Boolean(config.providers?.xai?.api_key),
      apiKeyPreview: keyPreview(config.providers?.xai?.api_key),
      baseUrl: config.providers?.xai?.base_url || DEFAULT_BASE_URLS.XAI_API_BASE_URL,
      displayName: PROVIDER_DISPLAY_NAMES.xai,
    },
    custom: {
      apiKeyConfigured: Boolean(config.providers?.custom?.api_key),
      apiKeyPreview: keyPreview(config.providers?.custom?.api_key),
      baseUrl: config.providers?.custom?.base_url || DEFAULT_BASE_URLS.CUSTOM_LLM_API_BASE_URL,
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
    defaultModel: config.default_model || 'gpt-4o',
    defaultProviderKey: config.default_provider_key || '',
    fallbackModel: config.fallback_model || '',
    fallbackProviderKey: config.fallback_provider_key || '',
    providers,
  }
}

function buildRuntimeLlmConfigPayload(config: RuntimeLlmConfig) {
  const providers: Record<string, { base_url: string }> = {
    openai: {
      base_url: config.providers?.openai?.base_url || DEFAULT_BASE_URLS.OPENAI_API_BASE_URL,
    },
    anthropic: {
      base_url: config.providers?.anthropic?.base_url || DEFAULT_BASE_URLS.ANTHROPIC_API_BASE_URL,
    },
    google: {
      base_url: config.providers?.google?.base_url || DEFAULT_BASE_URLS.GOOGLE_AI_API_BASE_URL,
    },
    kimi: {
      base_url: config.providers?.kimi?.base_url || DEFAULT_BASE_URLS.KIMI_API_BASE_URL,
    },
    qwen: {
      base_url: config.providers?.qwen?.base_url || DEFAULT_BASE_URLS.QWEN_API_BASE_URL,
    },
    minimax: {
      base_url: config.providers?.minimax?.base_url || DEFAULT_BASE_URLS.MINIMAX_API_BASE_URL,
    },
    xai: {
      base_url: config.providers?.xai?.base_url || DEFAULT_BASE_URLS.XAI_API_BASE_URL,
    },
    custom: {
      base_url: config.providers?.custom?.base_url || DEFAULT_BASE_URLS.CUSTOM_LLM_API_BASE_URL,
    },
  }

  for (const item of Object.entries(config.providers || {})
    .filter(([providerKey]) => providerKey.includes(':'))
    .map(([providerKey, provider]) => ({
      key: providerKey,
      baseUrl: provider.base_url || '',
    }))) {
    providers[item.key] = {
      base_url: item.baseUrl,
    }
  }

  return {
    default_model: config.default_model || 'gpt-4o',
    default_provider_key: config.default_provider_key || '',
    fallback_model: config.fallback_model || '',
    fallback_provider_key: config.fallback_provider_key || '',
    providers,
  }
}

function buildRuntimeApiKeysPayload(config: RuntimeLlmConfig): Record<string, string> {
  const payload: Record<string, string> = {
    openai: config.providers?.openai?.api_key ?? '',
    anthropic: config.providers?.anthropic?.api_key ?? '',
    google: config.providers?.google?.api_key ?? '',
    kimi: config.providers?.kimi?.api_key ?? '',
    qwen: config.providers?.qwen?.api_key ?? '',
    minimax: config.providers?.minimax?.api_key ?? '',
    xai: config.providers?.xai?.api_key ?? '',
    custom: config.providers?.custom?.api_key ?? '',
  }
  for (const [providerKey, provider] of Object.entries(config.providers || {})) {
    if (!providerKey.includes(':')) continue
    payload[providerKey] = provider.api_key || ''
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
    await syncRuntimeLlmConfigToProcessEnv().catch(() => undefined)
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
    await syncRuntimeLlmConfigToProcessEnv().catch(() => undefined)
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
    await syncRuntimeLlmConfigToProcessEnv().catch(() => undefined)
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
    const config = await getRuntimeLlmConfig()
    res.json({
      success: true,
      data: buildProviderConfig(config),
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
    const current = await getRuntimeLlmConfig()
    const nextProviders: RuntimeLlmConfig['providers'] = { ...(current.providers || {}) }
    const builtInProviderKeys = ['openai', 'anthropic', 'google', 'kimi', 'qwen', 'minimax', 'xai', 'custom']
    for (const providerKey of builtInProviderKeys) {
      const providerConfig = body.providers?.[providerKey]
      if (!providerConfig) continue
      const existing = nextProviders[providerKey] || {}
      nextProviders[providerKey] = {
        ...existing,
        api_key: providerConfig.clearApiKey ? '' : providerConfig.apiKey !== undefined ? providerConfig.apiKey.trim() : existing.api_key,
        base_url: providerConfig.baseUrl !== undefined ? providerConfig.baseUrl.trim() : existing.base_url,
        display_name: existing.display_name,
      }
    }
    for (const [providerKey, providerConfig] of Object.entries(body.providers || {})) {
      if (!providerKey.includes(':')) continue
      const existing = nextProviders[providerKey] || {}
      nextProviders[providerKey] = {
        ...existing,
        display_name: existing.display_name || providerKey.split(':', 2)[1] || providerKey,
        api_key: providerConfig.clearApiKey ? '' : providerConfig.apiKey !== undefined ? providerConfig.apiKey.trim() : existing.api_key,
        base_url: providerConfig.baseUrl !== undefined ? providerConfig.baseUrl.trim() : existing.base_url,
      }
    }

    const persisted = await updateRuntimeLlmConfig({
      default_model: body.defaultModel !== undefined ? body.defaultModel.trim() : current.default_model,
      default_provider_key: body.defaultProviderKey !== undefined ? body.defaultProviderKey.trim() : current.default_provider_key,
      fallback_model: body.fallbackModel !== undefined ? body.fallbackModel.trim() : current.fallback_model,
      fallback_provider_key: body.fallbackProviderKey !== undefined ? body.fallbackProviderKey.trim() : current.fallback_provider_key,
      providers: nextProviders,
    })
    applyRuntimeLlmConfigToProcessEnv(persisted)
    reloadProviders()

    try {
      const wsServer = getWSServer()
      wsServer.broadcastLLMConfigUpdate({
        llm_config: buildRuntimeLlmConfigPayload(persisted),
        api_keys: buildRuntimeApiKeysPayload(persisted),
      })
    } catch (error) {
      llmProviderRouteLogger.warn('执行平面 LLM 配置广播跳过', {
        reason: (error as Error).message,
      })
    }

    res.json({
      success: true,
      data: buildProviderConfig(persisted),
      meta: {
        updatedKeys: ['defaultModel', 'defaultProviderKey', 'fallbackModel', 'fallbackProviderKey', 'providers'],
      },
    })
  })
)

export default router
