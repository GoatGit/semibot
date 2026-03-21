'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import Image from 'next/image'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import clsx from 'clsx'
import { Send, Paperclip, Mic, StopCircle, User, RefreshCw, AlertCircle, X, FileText, Image as ImageIcon, ArrowLeft, ShieldAlert, Check, Copy, Download } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { MarkdownBlock } from '@/components/agent2ui/text/MarkdownBlock'
import { CitationList, extractCitations } from '@/components/agent2ui/text/CitationList'
import { ProcessCard } from '@/components/agent2ui/process/ProcessCard'
import { FileDownload } from '@/components/agent2ui/media/FileDownload'
import { useChat } from '@/hooks/useChat'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useSessionStore } from '@/stores/sessionStore'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
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

type AssistantViewMode = 'report'

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
      const data = msg.data as ToolResultData
      const idx = toolCalls.findIndex((tc) => tc.toolName === data.toolName && tc.status === 'calling')
      if (idx >= 0) {
        toolCalls[idx] = {
          ...toolCalls[idx],
          status: data.success ? 'success' : 'error',
          result: data.result,
          error: data.error,
          duration: data.duration,
        }
      } else {
        toolCalls.push({
          toolName: data.toolName,
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
        arguments: data.arguments,
        status: data.status as ToolCallData['status'],
        duration: data.duration,
      })
      continue
    }
    if (msg.type === 'mcp_result') {
      const data = msg.data as McpResultData
      const idx = toolCalls.findIndex((tc) => tc.toolName === data.toolName && tc.status === 'calling')
      if (idx >= 0) {
        toolCalls[idx] = {
          ...toolCalls[idx],
          status: data.success ? 'success' : 'error',
          result: data.result,
          error: data.error,
          duration: data.duration,
        }
      } else {
        toolCalls.push({
          toolName: data.toolName,
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

function toCachedDisplayMessages(messages: DisplayMessage[]): CachedDisplayMessage[] {
  return messages
    .filter((message) => !message.isStreaming && message.status !== 'sending')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      status: message.status,
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
        metadata,
        fileData,
        processData,
      } satisfies DisplayMessage
    })
  return restored.filter((item): item is DisplayMessage => item !== null)
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

function normalizePendingApprovals(raw: unknown, sessionId: string): PendingApproval[] {
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
    .filter((item) => !item.eventId || item.eventId.startsWith(`${sessionId}:`))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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

  const [inputValue, setInputValue] = useState('')
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [sessionMeta, setSessionMeta] = useState<Session | null>(null)
  const [isLoadingSession, setIsLoadingSession] = useState(true)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])
  const [isLoadingApprovals, setIsLoadingApprovals] = useState(false)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null)
  const [bulkApprovalAction, setBulkApprovalAction] = useState<'approve' | 'reject' | null>(null)
  const isLoadingApprovalsRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeAssistantRequestIdRef = useRef<string | null>(null)
  const latestAgent2UIMessagesRef = useRef<Agent2UIMessage[]>([])
  const historyCacheKey = `semibot:chat-history:${sessionId}`

  const { files, addFiles, removeFile, clearFiles, hasFiles } = useFileUpload()

  const { setCurrentSession: setStoreSession } = useSessionStore()

  const loadPendingApprovals = useCallback(async () => {
    if (isLoadingApprovalsRef.current) return
    isLoadingApprovalsRef.current = true
    try {
      setIsLoadingApprovals(true)
      const response = await apiClient.get<unknown>('/approvals', {
        params: { status: 'pending', limit: 100 },
      })
      setPendingApprovals(normalizePendingApprovals(response, sessionId))
      setApprovalError(null)
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : t('chatSession.error.loadApprovals'))
    } finally {
      isLoadingApprovalsRef.current = false
      setIsLoadingApprovals(false)
    }
  }, [sessionId, t])

  // 使用 useChat hook 进行真实对话
  const {
    agent2uiState,
    isSending,
    sendMessage,
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
              id: data.messageId,
              processData: hasProcessSnapshot ? processSnapshot : m.processData,
            }
          })

        return next
      })
      activeAssistantRequestIdRef.current = null
      resetChatState()
      void loadPendingApprovals()
    },
    onError: (error) => {
      console.error('[Chat] 错误:', error)
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

  // 加载会话数据
  useEffect(() => {
    const loadSession = async () => {
      try {
        setIsLoadingSession(true)
        setSessionError(null)

        // 并行获取会话信息和历史消息
        const [sessionResponse, messagesResponse] = await Promise.all([
          fetchWithRetry(() => apiClient.get<ApiResponse<Session>>(`/sessions/${sessionId}`)),
          fetchWithRetry(() => apiClient.get<ApiResponse<ApiMessage[]>>(`/sessions/${sessionId}/messages`)),
        ])

        if (!sessionResponse.success || !sessionResponse.data) {
          throw new Error(sessionResponse.error?.message ?? t('chatSession.error.loadSession'))
        }

        const session = sessionResponse.data
        setSessionMeta(session)
        setStoreSession({
          id: session.id,
          agentId: session.agentId,
          title: session.title ?? t('chatSession.newChat'),
          status: session.status,
          messages: [],
          createdAt: session.createdAt,
          updatedAt: session.createdAt,
        })

        if (messagesResponse.success && messagesResponse.data) {
          const historyMessages: DisplayMessage[] = messagesResponse.data
            .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
            .map((m: ApiMessage) => {
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
                metadata,
                fileData,
                processData,
              }
            })

          if (historyMessages.length > 0) {
            setDisplayMessages(historyMessages)
          }
        }
      } catch (error) {
        console.error('[Chat] 加载会话失败:', error)
        setSessionError(
          error instanceof Error ? error.message : t('chatSession.error.loadSession')
        )
      } finally {
        setIsLoadingSession(false)
      }
    }

    if (sessionId) {
      loadSession()
    }
  }, [sessionId, setStoreSession, t])

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
    if (!pendingInitialMessage || isLoadingSession || initialMessageSentRef.current || isSending) return
    initialMessageSentRef.current = true

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
    }
    setDisplayMessages((prev) => [...prev, userMessage])
    sendMessage(pendingInitialMessage).catch((error) => {
      console.error('[Chat] 自动发送初始消息失败:', error)
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, status: 'error' as const } : m
        )
      )
    })
  }, [pendingInitialMessage, isLoadingSession, isSending, sessionId, router, sendMessage])

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
      await apiClient.post(`/approvals/${approvalId}/${endpoint}`, {})
      setApprovalError(null)
    } finally {
      setActingApprovalId(null)
      await loadPendingApprovals()
    }
  }, [actingApprovalId, bulkApprovalAction, loadPendingApprovals])

  const handleBulkApprovalDecision = useCallback(async (decision: 'approve' | 'reject') => {
    if (actingApprovalId || bulkApprovalAction || pendingApprovals.length === 0) return
    setBulkApprovalAction(decision)
    try {
      const endpoint = decision === 'approve' ? 'approve' : 'reject'
      await Promise.all(
        pendingApprovals.map((approval) =>
          apiClient.post(`/approvals/${approval.id}/${endpoint}`, {})
        )
      )
      setDisplayMessages((prev) => [
        ...prev,
        {
          id: `approval-batch-${Date.now()}`,
          role: 'assistant',
          content: t('chatSession.bulkDone', { count: pendingApprovals.length, action: decision === 'approve' ? t('chatSession.approve') : t('chatSession.reject') }),
          timestamp: new Date(),
          status: 'sent',
        },
      ])
      await loadPendingApprovals()
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : t('chatSession.error.bulkApproval'))
    } finally {
      setBulkApprovalAction(null)
    }
  }, [actingApprovalId, bulkApprovalAction, loadPendingApprovals, pendingApprovals, t])

  // 键盘事件处理
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
              <div className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0">
                <Image src="/semibot-logo.png" alt="Semibot logo" width={32} height={32} />
              </div>
              <div className="bg-bg-elevated rounded-xl rounded-bl-sm px-4 py-3 border border-border-subtle">
                <p className="text-sm text-text-primary">
                  {t('chatSession.welcome')}
                </p>
              </div>
            </div>
          )}

          {orderedMessages.map((message, index) => {
            const resolvedProcessData = resolveProcessData(message)
            const showHistoricalProcessCard =
              message.role === 'assistant' &&
              !!resolvedProcessData
            const showLiveProcessCard =
              isSending &&
              hasProcessData &&
              index === liveProcessAnchorIndex
            return (
              <div key={message.id}>
                {showHistoricalProcessCard && resolvedProcessData && (
                  <div className="mb-4 ml-11 max-w-[80%] print:hidden">
                    <ProcessCard
                      isActive={false}
                      thinking={resolvedProcessData.thinking}
                      isThinking={false}
                      plan={resolvedProcessData.plan}
                      toolCalls={resolvedProcessData.toolCalls}
                      messages={resolvedProcessData.messages}
                      className="max-w-3xl"
                    />
                  </div>
                )}
                {showLiveProcessCard && (
                  <div className="mb-4 ml-11 max-w-[80%] print:hidden">
                    <ProcessCard
                      isActive={isSending}
                      thinking={agent2uiState.thinking}
                      isThinking={agent2uiState.isThinking}
                      plan={agent2uiState.plan}
                      toolCalls={agent2uiState.toolCalls}
                      messages={agent2uiState.messages}
                      className="max-w-3xl"
                    />
                  </div>
                )}
                <MessageBubble
                  message={message}
                  locale={locale}
                  assistantViewMode="report"
                />
              </div>
            )
          })}

          {/* 执行过程卡片：尚无 assistant 消息时显示在末尾（早期思考阶段） */}
          {isSending && hasProcessData && liveProcessAnchorIndex === -1 && (
            <div className="mt-2 ml-11 max-w-[80%] print:hidden">
              <ProcessCard
                isActive={isSending}
                thinking={agent2uiState.thinking}
                isThinking={agent2uiState.isThinking}
                plan={agent2uiState.plan}
                toolCalls={agent2uiState.toolCalls}
                messages={agent2uiState.messages}
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
          {pendingApprovals.length > 0 && (
            <div className="mb-3 rounded-xl border border-primary-500/30 bg-primary-500/5 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <ShieldAlert size={16} className="text-primary-500" />
                  {t('chatSession.pendingApprovals')} {pendingApprovals.length}
                </div>
                <div className="flex items-center gap-2">
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

            <div className="flex items-end gap-3 p-3">
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
                disabled={isSending}
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
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('chatSession.inputPlaceholder')}
                rows={1}
                disabled={isSending}
                className={clsx(
                  'flex-1 resize-none bg-transparent',
                  'text-text-primary placeholder:text-text-tertiary',
                  'focus:outline-none',
                  'min-h-[24px] max-h-[200px]',
                  'disabled:opacity-50'
                )}
                style={{
                  height: 'auto',
                  overflowY: inputValue.split('\n').length > 5 ? 'auto' : 'hidden',
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
                onClick={isSending ? handleStop : handleSendMessage}
                disabled={!isSending && !inputValue.trim() && !hasFiles}
                leftIcon={isSending ? <StopCircle size={16} /> : <Send size={16} />}
              >
                {isSending ? t('chatSession.stop') : t('chatSession.send')}
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
  assistantViewMode: AssistantViewMode
}

function MessageBubble({
  message,
  locale,
  assistantViewMode,
}: MessageBubbleProps) {
  const { t } = useLocale()
  const isUser = message.role === 'user'
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
          <Image src="/semibot-logo.png" alt="Semibot logo" width={32} height={32} className="rounded-full" />
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
              {message.content}
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
            viewMode={assistantViewMode}
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
  viewMode: AssistantViewMode
}

function AssistantMessageCard({
  message,
  viewMode,
}: AssistantMessageCardProps) {
  const { t } = useLocale()

  const handleCopyBody = useCallback(async () => {
    await navigator.clipboard.writeText(message.content)
  }, [message.content])

  const handleExportMarkdown = useCallback(() => {
    const blob = new Blob([message.content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `semibot-response-${message.id}.md`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, [message.content, message.id])

  return (
    <div className="text-sm">
      <div
        className={clsx(
          'mb-4 flex flex-wrap items-center justify-between gap-3 pb-2.5',
          viewMode === 'report' && 'rounded-2xl border border-border-subtle dark:border-[rgba(255,255,255,0.08)] bg-bg-elevated dark:bg-[rgba(10,10,10,0.46)] px-4 pt-3 print:border-0 print:bg-transparent print:px-0 print:pb-2'
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-500/12 ring-1 ring-primary-500/20">
            <Image src="/semibot-logo.png" alt="Semibot logo" width={20} height={20} />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-text-tertiary">
              {t('chatSession.responseLabel')}
            </p>
            <p className="text-[15px] font-medium leading-6 text-text-primary">
              {message.isStreaming ? t('chatSession.generatingLabel') : t('chatSession.readyLabel')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <button type="button" onClick={() => void handleCopyBody()} className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary dark:hover:border-[rgba(255,255,255,0.16)]">
            <Copy size={12} />
            {t('chatSession.copyBodyOnly')}
          </button>
          <button type="button" onClick={handleExportMarkdown} className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary dark:hover:border-[rgba(255,255,255,0.16)]">
            <Download size={12} />
            {t('chatSession.exportMarkdown')}
          </button>
        </div>
      </div>

      <MarkdownBlock data={{ content: message.content }} variant={viewMode} />
      {message.isStreaming && (
        <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-primary-400 align-middle" />
      )}
      {!message.isStreaming && message.content && (
        <CitationList content={message.content} variant={viewMode} initiallyExpanded />
      )}
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
