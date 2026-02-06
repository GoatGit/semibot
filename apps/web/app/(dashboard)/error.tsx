'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'
import Link from 'next/link'

interface ErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * Dashboard 错误边界
 */
export default function DashboardError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // 记录错误到日志服务
    console.error('[Dashboard Error]', error)
  }, [error])

  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="flex flex-col items-center gap-6 max-w-md text-center px-4">
        {/* 错误图标 */}
        <div className="w-16 h-16 rounded-full bg-error-500/10 flex items-center justify-center">
          <AlertTriangle size={32} className="text-error-500" />
        </div>

        {/* 错误信息 */}
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-text-primary">出错了</h2>
          <p className="text-sm text-text-secondary">
            {error.message || '加载页面时发生错误，请稍后重试'}
          </p>
          {error.digest && (
            <p className="text-xs text-text-tertiary">错误 ID: {error.digest}</p>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3">
          <button
            onClick={reset}
            className="flex items-center gap-2 px-4 py-2 bg-primary-500 text-white rounded-md hover:bg-primary-600 transition-colors"
          >
            <RefreshCw size={16} />
            重试
          </button>
          <Link
            href="/"
            className="flex items-center gap-2 px-4 py-2 bg-bg-secondary text-text-primary rounded-md hover:bg-bg-tertiary transition-colors"
          >
            <Home size={16} />
            返回首页
          </Link>
        </div>
      </div>
    </div>
  )
}
