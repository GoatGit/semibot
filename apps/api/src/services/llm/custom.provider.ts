/**
 * Custom Provider 实现
 *
 * 支持兼容 OpenAI API 的第三方服务（如 DeepSeek, 智谱, 月之暗面等）
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
  created?: number
  owned_by?: string
  display_name?: string
}

interface OpenAIModelsResponse {
  object: string
  data: OpenAIModel[]
}

// ═══════════════════════════════════════════════════════════════
// Custom Provider
// ═══════════════════════════════════════════════════════════════

export class CustomProvider implements LLMProvider {
  readonly name = 'custom'
  models: string[] = []

  private apiKey: string | null
  private baseUrl: string | null
  private modelsCache: string[] | null = null
  private modelsCacheTime: number = 0
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5分钟缓存

  constructor() {
    this.apiKey = process.env.CUSTOM_LLM_API_KEY || null
    this.baseUrl = process.env.CUSTOM_LLM_API_BASE_URL || null
  }

  isAvailable(): boolean {
    return !!(this.apiKey && this.baseUrl)
  }

  async fetchModels(): Promise<string[]> {
    const modelInfos = await this.fetchModelInfos()
    return modelInfos.map((model) => model.id)
  }

  async fetchModelInfos(): Promise<LLMModelInfo[]> {
    if (!this.apiKey || !this.baseUrl) {
      return []
    }

    // 检查缓存
    if (this.modelsCache && Date.now() - this.modelsCacheTime < this.CACHE_TTL) {
      return this.modelsCache.map((model) => ({ id: model }))
    }

    try {
      const response = await this.fetchWithOpenAICompatibleFallback('models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      })

      if (!response.ok) {
        console.error('[Custom] 获取模型列表失败:', response.statusText)
        return (this.modelsCache ?? []).map((model) => ({ id: model }))
      }

      const data = await response.json() as OpenAIModelsResponse

      // 获取所有模型
      const models = data.data
        .map((m) => ({
          id: m.id,
          displayName: m.display_name,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))

      this.modelsCache = models.map((model) => model.id)
      this.modelsCacheTime = Date.now()
      this.models = this.modelsCache

      console.log(`[Custom] 获取到 ${models.length} 个模型`)
      return models
    } catch (error) {
      console.error('[Custom] 获取模型列表出错:', error)
      return (this.modelsCache ?? []).map((model) => ({ id: model }))
    }
  }

  async generate(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
    if (!this.apiKey || !this.baseUrl) {
      throw new Error('Custom LLM API 未配置')
    }

    const response = await this.fetchWithOpenAICompatibleFallback('chat/completions', {
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
      throw new Error(`Custom LLM API 错误: ${errorData.error?.message ?? response.statusText}`)
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
    if (!this.apiKey || !this.baseUrl) {
      throw new Error('Custom LLM API 未配置')
    }

    const response = await this.fetchWithOpenAICompatibleFallback('chat/completions', {
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
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      onChunk({
        type: 'error',
        error: {
          code: 'CUSTOM_LLM_ERROR',
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

            if (delta.content) {
              onChunk({ type: 'text', content: delta.content })
            }

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

  private buildEndpointCandidates(path: string): string[] {
    if (!this.baseUrl) {
      return []
    }

    const normalizedBase = this.baseUrl.replace(/\/+$/, '')
    const direct = `${normalizedBase}/${path}`

    if (normalizedBase.endsWith('/v1')) {
      return [direct]
    }

    return [direct, `${normalizedBase}/v1/${path}`]
  }

  private async fetchWithOpenAICompatibleFallback(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    const candidates = this.buildEndpointCandidates(path)
    let lastResponse: Response | null = null

    for (const endpoint of candidates) {
      const response = await fetch(endpoint, init)
      if (response.ok) {
        return response
      }

      lastResponse = response

      if (response.status !== 404) {
        break
      }
    }

    if (lastResponse) {
      return lastResponse
    }

    throw new Error('Custom LLM API Endpoint 未配置')
  }
}
