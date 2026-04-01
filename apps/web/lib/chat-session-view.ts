import type {
  Agent2UIMessage,
  PlanData,
  SessionView,
  ThinkingData,
  ToolCallData,
  ToolResultData,
} from '@/types'

export interface ChatSessionDisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  status?: 'sending' | 'sent' | 'error'
  isStreaming?: boolean
  metadata?: Record<string, unknown>
  fileData?: { url: string; filename: string; mimeType: string; size?: number }
  processData?: {
    messages: Agent2UIMessage[]
    thinking: ThinkingData | null
    plan: PlanData | null
    toolCalls: ToolCallData[]
  }
}

function looksLikeRawRuntimePayload(content: string): boolean {
  const text = String(content || '').trim()
  if (!text || !text.startsWith('{')) return false
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const keys = new Set(Object.keys(parsed || {}).map((key) => key.trim().toLowerCase()))
    const rawKeys = ['url', 'status_code', 'content_type', 'title', 'text']
    const overlap = rawKeys.filter((key) => keys.has(key)).length
    if (overlap >= 3) return true
    if (keys.has('url') && keys.has('text') && text.length > 200) return true
    return false
  } catch {
    return false
  }
}

function stripInjectedDocumentBlocks(content: string): string {
  return String(content || '').replace(/\n\n---\n\n参考文档：[\s\S]*$/, '')
}

function messageRichnessScore(message: ChatSessionDisplayMessage): number {
  let score = 0
  if (message.content.trim()) score += 3
  if (message.fileData) score += 2
  if (message.processData) score += 2
  if (message.metadata && Object.keys(message.metadata).length > 0) score += 1
  return score
}

function isEphemeralLocalMessage(message: ChatSessionDisplayMessage): boolean {
  return (
    /^user-\d+$/.test(message.id) ||
    /^assistant-\d+$/.test(message.id) ||
    /^stream-\d+$/.test(message.id) ||
    /^error-\d+$/.test(message.id) ||
    /^file-\d+$/.test(message.id)
  )
}

function isEphemeralAssistantPlaceholder(message: ChatSessionDisplayMessage): boolean {
  if (!isEphemeralLocalMessage(message) || message.role !== 'assistant' || message.fileData) return false
  if (message.status === 'error') return true
  return !String(message.content || '').trim()
}

function messagesSemanticallyEquivalent(
  left: ChatSessionDisplayMessage,
  right: ChatSessionDisplayMessage
): boolean {
  if (left.role !== right.role) return false
  const leftFile = left.fileData?.filename || ''
  const rightFile = right.fileData?.filename || ''
  if (leftFile || rightFile) {
    return leftFile !== '' && leftFile === rightFile
  }
  const leftContent = stripInjectedDocumentBlocks(left.content).trim()
  const rightContent = stripInjectedDocumentBlocks(right.content).trim()
  if (!leftContent || !rightContent || leftContent !== rightContent) return false
  const deltaMs = Math.abs(left.timestamp.getTime() - right.timestamp.getTime())
  return deltaMs <= 2 * 60 * 1000
}

function isAgent2UIMessage(value: unknown): value is Agent2UIMessage {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.id === 'string' && typeof obj.type === 'string' && obj.data !== undefined
}

function extractExecutionProcess(metadata: Record<string, unknown>): Agent2UIMessage[] {
  const payload = metadata.execution_process as { messages?: unknown } | undefined
  const raw = Array.isArray(payload?.messages) ? payload.messages : []
  return raw.filter(isAgent2UIMessage)
}

