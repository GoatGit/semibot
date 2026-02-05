'use client'

import { AppShell } from '@/components/layout/AppShell'
import { NavBar } from '@/components/layout/NavBar'
import { DetailCanvas } from '@/components/layout/DetailCanvas'
import { useLayoutSync } from '@/hooks/useLayoutSync'

interface DashboardLayoutProps {
  children: React.ReactNode
}

/**
 * Dashboard Layout - 三栏布局
 *
 * 根据 ARCHITECTURE.md 设计:
 * - NavBar: 60px-240px 可折叠（首页展开，其他页面收起）
 * - Sidebar: flex:1 自适应 (children 区域)
 * - DetailCanvas: 480px-100% 可折叠/展开/最大化（无内容时自动收起）
 */
export default function DashboardLayout({ children }: DashboardLayoutProps) {
  // 同步路由与布局状态
  useLayoutSync()

  return (
    <AppShell>
      <NavBar />
      <main className="flex flex-1 min-w-0">
        {children}
      </main>
      <DetailCanvas />
    </AppShell>
  )
}
