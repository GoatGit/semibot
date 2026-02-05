'use client'

import { AppShell } from '@/components/layout/AppShell'
import { NavBar } from '@/components/layout/NavBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { DetailCanvas } from '@/components/layout/DetailCanvas'

interface DashboardLayoutProps {
  children: React.ReactNode
}

/**
 * Dashboard Layout - 三栏布局
 *
 * 根据 ARCHITECTURE.md 设计:
 * - NavBar: 60px-240px 可折叠
 * - Sidebar: flex:1 自适应 (children 区域)
 * - DetailCanvas: 320px-100% 可折叠/展开/最大化
 */
export default function DashboardLayout({ children }: DashboardLayoutProps) {
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
