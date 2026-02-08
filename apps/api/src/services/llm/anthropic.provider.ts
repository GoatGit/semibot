/**
 * Anthropic Provider 实现
 *
 * 支持 Claude 3 系列模型
 */

import type {
  LLMProvider,
  LLMModelInfo,
  LLMMessage,
  LLMConfig,
  LLMResponse,
  LLMStreamChunk,
  ToolCall,
  ToolDefinition,
} from './index'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; tool_use_id?: string; content?: string }>
}

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface AnthropicResponse {
  id: string
  type: string
  role: string
  content: Array<{
    type: 'text' | 'tool_use'
    text?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
  }>
  model: string
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

interface AnthropicModel {
  id: string
  type: string
  display_name?: string
}

interface AnthropicModelsResponse {
  data: AnthropicModel[]
}

// ═══════════════════════════════════════════════════════════════
// Anthropic Provider
// ═══════════════════════════════════════════════════════════════

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  models: string[] = []

  private apiKey: string | null
  private baseUrl: string
  private modelsCache: string[] | null = null
  private modelsCacheTime: number = 0
  private readonly CACHE_TTL = 5 * 60 * 1000

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || null
    this.baseUrl = process.env.ANTHROPIC_API_BASE_URL || 'https://api.anthropic.com/v1'
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

    if (this.modelsCache && Date.now() - this.modelsCacheTime < this.CACHE_TTL) {
      return this.modelsCache.map((model) => ({ id: model }))
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      })

      if (!response.ok) {
        console.error('[Anthropic] 获取模型列表失败:', response.statusText)
        return (this.modelsCache ?? []).map((model) => ({ id: model }))
      }

      const data = await response.json() as AnthropicModelsResponse

      const models = data.data
        .map((m) => ({
          id: m.id,
          displayName: m.display_name,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))

      this.modelsCache = models.map((model) => model.id)
      this.modelsCacheTime = Date.now()
      this.models = this.modelsCache

      console.log(`[Anthropic] 获取到 ${models.length} 个模型`)
      return models
    } catch (error) {
      console.error('[Anthropic] 获取模型列表出错:', error)
      return (this.modelsCache ?? []).map((model) => ({ id: model }))
    }
  }

  async generate(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('Anthropic API Key 未配置')
    }

    const { systemPrompt, anthropicMessages } = this.convertMessages(messages)

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        system: systemPrompt,
        messages: anthropicMessages,
        temperature: config.temperature ?? 0.7,
        top_p: config.topP ?? 1,
        stop_sequences: config.stop,
        tools: config.tools ? this.convertTools(config.tools) : undefined,
        container: config.container,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`Anthropic API 错误: ${errorData.error?.message ?? response.statusText}`)
    }

    const data = await response.json() as AnthropicResponse

    let content = ''
    const toolCalls: ToolCall[] = []

    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        content += block.text
      } else if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.mapStopReason(data.stop_reason),
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
    }
  }

  async generateStream(
    messages: LLMMessage[],
    config: LLMConfig,
    onChunk: (chunk: LLMStreamChunk) => void
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Anthropic API Key 未配置')
    }

    const { systemPrompt, anthropicMessages } = this.convertMessages(messages)

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        system: systemPrompt,
        messages: anthropicMessages,
        temperature: config.temperature ?? 0.7,
        top_p: config.topP ?? 1,
        stop_sequences: config.stop,
        tools: config.tools ? this.convertTools(config.tools) : undefined,
        container: config.container,
        stream: true,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      onChunk({
        type: 'error',
        error: {
          code: 'ANTHROPIC_ERROR',
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
    let currentToolCall: Partial<ToolCall> | null = null
    let inputTokens = 0
    let outputTokens = 0

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

          try {
            const event = JSON.parse(data)

            switch (event.type) {
              case 'message_start':
                if (event.message?.usage) {
                  inputTokens = event.message.usage.input_tokens
                }
                break

              case 'content_block_start':
                if (event.content_block?.type === 'tool_use') {
                  currentToolCall = {
                    id: event.content_block.id,
                    type: 'function',
                    function: {
                      name: event.content_block.name,
                      arguments: '',
                    },
                  }
                }
                break

              case 'content_block_delta':
                if (event.delta?.type === 'text_delta' && event.delta.text) {
                  onChunk({ type: 'text', content: event.delta.text })
                } else if (event.delta?.type === 'input_json_delta' && currentToolCall) {
                  currentToolCall.function!.arguments += event.delta.partial_json ?? ''
                }
                break

              case 'content_block_stop':
                if (currentToolCall && currentToolCall.id) {
                  onChunk({
                    type: 'tool_call',
                    toolCall: currentToolCall as ToolCall,
                  })
                  currentToolCall = null
                }
                break

              case 'message_delta':
                if (event.usage) {
                  outputTokens = event.usage.output_tokens
                }
                if (event.delta?.stop_reason) {
                  onChunk({
                    type: 'done',
                    finishReason: this.mapStopReason(event.delta.stop_reason),
                    usage: {
                      promptTokens: inputTokens,
                      completionTokens: outputTokens,
                      totalTokens: inputTokens + outputTokens,
                    },
                  })
                }
                break

              case 'message_stop':
                onChunk({ type: 'done' })
                break
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

  private convertMessages(messages: LLMMessage[]): {
    systemPrompt: string
    anthropicMessages: AnthropicMessage[]
  } {
    let systemPrompt = ''
    const anthropicMessages: AnthropicMessage[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        anthropicMessages.push({
          role: msg.role,
          content: msg.content,
        })
      } else if (msg.role === 'tool' && msg.toolCallId) {
        // 工具结果作为 user 消息
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId,
              content: msg.content,
            },
          ],
        })
      }
    }

    return { systemPrompt, anthropicMessages }
  }

  private convertTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }))
  }

  private mapStopReason(
    reason: string
  ): 'stop' | 'tool_calls' | 'length' | 'content_filter' {
    switch (reason) {
      case 'end_turn':
        return 'stop'
      case 'tool_use':
        return 'tool_calls'
      case 'max_tokens':
        return 'length'
      default:
        return 'stop'
    }
  }
}
