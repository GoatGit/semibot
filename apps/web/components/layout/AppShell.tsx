'use client'

import { useLayoutStore } from '@/stores/layoutStore'
import clsx from 'clsx'

interface AppShellProps {
  children: React.ReactNode
}

/**
 * AppShell - 三栏布局容器
 *
 * 根据 ARCHITECTURE.md 设计:
 * - NavBar: 60px-240px 可折叠
 * - Sidebar: flex:1 自适应
 * - DetailCanvas: 320px-100% 可折叠/展开/最大化
 */
export function AppShell({ children }: AppShellProps) {
  const { detailCanvasMode } = useLayoutStore()

  const isMaximized = detailCanvasMode === 'maximized'

  return (
    <div
      className={clsx(
        'flex h-screen w-screen overflow-hidden',
        'bg-bg-base'
      )}
    >
      {isMaximized ? (
        // 最大化模式: 只显示 DetailCanvas
        <div className="flex-1">{children}</div>
      ) : (
        // 标准模式: 三栏布局
        children
      )}
    </div>
  )
}
