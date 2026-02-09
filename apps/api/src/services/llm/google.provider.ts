/**
 * Google AI Provider 实现
 *
 * 支持 Gemini 系列模型
 */

import type {
  LLMProvider,
  LLMModelInfo,
  LLMMessage,
  LLMConfig,
  LLMResponse,
  LLMStreamChunk,
} from './index'
import { createLogger } from '../../lib/logger'

const googleLogger = createLogger('google-ai')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface GoogleAIContent {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

interface GoogleAIResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>
      role: string
    }
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER'
  }>
  usageMetadata: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

interface GoogleAIModel {
  name: string
  displayName?: string
}

interface GoogleAIModelsResponse {
  models?: GoogleAIModel[]
}

// ═══════════════════════════════════════════════════════════════
// Google AI Provider
// ═══════════════════════════════════════════════════════════════

export class GoogleAIProvider implements LLMProvider {
  readonly name = 'google'
  models: string[] = []

  private apiKey: string | null
  private baseUrl: string
  private modelsCache: string[] | null = null
  private modelsCacheTime: number = 0
  private readonly CACHE_TTL = 5 * 60 * 1000

  constructor() {
    this.apiKey = process.env.GOOGLE_AI_API_KEY || null
    this.baseUrl = process.env.GOOGLE_AI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
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
      const response = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`, {
        method: 'GET',
      })

      if (!response.ok) {
        googleLogger.error('获取模型列表失败', undefined, { status: response.statusText })
        return (this.modelsCache ?? []).map((model) => ({ id: model }))
      }

      const data = await response.json() as GoogleAIModelsResponse
      const models = (data.models ?? [])
        .map((m) => ({
          id: m.name.replace(/^models\//, ''),
          displayName: m.displayName,
        }))
        .filter((model) => model.id.length > 0)
        .sort((a, b) => a.id.localeCompare(b.id))

      this.modelsCache = models.map((model) => model.id)
      this.modelsCacheTime = Date.now()
      this.models = this.modelsCache

      googleLogger.info('获取模型列表成功', { count: models.length })
      return models
    } catch (error) {
      googleLogger.error('获取模型列表出错', error as Error)
      return (this.modelsCache ?? []).map((model) => ({ id: model }))
    }
  }

  async generate(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('Google AI API Key 未配置')
    }

    const { systemInstruction, contents } = this.convertMessages(messages)

    const response = await fetch(
      `${this.baseUrl}/models/${config.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            temperature: config.temperature ?? 0.7,
            maxOutputTokens: config.maxTokens ?? 4096,
            topP: config.topP ?? 1,
            stopSequences: config.stop,
          },
        }),
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`Google AI API 错误: ${errorData.error?.message ?? response.statusText}`)
    }

    const data = await response.json() as GoogleAIResponse
    const candidate = data.candidates[0]

    const content = candidate.content.parts.map((p) => p.text).join('')

    return {
      content,
      finishReason: this.mapFinishReason(candidate.finishReason),
      usage: {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      },
    }
  }

  async generateStream(
    messages: LLMMessage[],
    config: LLMConfig,
    onChunk: (chunk: LLMStreamChunk) => void
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Google AI API Key 未配置')
    }

    const { systemInstruction, contents } = this.convertMessages(messages)

    const response = await fetch(
      `${this.baseUrl}/models/${config.model}:streamGenerateContent?key=${this.apiKey}&alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            temperature: config.temperature ?? 0.7,
            maxOutputTokens: config.maxTokens ?? 4096,
            topP: config.topP ?? 1,
            stopSequences: config.stop,
          },
        }),
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } }
      onChunk({
        type: 'error',
        error: {
          code: 'GOOGLE_AI_ERROR',
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
            const parsed = JSON.parse(data) as GoogleAIResponse

            if (parsed.candidates?.[0]?.content?.parts) {
              for (const part of parsed.candidates[0].content.parts) {
                if (part.text) {
                  onChunk({ type: 'text', content: part.text })
                }
              }
            }

            // 处理完成状态
            if (parsed.candidates?.[0]?.finishReason) {
              onChunk({
                type: 'done',
                finishReason: this.mapFinishReason(parsed.candidates[0].finishReason),
                usage: parsed.usageMetadata ? {
                  promptTokens: parsed.usageMetadata.promptTokenCount,
                  completionTokens: parsed.usageMetadata.candidatesTokenCount,
                  totalTokens: parsed.usageMetadata.totalTokenCount,
                } : undefined,
              })
            }
          } catch {
            // 忽略解析错误
          }
        }
      }

      onChunk({ type: 'done' })
    } finally {
      reader.releaseLock()
    }
  }

  private convertMessages(messages: LLMMessage[]): {
    systemInstruction: string
    contents: GoogleAIContent[]
  } {
    let systemInstruction = ''
    const contents: GoogleAIContent[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n\n' : '') + msg.content
      } else if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        })
      } else if (msg.role === 'assistant') {
        contents.push({
          role: 'model',
          parts: [{ text: msg.content }],
        })
      }
    }

    return { systemInstruction, contents }
  }

  private mapFinishReason(reason: string): 'stop' | 'tool_calls' | 'length' | 'content_filter' {
    switch (reason) {
      case 'STOP':
        return 'stop'
      case 'MAX_TOKENS':
        return 'length'
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter'
      default:
        return 'stop'
    }
  }
}
