'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Plus, Trash2, Send, StopCircle, Bot, User } from 'lucide-react'
import { Button } from '@/components/ui/Button'

type MessageRole = 'user' | 'assistant'

interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: string
  status?: 'sending' | 'sent' | 'error'
}

interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: string
}

const STORAGE_KEY = 'semibot_chat_sessions_v1'
const ACTIVE_KEY = 'semibot_chat_active_session_v1'

function createSession(title = '未命名会话'): ChatSession {
  const now = new Date().toISOString()
  return {
    id: `session-${Date.now()}`,
    title,
    messages: [],
    createdAt: now,
  }
}

function safeParseSessions(raw: string | null): ChatSession[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter((s) => s && typeof s.id === 'string')
  } catch {
    return []
  }
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const streamTimerRef = useRef<number | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const storedSessions = safeParseSessions(localStorage.getItem(STORAGE_KEY))
    const storedActive = localStorage.getItem(ACTIVE_KEY)
    const initialSessions = storedSessions.length > 0 ? storedSessions : [createSession()]
    const initialActive =
      storedActive && initialSessions.some((s) => s.id === storedActive)
        ? storedActive
        : initialSessions[0]?.id ?? null

    setSessions(initialSessions)
    setActiveSessionId(initialActive)
    setIsHydrated(true)
  }, [])

  useEffect(() => {
    if (!isHydrated) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
    if (activeSessionId) {
      localStorage.setItem(ACTIVE_KEY, activeSessionId)
    }
  }, [sessions, activeSessionId, isHydrated])

  useEffect(() => {
    if (!isHydrated) return

    const container = messagesContainerRef.current
    if (container) {
      const raf = window.requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
      return () => window.cancelAnimationFrame(raf)
    }

    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [sessions, activeSessionId, isStreaming, isHydrated])

  useEffect(() => {
    return () => {
      if (streamTimerRef.current) {
        window.clearInterval(streamTimerRef.current)
      }
    }
  }, [])

  const activeSession = useMemo(() => {
    if (!activeSessionId) return null
    return sessions.find((s) => s.id === activeSessionId) ?? null
  }, [sessions, activeSessionId])

  const updateSession = (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === sessionId ? updater(session) : session))
    )
  }

  const stopStreaming = () => {
    if (streamTimerRef.current) {
      window.clearInterval(streamTimerRef.current)
      streamTimerRef.current = null
    }
    setIsStreaming(false)
  }

  const handleCreateSession = () => {
    setSessions((prev) => {
      const newSession = createSession(`会话 ${prev.length + 1}`)
      setActiveSessionId(newSession.id)
      return [...prev, newSession]
    })
    setError(null)
  }

  const handleDeleteSession = (sessionId: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((session) => session.id !== sessionId)
      if (activeSessionId === sessionId) {
        setActiveSessionId(remaining[0]?.id ?? null)
      }
      return remaining
    })
    setConfirmDeleteId(null)
  }

  const handleSendMessage = async () => {
    const trimmed = inputValue.trim()
    if (!trimmed || !activeSession) return

    setError(null)

    if (isStreaming) {
      stopStreaming()
    }

    try {
      await fetch('/api/chat/ping', { method: 'GET' })
    } catch {
      setError('网络错误，请稍后重试')
      return
    }

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
      status: 'sending',
    }

    const assistantMessageId = `msg-${Date.now() + 1}`
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    }

    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: [...session.messages, userMessage, assistantMessage],
    }))
    setInputValue('')

    setIsStreaming(true)

    const responseText = '这是一个模拟的流式回复，用于展示对话效果。'
    let index = 0
    const chunkSize = 6

    streamTimerRef.current = window.setInterval(() => {
      index = Math.min(responseText.length, index + chunkSize)
      updateSession(activeSession.id, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: responseText.slice(0, index) }
            : message.id === userMessage.id
              ? { ...message, status: 'sent' }
              : message
        ),
      }))

      if (index >= responseText.length) {
        stopStreaming()
      }
    }, 150)
  }

  const hasMessages = (activeSession?.messages.length ?? 0) > 0

  return (
    <div className="flex flex-1 min-h-0 bg-bg-base">
      <aside className="w-64 border-r border-border-subtle bg-bg-surface flex flex-col">
        <div className="p-4 border-b border-border-subtle">
          <Button
            type="button"
            className="w-full"
            leftIcon={<Plus size={16} />}
            onClick={handleCreateSession}
            data-testid="new-session-btn"
          >
            新建会话
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {sessions.map((session, index) => (
            <div
              key={session.id}
              className={clsx(
                'flex items-center justify-between gap-2 px-3 py-2 rounded-md',
                'transition-colors duration-fast',
                session.id === activeSessionId
                  ? 'bg-interactive-active text-text-primary'
                  : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
              )}
            >
              <div
                role="button"
                tabIndex={0}
                data-testid={index === 0 ? 'session-item' : undefined}
                onClick={() => setActiveSessionId(session.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setActiveSessionId(session.id)
                }}
                className="flex-1 truncate"
              >
                {session.title}
              </div>
              <button
                type="button"
                data-testid="delete-session-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  setConfirmDeleteId(session.id)
                }}
                className="p-1 text-text-tertiary hover:text-error-500"
                aria-label="删除会话"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex flex-col flex-1 min-h-0">
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-6 py-6"
        >
          <div className="max-w-3xl mx-auto space-y-4">
            {error && (
              <div className="p-3 rounded-md bg-error-500/10 border border-error-500/20">
                <p className="text-sm text-error-500">{error}</p>
              </div>
            )}

            {!hasMessages && (
              <div
                data-testid="empty-state"
                className="p-6 rounded-lg border border-border-subtle bg-bg-surface text-center text-text-secondary"
              >
                欢迎开始对话，输入您的问题即可体验聊天功能。
              </div>
            )}

            {activeSession?.messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {isStreaming && (
              <div
                data-testid="loading-indicator"
                className="text-sm text-text-tertiary animate-pulse"
              >
                思考中...
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="border-t border-border-subtle bg-bg-surface">
          <div className="max-w-3xl mx-auto p-4">
            <div
              className={clsx(
                'flex items-end gap-3 p-3 rounded-xl',
                'bg-bg-elevated border border-border-default',
                'focus-within:border-primary-500 focus-within:shadow-glow-primary',
                'transition-all duration-fast'
              )}
            >
              <textarea
                data-testid="chat-input"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="输入消息..."
                rows={1}
                className={clsx(
                  'flex-1 resize-none bg-transparent',
                  'text-text-primary placeholder:text-text-tertiary',
                  'focus:outline-none',
                  'min-h-[24px] max-h-[200px]'
                )}
              />
              <Button
                size="sm"
                onClick={handleSendMessage}
                leftIcon={<Send size={16} />}
                data-testid="send-btn"
              >
                发送
              </Button>
              {isStreaming && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={stopStreaming}
                  leftIcon={<StopCircle size={16} />}
                  data-testid="stop-btn"
                >
                  停止
                </Button>
              )}
            </div>
            <p className="text-xs text-text-tertiary text-center mt-2">
              按 Enter 发送，Shift + Enter 换行
            </p>
          </div>
        </div>
      </div>

      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">确认删除会话</h3>
            <p className="text-sm text-text-secondary">删除后该会话的消息将无法恢复。</p>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setConfirmDeleteId(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                type="button"
                onClick={() => handleDeleteSession(confirmDeleteId)}
              >
                确认
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface MessageBubbleProps {
  message: ChatMessage
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div
      data-testid="message-item"
      className={clsx('flex items-start gap-3', isUser && 'flex-row-reverse')}
    >
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

      <div
        data-testid={isUser ? undefined : 'assistant-message'}
        className={clsx(
          'max-w-[80%] px-4 py-3 rounded-xl',
          'animate-fade-in-up',
          !isUser && 'message-assistant',
          isUser
            ? 'bg-primary-600 text-neutral-0 rounded-br-sm'
            : 'bg-bg-elevated text-text-primary border border-border-subtle rounded-bl-sm'
        )}
      >
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        <div
          className={clsx(
            'flex items-center gap-2 mt-2 text-xs',
            isUser ? 'text-primary-200 justify-end' : 'text-text-tertiary'
          )}
        >
          {new Date(message.timestamp).toLocaleTimeString()}
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
