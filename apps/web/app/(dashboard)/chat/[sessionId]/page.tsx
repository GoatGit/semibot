'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import clsx from 'clsx'
import { Send, Paperclip, Mic, StopCircle, User, RefreshCw, AlertCircle, X, FileText, Image as ImageIcon, ArrowLeft, ShieldAlert, Check, Copy, Download } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { AgentBotAvatar } from '@/components/ui/AgentBotAvatar'
import { MarkdownBlock } from '@/components/agent2ui/text/MarkdownBlock'
import { CitationList } from '@/components/agent2ui/text/CitationList'
import { ProcessCard } from '@/components/agent2ui/process/ProcessCard'
import { FileDownload } from '@/components/agent2ui/media/FileDownload'
import { useChat } from '@/hooks/useChat'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useSessionStore } from '@/stores/sessionStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { takeInitialSessionFiles } from '@/lib/chat-draft-transfer'
import {
  buildDisplayMessagesFromSessionView,
  mergeDisplayMessagesFromSessionView,
} from '@/lib/chat-session-view'
import type {
  ApiResponse,
  Session,
  Message as ApiMessage,
  Agent2UIMessage,
  PlanData,
  ThinkingData,
  ToolCallData,
  ToolResultData,
  McpCallData,
  McpResultData,
  SessionView,
  RuntimeAttemptView,
} from '@/types'
import {
  TIME_FORMAT_OPTIONS,
  CHAT_UPLOAD_ALLOWED_EXTENSIONS,
  APPROVAL_POLL_INTERVAL_MS,
} from '@/constants/config'

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  status?: 'sending' | 'sent' | 'error'
  isStreaming?: boolean
  requestId?: string
  metadata?: Record<string, unknown>
  fileData?: { url: string; filename: string; mimeType: string; size?: number }
  processData?: {
    messages: Agent2UIMessage[]
    thinking: ThinkingData | null
    plan: PlanData | null
    toolCalls: ToolCallData[]
  }
}

interface CachedDisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  status?: 'sending' | 'sent' | 'error'
  metadata?: Record<string, unknown>
  fileData?: { url: string; filename: string; mimeType: string; size?: number }
  processData?: {
    messages: Agent2UIMessage[]
    thinking: ThinkingData | null
    plan: PlanData | null
    toolCalls: ToolCallData[]
  }
}

interface PendingApproval {
  id: string
  status: string
  attemptId?: string
  userMessageId?: string
  eventId?: string
  approvalScopeId?: string
  riskLevel: string
  summary?: string
  toolName?: string
  action?: string
  target?: string
  reason?: string
  createdAt: string
  context?: Record<string, unknown>
}

interface SessionDocumentReference {
  docId: string
  version: number
  title: string
  chunkCount: number
  summaryChars: number
  workspaceRootRelativePath: string
}

interface ApprovalResolveResponse {
  success?: boolean
  id?: string
  status?: string
  resolved?: boolean
  resumed?: boolean
  sessionId?: string
  assistantMessageId?: string
}

type AssistantViewMode = 'report'

type TerminalAttemptStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'

function normalizeTerminalAttemptStatus(rawStatus: string): TerminalAttemptStatus {
  const status = String(rawStatus || '').trim().toLowerCase()
  if (status === 'awaiting_approval') return 'awaiting_approval'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'completed') return 'completed'
  // done/execution_complete should be treated as terminal completion even if status is empty/"success"/"ok"
  return 'completed'
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

function extractCheckpointProcessMessages(payload: unknown): Agent2UIMessage[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const processTrace = record.processTrace
  if (processTrace && typeof processTrace === 'object') {
    const messages = (processTrace as { messages?: unknown }).messages
    if (Array.isArray(messages)) {
      return messages.filter(isAgent2UIMessage)
    }
  }
  const executionProcess = record.execution_process
  if (executionProcess && typeof executionProcess === 'object') {
    const messages = (executionProcess as { messages?: unknown }).messages
    if (Array.isArray(messages)) {
      return messages.filter(isAgent2UIMessage)
    }
  }
  return []
}

function isAwaitingApprovalMessage(message: Pick<DisplayMessage, 'content' | 'metadata'>): boolean {
  const status = String(message.metadata?.status || '').trim().toLowerCase()
  return status === 'awaiting_approval'
}

function isLegacyCachedAssistantStateMessage(message: Pick<DisplayMessage, 'role' | 'content' | 'metadata'>): boolean {
  if (message.role !== 'assistant') return false
  const status = String(message.metadata?.status || '').trim().toLowerCase()
  if (status === 'awaiting_approval' || status === 'in_progress') return true
  return !String(message.content || '').trim() && status.length > 0
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
      const data = msg.data as ToolResultData
      const idx = toolCalls.findIndex((tc) => {
        if (tc.status !== 'calling') return false
        if (data.capabilityId && tc.capabilityId) return data.capabilityId === tc.capabilityId
        return tc.toolName === data.toolName
      })
      if (idx >= 0) {
        toolCalls[idx] = {
          ...toolCalls[idx],
          capabilityId: data.capabilityId ?? toolCalls[idx].capabilityId,
          status: data.success ? 'success' : 'error',
          result: data.result,
          error: data.error,
          duration: data.duration,
        }
      } else {
        toolCalls.push({
          toolName: data.toolName,
          capabilityId: data.capabilityId,
          arguments: {},
          status: data.success ? 'success' : 'error',
          result: data.result,
          error: data.error,
          duration: data.duration,
        })
      }
      continue
    }
    if (msg.type === 'mcp_call') {
      const data = msg.data as McpCallData
      toolCalls.push({
        toolName: data.toolName,
        capabilityId: data.capabilityId,
        arguments: data.arguments,
        status: data.status as ToolCallData['status'],
        duration: data.duration,
      })
      continue
    }
    if (msg.type === 'mcp_result') {
      const data = msg.data as McpResultData
      const idx = toolCalls.findIndex((tc) => {
        if (tc.status !== 'calling') return false
        if (data.capabilityId && tc.capabilityId) return data.capabilityId === tc.capabilityId
        return tc.toolName === data.toolName
      })
      if (idx >= 0) {
        toolCalls[idx] = {
          ...toolCalls[idx],
          capabilityId: data.capabilityId ?? toolCalls[idx].capabilityId,
          status: data.success ? 'success' : 'error',
          result: data.result,
          error: data.error,
          duration: data.duration,
        }
      } else {
        toolCalls.push({
          toolName: data.toolName,
          capabilityId: data.capabilityId,
          arguments: {},
          status: data.success ? 'success' : 'error',
          result: data.result,
          error: data.error,
          duration: data.duration,
        })
      }
    }
  }

  return { messages, thinking, plan, toolCalls }
}

function resolveProcessData(
  message: Pick<DisplayMessage, 'processData' | 'metadata'>
): DisplayMessage['processData'] {
  if (message.processData) return message.processData
  if (!message.metadata) return undefined
  const historicalProcessMessages = extractExecutionProcess(message.metadata)
  if (historicalProcessMessages.length === 0) return undefined
  return buildProcessState(historicalProcessMessages)
}

function extractSessionDocumentReferences(messages: DisplayMessage[]): SessionDocumentReference[] {
  const docs = new Map<string, SessionDocumentReference>()
  for (const message of messages) {
    const metadata = message.metadata
    const raw = metadata && typeof metadata === 'object'
      ? (metadata.document_context as { docs?: unknown[] } | undefined)
      : undefined
    const rows = Array.isArray(raw?.docs) ? raw.docs : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const item = row as Record<string, unknown>
      const docId = typeof item.docId === 'string' ? item.docId : ''
      const version = typeof item.version === 'number' ? item.version : Number(item.version || 0)
      const workspaceRootRelativePath = typeof item.workspaceRootRelativePath === 'string' ? item.workspaceRootRelativePath : ''
      if (!docId || !version || !workspaceRootRelativePath) continue
      docs.set(`${docId}:v${version}`, {
        docId,
        version,
        title: typeof item.title === 'string' ? item.title : docId,
        chunkCount: typeof item.chunkCount === 'number' ? item.chunkCount : Number(item.chunkCount || 0),
        summaryChars: typeof item.summaryChars === 'number' ? item.summaryChars : Number(item.summaryChars || 0),
        workspaceRootRelativePath,
      })
    }
  }
  return Array.from(docs.values())
}

