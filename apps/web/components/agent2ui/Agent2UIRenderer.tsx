'use client'

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

  try {
    return (
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
    )
  } catch (error) {
    console.error(`[Agent2UIRenderer] Error rendering ${message.type}:`, error)

    if (onError && error instanceof Error) {
      onError(error, message)
    }

    // 渲染错误时显示错误信息
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
          {error instanceof Error ? error.message : String(error)}
        </pre>
      </div>
    )
  }
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
