'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import clsx from 'clsx'
import { MessageSquare, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { apiClient } from '@/lib/api'
import { NEW_CHAT_PATH } from '@/constants/config'
import type { ApiResponse, Session } from '@/types'

interface ChatLayoutProps {
  children: React.ReactNode
}

function formatTime(dateString: string) {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'

  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days <= 0) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export default function ChatLayout({ children }: ChatLayoutProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [sessions, setSessions] = useState<Session[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const loadSessions = useCallback(async () => {
    try {
      setIsLoading(true)
      const response = await apiClient.get<ApiResponse<Session[]>>('/sessions')
      if (response.success && response.data) {
        setSessions(response.data)
      }
    } catch {
      // 聊天主流程优先，列表失败时静默降级
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions, pathname])

  const activeSessionId = useMemo(() => {
    const prefix = '/chat/'
    if (!pathname.startsWith(prefix) || pathname === NEW_CHAT_PATH) return null
    const id = pathname.slice(prefix.length)
    return id.length > 0 ? id : null
  }, [pathname])

  return (
    <div className="flex flex-1 min-w-0">
      <aside className="w-80 border-r border-border-subtle bg-bg-surface flex flex-col">
        <div className="p-4 border-b border-border-subtle space-y-2">
          <Button
            type="button"
            className="w-full"
            leftIcon={<Plus size={16} />}
            onClick={() => router.push(NEW_CHAT_PATH)}
            data-testid="new-session-btn"
          >
            新建会话
          </Button>
          <button
            type="button"
            onClick={() => void loadSessions()}
            className="w-full h-8 rounded-md border border-border-default text-text-secondary text-xs hover:bg-interactive-hover flex items-center justify-center gap-1.5"
          >
            <RefreshCw size={12} />
            刷新会话
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {!isLoading && sessions.length === 0 && (
            <p className="text-xs text-text-tertiary px-3 py-2">暂无会话</p>
          )}
          {sessions.map((session) => {
            const isActive = activeSessionId === session.id
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => router.push(`/chat/${session.id}`)}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-md',
                  'transition-colors duration-fast',
                  isActive
                    ? 'bg-interactive-active text-text-primary'
                    : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                )}
              >
                <div className="flex items-start gap-2">
                  <MessageSquare size={14} className="mt-0.5 flex-shrink-0 text-text-tertiary" />
                  <div className="min-w-0">
                    <p className="text-sm truncate">{session.title ?? '未命名会话'}</p>
                    <p className="text-xs text-text-tertiary mt-0.5">{formatTime(session.createdAt)}</p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      <section className="flex flex-1 min-w-0">{children}</section>
    </div>
  )
}