function extractDirectMessageDocumentReferences(message: {
  metadata?: Record<string, unknown>
}): SessionDocumentReference[] {
  const metadata = message.metadata
  if (!metadata || typeof metadata !== 'object') return []
  const rawFromSourceDocs = metadata.source_docs
  const rawFromDocumentContext = metadata.document_context
  const candidates = Array.isArray(rawFromSourceDocs)
    ? rawFromSourceDocs
    : rawFromDocumentContext && typeof rawFromDocumentContext === 'object' && Array.isArray((rawFromDocumentContext as { docs?: unknown[] }).docs)
      ? (rawFromDocumentContext as { docs?: unknown[] }).docs ?? []
      : []
  const docs = new Map<string, SessionDocumentReference>()
  for (const row of candidates) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const docId = typeof item.docId === 'string' ? item.docId : ''
    const version = typeof item.version === 'number' ? item.version : Number(item.version || 0)
    const workspaceRootRelativePath = typeof item.workspaceRootRelativePath === 'string' ? item.workspaceRootRelativePath : ''
    if (!docId || !version || !workspaceRootRelativePath) continue
    docs.set(`${docId}:v${version}`, {
      docId,
      version,
      title: typeof item.title === 'string' ? item.title : docId,
      chunkCount: typeof item.chunkCount === 'number' ? item.chunkCount : Number(item.chunkCount || 0),
      summaryChars: typeof item.summaryChars === 'number' ? item.summaryChars : Number(item.summaryChars || 0),
      workspaceRootRelativePath,
    })
  }
  return Array.from(docs.values())
}

function extractDocumentReferencesFromApiMessages(
  messages: ApiMessage[],
  assistantMessageId?: string
): SessionDocumentReference[] {
  const toReferences = (message: Pick<ApiMessage, 'metadata'>): SessionDocumentReference[] => {
    return extractDirectMessageDocumentReferences({
      metadata: message.metadata && typeof message.metadata === 'object'
        ? (message.metadata as Record<string, unknown>)
        : undefined,
    })
  }

  const assistantIndex = assistantMessageId
    ? messages.findIndex((item) => item.id === assistantMessageId)
    : -1
  if (assistantIndex >= 0) {
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index]
      if (candidate.role !== 'user') continue
      const refs = toReferences(candidate)
      if (refs.length > 0) return refs
    }
  }

  const allRefs = new Map<string, SessionDocumentReference>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const ref of toReferences(message)) {
      allRefs.set(`${ref.docId}:v${ref.version}`, ref)
    }
  }
  return Array.from(allRefs.values())
}

function extractMessageScopedDocumentReferences(
  messages: DisplayMessage[],
  messageIndex: number
): SessionDocumentReference[] {
  const message = messages[messageIndex]
  if (!message) return []
  if (message.role === 'user') {
    return extractSessionDocumentReferences([message])
  }
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate.role !== 'user') continue
    const docs = extractSessionDocumentReferences([candidate])
    if (docs.length > 0) return docs
  }
  return []
}

interface SessionDocumentChunk {
  docId: string
  version: number
  chunkId: string
  content: string
}

type SessionDocumentChunkError = {
  error?: {
    code?: string
    details?: {
      references?: SessionDocumentReference[]
    }
  }
}

function parseEvidenceHref(href: string): { docId?: string; chunkIds: string[] } | null {
  try {
    const parsed = new URL(href)
    if (parsed.protocol !== 'semibot-evidence:' || parsed.hostname !== 'chunk') return null
    const explicitChunkId = parsed.searchParams.get('chunk_id')?.trim().toLowerCase()
    const explicitChunkIds = parsed.searchParams
      .get('chunk_ids')
      ?.split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^c\d{3,}$/i.test(item)) ?? []
    const chunkIds = explicitChunkId ? [explicitChunkId] : explicitChunkIds
    if (chunkIds.length === 0) return null
    const docId = parsed.searchParams.get('doc_id')?.trim() || undefined
    return { docId, chunkIds }
  } catch {
    return null
  }
}

function buildChunkAmbiguityMarkdown(
  chunkIds: string[],
  references: SessionDocumentReference[]
): string {
  if (references.length === 0) {
    return [
      '# 文档片段需要定位',
      '',
      `你引用了 ${chunkIds.map((item) => `\`${item}\``).join(', ')}，但当前消息没有找到关联的文档上下文。`,
      '',
      '请先重新发送该文档，或刷新页面后重试引用。',
    ].join('\n')
  }
  return [
    '# 文档片段需要消歧',
    '',
    `你引用了 ${chunkIds.map((item) => `\`${item}\``).join(', ')}，但当前会话下有多个已上传文档。`,
    '',
    '请在回答里改用显式引用格式：',
    '',
    '```text',
    `[doc:<doc_id> chunk:${chunkIds[0]}]`,
    '```',
    '',
    '当前可用文档：',
    '',
    ...references.flatMap((item) => [
      `- doc_id: \`${item.docId}\` · ${item.title} · v${item.version}`,
      '```text',
      `[doc:${item.docId} chunk:${chunkIds[0]}]`,
      '```',
    ]),
  ].join('\n')
}

function chunkIdToNumber(chunkId: string): number | null {
  const match = String(chunkId).trim().toLowerCase().match(/^c(\d{3,})$/)
  if (!match) return null
  return Number(match[1])
}

function numberToChunkId(value: number): string {
  return `c${String(value).padStart(4, '0')}`
}

function collectAdjacentChunkIds(chunkIds: string[], chunkCount: number): string[] {
  const ordered = new Set<string>()
  for (const chunkId of chunkIds) {
    ordered.add(chunkId)
  }
  if (chunkIds.length !== 1 || chunkCount <= 1) {
    return Array.from(ordered)
  }
  const numeric = chunkIdToNumber(chunkIds[0])
  if (!numeric) return Array.from(ordered)
  if (numeric > 1) ordered.add(numberToChunkId(numeric - 1))
  if (numeric < chunkCount) ordered.add(numberToChunkId(numeric + 1))
  return Array.from(ordered).sort((a, b) => {
    const left = chunkIdToNumber(a) ?? 0
    const right = chunkIdToNumber(b) ?? 0
    return left - right
  })
}

function stripInjectedDocumentBlocks(text: string): string {
  if (!text) return ''
  return String(text)
    .replace(/\[DOCUMENT_CONTEXT_BEGIN\][\s\S]*?\[DOCUMENT_CONTEXT_END\]\s*/gi, '')
    .replace(/\[DOCUMENT_CHUNK_EXPANSION_BEGIN\][\s\S]*?\[DOCUMENT_CHUNK_EXPANSION_END\]\s*/gi, '')
    .trim()
}

function toCachedDisplayMessages(messages: DisplayMessage[]): CachedDisplayMessage[] {
  return messages
    .filter((message) => {
      if (message.status === 'sending') return false
      if (message.status === 'error' && /^error-\d+$/.test(message.id)) return false
      if (isLegacyCachedAssistantStateMessage(message)) return false
      if (!message.isStreaming) return true
      return message.role === 'assistant' && message.content.trim().length > 0
    })
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      status: message.isStreaming ? 'sent' : message.status,
      metadata: message.metadata,
      fileData: message.fileData,
      processData: message.processData,
    }))
}

function fromCachedDisplayMessages(raw: unknown): DisplayMessage[] {
  if (!Array.isArray(raw)) return []
  const restored: Array<DisplayMessage | null> = raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : ''
      const role = record.role === 'user' || record.role === 'assistant' ? record.role : null
      const content = typeof record.content === 'string' ? record.content : ''
      const timestamp = typeof record.timestamp === 'string' ? new Date(record.timestamp) : null
      if (!id || !role || !timestamp || Number.isNaN(timestamp.getTime())) return null

      const metadata =
        record.metadata && typeof record.metadata === 'object'
          ? (record.metadata as Record<string, unknown>)
          : undefined
      const fileData =
        record.fileData && typeof record.fileData === 'object'
          ? (record.fileData as DisplayMessage['fileData'])
          : undefined
      const processData =
        record.processData && typeof record.processData === 'object'
          ? (record.processData as DisplayMessage['processData'])
          : undefined

      return {
        id,
        role,
        content,
        timestamp,
        status: record.status === 'sent' || record.status === 'error' ? record.status : undefined,
        isStreaming:
          record.status !== 'error' &&
          metadata?.status === 'in_progress',
        metadata,
        fileData,
        processData,
      } satisfies DisplayMessage
    })
  return restored
    .filter((item): item is DisplayMessage => item !== null)
    .filter((item) => !isLegacyCachedAssistantStateMessage(item))
}

