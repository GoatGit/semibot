/**
 * LLM Provider 抽象层
 *
 * 提供统一的 LLM 调用接口，支持多个 Provider
 */

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMConfig {
  model: string
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  stop?: string[]
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  container?: {
    skills?: Array<{
      type: 'anthropic' | 'custom'
      skill_id: string
      version?: string
    }>
  }
}

export interface LLMStreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error'
  content?: string
  toolCall?: ToolCall
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  error?: {
    code: string
    message: string
  }
}

export interface LLMResponse {
  content: string
  toolCalls?: ToolCall[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface LLMModelInfo {
  id: string
  displayName?: string
}

// ═══════════════════════════════════════════════════════════════
// Provider 接口
// ═══════════════════════════════════════════════════════════════

export interface LLMProvider {
  readonly name: string
  readonly models: string[]

  /**
   * 检查 Provider 是否可用
   */
  isAvailable(): boolean

  /**
   * 从 API 获取可用模型列表
   */
  fetchModels(): Promise<string[]>

  /**
   * 从 API 获取可用模型元数据
   */
  fetchModelInfos?(): Promise<LLMModelInfo[]>

  /**
   * 生成完整响应 (非流式)
   */
  generate(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse>

  /**
   * 生成流式响应
   */
  generateStream(
    messages: LLMMessage[],
    config: LLMConfig,
    onChunk: (chunk: LLMStreamChunk) => void
  ): Promise<void>
}

// ═══════════════════════════════════════════════════════════════
// Provider 注册表
// ═══════════════════════════════════════════════════════════════

const providers = new Map<string, LLMProvider>()

import { createLogger } from '../../lib/logger'
const llmLogger = createLogger('llm')

/**
 * 注册 Provider
 */
export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.name, provider)
  llmLogger.debug('Provider 已注册', { name: provider.name })
}

/**
 * 清空 Provider 注册表（用于运行时重载配置）
 */
export function clearProviders(): void {
  providers.clear()
}

/**
 * 获取 Provider
 */
export function getProvider(name: string): LLMProvider | undefined {
  return providers.get(name)
}

/**
 * 获取所有可用的 Provider
 */
export function getAvailableProviders(): LLMProvider[] {
  return Array.from(providers.values()).filter((p) => p.isAvailable())
}

/**
 * 根据模型名称获取 Provider
 */
export function getProviderForModel(model: string): LLMProvider | undefined {
  for (const provider of providers.values()) {
    if (provider.models.some((m) => model.startsWith(m) || m === model)) {
      return provider
    }
  }
  return undefined
}

// ═══════════════════════════════════════════════════════════════
// 默认导出
// ═══════════════════════════════════════════════════════════════

export { OpenAIProvider } from './openai.provider'
export { AnthropicProvider } from './anthropic.provider'
export { CustomProvider } from './custom.provider'
export { GoogleAIProvider } from './google.provider'