function buildProcessState(messages: Agent2UIMessage[]): {
  messages: Agent2UIMessage[]
  thinking: ThinkingData | null
  plan: PlanData | null
  toolCalls: ToolCallData[]
} {
  let thinking: ThinkingData | null = null
  let plan: PlanData | null = null
  const toolCalls: ToolCallData[] = []

  for (const msg of messages) {
    if (msg.type === 'thinking') {
      thinking = msg.data as ThinkingData
      continue
    }
    if (msg.type === 'plan') {
      plan = msg.data as PlanData
      continue
    }
    if (msg.type === 'tool_call') {
      toolCalls.push(msg.data as ToolCallData)
      continue
    }
    if (msg.type === 'tool_result') {
      const data = msg.data as ToolResultData & { status?: ToolCallData['status']; canRetry?: boolean }
      const idx = toolCalls.findIndex((tc) => {
        if (tc.status !== 'calling') return false
        if (data.capabilityId && tc.capabilityId) return data.capabilityId === tc.capabilityId
        return tc.toolName === data.toolName
      })
      if (idx >= 0) {
        toolCalls[idx] = {
          ...toolCalls[idx],
          capabilityId: data.capabilityId ?? toolCalls[idx].capabilityId,
          status: data.status ?? 'success',
          error: data.error,
          result: data.result,
        }
      }
    }
  }

  return {
    messages,
    thinking,
    plan,
    toolCalls,
  }
}

export function buildDisplayMessagesFromSessionView(view: SessionView): ChatSessionDisplayMessage[] {
  return view.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const metadata = (m.metadata ?? {}) as Record<string, unknown>
      const agent2ui = metadata.agent2ui as
        | { type?: string; data?: { url?: string; filename?: string; mimeType?: string; size?: number } }
        | undefined

      const isFileMessage = agent2ui?.type === 'file' && agent2ui.data?.url && agent2ui.data?.filename
      const fileData = isFileMessage
        ? {
            url: String(agent2ui?.data?.url),
            filename: String(agent2ui?.data?.filename),
            mimeType: String(agent2ui?.data?.mimeType ?? 'application/octet-stream'),
            size: typeof agent2ui?.data?.size === 'number' ? agent2ui.data.size : undefined,
          }
        : undefined
      const historicalProcessMessages = extractExecutionProcess(metadata)
      const processData =
        historicalProcessMessages.length > 0
          ? buildProcessState(historicalProcessMessages)
          : undefined

      return {
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: fileData ? '' : m.content,
        timestamp: new Date(m.createdAt),
        status: 'sent' as const,
        isStreaming: false,
        metadata,
        fileData,
        processData,
      }
    })
}

export function mergeDisplayMessagesFromSessionView(
  serverMessages: ChatSessionDisplayMessage[],
  cachedMessages: ChatSessionDisplayMessage[],
  options?: {
    currentAttemptStatus?: string | null
  }
): ChatSessionDisplayMessage[] {
  if (serverMessages.length === 0) return cachedMessages
  if (cachedMessages.length === 0) return serverMessages

  const normalizedAttemptStatus = String(options?.currentAttemptStatus || '').trim().toLowerCase()
  const hasServerAssistantArtifact = serverMessages.some((message) => message.role === 'assistant')
  const shouldDropRawEphemeralAssistant =
    !hasServerAssistantArtifact &&
    ['completed', 'failed', 'cancelled'].includes(normalizedAttemptStatus)

  const merged = new Map<string, ChatSessionDisplayMessage>()

  for (const message of serverMessages) {
    merged.set(message.id, message)
  }

  for (const message of cachedMessages) {
    if (isEphemeralAssistantPlaceholder(message)) {
      continue
    }
    if (
      shouldDropRawEphemeralAssistant &&
      isEphemeralLocalMessage(message) &&
      message.role === 'assistant' &&
      looksLikeRawRuntimePayload(message.content)
    ) {
      continue
    }

    const existing = merged.get(message.id)
    if (!existing) {
      if (
        isEphemeralLocalMessage(message) &&
        Array.from(merged.values()).some((serverMessage) =>
          messagesSemanticallyEquivalent(serverMessage, message)
        )
      ) {
        continue
      }
      merged.set(message.id, message)
      continue
    }

    if (messageRichnessScore(message) > messageRichnessScore(existing)) {
      merged.set(message.id, {
        ...existing,
        ...message,
      })
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}
