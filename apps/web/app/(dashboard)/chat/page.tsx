'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { Plus, Trash2, MessageSquare, Bot, AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { apiClient } from '@/lib/api'
import type { ApiResponse, Session } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

/**
 * Chat Page - 会话列表页面
 *
 * 显示用户的所有会话，支持：
 * - 查看会话列表
 * - 创建新会话
 * - 删除会话
 * - 选择会话进入对话
 */
export default function ChatPage() {
  const router = useRouter()
  const { locale, t } = useLocale()
  const [sessions, setSessions] = useState<Session[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // 加载会话列表
  const loadSessions = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    try {
      if (mode === 'initial') {
        setIsLoading(true)
      } else {
        setIsRefreshing(true)
      }
      setError(null)

      const response = await apiClient.get<ApiResponse<Session[]>>('/sessions')

      if (response.success && response.data) {
        setSessions(response.data)
      } else {
        throw new Error(response.error?.message ?? (locale === 'en-US' ? 'Failed to load sessions' : '加载会话列表失败'))
      }
    } catch (err) {
      console.error('[Chat] 加载会话列表失败:', err)
      setError(err instanceof Error ? err.message : (locale === 'en-US' ? 'Failed to load sessions' : '加载会话列表失败'))
    } finally {
      if (mode === 'initial') {
        setIsLoading(false)
      } else {
        setIsRefreshing(false)
      }
    }
  }, [locale])

  useEffect(() => {
    void loadSessions('initial')
  }, [loadSessions])

  // 创建新会话
  const handleCreateSession = () => {
    router.push('/chat/new')
  }

  // 选择会话
  const handleSelectSession = (sessionId: string) => {
    router.push(`/chat/${sessionId}`)
  }

  // 删除会话
  const handleDeleteSession = async (sessionId: string) => {
    try {
      setIsDeleting(true)
      await apiClient.delete(`/sessions/${sessionId}`)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      setConfirmDeleteId(null)
    } catch (err) {
      console.error('[Chat] 删除会话失败:', err)
      setError(err instanceof Error ? err.message : (locale === 'en-US' ? 'Failed to delete session' : '删除会话失败'))
    } finally {
      setIsDeleting(false)
    }
  }

  // 刷新会话
  const handleRefreshSessions = async () => {
    if (isLoading || isRefreshing) return
    await loadSessions('refresh')
  }

  // 格式化时间
  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (days === 0) {
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    } else if (days === 1) {
      return locale === 'en-US' ? 'Yesterday' : '昨天'
    } else if (days < 7) {
      return locale === 'en-US' ? `${days}d ago` : `${days} 天前`
    } else {
      return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
    }
  }

  // 加载中状态
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 bg-bg-base">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
        <p className="mt-4 text-text-secondary">{locale === 'en-US' ? 'Loading sessions...' : '加载会话列表...'}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 bg-bg-base">
      {/* 侧边栏 - 会话列表 */}
      <aside className="w-80 border-r border-border-subtle bg-bg-surface flex flex-col">
        <div className="p-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1 border-border-default bg-bg-base text-text-primary hover:bg-interactive-hover"
              leftIcon={<Plus size={16} />}
              onClick={handleCreateSession}
              data-testid="new-session-btn"
            >
              {t('chat.newChat')}
            </Button>
            <Button
              type="button"
              variant="tertiary"
              size="sm"
              className="h-10 px-3 border border-border-default text-text-secondary hover:text-text-primary"
              onClick={handleRefreshSessions}
              disabled={isRefreshing}
              leftIcon={<RefreshCw size={14} className={clsx(isRefreshing && 'animate-spin')} />}
              aria-label={locale === 'en-US' ? 'Refresh sessions' : '刷新会话'}
            >
              {locale === 'en-US' ? 'Refresh' : '刷新'}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="p-4">
              <div className="flex items-center gap-2 p-3 rounded-md bg-error-500/10 border border-error-500/20">
                <AlertCircle size={16} className="text-error-500 flex-shrink-0" />
                <p className="text-sm text-error-500">{error}</p>
              </div>
            </div>
          )}

          {sessions.length === 0 && !error ? (
            <div className="p-6 text-center">
              <MessageSquare size={48} className="mx-auto text-text-tertiary mb-4" />
              <p className="text-text-secondary text-sm">{locale === 'en-US' ? 'No sessions' : '暂无会话'}</p>
              <p className="text-text-tertiary text-xs mt-1">
                {locale === 'en-US' ? 'Click above to start a new chat' : '点击上方按钮创建新会话'}
              </p>
            </div>
          ) : (
            <div className="p-3 space-y-1">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={clsx(
                    'group flex items-center justify-between gap-2 px-3 py-3 rounded-lg',
                    'transition-colors duration-fast cursor-pointer',
                    'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                  )}
                  onClick={() => handleSelectSession(session.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSelectSession(session.id)
                  }}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                      <Bot size={16} className="text-primary-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {session.title ?? (locale === 'en-US' ? 'Untitled chat' : '未命名会话')}
                      </p>
                      <p className="text-xs text-text-tertiary">
                        {formatTime(session.createdAt)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDeleteId(session.id)
                    }}
                    className={clsx(
                      'p-1.5 rounded-md opacity-0 group-hover:opacity-100',
                      'text-text-tertiary hover:text-error-500 hover:bg-error-500/10',
                      'transition-all duration-fast'
                    )}
                    aria-label={locale === 'en-US' ? 'Delete session' : '删除会话'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* 主内容区 - 欢迎页 */}
      <div className="flex flex-col flex-1 min-h-0 items-center justify-center">
        <div className="text-center max-w-md px-6">
          <div className="w-20 h-20 rounded-2xl bg-primary-500/20 flex items-center justify-center mx-auto mb-6">
            <MessageSquare size={40} className="text-primary-400" />
          </div>
          <h1 className="text-2xl font-semibold text-text-primary mb-3">
            {locale === 'en-US' ? 'Select a session to start' : '选择一个会话开始对话'}
          </h1>
          <p className="text-text-secondary mb-6">
            {locale === 'en-US'
              ? 'Pick an existing session from the left, or create a new one to chat with your AI assistant.'
              : '从左侧选择一个已有会话，或创建新会话开始与 AI 助手交流'}
          </p>
          <Button onClick={handleCreateSession} leftIcon={<Plus size={16} />}>
            {locale === 'en-US' ? 'Create New Chat' : '创建新会话'}
          </Button>
        </div>
      </div>

      {/* 删除确认弹窗 */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">确认删除会话</h3>
            <p className="text-sm text-text-secondary">
              {locale === 'en-US' ? 'Messages in this session cannot be recovered after deletion.' : '删除后该会话的消息将无法恢复。'}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                disabled={isDeleting}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                type="button"
                onClick={() => handleDeleteSession(confirmDeleteId)}
                loading={isDeleting}
              >
                {locale === 'en-US' ? 'Delete' : '确认删除'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
