export type BridgeInboundEvent = {
  type: string
  [key: string]: unknown
}

export type OpenClawEvent = {
  kind: string
  text?: string
  tool_name?: string
  input?: unknown
  output?: unknown
  error?: string
  error_code?: string
  final_response?: string
}

export function toSemibotSSE(event: BridgeInboundEvent): Record<string, unknown> | null {
  if (event.type === 'execution_complete' || event.type === 'execution_error') {
    return event
  }

  if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_call' || event.type === 'tool_result') {
    return event
  }

  return null
}

export function translateOpenClawEvent(event: OpenClawEvent): Record<string, unknown> | null {
  switch (event.kind) {
    case 'reasoning':
      return { type: 'thinking', content: event.text ?? '', stage: 'planning' }
    case 'assistant_message':
      return { type: 'text', content: event.text ?? '' }
    case 'tool_started':
      return {
        type: 'tool_call',
        tool_name: event.tool_name ?? 'tool',
        input: event.input ?? {},
      }
    case 'tool_finished':
      return {
        type: 'tool_result',
        tool_name: event.tool_name ?? 'tool',
        output: event.output ?? {},
      }
    case 'done':
      return {
        type: 'execution_complete',
        final_response: event.final_response ?? event.text ?? '',
      }
    case 'error':
      return {
        type: 'execution_error',
        code: event.error_code ?? 'OPENCLAW_EXECUTION_ERROR',
        error: event.error ?? 'openclaw error',
      }
    default:
      return null
  }
}
