'use client'

import clsx from 'clsx'
import { FileText } from 'lucide-react'
import type { ReportData } from '@/types'
import { Agent2UIRenderer } from '../Agent2UIRenderer'

/**
 * ReportView - 结构化报告组件
 *
 * 展示包含多个章节的结构化报告
 * 支持嵌套的 Agent2UI 消息
 */

export interface ReportViewProps {
  data: ReportData
  className?: string
}

export function ReportView({ data, className }: ReportViewProps) {
  return (
    <div
      className={clsx(
        'rounded-lg border border-border-subtle',
        'bg-bg-surface overflow-hidden',
        className
      )}
    >
      {/* 报告头部 */}
      <div
        className={clsx(
          'flex items-center gap-3',
          'px-6 py-4',
          'bg-bg-elevated border-b border-border-subtle'
        )}
      >
        <div className="p-2 rounded-lg bg-primary-500/10">
          <FileText className="w-5 h-5 text-primary-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">
            {data.title}
          </h2>
          {data.summary && (
            <p className="text-sm text-text-secondary mt-0.5">
              {data.summary}
            </p>
          )}
        </div>
      </div>

      {/* 报告内容 */}
      <div className="divide-y divide-border-subtle">
        {data.sections.map((section, sectionIndex) => (
          <div key={sectionIndex} className="px-6 py-5">
            {/* 章节标题 */}
            <h3 className="text-base font-semibold text-text-primary mb-4">
              {section.heading}
            </h3>

            {/* 章节内容 - 嵌套渲染 Agent2UI 消息 */}
            <div className="space-y-4">
              {section.content.map((message) => (
                <Agent2UIRenderer key={message.id} message={message} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

ReportView.displayName = 'ReportView'
