'use client'

import React from 'react'
import clsx from 'clsx'
import type { Agent2UIMessage } from '@/types'
import { ComponentRegistry } from './ComponentRegistry'
import { TextBlock } from './text/TextBlock'

/**
 * Agent2UIRenderer - 统一渲染器
 *
 * 根据 ARCHITECTURE.md 2.1.3 和 2.1.4 设计
 * 根据消息类型自动路由到对应的组件进行渲染
 */

export interface Agent2UIRendererProps {
  /** Agent2UI 消息对象 */
  message: Agent2UIMessage
  /** 自定义样式类名 */
  className?: string
  /** 错误时的回调 */
  onError?: (error: Error, message: Agent2UIMessage) => void
}

interface ErrorBoundaryProps {
  message: Agent2UIMessage
  className?: string
  onError?: (error: Error, message: Agent2UIMessage) => void
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class RenderErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error): void {
    const { onError, message } = this.props
    if (onError) {
      onError(error, message)
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      const { message, className } = this.props
      return (
        <div
          className={clsx(
            'agent2ui-message agent2ui-error',
            'p-4 rounded-lg border border-error-500/50 bg-error-500/5',
            className
          )}
        >
          <div className="text-sm text-error-500">
            渲染失败: {message.type}
          </div>
          <pre className="mt-2 text-xs text-text-secondary font-mono overflow-auto">
            {this.state.error?.message ?? '未知错误'}
          </pre>
        </div>
      )
    }

    return this.props.children
  }
}

export function Agent2UIRenderer({
  message,
  className,
  onError,
}: Agent2UIRendererProps) {
  const Component = ComponentRegistry.get(message.type)

  // 未知类型处理
  if (!Component) {
    console.warn(`[Agent2UIRenderer] Unknown message type: ${message.type}`)

    // 尝试将数据作为文本展示
    const fallbackContent =
      typeof message.data === 'string'
        ? message.data
        : JSON.stringify(message.data, null, 2)

    return (
      <div className={clsx('agent2ui-message', className)}>
        <TextBlock data={{ content: fallbackContent }} />
      </div>
    )
  }

  return (
    <RenderErrorBoundary message={message} className={className} onError={onError}>
      <div
        className={clsx(
          'agent2ui-message',
          `agent2ui-${message.type}`,
          className
        )}
        data-message-id={message.id}
        data-message-type={message.type}
      >
        <Component data={message.data} metadata={message.metadata} />
      </div>
    </RenderErrorBoundary>
  )
}

Agent2UIRenderer.displayName = 'Agent2UIRenderer'

/**
 * Agent2UIMessageList - 消息列表渲染器
 *
 * 批量渲染多条 Agent2UI 消息
 */
export interface Agent2UIMessageListProps {
  messages: Agent2UIMessage[]
  className?: string
  messageClassName?: string
  gap?: 'sm' | 'md' | 'lg'
  onError?: (error: Error, message: Agent2UIMessage) => void
}

export function Agent2UIMessageList({
  messages,
  className,
  messageClassName,
  gap = 'md',
  onError,
}: Agent2UIMessageListProps) {
  const gapClasses = {
    sm: 'space-y-2',
    md: 'space-y-4',
    lg: 'space-y-6',
  }

  return (
    <div className={clsx(gapClasses[gap], className)}>
      {messages.map((message, index) => (
        <Agent2UIRenderer
          key={message.id || index}
          message={message}
          className={messageClassName}
          onError={onError}
        />
      ))}
    </div>
  )
}

Agent2UIMessageList.displayName = 'Agent2UIMessageList'
