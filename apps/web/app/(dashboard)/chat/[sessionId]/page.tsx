'use client'

import { useState, useRef, useEffect } from 'react'
import { useParams } from 'next/navigation'
import clsx from 'clsx'
import { Send, Paperclip, Mic, StopCircle, Bot, User } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  MOCK_RESPONSE_DELAY_MS,
  TYPING_INDICATOR_DELAYS,
  TIME_FORMAT_OPTIONS,
  DEFAULT_LOCALE,
} from '@/constants/config'

interface Message {
  id: string
  role: 'user' | 'agent'
  content: string
  timestamp: Date
  status?: 'sending' | 'sent' | 'error'
}

/**
 * Chat Session Page - 会话详情页面
 *
 * 显示与 Agent 的对话内容:
 * - 消息列表
 * - 输入区域
 * - 实时状态反馈
 */
export default function ChatSessionPage() {
  const params = useParams()
  const sessionId = params.sessionId as string

  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'agent',
      content: `您好！我是您的 AI 助手。会话 ID: ${sessionId}。有什么我可以帮助您的吗？`,
      timestamp: new Date(),
    },
  ])
  const [inputValue, setInputValue] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return

    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: inputValue.trim(),
      timestamp: new Date(),
      status: 'sending',
    }

    setMessages((prev) => [...prev, userMessage])
    setInputValue('')
    setIsTyping(true)

    // 模拟 Agent 回复
    // TODO: 实际实现时调用 API
    await new Promise((resolve) => setTimeout(resolve, MOCK_RESPONSE_DELAY_MS))

    const agentMessage: Message = {
      id: `msg-${Date.now() + 1}`,
      role: 'agent',
      content: `收到您的消息："${userMessage.content}"。我正在处理中...这是一个模拟的回复。在实际实现中，这里会显示 Agent 的真实响应。`,
      timestamp: new Date(),
    }

    setMessages((prev) => [
      ...prev.map((m) =>
        m.id === userMessage.id ? { ...m, status: 'sent' as const } : m
      ),
      agentMessage,
    ])
    setIsTyping(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {/* 正在输入指示器 */}
          {isTyping && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                <Bot size={16} className="text-primary-400" />
              </div>
              <div className="bg-bg-elevated rounded-xl rounded-bl-sm px-4 py-3 border border-border-subtle">
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-text-tertiary rounded-full animate-pulse" />
                  <span
                    className="w-2 h-2 bg-text-tertiary rounded-full animate-pulse"
                    style={{ animationDelay: `${TYPING_INDICATOR_DELAYS.DOT_2}s` }}
                  />
                  <span
                    className="w-2 h-2 bg-text-tertiary rounded-full animate-pulse"
                    style={{ animationDelay: `${TYPING_INDICATOR_DELAYS.DOT_3}s` }}
                  />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 输入区 */}
      <div className="flex-shrink-0 border-t border-border-subtle bg-bg-surface">
        <div className="max-w-3xl mx-auto p-4">
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
              className={clsx(
                'flex-1 resize-none bg-transparent',
                'text-text-primary placeholder:text-text-tertiary',
                'focus:outline-none',
                'min-h-[24px] max-h-[200px]'
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
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isTyping}
              leftIcon={isTyping ? <StopCircle size={16} /> : <Send size={16} />}
            >
              {isTyping ? '停止' : '发送'}
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
  message: Message
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
