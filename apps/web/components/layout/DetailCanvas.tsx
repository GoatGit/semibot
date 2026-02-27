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
      <div className="flex items-center border-l border-border-subtle">
        <button
          onClick={expandDetail}
          className={clsx(
            'flex items-center justify-center w-8 h-full',
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
      <div className="flex flex-col flex-1 bg-bg-surface">
        <DetailHeader
          onMinimize={exitMaximize}
          title={t('detailCanvas.title')}
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
        title={t('detailCanvas.title')}
        collapseLabel={t('detailCanvas.collapse')}
        maximizeLabel={t('detailCanvas.maximize')}
        exitMaximizeLabel={t('detailCanvas.exitMaximize')}
      />
      <DetailContent />
    </div>
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
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <FileText size={48} className="text-text-tertiary mb-4" />
      <p className="text-sm text-text-secondary">{t('detailCanvas.emptyTitle')}</p>
      <p className="text-xs text-text-tertiary mt-1">{t('detailCanvas.emptyDescription')}</p>
    </div>
  )
}
