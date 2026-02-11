'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import clsx from 'clsx'
import { Send, Paperclip, Mic, StopCircle, Bot, User, RefreshCw, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { MarkdownBlock } from '@/components/agent2ui/text/MarkdownBlock'
import { ProcessCard } from '@/components/agent2ui/process/ProcessCard'
import { useChat } from '@/hooks/useChat'
import { useSessionStore } from '@/stores/sessionStore'
import { apiClient } from '@/lib/api'
import type { ApiResponse, Session, Message as ApiMessage } from '@/types'
import {
  TIME_FORMAT_OPTIONS,
  DEFAULT_LOCALE,
} from '@/constants/config'

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  status?: 'sending' | 'sent' | 'error'
  isStreaming?: boolean
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
  const searchParams = useSearchParams()
  const sessionId = params.sessionId as string
  const initialMessage = searchParams.get('initialMessage')

  const [inputValue, setInputValue] = useState('')
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [isLoadingSession, setIsLoadingSession] = useState(true)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { setCurrentSession: setStoreSession } = useSessionStore()

  // 使用 useChat hook 进行真实对话
  const {
    agent2uiState,
    isSending,
    sendMessage,
    stopGeneration,
    retry,
  } = useChat({
    sessionId,
    onMessage: (message) => {
      // 处理流式文本消息
      if (message.type === 'text' || message.type === 'markdown') {
        const content = (message.data as { content: string }).content
        setDisplayMessages((prev) => {
          // 查找是否已有流式消息
          const lastMsg = prev[prev.length - 1]
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
            // 追加内容到流式消息
            return prev.map((m, i) =>
              i === prev.length - 1
                ? { ...m, content: m.content + content }
                : m
            )
          } else {
            // 创建新的流式消息
            return [
              ...prev,
              {
                id: `stream-${Date.now()}`,
                role: 'assistant' as const,
                content: content,
                timestamp: new Date(),
                isStreaming: true,
              },
            ]
          }
        })
      }
    },
    onComplete: (data) => {
      // 标记流式消息完成
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.isStreaming
            ? { ...m, isStreaming: false, id: data.messageId }
            : m
        )
      )
    },
    onError: (error) => {
      console.error('[Chat] 错误:', error)
      // 可以在这里显示错误消息
      setDisplayMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: 'assistant' as const,
          content: `抱歉，发生了错误: ${error.message}`,
          timestamp: new Date(),
          status: 'error',
        },
      ])
    },
  })

  // 加载会话数据
  useEffect(() => {
    const loadSession = async () => {
      try {
        setIsLoadingSession(true)
        setSessionError(null)

        // 获取会话信息
        const sessionResponse = await apiClient.get<ApiResponse<Session>>(
          `/sessions/${sessionId}`
        )

        if (!sessionResponse.success || !sessionResponse.data) {
          throw new Error(sessionResponse.error?.message ?? '加载会话失败')
        }

        const session = sessionResponse.data
        setStoreSession({
          id: session.id,
          agentId: session.agentId,
          title: session.title ?? '新对话',
          status: session.status,
          messages: [],
          createdAt: session.createdAt,
          updatedAt: session.createdAt,
        })

        // 获取历史消息
        const messagesResponse = await apiClient.get<ApiResponse<ApiMessage[]>>(
          `/sessions/${sessionId}/messages`
        )

        if (messagesResponse.success && messagesResponse.data) {
          const historyMessages: DisplayMessage[] = messagesResponse.data
            .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
            .map((m: { id: string; role: string; content: string; createdAt: string }) => ({
              id: m.id,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              timestamp: new Date(m.createdAt),
              status: 'sent' as const,
            }))

          setDisplayMessages(historyMessages)
        }
      } catch (error) {
        console.error('[Chat] 加载会话失败:', error)
        setSessionError(
          error instanceof Error ? error.message : '加载会话失败'
        )
      } finally {
        setIsLoadingSession(false)
      }
    }

    if (sessionId) {
      loadSession()
    }
  }, [sessionId, setStoreSession])

  // 自动发送 initialMessage（从新建会话页面跳转过来时）
  const initialMessageSentRef = useRef(false)
  useEffect(() => {
    if (!initialMessage || isLoadingSession || initialMessageSentRef.current || isSending) return
    initialMessageSentRef.current = true

    // 清除 URL 参数，避免刷新重复发送
    router.replace(`/chat/${sessionId}`, { scroll: false })

    const userMessage: DisplayMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: initialMessage,
      timestamp: new Date(),
      status: 'sent',
    }
    setDisplayMessages((prev) => [...prev, userMessage])
    sendMessage(initialMessage).catch((error) => {
      console.error('[Chat] 自动发送初始消息失败:', error)
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, status: 'error' as const } : m
        )
      )
    })
  }, [initialMessage, isLoadingSession, isSending, sessionId, router, sendMessage])

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
    }

    setDisplayMessages((prev) => [...prev, userMessage])
    const messageContent = inputValue.trim()
    setInputValue('')

    try {
      // 标记用户消息为已发送
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, status: 'sent' as const } : m
        )
      )

      // 发送消息到 API
      await sendMessage(messageContent)
    } catch (error) {
      console.error('[Chat] 发送失败:', error)
      setDisplayMessages((prev) =>
        prev.map((m) =>
          m.id === userMessage.id ? { ...m, status: 'error' as const } : m
        )
      )
    }
  }

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
        <p className="mt-4 text-text-secondary">加载会话中...</p>
      </div>
    )
  }

  // 错误状态
  if (sessionError) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 bg-bg-base">
        <AlertCircle size={48} className="text-error-400 mb-4" />
        <p className="text-text-primary mb-2">加载会话失败</p>
        <p className="text-text-secondary text-sm mb-4">{sessionError}</p>
        <Button onClick={() => router.push('/chat')} variant="secondary">
          返回会话列表
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* 欢迎消息 */}
          {displayMessages.length === 0 && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                <Bot size={16} className="text-primary-400" />
              </div>
              <div className="bg-bg-elevated rounded-xl rounded-bl-sm px-4 py-3 border border-border-subtle">
                <p className="text-sm text-text-primary">
                  您好！我是您的 AI 助手。有什么我可以帮助您的吗？
                </p>
              </div>
            </div>
          )}

          {displayMessages.map((message, index) => (
            <div key={message.id}>
              {/* 执行过程卡片：显示在流式 assistant 消息的上方 */}
              {isSending && message.isStreaming && message.role === 'assistant' && (
                <div className="mb-4">
                  <ProcessCard
                    isActive={isSending}
                    thinking={agent2uiState.thinking}
                    isThinking={agent2uiState.isThinking}
                    plan={agent2uiState.plan}
                    toolCalls={agent2uiState.toolCalls}
                    className="max-w-3xl"
                  />
                </div>
              )}
              <MessageBubble message={message} />
            </div>
          ))}

          {/* 执行过程卡片：尚无流式消息时显示在末尾 */}
          {isSending && !displayMessages.some((m) => m.isStreaming) && (
            <div className="mt-2">
              <ProcessCard
                isActive={isSending}
                thinking={agent2uiState.thinking}
                isThinking={agent2uiState.isThinking}
                plan={agent2uiState.plan}
                toolCalls={agent2uiState.toolCalls}
                className="max-w-3xl"
              />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 输入区 */}
      <div className="flex-shrink-0 border-t border-border-subtle bg-bg-surface">
        <div className="max-w-3xl mx-auto p-4">
          {/* 错误重试提示 */}
          {displayMessages.length > 0 &&
            displayMessages[displayMessages.length - 1].status === 'error' && (
              <div className="flex items-center justify-center gap-2 mb-3 text-sm text-error-400">
                <AlertCircle size={16} />
                <span>发送失败</span>
                <button
                  onClick={handleRetry}
                  className="flex items-center gap-1 text-primary-400 hover:underline"
                >
                  <RefreshCw size={14} />
                  重试
                </button>
              </div>
            )}

          <div
            className={clsx(
              'flex items-end gap-3 p-3 rounded-xl',
              'bg-bg-elevated border border-border-default',
              'focus-within:border-primary-500 focus-within:shadow-glow-primary',
              'transition-all duration-fast'
            )}
          >
            <button
              className={clsx(
                'p-2 rounded-lg',
                'text-text-tertiary hover:text-text-primary hover:bg-interactive-hover',
                'transition-colors duration-fast'
              )}
              aria-label="添加附件"
            >
              <Paperclip size={20} />
            </button>

            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入您的问题..."
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
              aria-label="语音输入"
            >
              <Mic size={20} />
            </button>

            <Button
              size="sm"
              onClick={isSending ? handleStop : handleSendMessage}
              disabled={!isSending && !inputValue.trim()}
              leftIcon={isSending ? <StopCircle size={16} /> : <Send size={16} />}
            >
              {isSending ? '停止' : '发送'}
            </Button>
          </div>

          <p className="text-xs text-text-tertiary text-center mt-2">
            按 Enter 发送，Shift + Enter 换行
          </p>
        </div>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: DisplayMessage
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div
      className={clsx('flex items-start gap-3', isUser && 'flex-row-reverse')}
    >
      {/* 头像 */}
      <div
        className={clsx(
          'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
          isUser ? 'bg-primary-500' : 'bg-primary-500/20'
        )}
      >
        {isUser ? (
          <User size={16} className="text-neutral-950" />
        ) : (
          <Bot size={16} className="text-primary-400" />
        )}
      </div>

      {/* 消息内容 */}
      <div
        className={clsx(
          'max-w-[80%] px-4 py-3 rounded-xl',
          'animate-fade-in-up',
          isUser
            ? 'bg-primary-600 text-neutral-0 rounded-br-sm'
            : 'bg-bg-elevated text-text-primary border border-border-subtle rounded-bl-sm',
          message.status === 'error' && 'border-error-400'
        )}
      >
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {message.content}
          </p>
        ) : (
          <div className="text-sm">
            <MarkdownBlock data={{ content: message.content }} />
            {message.isStreaming && (
              <span className="inline-block w-2 h-4 bg-primary-400 animate-pulse ml-1" />
            )}
          </div>
        )}
        <div
          className={clsx(
            'flex items-center gap-2 mt-2 text-xs',
            isUser ? 'text-primary-200 justify-end' : 'text-text-tertiary'
          )}
        >
          <span>
            {message.timestamp.toLocaleTimeString(DEFAULT_LOCALE, TIME_FORMAT_OPTIONS)}
          </span>
          {isUser && message.status === 'sending' && <span>发送中...</span>}
          {isUser && message.status === 'sent' && <span>已发送</span>}
          {isUser && message.status === 'error' && (
            <span className="text-error-400">发送失败</span>
          )}
        </div>
      </div>
    </div>
  )
}
