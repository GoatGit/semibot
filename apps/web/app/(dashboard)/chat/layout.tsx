'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import clsx from 'clsx'
import { MessageSquare, Plus, RefreshCw } from 'lucide-react'
import { AgentBotAvatar } from '@/components/ui/AgentBotAvatar'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { apiClient } from '@/lib/api'
import { NEW_CHAT_PATH } from '@/constants/config'
import type { ApiResponse, Session } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

interface ChatLayoutProps {
  children: React.ReactNode
}

interface GatewayConversationSummary {
  conversationId: string
  provider: string
  gatewayKey: string
  instanceId: string
  botId: string
  chatId: string
  updatedAt: string
  latestRun?: {
    runId: string
    resultSummary: string
    updatedAt: string
  } | null
}

interface RuntimeGatewayConversationsResponse {
  success: boolean
  data?: {
    conversations?: GatewayConversationSummary[]
  }
}

interface ChannelInstance {
  id: string
  displayName: string
  provider: string
  isActive?: boolean
}

type ConversationFilter = 'web' | `channel:${string}`

interface ConversationListItem {
  id: string
  title: string
  createdAt: string
  href: string
  filterKey: ConversationFilter
  kind: 'web' | 'channel'
}

function formatTime(dateString: string, locale: string) {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days <= 0) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  }
  if (days < 7) return rtf.format(-days, 'day')
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

