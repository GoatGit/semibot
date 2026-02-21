export type BridgeCommandType =
  | 'start'
  | 'user_message'
  | 'cp_response'
  | 'cancel'
  | 'stop'

export type BridgeOutboundType =
  | 'thinking'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'execution_complete'
  | 'execution_error'
  | 'cp_request'
  | 'cp_fire_and_forget'

export type BridgeCommand = {
  type: BridgeCommandType
  id?: string
  session_id?: string
  payload?: Record<string, unknown>
  result?: unknown
  error?: { code?: string; message?: string } | null
}

export type SdkCommandInput = {
  message: string
  memory_context: string[]
  loaded_skill_count: number
  model: string
  tool_profile: string
}

export type SdkCommandOutput = {
  text: string
  usage?: {
    tokens_in?: number
    tokens_out?: number
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function parseBridgeCommand(raw: string): BridgeCommand | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(data)) return null
  const type = data.type
  if (
    type !== 'start' &&
    type !== 'user_message' &&
    type !== 'cp_response' &&
    type !== 'cancel' &&
    type !== 'stop'
  ) {
    return null
  }
  return {
    type,
    id: typeof data.id === 'string' ? data.id : undefined,
    session_id: typeof data.session_id === 'string' ? data.session_id : undefined,
    payload: isRecord(data.payload) ? data.payload : undefined,
    result: data.result,
    error: isRecord(data.error)
      ? {
          code: typeof data.error.code === 'string' ? data.error.code : undefined,
          message: typeof data.error.message === 'string' ? data.error.message : undefined,
        }
      : undefined,
  }
}

export function toSdkCommandInput(input: {
  message: string
  memoryContext: string[]
  loadedSkillCount: number
  model?: string
  toolProfile?: string
}): SdkCommandInput {
  return {
    message: input.message,
    memory_context: input.memoryContext,
    loaded_skill_count: input.loadedSkillCount,
    model: input.model ?? 'openclaw-sdk',
    tool_profile: input.toolProfile ?? 'default',
  }
}

export function parseSdkCommandOutput(raw: string): SdkCommandOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw || '{}')
  } catch {
    return { text: raw.trim() }
  }
  if (!isRecord(parsed)) return { text: raw.trim() }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  const usageRaw = parsed.usage
  const usage =
    isRecord(usageRaw)
      ? {
          tokens_in: typeof usageRaw.tokens_in === 'number' ? usageRaw.tokens_in : undefined,
          tokens_out: typeof usageRaw.tokens_out === 'number' ? usageRaw.tokens_out : undefined,
        }
      : undefined
  return { text, usage }
}
