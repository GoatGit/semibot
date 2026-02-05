'use client'

import { useLayoutStore } from '@/stores/layoutStore'
import clsx from 'clsx'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Download,
  Share2,
  Printer
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
        <DetailHeader onMinimize={exitMaximize} isMaximized />
        <DetailContent />
        <DetailFooter />
      </div>
    )
  }

  // 正常展开状态
  return (
    <div
      className={clsx(
        'flex flex-col w-[640px]',
        'bg-bg-surface border-l border-border-subtle',
        'transition-all duration-normal ease-out'
      )}
    >
      <DetailHeader
        onCollapse={collapseDetail}
        onMaximize={maximizeDetail}
      />
      <DetailContent />
      <DetailFooter />
    </div>
  )
}

interface DetailHeaderProps {
  onCollapse?: () => void
  onMaximize?: () => void
  onMinimize?: () => void
  isMaximized?: boolean
}

function DetailHeader({ onCollapse, onMaximize, onMinimize, isMaximized: _isMaximized }: DetailHeaderProps) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between px-4 h-14',
        'border-b border-border-subtle'
      )}
    >
      <div>
        <h2 className="text-sm font-semibold text-text-primary">销售数据分析报告</h2>
        <p className="text-xs text-text-tertiary">生成时间: 2026-02-05 12:30</p>
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
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* 数据表格 */}
      <div className="bg-bg-elevated rounded-lg p-4 border border-border-subtle">
        <h3 className="text-sm font-medium text-text-primary mb-3">📊 数据表格</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-default">
                <th className="text-left py-2 text-text-secondary font-medium">产品</th>
                <th className="text-right py-2 text-text-secondary font-medium">Q1</th>
                <th className="text-right py-2 text-text-secondary font-medium">Q2</th>
                <th className="text-right py-2 text-text-secondary font-medium">Q3</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border-subtle">
                <td className="py-2 text-text-primary">产品A</td>
                <td className="py-2 text-right text-text-primary">1,200</td>
                <td className="py-2 text-right text-text-primary">1,450</td>
                <td className="py-2 text-right text-success-500">1,680</td>
              </tr>
              <tr className="border-b border-border-subtle">
                <td className="py-2 text-text-primary">产品B</td>
                <td className="py-2 text-right text-text-primary">800</td>
                <td className="py-2 text-right text-text-primary">920</td>
                <td className="py-2 text-right text-success-500">1,100</td>
              </tr>
              <tr>
                <td className="py-2 text-text-primary">产品C</td>
                <td className="py-2 text-right text-text-primary">650</td>
                <td className="py-2 text-right text-text-primary">580</td>
                <td className="py-2 text-right text-error-500">520</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 分析报告 */}
      <div className="bg-bg-elevated rounded-lg p-4 border border-border-subtle">
        <h3 className="text-sm font-medium text-text-primary mb-3">📄 分析报告</h3>
        <div className="prose prose-sm prose-invert max-w-none">
          <h4 className="text-text-primary font-medium mb-2">分析结论</h4>
          <p className="text-text-secondary text-sm leading-relaxed mb-3">
            根据 Q1-Q3 销售数据分析，主要发现如下：
          </p>
          <h5 className="text-text-primary font-medium mb-2">1. 增长趋势</h5>
          <ul className="list-disc list-inside text-text-secondary text-sm space-y-1 mb-3">
            <li>产品A 和 产品B 呈现持续增长态势</li>
            <li>产品C 需要关注，连续三个季度下滑</li>
          </ul>
          <h5 className="text-text-primary font-medium mb-2">2. 建议措施</h5>
          <ol className="list-decimal list-inside text-text-secondary text-sm space-y-1">
            <li>加大产品A的市场投入</li>
            <li>分析产品C下滑原因，考虑产品升级或淘汰</li>
            <li>产品B可考虑扩展到新市场</li>
          </ol>
        </div>
      </div>
    </div>
  )
}

function DetailFooter() {
  return (
    <div
      className={clsx(
        'flex items-center justify-center gap-2 px-4 py-3',
        'border-t border-border-subtle'
      )}
    >
      <button
        className={clsx(
          'flex items-center gap-2 px-3 py-2 rounded-md',
          'text-sm text-text-secondary',
          'hover:bg-interactive-hover hover:text-text-primary',
          'transition-colors duration-fast'
        )}
      >
        <Download size={16} />
        下载
      </button>
      <button
        className={clsx(
          'flex items-center gap-2 px-3 py-2 rounded-md',
          'text-sm text-text-secondary',
          'hover:bg-interactive-hover hover:text-text-primary',
          'transition-colors duration-fast'
        )}
      >
        <Share2 size={16} />
        分享
      </button>
      <button
        className={clsx(
          'flex items-center gap-2 px-3 py-2 rounded-md',
          'text-sm text-text-secondary',
          'hover:bg-interactive-hover hover:text-text-primary',
          'transition-colors duration-fast'
        )}
      >
        <Printer size={16} />
        打印
      </button>
    </div>
  )
}
