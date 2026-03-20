import {
  type LLMMessage,
  type LLMConfig,
  type LLMResponse,
  type LLMStreamChunk,
  type LLMModelInfo,
  type LLMProvider,
  registerProvider,
  clearProviders,
  getProvider,
  getAvailableProviders,
  getAllProviders,
} from './llm/index'
import { OpenAIProvider } from './llm/openai.provider'
import { AnthropicProvider } from './llm/anthropic.provider'
import { CustomProvider } from './llm/custom.provider'
import { GoogleAIProvider } from './llm/google.provider'
import { createLogger } from '../lib/logger'
import { getRuntimeLlmConfig, type RuntimeLlmConfig } from '../lib/runtime-config-client'

const llmLogger = createLogger('llm')

// ═══════════════════════════════════════════════════════════════
// 初始化 Providers
// ═══════════════════════════════════════════════════════════════

let isInitialized = false

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  kimi: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  minimax: 'https://api.minimax.chat/v1',
  xai: 'https://api.x.ai/v1',
  custom: '',
}

function initializeProviders(): void {
  if (isInitialized) return
  registerProvider(new OpenAIProvider({ name: 'openai', displayName: 'OpenAI' }))
  registerProvider(new AnthropicProvider({ name: 'anthropic', displayName: 'Anthropic' }))
  registerProvider(new GoogleAIProvider({ name: 'google', displayName: 'Google AI' }))
  registerProvider(new CustomProvider({ name: 'kimi', displayName: 'Kimi', baseUrl: DEFAULT_BASE_URLS.kimi }))
  registerProvider(new CustomProvider({ name: 'qwen', displayName: 'Qwen', baseUrl: DEFAULT_BASE_URLS.qwen }))
  registerProvider(new CustomProvider({ name: 'minimax', displayName: 'MiniMax', baseUrl: DEFAULT_BASE_URLS.minimax }))
  registerProvider(new CustomProvider({ name: 'xai', displayName: 'xAI', baseUrl: DEFAULT_BASE_URLS.xai }))
  registerProvider(new CustomProvider({ name: 'custom', displayName: '自定义模型' }))
  isInitialized = true
  llmLogger.info('Providers 初始化完成')
}

function reloadProvidersFromConfig(config: RuntimeLlmConfig): void {
  clearProviders()
  isInitialized = false

  const providers = config.providers || {}

  const getCfg = (key: string) => {
    const cfg = providers[key] || {}
    return {
      apiKey: cfg.api_key || undefined,
      baseUrl: cfg.base_url || DEFAULT_BASE_URLS[key] || undefined,
    }
  }

  registerProvider(new OpenAIProvider({ name: 'openai', displayName: 'OpenAI', ...getCfg('openai') }))
  registerProvider(new AnthropicProvider({ name: 'anthropic', displayName: 'Anthropic', ...getCfg('anthropic') }))
  registerProvider(new GoogleAIProvider({ name: 'google', displayName: 'Google AI', ...getCfg('google') }))
  registerProvider(new CustomProvider({ name: 'kimi', displayName: 'Kimi', ...getCfg('kimi') }))
  registerProvider(new CustomProvider({ name: 'qwen', displayName: 'Qwen', ...getCfg('qwen') }))
  registerProvider(new CustomProvider({ name: 'minimax', displayName: 'MiniMax', ...getCfg('minimax') }))
  registerProvider(new CustomProvider({ name: 'xai', displayName: 'xAI', ...getCfg('xai') }))
  registerProvider(new CustomProvider({ name: 'custom', displayName: '自定义模型', ...getCfg('custom') }))

  for (const [providerKey, rawCfg] of Object.entries(providers)) {
    if (!providerKey.includes(':')) continue
    const [type, id] = providerKey.split(':', 2)
    const providerName = `${type}:${id}`
    const cfg = rawCfg || {}
    const apiKey = cfg.api_key || undefined
    const baseUrl = cfg.base_url || undefined
    const displayName = cfg.display_name || id
    if (type === 'openai') {
      registerProvider(new OpenAIProvider({ name: providerName, displayName, apiKey, baseUrl }))
    } else if (type === 'anthropic') {
      registerProvider(new AnthropicProvider({ name: providerName, displayName, apiKey, baseUrl }))
    } else if (type === 'google') {
      registerProvider(new GoogleAIProvider({ name: providerName, displayName, apiKey, baseUrl }))
    } else {
      registerProvider(new CustomProvider({ name: providerName, displayName, apiKey, baseUrl: baseUrl || DEFAULT_BASE_URLS[type] }))
    }
  }

  isInitialized = true
  llmLogger.info('Providers 已从 DB 配置重载')
}

// 立即初始化（无 API key，等待 DB 配置）
initializeProviders()

/**
 * 运行时重载 Provider（用于 LLM 配置更新后生效）
 */
export function reloadProviders(): void {
  clearProviders()
  isInitialized = false
  initializeProviders()
  llmLogger.info('Providers 已重载')
}

async function refreshProvidersFromDb(): Promise<RuntimeLlmConfig> {
  const config = await getRuntimeLlmConfig().catch(() => null)
  const resolved = config || {
    default_model: '',
    default_provider_key: '',
    fallback_model: '',
    fallback_provider_key: '',
    providers: {},
  }
  reloadProvidersFromConfig(resolved)
  return resolved
}

