'use client'

import { useLayoutStore } from '@/stores/layoutStore'
import { DETAIL_CANVAS_WIDTH_PX } from '@/constants/config'
import clsx from 'clsx'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  FileText,
} from 'lucide-react'

/**
 * DetailCanvas - 详情画布
 *
 * 根据 ARCHITECTURE.md 设计:
 * - 折叠状态: 隐藏
 * - 展开状态: 320px
 * - 最大化状态: 100%
 * - 职责: 结果数据、报告展示
 */
export function DetailCanvas() {
  const {
    detailCanvasMode,
    collapseDetail,
    expandDetail,
    maximizeDetail,
    exitMaximize
  } = useLayoutStore()

  // 折叠状态时只显示展开按钮
  if (detailCanvasMode === 'collapsed') {
    return (
      <div className="flex items-center border-l border-border-subtle">
        <button
          onClick={expandDetail}
          className={clsx(
            'flex items-center justify-center w-8 h-full',
            'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
            'transition-colors duration-fast'
          )}
          aria-label="展开详情画布"
        >
          <ChevronLeft size={18} />
        </button>
      </div>
    )
  }

  // 最大化状态
  if (detailCanvasMode === 'maximized') {
    return (
      <div className="flex flex-col flex-1 bg-bg-surface">
        <DetailHeader onMinimize={exitMaximize} />
        <DetailContent />
      </div>
    )
  }

  // 正常展开状态
  return (
    <div
      style={{ width: DETAIL_CANVAS_WIDTH_PX }}
      className={clsx(
        'flex flex-col',
        'bg-bg-surface border-l border-border-subtle',
        'transition-all duration-normal ease-out'
      )}
    >
      <DetailHeader
        onCollapse={collapseDetail}
        onMaximize={maximizeDetail}
      />
      <DetailContent />
    </div>
  )
}

interface DetailHeaderProps {
  onCollapse?: () => void
  onMaximize?: () => void
  onMinimize?: () => void
}

function DetailHeader({ onCollapse, onMaximize, onMinimize }: DetailHeaderProps) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between px-4 h-14',
        'border-b border-border-subtle'
      )}
    >
      <div>
        <h2 className="text-sm font-semibold text-text-primary">详情</h2>
      </div>
      <div className="flex items-center gap-1">
        {onCollapse && (
          <button
            onClick={onCollapse}
            className={clsx(
              'p-2 rounded-md',
              'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
              'transition-colors duration-fast'
            )}
            aria-label="折叠"
          >
            <ChevronRight size={16} />
          </button>
        )}
        {onMaximize && (
          <button
            onClick={onMaximize}
            className={clsx(
              'p-2 rounded-md',
              'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
              'transition-colors duration-fast'
            )}
            aria-label="最大化"
          >
            <Maximize2 size={16} />
          </button>
        )}
        {onMinimize && (
          <button
            onClick={onMinimize}
            className={clsx(
              'p-2 rounded-md',
              'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
              'transition-colors duration-fast'
            )}
            aria-label="退出最大化"
          >
            <Minimize2 size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

function DetailContent() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <FileText size={48} className="text-text-tertiary mb-4" />
      <p className="text-sm text-text-secondary">暂无内容</p>
      <p className="text-xs text-text-tertiary mt-1">对话产生的结果将在此展示</p>
    </div>
  )
}
