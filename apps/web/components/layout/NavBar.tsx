'use client'

import { useLayoutStore } from '@/stores/layoutStore'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'
import {
  Home,
  Bot,
  Settings,
  Plus,
  MessageSquare,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'

interface NavItem {
  icon: React.ReactNode
  label: string
  href: string
}

const navItems: NavItem[] = [
  { icon: <Home size={20} />, label: '首页', href: '/' },
  { icon: <Bot size={20} />, label: 'Agents', href: '/agents' },
  { icon: <Settings size={20} />, label: '设置', href: '/settings' },
]

/**
 * NavBar - 左侧导航栏
 *
 * 根据 ARCHITECTURE.md 设计:
 * - 展开状态: 240px
 * - 折叠状态: 60px
 * - 包含: 主导航入口 + 会话列表
 * - 首页自动展开，其他页面自动收起
 */
export function NavBar() {
  const { navBarExpanded, toggleNavBar } = useLayoutStore()
  const pathname = usePathname()

  return (
    <nav
      className={clsx(
        'flex flex-col h-full',
        'bg-bg-surface border-r border-border-subtle',
        'transition-all duration-normal ease-out',
        navBarExpanded ? 'w-60' : 'w-[60px]'
      )}
    >
      {/* Logo 区域 */}
      <div
        className={clsx(
          'flex items-center h-14 px-4',
          'border-b border-border-subtle'
        )}
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary-500 flex items-center justify-center">
            <Bot size={18} className="text-neutral-950" />
          </div>
          {navBarExpanded && (
            <span className="font-display font-semibold text-lg text-text-primary">
              Semibot
            </span>
          )}
        </div>
      </div>

      {/* 导航项 */}
      <div className="flex-1 py-4 space-y-1 px-2 overflow-y-auto">
        {navItems.map((item) => (
          <NavButton
            key={item.href}
            icon={item.icon}
            label={item.label}
            href={item.href}
            active={pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))}
            expanded={navBarExpanded}
          />
        ))}

        {/* 会话分隔线 */}
        <div className="my-4 border-t border-border-subtle" />

        {/* 新建会话按钮 */}
        <NavButton
          icon={<Plus size={20} />}
          label="新建会话"
          href="/chat/new"
          active={pathname === '/chat/new'}
          expanded={navBarExpanded}
          variant="primary"
        />

        {/* 会话列表占位 */}
        {navBarExpanded && (
          <div className="mt-2 space-y-1">
            <SessionItem title="销售数据分析" time="14:30" />
            <SessionItem title="市场调研报告" time="10:15" />
            <SessionItem title="竞品分析" time="昨天" />
          </div>
        )}
      </div>

      {/* 折叠按钮 */}
      <div className="p-2 border-t border-border-subtle">
        <button
          onClick={toggleNavBar}
          className={clsx(
            'flex items-center justify-center w-full h-10',
            'rounded-md text-text-secondary',
            'hover:bg-interactive-hover hover:text-text-primary',
            'transition-colors duration-fast'
          )}
          aria-label={navBarExpanded ? '折叠导航栏' : '展开导航栏'}
        >
          {navBarExpanded ? (
            <>
              <ChevronLeft size={18} />
              <span className="ml-2 text-sm">折叠</span>
            </>
          ) : (
            <ChevronRight size={18} />
          )}
        </button>
      </div>
    </nav>
  )
}

interface NavButtonProps {
  icon: React.ReactNode
  label: string
  href: string
  active?: boolean
  expanded: boolean
  variant?: 'default' | 'primary'
}

function NavButton({ icon, label, href, active, expanded, variant = 'default' }: NavButtonProps) {
  return (
    <a
      href={href}
      className={clsx(
        'flex items-center gap-3 h-10 px-3 rounded-md',
        'transition-colors duration-fast',
        expanded ? 'justify-start' : 'justify-center',
        active
          ? 'bg-interactive-active text-text-primary'
          : variant === 'primary'
            ? 'bg-primary-500/10 text-primary-400 hover:bg-primary-500/20'
            : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
      )}
      title={!expanded ? label : undefined}
    >
      {icon}
      {expanded && <span className="text-sm font-medium">{label}</span>}
    </a>
  )
}

interface SessionItemProps {
  title: string
  time: string
}

function SessionItem({ title, time }: SessionItemProps) {
  return (
    <a
      href="#"
      className={clsx(
        'flex items-center gap-2 px-3 py-2 rounded-md',
        'text-text-secondary hover:bg-interactive-hover hover:text-text-primary',
        'transition-colors duration-fast'
      )}
    >
      <MessageSquare size={16} />
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{title}</div>
        <div className="text-xs text-text-tertiary">{time}</div>
      </div>
    </a>
  )
}
