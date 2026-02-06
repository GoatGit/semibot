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
  registerProvider,
  getProvider,
  getProviderForModel,
  getAvailableProviders,
} from './llm/index'
import { OpenAIProvider } from './llm/openai.provider'
import { AnthropicProvider } from './llm/anthropic.provider'

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

  isInitialized = true
  console.log('[LLM] Providers 初始化完成')
}

// 立即初始化
initializeProviders()

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

  const provider = getProviderForModel(fullConfig.model)

  if (!provider || !provider.isAvailable()) {
    // 尝试 Fallback
    const fallbackProvider = getProviderForModel(FALLBACK_MODEL)
    if (fallbackProvider?.isAvailable()) {
      console.warn(
        `[LLM] Provider 不可用，使用 Fallback: ${fullConfig.model} -> ${FALLBACK_MODEL}`
      )
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

  const provider = getProviderForModel(fullConfig.model)

  if (!provider || !provider.isAvailable()) {
    // 尝试 Fallback
    const fallbackProvider = getProviderForModel(FALLBACK_MODEL)
    if (fallbackProvider?.isAvailable()) {
      console.warn(
        `[LLM] Provider 不可用，使用 Fallback: ${fullConfig.model} -> ${FALLBACK_MODEL}`
      )
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
export function getAvailableModels(): string[] {
  const models: string[] = []
  for (const provider of getAvailableProviders()) {
    models.push(...provider.models)
  }
  return models
}

/**
 * 获取 Provider 状态
 */
export function getProviderStatus(): Array<{
  name: string
  available: boolean
  models: string[]
}> {
  initializeProviders()

  const openai = getProvider('openai')
  const anthropic = getProvider('anthropic')

  return [
    {
      name: 'openai',
      available: openai?.isAvailable() ?? false,
      models: openai?.models ?? [],
    },
    {
      name: 'anthropic',
      available: anthropic?.isAvailable() ?? false,
      models: anthropic?.models ?? [],
    },
  ]
}

// 导出类型
export type { LLMMessage, LLMConfig, LLMResponse, LLMStreamChunk }