export default function ChatLayout({ children }: ChatLayoutProps) {
  const router = useRouter()
  const pathname = usePathname()
  const { locale, t } = useLocale()
  const [sessions, setSessions] = useState<Session[]>([])
  const [channelConversations, setChannelConversations] = useState<GatewayConversationSummary[]>([])
  const [channelInstances, setChannelInstances] = useState<ChannelInstance[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedFilter, setSelectedFilter] = useState<ConversationFilter>('web')

  const isChannelBackedSession = useCallback((sessionId: string) => {
    const id = String(sessionId || '')
    return (
      id.startsWith('sess_telegram_') ||
      id.startsWith('sess_feishu_') ||
      id.startsWith('sess_discord_') ||
      id.startsWith('sess_whatsapp_') ||
      id.startsWith('sess_imessage_')
    )
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      setIsLoading(true)
      const [sessionsResponse, conversationsResponse, channelsResponse] = await Promise.allSettled([
        apiClient.get<ApiResponse<Session[]>>('/sessions'),
        apiClient.get<RuntimeGatewayConversationsResponse>('/runtime/channels/conversations', {
          params: { limit: 100 },
        }),
        apiClient.get<ApiResponse<ChannelInstance[]>>('/channels'),
      ])

      if (sessionsResponse.status === 'fulfilled' && sessionsResponse.value.success && sessionsResponse.value.data) {
        setSessions(sessionsResponse.value.data.filter((session) => !isChannelBackedSession(session.id)))
      }

      if (
        conversationsResponse.status === 'fulfilled' &&
        conversationsResponse.value.success &&
        Array.isArray(conversationsResponse.value.data?.conversations)
      ) {
        setChannelConversations(conversationsResponse.value.data?.conversations ?? [])
      }

      if (channelsResponse.status === 'fulfilled' && channelsResponse.value.success && channelsResponse.value.data) {
        setChannelInstances(channelsResponse.value.data)
      }
    } catch {
      // 聊天主流程优先，列表失败时静默降级
    } finally {
      setIsLoading(false)
    }
  }, [isChannelBackedSession])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const activeSessionId = useMemo(() => {
    const prefix = '/chat/'
    if (!pathname.startsWith(prefix) || pathname === NEW_CHAT_PATH) return null
    const id = pathname.slice(prefix.length)
    return id.length > 0 ? id : null
  }, [pathname])

  const channelNameMap = useMemo(() => {
    return new Map(channelInstances.map((instance) => [instance.id, instance.displayName || instance.provider]))
  }, [channelInstances])

  const filters = useMemo(() => {
    const base = [{ key: 'web' as const, label: t('dashboard.recentSessions.sources.web') }]
    const seen = new Set<string>()
    const channelFilters = channelInstances
      .map((instance) => {
        const instanceId = String(instance.id || '').trim()
        if (!instanceId || seen.has(instanceId)) return null
        seen.add(instanceId)
        const label = instance.displayName || channelNameMap.get(instanceId) || instance.provider || instanceId
        return {
          key: `channel:${instanceId}` as const,
          label,
        }
      })
      .filter((item): item is { key: `channel:${string}`; label: string } => item !== null)
      .sort((a, b) => a.label.localeCompare(b.label, locale))

    return [...base, ...channelFilters]
  }, [channelInstances, channelNameMap, locale, t])

  useEffect(() => {
    if (!filters.some((item) => item.key === selectedFilter)) {
      setSelectedFilter('web')
    }
  }, [filters, selectedFilter])

  const conversationItems = useMemo<ConversationListItem[]>(() => {
    const webItems = sessions.map((session) => ({
      id: `web:${session.id}`,
      title: session.title ?? t('chatLayout.untitled'),
      createdAt: session.createdAt,
      href: `/chat/${session.id}`,
      filterKey: 'web' as const,
      kind: 'web' as const,
    }))

    const channelItems = channelConversations.map((conversation) => {
      const instanceId = String(conversation.instanceId || '').trim()
      const filterKey = `channel:${instanceId}` as const
      const instanceLabel = channelNameMap.get(instanceId) || conversation.botId || instanceId
      const fallbackTitle = conversation.chatId
        ? `${instanceLabel} · ${conversation.chatId}`
        : `${instanceLabel} · ${conversation.conversationId.slice(0, 8)}`
      const title = conversation.latestRun?.resultSummary?.trim() || fallbackTitle
      return {
        id: `channel:${conversation.conversationId}`,
        title,
        createdAt: conversation.latestRun?.updatedAt || conversation.updatedAt,
        href: `/channel-conversations/${encodeURIComponent(conversation.conversationId)}`,
        filterKey,
        kind: 'channel' as const,
      }
    })

    return [...webItems, ...channelItems]
      .filter((item) => item.filterKey === selectedFilter)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [channelConversations, channelNameMap, selectedFilter, sessions, t])

  return (
    <div className="flex flex-1 min-w-0 overflow-hidden">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border-subtle bg-bg-surface">
        <div className="p-4 border-b border-border-subtle space-y-2">
          <Button
            type="button"
            className="w-full"
            leftIcon={<Plus size={16} />}
            onClick={() => router.push(NEW_CHAT_PATH)}
            data-testid="new-session-btn"
          >
            {t('chatLayout.newChat')}
          </Button>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={selectedFilter}
                onChange={(value) => setSelectedFilter(value as ConversationFilter)}
                options={filters.map((filter) => ({ value: filter.key, label: filter.label }))}
                size="sm"
                data-testid="chat-filter-select"
              />
            </div>
            <button
              type="button"
              onClick={() => void loadSessions()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-default text-text-secondary hover:bg-interactive-hover"
              aria-label={t('chatLayout.refresh')}
              title={t('chatLayout.refresh')}
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {!isLoading && conversationItems.length === 0 && (
            <p className="text-xs text-text-tertiary px-3 py-2">{t('chatLayout.noSessions')}</p>
          )}
          {conversationItems.map((item) => {
            const isActive = item.kind === 'web' && activeSessionId === item.id.replace(/^web:/, '')
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => router.push(item.href)}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-md',
                  'transition-colors duration-fast',
                  isActive
                    ? 'bg-interactive-active text-text-primary'
                    : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                )}
              >
                <div className="flex items-start gap-2">
                  {item.kind === 'web' ? (
                    <MessageSquare size={14} className="mt-0.5 flex-shrink-0 text-text-tertiary" />
                  ) : (
                    <AgentBotAvatar
                      agentId={item.id}
                      agentName={item.title}
                      size={14}
                      iconScale={0.72}
                      className="mt-0.5 flex-shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm truncate">{item.title || t('chatLayout.untitled')}</p>
                    <p className="text-xs text-text-tertiary mt-0.5">{formatTime(item.createdAt, locale)}</p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </aside>

      <section className="flex flex-1 min-w-0 overflow-hidden">{children}</section>
    </div>
  )
}
