'use client'

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
  return (
    <div
      className={clsx(
        'relative flex h-screen w-screen overflow-hidden',
        'bg-bg-base'
      )}
    >
      {children}
    </div>
  )
}
