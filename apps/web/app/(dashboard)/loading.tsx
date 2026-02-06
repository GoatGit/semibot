'use client'

/**
 * Dashboard 加载状态
 */
export default function DashboardLoading() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="flex flex-col items-center gap-4">
        {/* 加载动画 */}
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 border-4 border-primary-500/20 rounded-full" />
          <div className="absolute inset-0 border-4 border-transparent border-t-primary-500 rounded-full animate-spin" />
        </div>

        {/* 加载文字 */}
        <p className="text-sm text-text-secondary">加载中...</p>
      </div>
    </div>
  )
}
