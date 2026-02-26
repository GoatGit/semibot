/**
 * LLM 服务 - 统一的 LLM 调用接口
 *
 * 功能:
 * - Provider 管理和选择
 * - Fallback 机制
 * - 使用量记录
 * - 错误处理
 */

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
} from './llm/index'
import { OpenAIProvider } from './llm/openai.provider'
import { AnthropicProvider } from './llm/anthropic.provider'
import { CustomProvider } from './llm/custom.provider'
import { GoogleAIProvider } from './llm/google.provider'
import { createLogger } from '../lib/logger'

const llmLogger = createLogger('llm')

// ═══════════════════════════════════════════════════════════════
// 初始化 Providers
// ═══════════════════════════════════════════════════════════════

let isInitialized = false

function initializeProviders(): void {
  if (isInitialized) return

  // 注册 OpenAI Provider
  const openai = new OpenAIProvider()
  registerProvider(openai)

  // 注册 Anthropic Provider
  const anthropic = new AnthropicProvider()
  registerProvider(anthropic)

  // 注册 Google AI Provider
  const google = new GoogleAIProvider()
  registerProvider(google)

  // 注册 Custom Provider (兼容 OpenAI API 的第三方服务)
  const custom = new CustomProvider()
  registerProvider(custom)

  isInitialized = true
  llmLogger.info('Providers 初始化完成')
}

// 立即初始化
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

// ═══════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MODEL = process.env.DEFAULT_LLM_MODEL ?? 'gpt-4o'
const FALLBACK_MODEL = process.env.FALLBACK_LLM_MODEL ?? 'gpt-3.5-turbo'

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
  const fullConfig: LLMConfig = {
    model: config.model ?? DEFAULT_MODEL,
    ...DEFAULT_CONFIG,
    ...config,
  }

  const provider = await resolveProviderForModel(fullConfig.model)

  if (!provider || !provider.isAvailable()) {
    // 尝试 Fallback
    const fallbackProvider = await resolveProviderForModel(FALLBACK_MODEL)
    if (fallbackProvider?.isAvailable()) {
      llmLogger.warn('Provider 不可用，使用 Fallback', {
        original: fullConfig.model,
        fallback: FALLBACK_MODEL,
      })
      fullConfig.model = FALLBACK_MODEL
      return fallbackProvider.generate(messages, fullConfig)
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
  const fullConfig: LLMConfig = {
    model: config.model ?? DEFAULT_MODEL,
    ...DEFAULT_CONFIG,
    ...config,
  }

  const provider = await resolveProviderForModel(fullConfig.model)

  if (!provider || !provider.isAvailable()) {
    // 尝试 Fallback
    const fallbackProvider = await resolveProviderForModel(FALLBACK_MODEL)
    if (fallbackProvider?.isAvailable()) {
      llmLogger.warn('Provider 不可用，使用 Fallback', {
        original: fullConfig.model,
        fallback: FALLBACK_MODEL,
      })
      fullConfig.model = FALLBACK_MODEL
      return fallbackProvider.generateStream(messages, fullConfig, onChunk)
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
  available: boolean
  models: string[]
  modelInfos: LLMModelInfo[]
}>> {
  initializeProviders()

  const openai = getProvider('openai')
  const anthropic = getProvider('anthropic')
  const google = getProvider('google')
  const custom = getProvider('custom')

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

  const openaiModels = await loadProviderModels(openai)
  const anthropicModels = await loadProviderModels(anthropic)
  const googleModels = await loadProviderModels(google)
  const customModels = await loadProviderModels(custom)

  return [
    {
      name: 'openai',
      available: openai?.isAvailable() ?? false,
      models: openaiModels.models,
      modelInfos: openaiModels.modelInfos,
    },
    {
      name: 'anthropic',
      available: anthropic?.isAvailable() ?? false,
      models: anthropicModels.models,
      modelInfos: anthropicModels.modelInfos,
    },
    {
      name: 'google',
      available: google?.isAvailable() ?? false,
      models: googleModels.models,
      modelInfos: googleModels.modelInfos,
    },
    {
      name: 'custom',
      available: custom?.isAvailable() ?? false,
      models: customModels.models,
      modelInfos: customModels.modelInfos,
    },
  ]
}

// 导出类型
export type { LLMMessage, LLMConfig, LLMResponse, LLMStreamChunk }
