/**
 * OpenAI Provider 实现
 *
 * 支持 GPT-4, GPT-4 Turbo, GPT-4o 等模型
 * 模型列表从 API 动态获取
 */

import type {
  LLMProvider,
  LLMModelInfo,
  LLMMessage,
  LLMConfig,
  LLMResponse,
  LLMStreamChunk,
  ToolCall,
} from './index'
import { createLogger } from '../../lib/logger'

const openaiLogger = createLogger('openai')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
  tool_call_id?: string
}

interface OpenAIResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface OpenAIStreamDelta {
  role?: string
  content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface OpenAIModel {
  id: string
  object: string
  created: number
  owned_by: string
  display_name?: string
}

interface OpenAIModelsResponse {
  object: string
  data: OpenAIModel[]
}

// ═══════════════════════════════════════════════════════════════
// OpenAI Provider
// ═══════════════════════════════════════════════════════════════

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  models: string[] = []

  private apiKey: string | null
  private baseUrl: string
  private modelsCache: string[] | null = null
  private modelsCacheTime: number = 0
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5分钟缓存

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || null
    this.baseUrl = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
  }

  isAvailable(): boolean {
    return !!this.apiKey
  }

  async fetchModels(): Promise<string[]> {
    const modelInfos = await this.fetchModelInfos()
    return modelInfos.map((model) => model.id)
  }

  async fetchModelInfos(): Promise<LLMModelInfo[]> {
    if (!this.apiKey) {
      return []
    }

    // 检查缓存
    if (this.modelsCache && Date.now() - this.modelsCacheTime < this.CACHE_TTL) {
      return this.modelsCache.map((model) => ({ id: model }))
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      })

      if (!response.ok) {
        openaiLogger.error('获取模型列表失败', undefined, { status: response.statusText })
        return (this.modelsCache ?? []).map((model) => ({ id: model }))
      }

      const data = await response.json() as OpenAIModelsResponse

      // 过滤出 chat 模型 (gpt-*)
      const chatModels = data.data
        .filter((m) => m.id.startsWith('gpt-'))
        .map((m) => ({
          id: m.id,
          displayName: m.display_name,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))

      this.modelsCache = chatModels.map((model) => model.id)
      this.modelsCacheTime = Date.now()
      this.models = this.modelsCache

      openaiLogger.info('获取模型列表成功', { count: chatModels.length })
      return chatModels
    } catch (error) {
      openaiLogger.error('获取模型列表出错', error as Error)
      return (this.modelsCache ?? []).map((model) => ({ id: model }))
    }
  }

  async generate(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('OpenAI API Key 未配置')
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: this.convertMessages(messages),
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 4096,
        top_p: config.topP ?? 1,
        frequency_penalty: config.frequencyPenalty ?? 0,
        presence_penalty: config.presencePenalty ?? 0,
        stop: config.stop,
        tools: config.tools,
        tool_choice: config.toolChoice,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`OpenAI API 错误: ${errorData.error?.message ?? response.statusText}`)
    }

    const data = await response.json() as OpenAIResponse
    const choice = data.choices[0]

    return {
      content: choice.message.content ?? '',
      toolCalls: choice.message.tool_calls?.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: tc.function,
      })),
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
    }
  }

  async generateStream(
    messages: LLMMessage[],
    config: LLMConfig,
    onChunk: (chunk: LLMStreamChunk) => void
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error('OpenAI API Key 未配置')
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: this.convertMessages(messages),
        temperature: config.temperature ?? 0.7,
        max_tokens: config.maxTokens ?? 4096,
        top_p: config.topP ?? 1,
        frequency_penalty: config.frequencyPenalty ?? 0,
        presence_penalty: config.presencePenalty ?? 0,
        stop: config.stop,
        tools: config.tools,
        tool_choice: config.toolChoice,
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      onChunk({
        type: 'error',
        error: {
          code: 'OPENAI_ERROR',
          message: errorData.error?.message ?? response.statusText,
        },
      })
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      onChunk({
        type: 'error',
        error: { code: 'STREAM_ERROR', message: '无法读取响应流' },
      })
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    const toolCallsInProgress: Map<number, ToolCall> = new Map()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()

          if (data === '[DONE]') {
            // 发送完成的 tool calls
            if (toolCallsInProgress.size > 0) {
              for (const toolCall of toolCallsInProgress.values()) {
                onChunk({ type: 'tool_call', toolCall })
              }
            }
            onChunk({ type: 'done' })
            return
          }

          try {
            const parsed = JSON.parse(data)
            const delta: OpenAIStreamDelta = parsed.choices?.[0]?.delta ?? {}
            const finishReason = parsed.choices?.[0]?.finish_reason

            // 处理文本内容
            if (delta.content) {
              onChunk({ type: 'text', content: delta.content })
            }

            // 处理 tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                let existing = toolCallsInProgress.get(tc.index)
                if (!existing) {
                  existing = {
                    id: tc.id ?? '',
                    type: 'function',
                    function: { name: '', arguments: '' },
                  }
                  toolCallsInProgress.set(tc.index, existing)
                }

                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.function.name += tc.function.name
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
              }
            }

            // 处理使用量
            if (parsed.usage) {
              onChunk({
                type: 'done',
                finishReason: finishReason ?? 'stop',
                usage: {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
                },
              })
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private convertMessages(messages: LLMMessage[]): OpenAIMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      tool_calls: msg.toolCalls?.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: tc.function,
      })),
      tool_call_id: msg.toolCallId,
    }))
  }
}
