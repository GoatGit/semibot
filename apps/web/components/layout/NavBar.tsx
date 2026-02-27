'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useLayoutStore } from '@/stores/layoutStore'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { MS_PER_DAY, RELATIVE_TIME_DAYS_THRESHOLD, NEW_CHAT_PATH } from '@/constants/config'
import clsx from 'clsx'
import {
  LayoutDashboard,
  Bot,
  SlidersHorizontal,
  Plus,
  MessageSquare,
  Sparkles,
  Puzzle,
  Wrench,
  Activity,
  Workflow,
  ShieldCheck,
  Languages,
} from 'lucide-react'
import { apiClient } from '@/lib/api'
import type { ApiResponse, Session } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

interface NavItem {
  icon: React.ReactNode
  label: string
  href: string
}

const navItems: NavItem[] = [
  { icon: <LayoutDashboard size={20} />, label: '仪表盘', href: '/dashboard' },
  { icon: <MessageSquare size={20} />, label: '会话', href: '/chat' },
  { icon: <Activity size={20} />, label: '事件', href: '/events' },
  { icon: <Workflow size={20} />, label: '规则', href: '/rules' },
  { icon: <ShieldCheck size={20} />, label: '审批', href: '/approvals' },
  { icon: <Bot size={20} />, label: 'Agents', href: '/agents' },
  { icon: <Sparkles size={20} />, label: 'Skills', href: '/skills' },
  { icon: <Puzzle size={20} />, label: 'MCP', href: '/mcp' },
  { icon: <Wrench size={20} />, label: 'Tools', href: '/tools' },
  { icon: <SlidersHorizontal size={20} />, label: '配置', href: '/config' },
]

const NAVBAR_SESSION_LIMIT = 10

export function NavBar() {
  const { navBarExpanded } = useLayoutStore()
  const pathname = usePathname()
  const { locale, setLocale } = useLocale()
  const [isHovered, setIsHovered] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [sessionPage, setSessionPage] = useState(1)
  const [hasMoreSessions, setHasMoreSessions] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

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
    void loadSessions()
    return () => {
      cancelled = true
    }
  }, [])

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

  const isExpanded = navBarExpanded || isHovered

  const sentinelVisibleRef = useRef(false)

  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollContainerRef.current
    if (!sentinel || !root) return

    const observer = new IntersectionObserver(
      (entries) => {
        sentinelVisibleRef.current = entries[0].isIntersecting
        if (entries[0].isIntersecting && hasMoreSessions && !isLoadingMore) {
          void loadMoreSessions()
        }
      },
      { root, threshold: 0.1 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [isExpanded, hasMoreSessions, isLoadingMore, loadMoreSessions])

  useEffect(() => {
    if (!isLoadingMore && hasMoreSessions && sentinelVisibleRef.current) {
      void loadMoreSessions()
    }
  }, [isLoadingMore, hasMoreSessions, loadMoreSessions])

  const handleMouseEnter = useCallback(() => {
    if (!navBarExpanded) {
      setIsHovered(true)
    }
  }, [navBarExpanded])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
  }, [])

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')
  }, [locale, setLocale])

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
      <div className={clsx('px-3 py-3', 'border-b border-border-subtle')}>
        <div className={clsx('flex items-center', isExpanded ? 'gap-2 px-1' : 'justify-center')}>
          <div className="w-8 h-8 rounded-lg bg-primary-500 flex items-center justify-center">
            <Bot size={18} className="text-neutral-950" />
          </div>
          {isExpanded && (
            <span className="font-display font-semibold text-lg text-text-primary whitespace-nowrap">
              Semibot
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={toggleLocale}
          className={clsx(
            'mt-2 w-full h-8 rounded-md border border-border-default',
            'text-xs transition-colors',
            'hover:bg-interactive-hover hover:text-text-primary',
            'text-text-secondary',
            isExpanded ? 'flex items-center justify-between px-2.5' : 'flex items-center justify-center'
          )}
          title={locale === 'zh-CN' ? 'Switch to English' : '切换到中文'}
          aria-label={locale === 'zh-CN' ? 'Switch to English' : '切换到中文'}
        >
          <span className="flex items-center gap-1.5">
            <Languages size={14} />
            {isExpanded && <span>{locale === 'zh-CN' ? '语言' : 'Language'}</span>}
          </span>
          {isExpanded && <span className="font-medium text-text-primary">{locale === 'zh-CN' ? '中文' : 'EN'}</span>}
        </button>
      </div>

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

        <div className="my-4 border-t border-border-subtle" />

        <NavButton
          icon={<Plus size={20} />}
          label={locale === 'zh-CN' ? '新建会话' : 'New Chat'}
          href={NEW_CHAT_PATH}
          active={pathname === NEW_CHAT_PATH}
          expanded={isExpanded}
          variant="primary"
        />

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
              <p className="px-3 py-2 text-xs text-text-tertiary">{locale === 'en-US' ? 'No sessions' : '暂无会话'}</p>
            ) : (
              <>
                {sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={pathname === `/chat/${session.id}`}
                    locale={locale}
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
  locale: string
}

function formatSessionTime(dateString: string, locale: string): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / MS_PER_DAY)

  if (days === 0) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  }
  if (days === 1) {
    return locale === 'en-US' ? 'Yesterday' : '昨天'
  }
  if (days < RELATIVE_TIME_DAYS_THRESHOLD) {
    return locale === 'en-US' ? `${days}d ago` : `${days} 天前`
  }
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

function SessionItem({ session, active, locale }: SessionItemProps) {
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
        <div className="text-sm truncate">{session.title ?? (locale === 'en-US' ? 'Untitled chat' : '未命名会话')}</div>
        <div className="text-xs text-text-tertiary">{formatSessionTime(session.createdAt, locale)}</div>
      </div>
    </Link>
  )
}
