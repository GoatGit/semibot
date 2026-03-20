'use client'

import { useLayoutStore } from '@/stores/layoutStore'
import { DETAIL_CANVAS_WIDTH_PX, PATHS_WITHOUT_DETAIL } from '@/constants/config'
import clsx from 'clsx'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  FileText,
} from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'
import { MarkdownBlock } from '@/components/agent2ui/text/MarkdownBlock'

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
  const { t } = useLocale()
  const {
    detailCanvasMode,
    detailContent,
    currentPath,
    collapseDetail,
    expandDetail,
    maximizeDetail,
    exitMaximize
  } = useLayoutStore()

  const isPathWithoutDetail = PATHS_WITHOUT_DETAIL.some(
    (p) => currentPath === p || currentPath.startsWith(`${p}/`)
  )

  // 折叠状态下，若当前路径不需要详情画布，完全不渲染
  if (detailCanvasMode === 'collapsed' && isPathWithoutDetail) {
    return null
  }

  // 折叠状态时只显示展开按钮
  if (detailCanvasMode === 'collapsed') {
    return (
      <div className="absolute right-0 top-0 bottom-0 z-20 flex items-center">
        <button
          onClick={expandDetail}
          className={clsx(
            'flex h-full w-8 items-center justify-center border-l border-border-subtle bg-bg-surface/95 backdrop-blur-sm',
            'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
            'transition-colors duration-fast'
          )}
          aria-label={t('detailCanvas.expand')}
        >
          <ChevronLeft size={18} />
        </button>
      </div>
    )
  }

  // 最大化状态
  if (detailCanvasMode === 'maximized') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-bg-surface">
        <DetailHeader
          onMinimize={exitMaximize}
          title={detailContent?.title || t('detailCanvas.title')}
          collapseLabel={t('detailCanvas.collapse')}
          maximizeLabel={t('detailCanvas.maximize')}
          exitMaximizeLabel={t('detailCanvas.exitMaximize')}
        />
        <DetailContent />
      </div>
    )
  }

  // 正常展开状态
  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-10 cursor-default bg-transparent"
        aria-label={t('detailCanvas.collapse')}
        onClick={collapseDetail}
      />
      <div
        style={{ width: DETAIL_CANVAS_WIDTH_PX }}
        className={clsx(
          'absolute right-0 top-0 bottom-0 z-20 flex flex-col overflow-hidden',
          'bg-bg-surface/98 border-l border-border-subtle shadow-2xl backdrop-blur-sm',
          'transition-all duration-normal ease-out'
        )}
      >
        <DetailHeader
          onCollapse={collapseDetail}
          onMaximize={maximizeDetail}
          title={detailContent?.title || t('detailCanvas.title')}
          collapseLabel={t('detailCanvas.collapse')}
          maximizeLabel={t('detailCanvas.maximize')}
          exitMaximizeLabel={t('detailCanvas.exitMaximize')}
        />
        <DetailContent />
      </div>
    </>
  )
}

interface DetailHeaderProps {
  onCollapse?: () => void
  onMaximize?: () => void
  onMinimize?: () => void
  title: string
  collapseLabel: string
  maximizeLabel: string
  exitMaximizeLabel?: string
}

function DetailHeader({ onCollapse, onMaximize, onMinimize, title, collapseLabel, maximizeLabel, exitMaximizeLabel }: DetailHeaderProps) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between px-4 h-14',
        'border-b border-border-subtle'
      )}
    >
      <div>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
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
            aria-label={collapseLabel}
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
            aria-label={maximizeLabel}
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
            aria-label={exitMaximizeLabel}
          >
            <Minimize2 size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

function DetailContent() {
  const { t } = useLocale()
  const { detailContent } = useLayoutStore()

  if (detailContent?.kind === 'markdown') {
    return (
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {detailContent.filename && (
          <div className="mb-4 text-xs uppercase tracking-[0.08em] text-text-tertiary">
            {detailContent.filename}
          </div>
        )}
        <MarkdownBlock
          data={{ content: detailContent.content }}
          variant="report"
          className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5"
        />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <FileText size={48} className="text-text-tertiary mb-4" />
      <p className="text-sm text-text-secondary">{t('detailCanvas.emptyTitle')}</p>
      <p className="text-xs text-text-tertiary mt-1">{t('detailCanvas.emptyDescription')}</p>
    </div>
  )
}
