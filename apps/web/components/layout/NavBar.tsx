'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useLayoutStore } from '@/stores/layoutStore'
import { useAuthStore } from '@/stores/authStore'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { MS_PER_DAY, RELATIVE_TIME_DAYS_THRESHOLD } from '@/constants/config'
import clsx from 'clsx'
import {
  Home,
  Bot,
  Settings,
  Plus,
  MessageSquare,
  Sparkles,
  Puzzle,
  User,
  LogOut,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { apiClient } from '@/lib/api'
import type { ApiResponse, Session } from '@/types'

interface NavItem {
  icon: React.ReactNode
  label: string
  href: string
}

const navItems: NavItem[] = [
  { icon: <Home size={20} />, label: '首页', href: '/' },
  { icon: <Bot size={20} />, label: 'Agents', href: '/agents' },
  { icon: <Sparkles size={20} />, label: 'Skills', href: '/skills' },
  { icon: <Puzzle size={20} />, label: 'MCP', href: '/mcp' },
]

/**
 * NavBar - 左侧导航栏
 *
 * 根据 ARCHITECTURE.md 设计:
 * - 展开状态: 240px
 * - 折叠状态: 60px
 * - 包含: 主导航入口 + 会话列表
 * - 首页自动展开，其他页面自动收起
 * - 折叠状态下鼠标悬停自动展开
 */
const NAVBAR_SESSION_LIMIT = 10

export function NavBar() {
  const { navBarExpanded } = useLayoutStore()
  const { user, logout } = useAuthStore()
  const pathname = usePathname()
  const router = useRouter()
  const [isHovered, setIsHovered] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [sessionPage, setSessionPage] = useState(1)
  const [hasMoreSessions, setHasMoreSessions] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭用户菜单
  useEffect(() => {
    if (!showUserMenu) return
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showUserMenu])

  // 加载最近会话列表
  useEffect(() => {
    let cancelled = false
    const loadSessions = async () => {
      try {
        setIsLoadingSessions(true)
        const response = await apiClient.get<ApiResponse<Session[]>>('/sessions', {
          params: { limit: NAVBAR_SESSION_LIMIT, page: 1 },
        })
        if (!cancelled && response.success && response.data) {
          setSessions(response.data)
          setSessionPage(1)
          setHasMoreSessions(response.data.length >= NAVBAR_SESSION_LIMIT)
        }
      } catch {
        // 静默处理，不影响导航栏其他功能
      } finally {
        if (!cancelled) {
          setIsLoadingSessions(false)
        }
      }
    }
    loadSessions()
    return () => { cancelled = true }
  }, [])

  // 加载更多会话
  const loadMoreSessions = useCallback(async () => {
    if (isLoadingMore || !hasMoreSessions) return
    const nextPage = sessionPage + 1
    try {
      setIsLoadingMore(true)
      const response = await apiClient.get<ApiResponse<Session[]>>('/sessions', {
        params: { limit: NAVBAR_SESSION_LIMIT, page: nextPage },
      })
      if (response.success && response.data) {
        const newSessions = response.data
        setSessions((prev) => [...prev, ...newSessions])
        setSessionPage(nextPage)
        setHasMoreSessions(newSessions.length >= NAVBAR_SESSION_LIMIT)
      }
    } catch {
      // 静默处理
    } finally {
      setIsLoadingMore(false)
    }
  }, [isLoadingMore, hasMoreSessions, sessionPage])

  // IntersectionObserver 监听哨兵元素
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollContainerRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMoreSessions && !isLoadingMore) {
          loadMoreSessions()
        }
      },
      { root, threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreSessions, isLoadingMore, loadMoreSessions])

  // 实际显示的展开状态：固定展开 或 悬停展开
  const isExpanded = navBarExpanded || isHovered

  const handleMouseEnter = useCallback(() => {
    if (!navBarExpanded) {
      setIsHovered(true)
    }
  }, [navBarExpanded])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
  }, [])

  return (
    <nav
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={clsx(
        'flex flex-col h-full',
        'bg-bg-surface border-r border-border-subtle',
        'transition-all duration-normal ease-out',
        isExpanded ? 'w-60' : 'w-[60px]'
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
          {isExpanded && (
            <span className="font-display font-semibold text-lg text-text-primary whitespace-nowrap">
              Semibot
            </span>
          )}
        </div>
      </div>

      {/* 导航项 */}
      <div ref={scrollContainerRef} className="flex-1 py-4 space-y-1 px-2 overflow-y-auto">
        {navItems.map((item) => (
          <NavButton
            key={item.href}
            icon={item.icon}
            label={item.label}
            href={item.href}
            active={pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))}
            expanded={isExpanded}
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
          expanded={isExpanded}
          variant="primary"
        />

        {/* 会话列表 */}
        {isExpanded && (
          <div className="mt-2 space-y-1">
            {isLoadingSessions ? (
              <>
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 animate-pulse">
                    <div className="w-4 h-4 rounded bg-neutral-700" />
                    <div className="flex-1 space-y-1">
                      <div className="h-3 bg-neutral-700 rounded w-3/4" />
                      <div className="h-2 bg-neutral-700 rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </>
            ) : sessions.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-tertiary">暂无会话</p>
            ) : (
              <>
                {sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={pathname === `/chat/${session.id}`}
                  />
                ))}
                {isLoadingMore && (
                  <div className="flex items-center justify-center py-2">
                    <div className="w-4 h-4 border-2 border-text-tertiary border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {hasMoreSessions && <div ref={sentinelRef} className="h-4" />}
              </>
            )}
          </div>
        )}
      </div>

      {/* 用户菜单 */}
      <div className="border-t border-border-subtle p-2">
        <div className="relative" ref={userMenuRef}>
          <button
            type="button"
            data-testid="user-menu"
            aria-label="用户"
            onClick={() => setShowUserMenu((prev) => !prev)}
            className={clsx(
              'flex items-center gap-3 w-full h-10 px-3 rounded-md',
              'transition-colors duration-fast',
              'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
            )}
          >
            <div className="w-7 h-7 rounded-full bg-primary-500/20 flex items-center justify-center">
              <User size={14} className="text-primary-400" />
            </div>
            {isExpanded && (
              <span className="text-sm font-medium truncate">
                {user?.name || '用户'}
              </span>
            )}
          </button>

          {showUserMenu && (
            <div
              className={clsx(
                'absolute bottom-full left-0 mb-2 w-full',
                'bg-bg-elevated border border-border-default rounded-lg shadow-lg',
                'z-20'
              )}
            >
              <Link
                href="/settings"
                className={clsx(
                  'flex items-center gap-2 w-full px-3 py-2 text-sm',
                  'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                )}
                onClick={() => setShowUserMenu(false)}
              >
                <Settings size={14} />
                设置
              </Link>
              <div className="border-t border-border-subtle" />
              <button
                type="button"
                className={clsx(
                  'flex items-center gap-2 w-full px-3 py-2 text-sm',
                  'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                )}
                onClick={() => {
                  logout()
                  setShowUserMenu(false)
                  router.push('/login')
                }}
              >
                <LogOut size={14} />
                退出登录
              </button>
            </div>
          )}
        </div>
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
    <Link
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
    </Link>
  )
}

interface SessionItemProps {
  session: Session
  active?: boolean
}

function formatSessionTime(dateString: string): string {
  const date = new Date(dateString)
  if (isNaN(date.getTime())) {
    return '--'
  }
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / MS_PER_DAY)

  if (days === 0) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } else if (days === 1) {
    return '昨天'
  } else if (days < RELATIVE_TIME_DAYS_THRESHOLD) {
    return `${days} 天前`
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function SessionItem({ session, active }: SessionItemProps) {
  return (
    <Link
      href={`/chat/${session.id}`}
      className={clsx(
        'flex items-center gap-2 px-3 py-2 rounded-md',
        'transition-colors duration-fast',
        active
          ? 'bg-interactive-active text-text-primary'
          : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
      )}
    >
      <MessageSquare size={16} />
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{session.title ?? '未命名会话'}</div>
        <div className="text-xs text-text-tertiary">{formatSessionTime(session.createdAt)}</div>
      </div>
    </Link>
  )
}
