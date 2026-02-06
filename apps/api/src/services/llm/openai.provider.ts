/**
 * OpenAI Provider 实现
 *
 * 支持 GPT-4, GPT-4 Turbo, GPT-3.5 Turbo 等模型
 */

import type {
  LLMProvider,
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

// ═══════════════════════════════════════════════════════════════
// OpenAI Provider
// ═══════════════════════════════════════════════════════════════

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  readonly models = ['gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-3.5-turbo']

  private apiKey: string | null
  private baseUrl: string

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY ?? null
    this.baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  }

  isAvailable(): boolean {
    return !!this.apiKey
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
