import { createLogger } from '../lib/logger'

const logger = createLogger('production-runtime-client')

export interface RuntimeSseResult {
  finalResponse: string
  status: string
  error?: string
  runtimeEvents: Array<Record<string, unknown>>
  usage: Record<string, unknown>
}

export function getRuntimeBaseUrl(): string {
  const configured = (process.env.RUNTIME_URL || '').trim().replace(/\/+$/, '')
  if (configured) return configured
  const port = String(process.env.RUNTIME_PORT || '8765').trim() || '8765'
  return `http://127.0.0.1:${port}`
}

export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i)
  if (fenced?.[1]) {
    const inner = fenced[1].trim()
    if (inner.startsWith('{') && inner.endsWith('}')) return inner
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }
  return null
}

export async function consumeRuntimeSse(response: Response): Promise<RuntimeSseResult> {
  if (!response.body) {
    return {
      finalResponse: '',
      status: '',
      runtimeEvents: [],
      usage: {},
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let doneStatus = ''
  let doneFinalResponse = ''
  let doneError = ''
  const runtimeEvents: Array<Record<string, unknown>> = []
  const usageTotals = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }

  const handlePayload = (payload: Record<string, unknown>) => {
    const eventName = String(payload.event || '')
    if (!eventName || eventName === 'start') return
    if (eventName === 'done') {
      doneStatus = String(payload.status || '')
      doneFinalResponse = String(payload.final_response || '')
      doneError = payload.error ? String(payload.error) : ''
      return
    }

    runtimeEvents.push(payload)
    const usageSource =
      typeof payload.data === 'object' && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : payload
    if (String(usageSource.type || payload.type || '') === 'llm.usage') {
      usageTotals.prompt_tokens += Number(usageSource.prompt_tokens || 0)
      usageTotals.completion_tokens += Number(usageSource.completion_tokens || 0)
      usageTotals.total_tokens += Number(usageSource.total_tokens || 0)
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLines = chunk
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
        if (dataLines.length > 0) {
          try {
            handlePayload(JSON.parse(dataLines.join('\n')) as Record<string, unknown>)
          } catch (error) {
            logger.warn('Ignore malformed APS runtime SSE frame', { error })
          }
        }
        boundary = buffer.indexOf('\n\n')
      }

      if (done) break
    }

    if (buffer.trim()) {
      const dataLines = buffer
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
      if (dataLines.length > 0) {
        try {
          handlePayload(JSON.parse(dataLines.join('\n')) as Record<string, unknown>)
        } catch (error) {
          logger.warn('Ignore malformed APS runtime trailing frame', { error })
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return {
    finalResponse: doneFinalResponse,
    status: doneStatus,
    error: doneError || undefined,
    runtimeEvents,
    usage: usageTotals,
  }
}
