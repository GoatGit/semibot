'use client'

import clsx from 'clsx'
import { Brain } from 'lucide-react'
import type { ThinkingData } from '@/types'

/**
 * ThinkingView - 思考过程展示组件
 *
 * 根据 DESIGN_SYSTEM.md 中思考动画设计
 * 展示 Agent 的思考过程，带有脉冲动画效果
 */

export interface ThinkingViewProps {
  data: ThinkingData
  className?: string
}

export function ThinkingView({ data, className }: ThinkingViewProps) {
  // 解析思考内容，支持多行和列表格式
  const parseContent = (content: string): string[] => {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  const lines = parseContent(data.content)

  return (
    <div
      className={clsx(
        'rounded-lg border border-border-subtle',
        'bg-bg-surface overflow-hidden',
        className
      )}
    >
      {/* 头部 */}
      <div
        className={clsx(
          'flex items-center gap-3',
          'px-4 py-3',
          'bg-bg-elevated border-b border-border-subtle'
        )}
      >
        <div className="relative">
          <Brain className="w-5 h-5 text-primary-500" />
          {/* 脉冲动画 */}
          <span className="absolute inset-0 rounded-full bg-primary-500/30 animate-ping" />
        </div>
        <span className="text-sm font-medium text-text-primary">正在思考...</span>

        {/* 思考点动画 */}
        <div className="flex items-center gap-1 ml-auto">
          <span
            className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse"
            style={{ animationDelay: '0ms' }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse"
            style={{ animationDelay: '200ms' }}
          />
          <span
            className="w-1.5 h-1.5 rounded-full bg-primary-500 animate-pulse"
            style={{ animationDelay: '400ms' }}
          />
        </div>
      </div>

      {/* 内容 */}
      <div className="px-4 py-3 space-y-2">
        {lines.map((line, index) => {
          // 检测是否是列表项 (以 > 或 - 或 * 开头)
          const isListItem = /^[>\-*]/.test(line)
          const cleanLine = line.replace(/^[>\-*]\s*/, '')

          return (
            <div
              key={index}
              className={clsx(
                'flex items-start gap-2',
                'animate-fade-in-up',
                'text-text-secondary text-sm'
              )}
              style={{
                animationDelay: `${index * 100}ms`,
                animationFillMode: 'both',
              }}
            >
              {isListItem && (
                <span className="text-primary-500 mt-0.5">›</span>
              )}
              <span className={clsx(!isListItem && 'text-text-primary')}>
                {cleanLine}
              </span>
            </div>
          )
        })}
      </div>

      {/* 底部渐变遮罩，暗示内容可能还在增加 */}
      <div
        className={clsx(
          'h-4 bg-gradient-to-t from-bg-surface to-transparent',
          '-mt-4 relative z-10 pointer-events-none'
        )}
      />
    </div>
  )
}

ThinkingView.displayName = 'ThinkingView'