async function fetchWithRetry<T>(
  loader: () => Promise<T>,
  retries = 4,
  delayMs = 350
): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await loader()
    } catch (error) {
      lastError = error
      if (attempt === retries - 1) break
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
    }
  }
  throw lastError
}

function normalizePendingApprovals(raw: unknown, sessionId: string, attemptId?: string): PendingApproval[] {
  if (!raw || typeof raw !== 'object') return []
  const payload = raw as { items?: unknown[]; data?: unknown }
  const items = Array.isArray(payload.items)
    ? payload.items
    : payload.data && typeof payload.data === 'object' && Array.isArray((payload.data as { items?: unknown[] }).items)
      ? (payload.data as { items?: unknown[] }).items ?? []
      : []

  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : (typeof record.approval_id === 'string' ? record.approval_id : '')
      if (!id) return null

      const status = typeof record.status === 'string' ? record.status : 'pending'
      const attemptId = typeof record.attemptId === 'string'
        ? record.attemptId
        : (typeof record.attempt_id === 'string' ? record.attempt_id : undefined)
      const userMessageId = typeof record.userMessageId === 'string'
        ? record.userMessageId
        : (typeof record.user_message_id === 'string' ? record.user_message_id : undefined)
      const eventId = typeof record.eventId === 'string' ? record.eventId : (typeof record.event_id === 'string' ? record.event_id : undefined)
      const riskLevel = typeof record.riskLevel === 'string' ? record.riskLevel : (typeof record.risk_level === 'string' ? record.risk_level : 'medium')
      const summary = typeof record.summary === 'string' ? record.summary : undefined
      const toolName = typeof record.toolName === 'string' ? record.toolName : (typeof record.tool_name === 'string' ? record.tool_name : undefined)
      const action = typeof record.action === 'string' ? record.action : undefined
      const target = typeof record.target === 'string' ? record.target : undefined
      const reason = typeof record.reason === 'string' ? record.reason : undefined
      const createdAt = typeof record.createdAt === 'string' ? record.createdAt : (typeof record.created_at === 'string' ? record.created_at : new Date().toISOString())
      const context = record.context && typeof record.context === 'object'
        ? (record.context as Record<string, unknown>)
        : undefined
      const approvalScopeId =
        (typeof record.approval_scope_id === 'string' && record.approval_scope_id.trim())
          ? record.approval_scope_id
          : (typeof context?.approval_scope_id === 'string' && context.approval_scope_id.trim())
            ? (context.approval_scope_id as string)
            : undefined

      return {
        id,
        status,
        attemptId,
        userMessageId,
        eventId,
        approvalScopeId,
        riskLevel,
        summary,
        toolName,
        action,
        target,
        reason,
        createdAt,
        context,
      } as PendingApproval
    })
    .filter((item): item is PendingApproval => item !== null)
    .filter((item) => item.status === 'pending')
    .filter((item) => {
      if (attemptId) {
        if (item.attemptId === attemptId) return true
        const context = item.context && typeof item.context === 'object'
          ? (item.context as Record<string, unknown>)
          : undefined
        const contextAttemptId = typeof context?.attempt_id === 'string' ? context.attempt_id : ''
        const currentAttemptId = typeof context?.current_attempt_id === 'string' ? context.current_attempt_id : ''
        return contextAttemptId === attemptId || currentAttemptId === attemptId
      }
      if (item.eventId && item.eventId.startsWith(`${sessionId}:`)) return true
      if (item.approvalScopeId && item.approvalScopeId === sessionId) return true
      const context = item.context && typeof item.context === 'object'
        ? (item.context as Record<string, unknown>)
        : undefined
      const contextSessionId = typeof context?.session_id === 'string' ? context.session_id : ''
      const runtimeSessionId = typeof context?.runtime_session_id === 'string' ? context.runtime_session_id : ''
      return contextSessionId === sessionId || runtimeSessionId === sessionId
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function tailId(value: string | undefined, size = 8): string {
  const text = String(value || '').trim()
  if (!text) return '--'
  return text.length <= size ? text : text.slice(-size)
}

/**
 * Chat Session Page - 会话详情页面
 *
 * 显示与 Agent 的对话内容:
 * - 消息列表
 * - 输入区域
 * - 实时状态反馈
 * - SSE 流式响应
 */
export default function ChatSessionPage() {
  const params = useParams()
  const router = useRouter()
  const { locale, t } = useLocale()
  const searchParams = useSearchParams()
  const sessionId = params.sessionId as string
  const initialMessage = searchParams.get('initialMessage')
  const [pendingInitialMessage, setPendingInitialMessage] = useState(initialMessage ?? '')
  const [pendingInitialFilesReady, setPendingInitialFilesReady] = useState(false)

  const [inputValue, setInputValue] = useState('')
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [sessionMeta, setSessionMeta] = useState<Session | null>(null)
  const [currentAttemptView, setCurrentAttemptView] = useState<RuntimeAttemptView | null>(null)
  const [sessionProcessMessages, setSessionProcessMessages] = useState<Agent2UIMessage[]>([])
  const [isLoadingSession, setIsLoadingSession] = useState(true)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionWarning, setSessionWarning] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])
  const [isLoadingApprovals, setIsLoadingApprovals] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null)
  const [bulkApprovalAction, setBulkApprovalAction] = useState<'approve' | 'reject' | null>(null)
  const isLoadingApprovalsRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const activeAssistantRequestIdRef = useRef<string | null>(null)
  const latestAgent2UIMessagesRef = useRef<Agent2UIMessage[]>([])
  const historyCacheKey = `semibot:chat-history:${sessionId}`
  const currentAttemptId = String(currentAttemptView?.attempt.id || '').trim()
  const currentAttemptStatus = String(currentAttemptView?.attempt.status || '').trim().toLowerCase()
  const isCurrentAttemptAwaitingApproval = currentAttemptStatus === 'awaiting_approval'
  const attemptNotices = currentAttemptView?.notices ?? []

  const { files, addFiles, removeFile, clearFiles, hasFiles } = useFileUpload()

  const { setCurrentSession: setStoreSession } = useSessionStore()

  const loadPendingApprovals = useCallback(async () => {
    if (!currentAttemptId || !isCurrentAttemptAwaitingApproval) {
      setPendingApprovals([])
      setApprovalError(null)
      return
    }
    if (isLoadingApprovalsRef.current) return
    isLoadingApprovalsRef.current = true
    try {
      setIsLoadingApprovals(true)
      const response = await apiClient.get<unknown>('/approvals', {
        params: { status: 'pending', limit: 100 },
      })
      setPendingApprovals(normalizePendingApprovals(response, sessionId, currentAttemptId))
      setApprovalError(null)
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : t('chatSession.error.loadApprovals'))
    } finally {
      isLoadingApprovalsRef.current = false
      setIsLoadingApprovals(false)
    }
  }, [currentAttemptId, isCurrentAttemptAwaitingApproval, sessionId, t])

  // 使用 useChat hook 进行真实对话
  const {
    agent2uiState,
    isSending,
    sendMessage,
    resumeSession,
    stopGeneration,
    retry,
    reset: resetChatState,
  } = useChat({
    sessionId,
    onMessage: (message) => {
      // 处理文件消息
      if (message.type === 'file') {
        const fileData = message.data as { url: string; filename: string; mimeType: string; size?: number }
        setDisplayMessages((prev) => {
          // 按 filename 去重，避免 replan 重试导致重复卡片
          const alreadyExists = prev.some(
            (m) => m.fileData && m.fileData.filename === fileData.filename
          )
          if (alreadyExists) return prev

          return [
            ...prev,
            {
              id: `file-${Date.now()}`,
              role: 'assistant' as const,
              content: '',
              timestamp: new Date(),
              fileData,
            },
          ]
        })
        return
      }

      // 处理流式文本消息
      if (message.type === 'text' || message.type === 'markdown') {
        const content = (message.data as { content: string }).content
        setDisplayMessages((prev) => {
          const lastStreamingIndex = [...prev]
            .map((m, idx) => ({ m, idx }))
            .reverse()
            .find(({ m }) => m.role === 'assistant' && m.isStreaming)?.idx
          if (typeof lastStreamingIndex === 'number') {
            return prev.map((m, i) =>
              i === lastStreamingIndex
                ? { ...m, content: m.content + content }
                : m
            )
          }
          return [
            ...prev,
            {
              id: `stream-${Date.now()}`,
              role: 'assistant' as const,
              content,
              timestamp: new Date(),
              isStreaming: true,
            },
          ]
        })
      }
    },
    onComplete: (data) => {
      const normalizedTerminalStatus = normalizeTerminalAttemptStatus(String(data.status || ''))
      const completedRequestId = activeAssistantRequestIdRef.current
      const processSnapshot = buildProcessState(latestAgent2UIMessagesRef.current)
      const hasProcessSnapshot = !!(
        processSnapshot.thinking ||
        processSnapshot.plan ||
        processSnapshot.toolCalls.length > 0 ||
        processSnapshot.messages.length > 0
      )
      // 标记流式消息完成
      setDisplayMessages((prev) => {
        const next = prev
          .filter((m) => !(completedRequestId && m.requestId === completedRequestId && m.status === 'error'))
          .map((m) => {
            if (!m.isStreaming) return m
            return {
              ...m,
              isStreaming: false,
              id: data.messageId || m.id,
              processData: hasProcessSnapshot ? processSnapshot : m.processData,
            }
          })

        return next
      })
      activeAssistantRequestIdRef.current = null
      setSessionMeta((prev) => {
        if (!prev) return prev
        if (normalizedTerminalStatus === 'awaiting_approval') {
          return { ...prev, status: 'active' }
        }
        return {
          ...prev,
          status: normalizedTerminalStatus === 'completed' ? 'completed' : 'failed',
        }
      })
      setCurrentAttemptView((prev) => (
        prev
          ? {
              ...prev,
              attempt: {
                ...prev.attempt,
                status: normalizedTerminalStatus as typeof prev.attempt.status,
              },
            }
          : prev
      ))
      resetChatState()
      void reloadSessionData()
      void loadPendingApprovals()
    },
    onError: (error) => {
      console.error('[Chat] 错误:', error)
      if (error.code === 'CHAT_RESUME_ERROR' || isTransientLoadFailedMessage(error.message)) {
        // 历史消息已通过 API 加载，SSE 实时流断开只影响后续更新
        // 显示友好提示而非原始错误信息
        setSessionWarning(t('chatSession.error.streamDisconnected'))
        return
      }
      const failedRequestId = activeAssistantRequestIdRef.current
      setDisplayMessages((prev) => {
        const next = prev.map((m) =>
          m.isStreaming
            ? { ...m, isStreaming: false, status: 'error' as const }
            : m
        )
        return [
          ...next,
          {
            id: `error-${Date.now()}`,
            role: 'assistant' as const,
            content: t('chatSession.error.messageWithReason', { message: error.message }),
            timestamp: new Date(),
            status: 'error',
            requestId: failedRequestId ?? undefined,
          },
        ]
      })
      void loadPendingApprovals()
    },
  })

  useEffect(() => {
    latestAgent2UIMessagesRef.current = agent2uiState.messages
  }, [agent2uiState.messages])

  // 思考过程数据是否存在（用于控制 ProcessCard 渲染，独立于 isSending）
  const hasProcessData = !!(
    agent2uiState.thinking ||
    agent2uiState.plan ||
    agent2uiState.toolCalls.length > 0 ||
    agent2uiState.isThinking
  )
  const restoredProcessData = useMemo(
    () => (sessionProcessMessages.length > 0 ? buildProcessState(sessionProcessMessages) : undefined),
    [sessionProcessMessages]
  )
  const restoredAwaitingApproval = isCurrentAttemptAwaitingApproval

  // 将文件下载卡片调整到对应答案之后展示，避免在答案前插入。
  const orderedMessages = useMemo(() => {
    const result: DisplayMessage[] = []
    let pendingAssistantFiles: DisplayMessage[] = []

    for (const message of displayMessages) {
      const isAssistantFile = message.role === 'assistant' && !!message.fileData
      if (isAssistantFile) {
        pendingAssistantFiles.push(message)
        continue
      }

      result.push(message)

      const isAssistantAnswer = message.role === 'assistant' && !message.fileData
      if (isAssistantAnswer && pendingAssistantFiles.length > 0) {
        result.push(...pendingAssistantFiles)
        pendingAssistantFiles = []
      }
    }

    if (pendingAssistantFiles.length > 0) {
      result.push(...pendingAssistantFiles)
    }

    return result
  }, [displayMessages])

  const visibleApprovals = useMemo(
    () => pendingApprovals.slice(0, 3),
    [pendingApprovals]
  )
  const hiddenApprovalCount = Math.max(0, pendingApprovals.length - visibleApprovals.length)
  const primaryNotice = attemptNotices[0] ?? null
  const shouldShowApprovalNotice = isCurrentAttemptAwaitingApproval
  const isAwaitingApprovalActive = isCurrentAttemptAwaitingApproval
  const hasActiveStreamingMessage = useMemo(
    () => displayMessages.some((msg) => msg.role === 'assistant' && msg.isStreaming),
    [displayMessages]
  )
  const isStopActionActive = isSending && hasActiveStreamingMessage && !isAwaitingApprovalActive
  const attemptDiagnostics = useMemo(() => {
    if (!currentAttemptView) return null
    const eventPending = currentAttemptView.eventOutbox.filter((item) => item.status !== 'delivered').length
    const checkpointPending = currentAttemptView.checkpointOutbox.filter((item) => item.status !== 'delivered').length
    return {
      attemptId: currentAttemptView.attempt.id,
      status: currentAttemptView.attempt.status,
      latestRevision: currentAttemptView.attempt.latestRevision,
      checkpointRevision: currentAttemptView.latestCheckpoint?.revision,
      checkpointStatus: currentAttemptView.latestCheckpoint?.status,
      terminalReason: currentAttemptView.attempt.terminalReason,
      eventPending,
      checkpointPending,
    }
  }, [currentAttemptView])
  // 加载会话数据
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const cached = window.sessionStorage.getItem(historyCacheKey)
      if (!cached) return
      const restored = fromCachedDisplayMessages(JSON.parse(cached))
      if (restored.length > 0) {
        setDisplayMessages((prev) => (prev.length > 0 ? prev : restored))
      }
    } catch {
      // ignore malformed cache
    }
  }, [historyCacheKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem(
        historyCacheKey,
        JSON.stringify(toCachedDisplayMessages(displayMessages))
      )
    } catch {
      // ignore storage failures
    }
  }, [displayMessages, historyCacheKey])

  const reloadSessionData = useCallback(async () => {
    const viewResponse = await fetchWithRetry(() => apiClient.get<ApiResponse<SessionView>>(`/sessions/${sessionId}/view`))

    if (!viewResponse.success || !viewResponse.data) {
      throw new Error(viewResponse.error?.message ?? t('chatSession.error.loadSession'))
    }

    const view = viewResponse.data
    const session = view.session
    setSessionMeta(session)
    if (view.currentAttempt?.id) {
      try {
        const attemptResponse = await fetchWithRetry(() => apiClient.get<ApiResponse<RuntimeAttemptView>>(`/sessions/attempts/${view.currentAttempt?.id}`))
        if (attemptResponse.success && attemptResponse.data) {
          setCurrentAttemptView(attemptResponse.data)
          const attemptProcessMessages = Array.isArray(attemptResponse.data.processTrace?.messages)
            ? attemptResponse.data.processTrace.messages
            : []
          const checkpointMessages = extractCheckpointProcessMessages(attemptResponse.data.latestCheckpoint?.payload)
          setSessionProcessMessages((prev) => {
            const nextMessages = attemptProcessMessages.length > 0
              ? attemptProcessMessages
              : checkpointMessages
            if (nextMessages.length > 0) {
              return nextMessages
            }
            const attemptStatus = String(attemptResponse.data?.attempt.status || '').trim().toLowerCase()
            if (prev.length > 0 && ['running', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(attemptStatus)) {
              return prev
            }
            return []
          })
        } else {
          setCurrentAttemptView(null)
          setSessionProcessMessages([])
        }
      } catch {
        setCurrentAttemptView(null)
        setSessionProcessMessages([])
      }
    } else {
      setCurrentAttemptView(null)
      setSessionProcessMessages([])
    }
    setStoreSession({
      id: session.id,
      agentId: session.agentId,
      title: session.title ?? t('chatSession.newChat'),
      status: session.status,
      messages: [],
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
    })

    const historyMessages: DisplayMessage[] = buildDisplayMessagesFromSessionView(view)

    setDisplayMessages((prev) =>
      mergeDisplayMessagesFromSessionView(historyMessages, prev, {
        currentAttemptStatus: String(view.currentAttempt?.status || '').trim().toLowerCase(),
      })
    )
  }, [sessionId, setStoreSession, t])

  // 加载会话数据
  useEffect(() => {
    let cancelled = false

    const loadSession = async () => {
      try {
        setIsLoadingSession(true)
        setSessionError(null)
        setSessionWarning(null)

        const result = await Promise.allSettled([reloadSessionData()])

        if (cancelled) return

        if (result[0].status !== 'fulfilled') {
          throw result[0].reason instanceof Error
            ? result[0].reason
            : new Error(t('chatSession.error.loadSession'))
        }
      } catch (error) {
        console.error('[Chat] 加载会话失败:', error)
        if (!cancelled) {
          setSessionError(
            error instanceof Error ? error.message : t('chatSession.error.loadSession')
          )
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSession(false)
        }
      }
    }

    if (sessionId) {
      void loadSession()
    }

    return () => {
      cancelled = true
    }
  }, [reloadSessionData, t])

  // 定时刷新当前会话待审批项
  useEffect(() => {
    void loadPendingApprovals()
    const timer = setInterval(() => {
      void loadPendingApprovals()
    }, APPROVAL_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [loadPendingApprovals])

  // 自动发送 initialMessage（从新建会话页面跳转过来时）
  const initialMessageSentRef = useRef(false)
  const initialFilesRestoredRef = useRef(false)
  const resumeAttemptedRef = useRef(false)
  useEffect(() => {
    if (pendingInitialMessage || typeof window === 'undefined' || !sessionId) return
    const cached = sessionStorage.getItem(`semibot:initialMessage:${sessionId}`)
    if (cached && cached.trim()) {
      setPendingInitialMessage(cached)
    }
  }, [pendingInitialMessage, sessionId])

  useEffect(() => {
    if (initialMessage && initialMessage.trim()) {
      setPendingInitialMessage(initialMessage)
    }
  }, [initialMessage])

  useEffect(() => {
    resumeAttemptedRef.current = false
  }, [sessionId])

  useEffect(() => {
    if (typeof window === 'undefined' || isLoadingSession || initialFilesRestoredRef.current) return
    initialFilesRestoredRef.current = true
    try {
      const restoredFiles = takeInitialSessionFiles(sessionId)
      if (restoredFiles.length === 0) {
        setPendingInitialFilesReady(true)
        return
      }
      const restoreError = addFiles(restoredFiles)
      setUploadError(restoreError)
    } catch {
      // ignore in-memory transfer failures
    } finally {
      setPendingInitialFilesReady(true)
    }
  }, [addFiles, isLoadingSession, sessionId])

  useEffect(() => {
    if (!pendingInitialMessage || isLoadingSession || !pendingInitialFilesReady || initialMessageSentRef.current || isSending) return
    initialMessageSentRef.current = true
    resumeAttemptedRef.current = true

    // 清除 URL 参数，避免刷新重复发送
    router.replace(`/chat/${sessionId}`, { scroll: false })
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(`semibot:initialMessage:${sessionId}`)
    }

    const userMessage: DisplayMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: pendingInitialMessage,
      timestamp: new Date(),
      status: 'sent',
      metadata: hasFiles ? {
        attachments: files.map((f) => ({
          filename: f.file.name,
          size: f.file.size,
          mimeType: f.file.type,
          isImage: f.file.type.startsWith('image/'),
        })),
      } : undefined,
    }
    setDisplayMessages((prev) => [...prev, userMessage])
    const filesToSend = hasFiles ? files.map((f) => f.file) : undefined
    clearFiles()
    sendMessage(pendingInitialMessage, undefined, filesToSend).catch((error) => {
      console.error('[Chat] 自动发送初始消息失败:', error)
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, status: 'error' as const } : m
        )
      )
    })
  }, [pendingInitialMessage, isLoadingSession, pendingInitialFilesReady, isSending, sessionId, router, sendMessage, hasFiles, files, clearFiles])

  useEffect(() => {
    if (isLoadingSession) return
    if (isSending) return
    if (resumeAttemptedRef.current) return
    if (pendingInitialMessage) return
    if (sessionMeta?.status !== 'active') return
    if (currentAttemptStatus && currentAttemptStatus !== 'running') return
    setDisplayMessages((prev) => {
      const hasStreamingAssistant = prev.some((m) => m.role === 'assistant' && m.isStreaming)
      if (hasStreamingAssistant) return prev
      const requestId = `resume-${Date.now()}`
      activeAssistantRequestIdRef.current = requestId
      return [
        ...prev,
        {
          id: requestId,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          isStreaming: true,
          requestId,
        },
      ]
    })
    resumeAttemptedRef.current = true
    void resumeSession()
  }, [currentAttemptStatus, isLoadingSession, isSending, pendingInitialMessage, resumeSession, sessionMeta?.status])

  useEffect(() => {
    if (!isSending) return
    if (!currentAttemptStatus) return
    if (currentAttemptStatus === 'running' || currentAttemptStatus === 'awaiting_approval') return
    stopGeneration()
  }, [currentAttemptStatus, isSending, stopGeneration])

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [displayMessages, scrollToBottom])

  // 发送消息
  const handleSendMessage = async () => {
    if (!inputValue.trim() || isSending) return
    resumeAttemptedRef.current = true

    const userMessage: DisplayMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: inputValue.trim(),
      timestamp: new Date(),
      status: 'sending',
      metadata: hasFiles ? {
        attachments: files.map((f) => ({
          filename: f.file.name,
          size: f.file.size,
          mimeType: f.file.type,
          isImage: f.file.type.startsWith('image/'),
        })),
      } : undefined,
    }

    setDisplayMessages((prev) => [...prev, userMessage])
    const messageContent = inputValue.trim()
    const filesToSend = hasFiles ? files.map((f) => f.file) : undefined
    setInputValue('')
    clearFiles()

    try {
      // 清理上一轮残留的 isStreaming 标记，防止新消息追加到旧板块
      setDisplayMessages((prev) =>
        prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
      )

      const requestId = `assistant-${Date.now()}`
      activeAssistantRequestIdRef.current = requestId
      setDisplayMessages((prev) => [
        ...prev,
        {
          id: requestId,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          isStreaming: true,
          requestId,
        },
      ])

      // 标记用户消息为已发送
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, status: 'sent' as const } : m
        )
      )

      // 发送消息到 API
      await sendMessage(messageContent, undefined, filesToSend)
    } catch (error) {
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, status: 'error' as const } : m
        )
      )
    }
  }

  const handleApprovalDecision = useCallback(async (approvalId: string, decision: 'approve' | 'reject') => {
    if (actingApprovalId || bulkApprovalAction) return
    const actionKey = `${approvalId}:${decision}`
    setActingApprovalId(actionKey)
    try {
      const endpoint = decision === 'approve' ? 'approve' : 'reject'
      await apiClient.post<ApprovalResolveResponse>(`/approvals/${approvalId}/${endpoint}`, {})
      setApprovalError(null)
      if (decision === 'approve') {
        setPendingApprovals((prev) => prev.filter((item) => item.id !== approvalId))
        resumeAttemptedRef.current = false
      }
      await reloadSessionData()
    } finally {
      setActingApprovalId(null)
      await loadPendingApprovals()
      if (decision === 'approve') {
        void resumeSession()
        window.setTimeout(() => {
          void reloadSessionData()
        }, 1200)
      }
    }
  }, [actingApprovalId, bulkApprovalAction, loadPendingApprovals, reloadSessionData, resumeSession])

  const handleBulkApprovalDecision = useCallback(async (decision: 'approve' | 'reject') => {
    if (actingApprovalId || bulkApprovalAction || pendingApprovals.length === 0) return
    setBulkApprovalAction(decision)
    try {
      const endpoint = decision === 'approve' ? 'approve' : 'reject'
      await Promise.all(
        pendingApprovals.map((approval) =>
          apiClient.post<ApprovalResolveResponse>(`/approvals/${approval.id}/${endpoint}`, {})
        )
      )
      if (decision === 'approve') {
        setPendingApprovals([])
        resumeAttemptedRef.current = false
      }
      await reloadSessionData()
      await loadPendingApprovals()
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : t('chatSession.error.bulkApproval'))
    } finally {
      setBulkApprovalAction(null)
      if (decision === 'approve') {
        void resumeSession()
        window.setTimeout(() => {
          void reloadSessionData()
        }, 1200)
      }
    }
  }, [actingApprovalId, bulkApprovalAction, loadPendingApprovals, pendingApprovals, reloadSessionData, resumeSession, t])

  // textarea 自适应高度
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [inputValue])

  // 键盘事件处理
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // 停止生成
  const handleStop = () => {
    stopGeneration()
    // 标记流式消息为完成
    setDisplayMessages((prev) =>
      prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
    )
  }

  // 重试
  const handleRetry = () => {
    // 移除最后一条错误消息
    setDisplayMessages((prev) => {
      const lastMsg = prev[prev.length - 1]
      if (lastMsg && lastMsg.status === 'error') {
        return prev.slice(0, -1)
      }
      return prev
    })
    retry()
  }

  // 加载中状态
  if (isLoadingSession) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 bg-bg-base">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
        <p className="mt-4 text-text-secondary">{t('chatSession.loadingSession')}</p>
      </div>
    )
  }

  // 错误状态
  if (sessionError) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 bg-bg-base">
        <AlertCircle size={48} className="text-error-400 mb-4" />
        <p className="text-text-primary mb-2">{t('chatSession.error.loadSession')}</p>
        <p className="text-text-secondary text-sm mb-4">{sessionError}</p>
        <Button onClick={() => router.push('/chat')} variant="secondary">
          {t('chatSession.backToChats')}
        </Button>
      </div>
    )
  }

  const liveProcessAnchorIndex = orderedMessages.findIndex(
    (m) => m.role === 'assistant' && m.isStreaming
  )

  const assistantAgentId = sessionMeta?.agentId || 'semibot'
  const assistantAgentName = sessionMeta?.agentId || 'Semibot'

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-base print:bg-white">
      <div className="border-b border-border-subtle bg-bg-surface print:hidden">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => router.push('/chat')}
                className="p-1 rounded-md text-text-tertiary hover:bg-interactive-hover hover:text-text-primary"
                aria-label={t('chatSession.backToChats')}
              >
                <ArrowLeft size={16} />
              </button>
              <h1 className="text-sm font-semibold text-text-primary truncate">
                {sessionMeta?.title || t('chatLayout.untitled')}
              </h1>
            </div>
            <p className="text-xs text-text-tertiary pl-7 mt-0.5">
              {t('chatSession.sessionLabel')} {sessionId.slice(0, 8)}...
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'px-2 py-1 rounded-full text-xs',
                sessionMeta?.status === 'active'
                  ? 'bg-success-500/10 text-success-500'
                  : 'bg-interactive-hover text-text-secondary'
              )}
            >
              {sessionMeta?.status || 'active'}
            </span>
          </div>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-6 print:overflow-visible print:px-0 print:py-0">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* 欢迎消息 */}
          {orderedMessages.length === 0 && (
            <div className="flex items-start gap-3">
              <AgentBotAvatar
                agentId={assistantAgentId}
                agentName={assistantAgentName}
                size={32}
                iconScale={0.52}
                className="flex-shrink-0"
              />
              <div className="bg-bg-elevated rounded-xl rounded-bl-sm px-4 py-3 border border-border-subtle">
                <p className="text-sm text-text-primary">
                  {t('chatSession.welcome')}
                </p>
              </div>
            </div>
          )}

          {orderedMessages.map((message, index) => {
            const resolvedProcessData = resolveProcessData(message)
            const isLiveAnchor = index === liveProcessAnchorIndex

            // 合并历史 + 实时过程数据到一个 ProcessCard
            const mergedThinking = isLiveAnchor
              ? (agent2uiState.thinking ?? resolvedProcessData?.thinking ?? null)
              : (resolvedProcessData?.thinking ?? null)
            const mergedPlan = isLiveAnchor
              ? (agent2uiState.plan ?? resolvedProcessData?.plan ?? null)
              : (resolvedProcessData?.plan ?? null)
            const mergedToolCalls = isLiveAnchor && agent2uiState.toolCalls.length > 0
              ? agent2uiState.toolCalls
              : (resolvedProcessData?.toolCalls ?? [])
            const mergedMessages = isLiveAnchor && agent2uiState.messages.length > 0
              ? agent2uiState.messages
              : (resolvedProcessData?.messages ?? [])
            const mergedIsThinking = isLiveAnchor && agent2uiState.isThinking
            const awaitingApproval = message.role === 'assistant' && isAwaitingApprovalMessage(message)

            const showProcessCard =
              message.role === 'assistant' &&
              (!!resolvedProcessData || (isLiveAnchor && hasProcessData))
            const hideAssistantBubble = awaitingApproval
            return (
              <div key={message.id}>
                {showProcessCard && (
                  <div className="mb-4 ml-11 max-w-[80%] print:hidden">
                    <ProcessCard
                      isActive={isLiveAnchor && isSending}
                      awaitingApproval={awaitingApproval}
                      thinking={mergedThinking}
                      isThinking={mergedIsThinking}
                      plan={mergedPlan}
                      toolCalls={mergedToolCalls}
                      messages={mergedMessages}
                      className="max-w-3xl"
                    />
                  </div>
                )}
                {!hideAssistantBubble && (
                  <MessageBubble
                    message={message}
                    locale={locale}
                    sessionId={sessionId}
                    sessionDocumentReferences={extractMessageScopedDocumentReferences(orderedMessages, index)}
                    assistantViewMode="report"
                    assistantAgentId={assistantAgentId}
                    assistantAgentName={assistantAgentName}
                  />
                )}
              </div>
            )
          })}

          {/* 执行过程卡片：没有 artifact 锚点时，使用 live 或 restored process trace 展示 */}
          {liveProcessAnchorIndex === -1 && ((
            isSending && hasProcessData
          ) || (
            !isSending && restoredProcessData
          )) && (
            <div className="mt-2 ml-11 max-w-[80%] print:hidden">
              <ProcessCard
                isActive={isSending}
                awaitingApproval={!isSending && restoredAwaitingApproval}
                thinking={isSending ? agent2uiState.thinking : (restoredProcessData?.thinking ?? null)}
                isThinking={isSending ? agent2uiState.isThinking : false}
                plan={isSending ? agent2uiState.plan : (restoredProcessData?.plan ?? null)}
                toolCalls={isSending ? agent2uiState.toolCalls : (restoredProcessData?.toolCalls ?? [])}
                messages={isSending ? agent2uiState.messages : (restoredProcessData?.messages ?? [])}
                className="max-w-3xl"
              />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 输入区 */}
      <div className="flex-shrink-0 border-t border-border-subtle bg-bg-surface print:hidden">
        <div className="max-w-3xl mx-auto p-4">
          {shouldShowApprovalNotice && (
            <div className="mb-3 rounded-xl border border-primary-500/30 bg-primary-500/5 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <ShieldAlert size={16} className="text-primary-500" />
                  {t('chatSession.pendingApprovals')} {pendingApprovals.length}
                </div>
                <div className="flex items-center gap-2">
                  {pendingApprovals.length > 0 && (
                    <>
                      <Button
                        size="xs"
                        variant="secondary"
                        loading={bulkApprovalAction === 'approve'}
                        disabled={!!actingApprovalId || !!bulkApprovalAction}
                        onClick={() => void handleBulkApprovalDecision('approve')}
                      >
                        {t('chatSession.approveAll')}
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        loading={bulkApprovalAction === 'reject'}
                        disabled={!!actingApprovalId || !!bulkApprovalAction}
                        onClick={() => void handleBulkApprovalDecision('reject')}
                      >
                        {t('chatSession.rejectAll')}
                      </Button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => void loadPendingApprovals()}
                    disabled={isLoadingApprovals}
                    className={clsx(
                      'inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary',
                      isLoadingApprovals && 'opacity-60'
                    )}
                  >
                    <RefreshCw size={12} className={clsx(isLoadingApprovals && 'animate-spin')} />
                    {t('common.refresh')}
                  </button>
                </div>
              </div>

              {approvalError && (
                <p className="mt-2 text-xs text-error-400">{approvalError}</p>
              )}

              {!approvalError && primaryNotice?.kind === 'awaiting_approval' && primaryNotice.message && (
                <p className="mt-2 text-xs text-text-secondary whitespace-pre-wrap break-words">
                  {primaryNotice.message}
                </p>
              )}

              <div className="mt-2 space-y-2">
                {visibleApprovals.map((approval) => (
                  <div
                    key={approval.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-elevated px-2 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs text-text-primary break-words">
                        {approval.summary || approval.reason || approval.toolName || approval.id}
                      </p>
                      <p className="text-[11px] text-text-tertiary break-words">
                        {approval.toolName && `${approval.toolName}`}
                        {approval.action && ` · ${approval.action}`}
                        {approval.target && ` · ${approval.target}`}
                        {(approval.toolName || approval.action || approval.target) && ' · '}
                        {t('chatSession.risk')} {approval.riskLevel}
                      </p>
                      <p className="text-[11px] text-text-tertiary">
                        {approval.id}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="secondary"
                        loading={actingApprovalId === `${approval.id}:approve`}
                        disabled={!!actingApprovalId || !!bulkApprovalAction}
                        leftIcon={<Check size={12} />}
                        onClick={() => void handleApprovalDecision(approval.id, 'approve')}
                      >
                        {t('chatSession.approve')}
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        loading={actingApprovalId === `${approval.id}:reject`}
                        disabled={!!actingApprovalId || !!bulkApprovalAction}
                        leftIcon={<X size={12} />}
                        onClick={() => void handleApprovalDecision(approval.id, 'reject')}
                      >
                        {t('chatSession.reject')}
                      </Button>
                    </div>
                  </div>
                ))}
                {hiddenApprovalCount > 0 && (
                  <p className="text-[11px] text-text-tertiary px-1">
                    {t('chatSession.moreApprovalsHint', { count: hiddenApprovalCount })}
                  </p>
                )}
              </div>

              <p className="mt-2 text-[11px] text-text-tertiary">
                {t('chatSession.approvalHint')}
              </p>
            </div>
          )}

          {/* 错误重试提示 */}
          {displayMessages.length > 0 &&
            displayMessages[displayMessages.length - 1].status === 'error' && (
              <div className="flex items-center justify-center gap-2 mb-3 text-sm text-error-400">
                <AlertCircle size={16} />
                <span>{t('chatSession.sendFailed')}</span>
                <button
                  onClick={handleRetry}
                  className="flex items-center gap-1 text-primary-400 hover:underline"
                >
                  <RefreshCw size={14} />
                  {t('common.retry')}
                </button>
              </div>
            )}
          {approvalError && pendingApprovals.length === 0 && (
            <InlineErrorAlert className="mb-3 px-3 py-2 text-xs" message={approvalError} />
          )}
          {sessionWarning && (
            <div className="mb-3 flex items-center gap-2">
              <InlineErrorAlert className="flex-1 px-3 py-2 text-xs" message={sessionWarning} />
              {sessionMeta?.status === 'active' && (
                <button
                  type="button"
                  onClick={() => {
                    setSessionWarning(null)
                    resumeAttemptedRef.current = false
                    void resumeSession()
                  }}
                  className="shrink-0 rounded px-2 py-1 text-xs text-primary-500 hover:text-primary-400 hover:bg-primary-500/10 transition-colors"
                >
                  <RefreshCw size={12} className="inline mr-1" />
                  {t('common.retry')}
                </button>
              )}
            </div>
          )}
          {uploadError && (
            <InlineErrorAlert className="mb-3 px-3 py-2 text-xs" message={uploadError} />
          )}

          <div
            className={clsx(
              'flex flex-col rounded-xl',
              'bg-bg-elevated border border-border-default',
              'focus-within:border-primary-500 focus-within:shadow-glow-primary',
              'transition-all duration-fast'
            )}
          >
            {/* 文件预览条 */}
            {hasFiles && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {files.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-bg-base border border-border-subtle text-xs text-text-secondary"
                  >
                    {f.preview ? (
                      // User-selected local previews are transient blob/data URLs; next/image is not a good fit here.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.preview} alt={f.file.name} className="w-6 h-6 rounded object-cover" />
                    ) : (
                      <FileText size={14} className="text-text-tertiary" />
                    )}
                    <span className="max-w-[120px] truncate">{f.file.name}</span>
                    <button
                      onClick={() => removeFile(f.id)}
                      className="p-0.5 rounded hover:bg-interactive-hover text-text-tertiary hover:text-text-primary"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 p-3">
              {/* 隐藏的文件输入 */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={CHAT_UPLOAD_ALLOWED_EXTENSIONS.join(',')}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) {
                    const error = addFiles(e.target.files)
                    setUploadError(error)
                    if (error) setTimeout(() => setUploadError(null), 3000)
                  }
                  e.target.value = ''
                }}
              />

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isSending || isAwaitingApprovalActive}
                className={clsx(
                  'p-2 rounded-lg',
                  'text-text-tertiary hover:text-text-primary hover:bg-interactive-hover',
                  'transition-colors duration-fast',
                  'disabled:opacity-50'
                )}
                aria-label={t('chatSession.addAttachment')}
              >
                <Paperclip size={20} />
              </button>

              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isAwaitingApprovalActive ? t('chatSession.pendingApprovals') : t('chatSession.inputPlaceholder')}
                rows={1}
                disabled={isSending || isAwaitingApprovalActive}
                className={clsx(
                  'flex-1 resize-none bg-transparent',
                  'text-text-primary placeholder:text-text-tertiary',
                  'focus:outline-none',
                  'min-h-[24px] max-h-[200px]',
                  'disabled:opacity-50'
                )}
                style={{
                  overflowY: textareaRef.current && textareaRef.current.scrollHeight > 200 ? 'auto' : 'hidden',
                }}
              />

              <button
                className={clsx(
                  'p-2 rounded-lg',
                  'text-text-tertiary hover:text-text-primary hover:bg-interactive-hover',
                  'transition-colors duration-fast'
                )}
                aria-label={t('chatSession.voiceInput')}
              >
                <Mic size={20} />
              </button>

              <Button
                size="sm"
                onClick={isStopActionActive ? handleStop : handleSendMessage}
                disabled={isAwaitingApprovalActive || (!isStopActionActive && !inputValue.trim() && !hasFiles)}
                leftIcon={
                  isAwaitingApprovalActive
                    ? <ShieldAlert size={16} />
                    : isStopActionActive
                      ? <StopCircle size={16} />
                      : <Send size={16} />
                }
              >
                {isAwaitingApprovalActive ? t('chatSession.pendingApprovals') : isStopActionActive ? t('chatSession.stop') : t('chatSession.send')}
              </Button>
            </div>
          </div>

          <p className="text-xs text-text-tertiary text-center mt-2">
            {t('chatSession.keyboardHint')}
          </p>
        </div>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: DisplayMessage
  locale: string
  sessionId: string
  sessionDocumentReferences: SessionDocumentReference[]
  assistantViewMode: AssistantViewMode
  assistantAgentId?: string
  assistantAgentName?: string
}