// ═══════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: Partial<LLMConfig> = {
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
}

async function resolveProviderForModel(model: string): Promise<LLMProvider | undefined> {
  for (const provider of getAvailableProviders()) {
    const models = await provider.fetchModels()

    const matched = models.some((configuredModel) => {
      return model === configuredModel || model.startsWith(configuredModel) || configuredModel.startsWith(model)
    })

    if (matched) {
      return provider
    }
  }

  return undefined
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 生成 LLM 响应 (非流式)
 */
export async function generate(
  messages: LLMMessage[],
  config: Partial<LLMConfig> = {}
): Promise<LLMResponse> {
  const llmConfig = await refreshProvidersFromDb()
  const defaultModel = llmConfig.default_model || ''
  const fallbackModel = llmConfig.fallback_model || ''
  const fullConfig: LLMConfig = {
    model: config.model ?? defaultModel,
    ...DEFAULT_CONFIG,
    ...config,
  }

  const provider = await resolveProviderForModel(fullConfig.model)

  if (!provider || !provider.isAvailable()) {
    if (fallbackModel) {
      const fallbackProvider = await resolveProviderForModel(fallbackModel)
      if (fallbackProvider?.isAvailable()) {
        llmLogger.warn('Provider 不可用，使用 Fallback', {
          original: fullConfig.model,
          fallback: fallbackModel,
        })
        fullConfig.model = fallbackModel
        return fallbackProvider.generate(messages, fullConfig)
      }
    }

    throw new Error(`没有可用的 LLM Provider (尝试模型: ${fullConfig.model})`)
  }

  return provider.generate(messages, fullConfig)
}

/**
 * 生成流式 LLM 响应
 */
export async function generateStream(
  messages: LLMMessage[],
  config: Partial<LLMConfig> = {},
  onChunk: (chunk: LLMStreamChunk) => void
): Promise<void> {
  const llmConfig = await refreshProvidersFromDb()
  const defaultModel = llmConfig.default_model || ''
  const fallbackModel = llmConfig.fallback_model || ''
  const fullConfig: LLMConfig = {
    model: config.model ?? defaultModel,
    ...DEFAULT_CONFIG,
    ...config,
  }

  const provider = await resolveProviderForModel(fullConfig.model)

  if (!provider || !provider.isAvailable()) {
    if (fallbackModel) {
      const fallbackProvider = await resolveProviderForModel(fallbackModel)
      if (fallbackProvider?.isAvailable()) {
        llmLogger.warn('Provider 不可用，使用 Fallback', {
          original: fullConfig.model,
          fallback: fallbackModel,
        })
        fullConfig.model = fallbackModel
        return fallbackProvider.generateStream(messages, fullConfig, onChunk)
      }
    }

    onChunk({
      type: 'error',
      error: {
        code: 'NO_PROVIDER',
        message: `没有可用的 LLM Provider (尝试模型: ${fullConfig.model})`,
      },
    })
    return
  }

  return provider.generateStream(messages, fullConfig, onChunk)
}

/**
 * 检查 LLM 服务是否可用
 */
export function isLLMAvailable(): boolean {
  return getAvailableProviders().length > 0
}

/**
 * 获取可用的模型列表
 */
export async function getAvailableModels(): Promise<string[]> {
  await refreshProvidersFromDb()
  const models: string[] = []
  for (const provider of getAvailableProviders()) {
    models.push(...(await provider.fetchModels()))
  }
  return models
}

/**
 * 获取 Provider 状态
 */
export async function getProviderStatus(): Promise<Array<{
  name: string
  displayName?: string
  available: boolean
  models: string[]
  modelInfos: LLMModelInfo[]
}>> {
  await refreshProvidersFromDb()

  const loadProviderModels = async (
    provider?: LLMProvider
  ): Promise<{ models: string[]; modelInfos: LLMModelInfo[] }> => {
    if (!provider || !provider.isAvailable()) {
      return { models: [], modelInfos: [] }
    }

    if (provider.fetchModelInfos) {
      const modelInfos = await provider.fetchModelInfos()
      return {
        models: modelInfos.map((model) => model.id),
        modelInfos,
      }
    }

    const models = await provider.fetchModels()
    return {
      models,
      modelInfos: models.map((modelId) => ({ id: modelId })),
    }
  }

  const defaultOrder = ['openai', 'anthropic', 'google', 'kimi', 'qwen', 'minimax', 'xai', 'custom']
  const providers = getAllProviders()
  const providerNames = Array.from(
    new Set([
      ...defaultOrder,
      ...providers.map((provider) => provider.name),
    ])
  )

  const statuses = await Promise.all(providerNames.map(async (name) => {
    const provider = getProvider(name)
    const loaded = await loadProviderModels(provider)
    const withDisplayName = provider as LLMProvider & { displayName?: string }
    return {
      name,
      displayName: withDisplayName?.displayName,
      available: provider?.isAvailable() ?? false,
      models: loaded.models,
      modelInfos: loaded.modelInfos,
    }
  }))

  return statuses
}

// 导出类型
export type { LLMMessage, LLMConfig, LLMResponse, LLMStreamChunk }
