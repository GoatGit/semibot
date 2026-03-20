'use client'

import clsx from 'clsx'

/**
 * Sidebar - 会话区
 *
 * 根据 ARCHITECTURE.md 设计:
 * - 宽度: flex: 1 自适应
 * - 始终显示
 * - 职责: 执行过程、思考过程、对话交互
 */
export function Sidebar() {
  return (
    <div
      className={clsx(
        'flex flex-col flex-1 min-w-0',
        'bg-bg-base'
      )}
    >
      {/* 执行过程区 */}
      <div className="flex-shrink-0 p-4 border-b border-border-subtle">
        <ProcessArea />
      </div>

      {/* 对话区 */}
      <div className="flex-1 flex flex-col min-h-0">
        <ChatArea />
      </div>
    </div>
  )
}

/**
 * ProcessArea - 执行过程展示区
 */
function ProcessArea() {
  return (
    <div className="space-y-3">
      {/* 计划步骤 */}
      <div className="bg-bg-surface rounded-lg p-4 border border-border-subtle">
        <h3 className="text-sm font-medium text-text-primary mb-3">执行计划</h3>
        <div className="flex items-center gap-2">
          <StepIndicator status="completed" label="分析" />
          <StepConnector />
          <StepIndicator status="completed" label="规划" />
          <StepConnector />
          <StepIndicator status="running" label="执行" />
          <StepConnector />
          <StepIndicator status="pending" label="观察" />
          <StepConnector />
          <StepIndicator status="pending" label="总结" />
        </div>
      </div>

      {/* 工具调用 */}
      <div className="bg-bg-surface rounded-lg p-4 border border-border-subtle">
        <h3 className="text-sm font-medium text-text-primary mb-3">工具调用</h3>
        <div className="space-y-2">
          <ToolCallItem name="web_search" status="success" duration="1.2s" />
          <ToolCallItem name="code_executor" status="running" />
        </div>
      </div>
    </div>
  )
}

interface StepIndicatorProps {
  status: 'pending' | 'running' | 'completed'
  label: string
}

function StepIndicator({ status, label }: StepIndicatorProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={clsx(
          'w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium',
          'transition-colors duration-fast',
          status === 'completed' && 'bg-success-500 text-neutral-950',
          status === 'running' && 'bg-primary-500 text-neutral-950 animate-pulse',
          status === 'pending' && 'bg-neutral-700 text-text-tertiary'
        )}
      >
        {status === 'completed' ? '✓' : status === 'running' ? '◉' : '○'}
      </div>
      <span className="text-xs text-text-secondary">{label}</span>
    </div>
  )
}

function StepConnector() {
  return <div className="flex-1 h-0.5 bg-border-default mt-[-12px]" />
}

interface ToolCallItemProps {
  name: string
  status: 'running' | 'success' | 'error'
  duration?: string
}

function ToolCallItem({ name, status, duration }: ToolCallItemProps) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between px-3 py-2 rounded-md',
        'bg-bg-elevated border border-border-subtle'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm">🔧</span>
        <span className="text-sm font-mono text-text-primary">{name}</span>
      </div>
      <div className="flex items-center gap-2">
        {status === 'running' && (
          <span className="text-xs text-primary-400 animate-pulse">执行中...</span>
        )}
        {status === 'success' && (
          <>
            <span className="text-xs text-success-500">✓ 成功</span>
            {duration && <span className="text-xs text-text-tertiary">{duration}</span>}
          </>
        )}
        {status === 'error' && (
          <span className="text-xs text-error-500">✗ 失败</span>
        )}
      </div>
    </div>
  )
}

/**
 * ChatArea - 对话交互区
 */
function ChatArea() {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <MessageBubble role="user" content="帮我分析这份销售数据" time="14:30" />
        <MessageBubble
          role="agent"
          content="好的，我来分析这份数据。从数据中可以看出，Q1-Q3 的销售趋势呈现上升态势..."
          time="14:31"
        />
      </div>

      {/* 输入区 */}
      <div className="flex-shrink-0 p-4 border-t border-border-subtle">
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="输入您的问题..."
            className={clsx(
              'flex-1 h-11 px-4 rounded-lg',
              'bg-bg-surface border border-border-default',
              'text-text-primary placeholder:text-text-tertiary',
              'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
              'transition-all duration-fast'
            )}
          />
          <button
            className={clsx(
              'h-11 px-6 rounded-lg',
              'bg-primary-500 text-neutral-950 font-medium',
              'hover:bg-primary-400',
              'active:bg-primary-600 active:scale-[0.98]',
              'transition-all duration-fast'
            )}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  role: 'user' | 'agent'
  content: string
  time: string
}

function MessageBubble({ role, content, time }: MessageBubbleProps) {
  return (
    <div
      className={clsx(
        'flex',
        role === 'user' ? 'justify-end' : 'justify-start'
      )}
    >
      <div
        className={clsx(
          'max-w-[80%] px-4 py-3 rounded-xl',
          'animate-fade-in-up',
          role === 'user'
            ? 'bg-primary-600 text-neutral-0 rounded-br-sm'
            : 'bg-bg-elevated text-text-primary border border-border-subtle rounded-bl-sm'
        )}
      >
        <p className="text-sm leading-relaxed">{content}</p>
        <div
          className={clsx(
            'text-xs mt-2',
            role === 'user' ? 'text-primary-200' : 'text-text-tertiary'
          )}
        >
          {time}
        </div>
      </div>
    </div>
  )
}