function MessageBubble({
  message,
  locale,
  sessionId,
  sessionDocumentReferences,
  assistantViewMode,
  assistantAgentId,
  assistantAgentName,
}: MessageBubbleProps) {
  const { t } = useLocale()
  const isUser = message.role === 'user'
  const displayContent = stripInjectedDocumentBlocks(message.content)
  const attachments = (message.metadata?.attachments ?? []) as Array<{
    filename: string
    size: number
    mimeType: string
    isImage: boolean
  }>

  return (
    <div
      className={clsx('flex items-start gap-3', isUser && 'flex-row-reverse')}
    >
      {/* 头像 */}
      <div
        className={clsx(
          'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
          isUser ? 'bg-primary-500' : ''
        )}
      >
        {isUser ? (
          <User size={16} className="text-neutral-950" />
        ) : (
          <AgentBotAvatar
            agentId={assistantAgentId}
            agentName={assistantAgentName}
            size={32}
            iconScale={0.52}
          />
        )}
      </div>

      {/* 消息内容 */}
      <div
        className={clsx(
          'px-4 py-3 rounded-xl',
          'animate-fade-in-up',
          isUser
            ? 'max-w-[80%] bg-primary-600 text-neutral-0 rounded-br-sm'
            : assistantViewMode === 'report'
              ? 'w-full max-w-[min(100%,960px)] rounded-2xl border border-border-subtle bg-bg-surface dark:border-[rgba(255,255,255,0.08)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] px-5 py-4 text-text-primary shadow-sm dark:shadow-[0_18px_48px_rgba(0,0,0,0.28)]'
              : 'max-w-[80%] bg-bg-elevated text-text-primary border border-border-subtle rounded-bl-sm',
          message.status === 'error' && 'border-error-400'
        )}
      >
        {isUser ? (
          <>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {displayContent}
            </p>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {attachments.map((att) => (
                  <div
                    key={att.filename}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary-700/50 text-xs text-primary-100"
                  >
                    {att.isImage ? <ImageIcon size={12} /> : <FileText size={12} />}
                    <span className="max-w-[100px] truncate">{att.filename}</span>
                    <span className="text-primary-300">({formatFileSize(att.size)})</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : message.fileData ? (
          <FileDownload data={message.fileData} />
        ) : (
          <AssistantMessageCard
            message={message}
            sessionId={sessionId}
            sessionDocumentReferences={sessionDocumentReferences}
            viewMode={assistantViewMode}
            assistantAgentId={assistantAgentId}
            assistantAgentName={assistantAgentName}
          />
        )}
        <div
          className={clsx(
            'flex items-center gap-2 mt-2 text-xs',
            isUser ? 'text-primary-200 justify-end' : 'text-text-tertiary'
          )}
        >
          <span>
            {message.timestamp.toLocaleTimeString(locale, TIME_FORMAT_OPTIONS)}
          </span>
          {isUser && message.status === 'sending' && <span>{t('chatSession.messageStatus.sending')}</span>}
          {isUser && message.status === 'sent' && <span>{t('chatSession.messageStatus.sent')}</span>}
          {isUser && message.status === 'error' && (
            <span className="text-error-400">{t('chatSession.messageStatus.failed')}</span>
          )}
        </div>
      </div>
    </div>
  )
}

interface AssistantMessageCardProps {
  message: DisplayMessage
  sessionId: string
  sessionDocumentReferences: SessionDocumentReference[]
  viewMode: AssistantViewMode
  assistantAgentId?: string
  assistantAgentName?: string
}

function AssistantMessageCard({
  message,
  sessionId,
  sessionDocumentReferences,
  viewMode,
  assistantAgentId,
  assistantAgentName,
}: AssistantMessageCardProps) {
  const { t } = useLocale()
  const { openDetailContent } = useLayoutStore()
  const awaitingApproval = String(message.metadata?.status || '').trim().toLowerCase() === 'awaiting_approval'
  const displayContent = stripInjectedDocumentBlocks(message.content)
  const directMessageReferences = useMemo(
    () => extractDirectMessageDocumentReferences(message),
    [message]
  )

  const resolveServerScopedReferences = useCallback(async (): Promise<SessionDocumentReference[]> => {
    const response = await apiClient.get<ApiResponse<ApiMessage[]>>(`/sessions/${sessionId}/messages`)
    if (!response.success || !response.data) return []
    const assistantMessage = response.data.find((item) => item.id === message.id)
    const directRefs = assistantMessage ? extractDirectMessageDocumentReferences({
      metadata: assistantMessage.metadata && typeof assistantMessage.metadata === 'object'
        ? (assistantMessage.metadata as Record<string, unknown>)
        : undefined,
    }) : []
    if (directRefs.length > 0) return directRefs
    return extractDocumentReferencesFromApiMessages(response.data, message.id)
  }, [sessionId, message.id])

  const handleCopyBody = useCallback(async () => {
    await navigator.clipboard.writeText(displayContent)
  }, [displayContent])

  const handleExportMarkdown = useCallback(() => {
    const blob = new Blob([displayContent], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `semibot-response-${message.id}.md`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [displayContent, message.id])

  const handleEvidenceClick = useCallback(async (href: string, label: string) => {
    const parsed = parseEvidenceHref(href)
    if (!parsed) return

    let candidateReferences = directMessageReferences.length > 0
      ? directMessageReferences
      : sessionDocumentReferences
    if (candidateReferences.length === 0) {
      candidateReferences = await resolveServerScopedReferences()
    }

    let reference: SessionDocumentReference | undefined
    if (parsed.docId) {
      reference = candidateReferences.find((item) => item.docId === parsed.docId)
    } else if (candidateReferences.length === 1) {
      reference = candidateReferences[0]
    }

    if (!reference) {
      try {
        const fallbackChunkId = parsed.chunkIds[0]
        if (!fallbackChunkId) throw new Error('missing chunk id')
        const fallback = await apiClient.get<ApiResponse<SessionDocumentChunk>>(`/sessions/${sessionId}/document-chunk`, {
          params: { chunkId: fallbackChunkId },
        })
        if (fallback.success && fallback.data) {
          openDetailContent({
            kind: 'document-chunk',
            title: label || '文档片段',
            sessionId,
            docId: fallback.data.docId,
            docTitle: fallback.data.docId,
            version: fallback.data.version,
            totalChunks: 0,
            chunks: [fallback.data],
            selectedChunkId: fallback.data.chunkId,
          })
          return
        }
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: SessionDocumentChunkError } }).response
        const responseReferences = response?.data?.error?.details?.references
        if (Array.isArray(responseReferences) && responseReferences.length > 0) {
          candidateReferences = responseReferences
        }
      }

      openDetailContent({
        kind: 'markdown',
        title: '文档片段',
        filename: 'chunk-resolution.md',
        content: buildChunkAmbiguityMarkdown(parsed.chunkIds, candidateReferences),
      })
      return
    }

    openDetailContent({
      kind: 'markdown',
      title: label || '文档片段',
      filename: `${reference.docId}.chunk.md`,
      content: '# 正在加载文档片段…',
    })

    try {
      const requestedChunkIds = collectAdjacentChunkIds(parsed.chunkIds, reference.chunkCount)
      const responses = await Promise.all(
        requestedChunkIds.map((chunkId) =>
          apiClient.get<ApiResponse<SessionDocumentChunk>>(`/sessions/${sessionId}/document-chunk`, {
            params: {
              docId: reference?.docId,
              version: reference?.version,
              chunkId,
            },
          })
        )
      )

      const chunks = responses
        .filter((response) => response.success && response.data)
        .map((response) => response.data as SessionDocumentChunk)

      if (chunks.length === 0) {
        openDetailContent({
          kind: 'markdown',
          title: label || '文档片段',
          filename: `${reference.docId}.chunk.md`,
          content: [
            '# 文档片段未找到',
            '',
            `- 文档: \`${reference.docId}\``,
            `- 请求片段: ${parsed.chunkIds.map((item) => `\`${item}\``).join(', ')}`,
          ].join('\n'),
        })
        return
      }

      openDetailContent({
        kind: 'document-chunk',
        title: label || `${reference.title} 片段`,
        sessionId,
        docId: reference.docId,
        docTitle: reference.title,
        version: reference.version,
        totalChunks: reference.chunkCount,
        chunks,
        selectedChunkId: parsed.chunkIds[0] || chunks[0]?.chunkId || '',
      })
    } catch (error) {
      openDetailContent({
        kind: 'markdown',
        title: label || '文档片段',
        filename: `${reference.docId}.chunk.md`,
        content: [
          '# 文档片段加载失败',
          '',
          '```text',
          error instanceof Error ? error.message : String(error),
          '```',
        ].join('\n'),
      })
    }
  }, [directMessageReferences, openDetailContent, resolveServerScopedReferences, sessionDocumentReferences, sessionId])

  return (
    <div className="text-sm">
      <div
        className={clsx(
          'mb-4 flex flex-wrap items-center justify-between gap-3 pb-2.5',
          viewMode === 'report' && 'rounded-2xl border border-border-subtle dark:border-[rgba(255,255,255,0.08)] bg-bg-elevated dark:bg-[rgba(10,10,10,0.46)] px-4 pt-3 print:border-0 print:bg-transparent print:px-0 print:pb-2'
        )}
      >
        <div className="flex items-center gap-3">
          <AgentBotAvatar
            agentId={assistantAgentId}
            agentName={assistantAgentName}
            size={32}
            iconScale={0.5}
          />
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-text-tertiary">
              {t('chatSession.responseLabel')}
            </p>
            <p className="text-[15px] font-medium leading-6 text-text-primary">
              {awaitingApproval
                ? t('chatSession.awaitingApprovalLabel')
                : message.isStreaming
                  ? t('chatSession.generatingLabel')
                  : t('chatSession.readyLabel')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          {!awaitingApproval && (
            <>
          <button type="button" onClick={() => void handleCopyBody()} className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary dark:hover:border-[rgba(255,255,255,0.16)]">
            <Copy size={12} />
            {t('chatSession.copyBodyOnly')}
          </button>
          <button type="button" onClick={handleExportMarkdown} className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary dark:hover:border-[rgba(255,255,255,0.16)]">
            <Download size={12} />
            {t('chatSession.exportMarkdown')}
          </button>
            </>
          )}
        </div>
      </div>

      <MarkdownBlock
        data={{ content: displayContent }}
        variant={viewMode}
        onEvidenceClick={handleEvidenceClick}
      />
      {message.isStreaming && (
        <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-primary-400 align-middle" />
      )}
      {!message.isStreaming && displayContent && (
        <CitationList content={displayContent} variant={viewMode} initiallyExpanded />
      )}
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function isTransientLoadFailedMessage(message: string): boolean {
  const text = String(message || '')
  return (
    text.includes('Load failed') ||
    text.includes('Failed to fetch') ||
    text.includes('NetworkError') ||
    text.includes('fetch failed') ||
    text.includes('This operation was aborted')
  )
}
