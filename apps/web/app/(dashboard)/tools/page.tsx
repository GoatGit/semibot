'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw, Server, Wrench, TerminalSquare, ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardContent } from '@/components/ui/Card'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'
import { McpServersManager } from '@/components/tools/McpServersManager'

type ToolTab = 'builtin' | 'mcp' | 'cli'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface ToolCatalogItem {
  toolId: string
  toolName: string
  displayName: string
  description: string
  sourceType: 'builtin' | 'mcp' | 'cli'
  providerId?: string | null
}

interface ToolCatalogResponse {
  items: ToolCatalogItem[]
  generatedAt?: string
  source?: string
}

interface McpServerItem {
  id: string
  name: string
  description?: string
  endpoint?: string
  transport?: string
  status?: string
  isActive?: boolean
  isSystem?: boolean
  lastConnectedAt?: string | null
  tools?: unknown[]
  resources?: unknown[]
}

export default function ToolsPage() {
  const { t } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab] = useState<ToolTab>('builtin')
  const [catalogItems, setCatalogItems] = useState<ToolCatalogItem[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const tSafe = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const value = t(key, params)
      return value === key ? fallback : value
    },
    [t]
  )

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [catalogRes, mcpRes] = await Promise.allSettled([
        apiClient.get<ApiResponse<ToolCatalogResponse>>('/tools/catalog'),
        apiClient.get<ApiResponse<McpServerItem[]>>('/mcp', { params: { page: 1, limit: 100 } }),
      ])

      const nextCatalog =
        catalogRes.status === 'fulfilled' && catalogRes.value.success
          ? catalogRes.value.data?.items || []
          : []
      const nextMcpServers =
        mcpRes.status === 'fulfilled' && mcpRes.value.success
          ? mcpRes.value.data || []
          : []

      setCatalogItems(nextCatalog)
      setMcpServers(nextMcpServers)

      if (
        (catalogRes.status === 'rejected' || !catalogRes.value.success) &&
        (mcpRes.status === 'rejected' || !mcpRes.value.success)
      ) {
        setError(tSafe('toolsCenter.errors.load', 'Failed to load tools center'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tSafe('toolsCenter.errors.load', 'Failed to load tools center'))
    } finally {
      setIsLoading(false)
    }
  }, [tSafe])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    const requestedTab = String(searchParams.get('tab') || '').trim().toLowerCase()
    if (requestedTab === 'builtin' || requestedTab === 'mcp' || requestedTab === 'cli') {
      setActiveTab(requestedTab)
      return
    }
    setActiveTab('builtin')
  }, [searchParams])

  const updateActiveTab = useCallback(
    (nextTab: ToolTab) => {
      setActiveTab(nextTab)
      const params = new URLSearchParams(searchParams.toString())
      if (nextTab === 'builtin') {
        params.delete('tab')
      } else {
        params.set('tab', nextTab)
      }
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const builtinTools = useMemo(
    () => catalogItems.filter((item) => item.sourceType === 'builtin'),
    [catalogItems]
  )
  const cliTools = useMemo(
    () => catalogItems.filter((item) => item.sourceType === 'cli'),
    [catalogItems]
  )
  const mcpBackedTools = useMemo(
    () => catalogItems.filter((item) => item.sourceType === 'mcp'),
    [catalogItems]
  )

  const tabs = useMemo(
    () => [
      {
        id: 'builtin' as const,
        label: tSafe('toolsCenter.tabs.builtin', '内建工具'),
        count: builtinTools.length,
        icon: Wrench,
      },
      {
        id: 'mcp' as const,
        label: tSafe('toolsCenter.tabs.mcp', 'MCP 服务器'),
        count: mcpServers.length,
        icon: Server,
      },
      {
        id: 'cli' as const,
        label: tSafe('toolsCenter.tabs.cli', 'CLI 工具'),
        count: cliTools.length,
        icon: TerminalSquare,
      },
    ],
    [builtinTools.length, cliTools.length, mcpServers.length, tSafe]
  )

  const summaryCards = useMemo(
    () => [
      {
        label: tSafe('toolsCenter.summary.builtin', '内建工具'),
        value: builtinTools.length,
        helper: tSafe('toolsCenter.summary.builtinHelper', 'Runtime 自带能力'),
      },
      {
        label: tSafe('toolsCenter.summary.mcpServers', 'MCP 服务器'),
        value: mcpServers.length,
        helper: tSafe('toolsCenter.summary.mcpHelper', '外部连接与同步源'),
      },
      {
        label: tSafe('toolsCenter.summary.cliTools', 'CLI 工具'),
        value: cliTools.length,
        helper: tSafe('toolsCenter.summary.cliHelper', '本地 harness 与命令能力'),
      },
      {
        label: tSafe('toolsCenter.summary.mcpTools', 'MCP 工具'),
        value: mcpBackedTools.length,
        helper: tSafe('toolsCenter.summary.mcpToolsHelper', '由 MCP server 暴露'),
      },
    ],
    [builtinTools.length, cliTools.length, mcpBackedTools.length, mcpServers.length, tSafe]
  )

  const renderToolList = (items: ToolCatalogItem[], emptyTitle: string, emptyDescription: string) => {
    if (items.length === 0) {
      return (
        <Card className="border-border-default">
          <CardContent className="p-6">
            <p className="text-sm font-medium text-text-primary">{emptyTitle}</p>
            <p className="mt-1 text-sm text-text-secondary">{emptyDescription}</p>
          </CardContent>
        </Card>
      )
    }
    return (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {items.map((item) => (
          <Card key={item.toolId} className="border-border-default">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{item.displayName || item.toolName}</p>
                  <p className="mt-1 text-sm text-text-secondary">{item.description || '--'}</p>
                </div>
                <Badge variant="outline">{item.sourceType}</Badge>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-text-tertiary">
                <span className="rounded border border-border-subtle bg-bg-surface px-2 py-1 font-mono">
                  {item.toolName}
                </span>
                <span className="rounded border border-border-subtle bg-bg-surface px-2 py-1 font-mono">
                  {item.toolId}
                </span>
                {item.providerId ? (
                  <span className="rounded border border-border-subtle bg-bg-surface px-2 py-1">
                    provider: {item.providerId}
                  </span>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-text-tertiary">
                  {tSafe('toolsCenter.eyebrow', 'Tools Center')}
                </p>
                <h1 className="text-2xl font-semibold text-text-primary">
                  {tSafe('toolsCenter.title', '工具中心')}
                </h1>
                <p className="text-sm text-text-secondary">
                  {tSafe(
                    'toolsCenter.subtitle',
                    '统一查看内建工具、MCP 服务器和 CLI 工具。高级编辑仍保留在原有配置页面。'
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={() => void loadData()} disabled={isLoading}>
                  {tSafe('common.refresh', '刷新')}
                </Button>
                <Link href="/config" className="inline-flex">
                  <Button variant="tertiary" rightIcon={<ExternalLink size={14} />}>
                    {tSafe('toolsCenter.actions.config', '高级配置')}
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>

        {error ? <InlineErrorAlert message={error} onClose={() => setError(null)} /> : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map((card) => (
            <Card key={card.label} className="border-border-default">
              <CardContent className="p-5">
                <p className="text-sm text-text-secondary">{card.label}</p>
                <p className="mt-2 text-3xl font-semibold text-text-primary">{card.value}</p>
                <p className="mt-2 text-xs text-text-tertiary">{card.helper}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => updateActiveTab(tab.id)}
                className={[
                  'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors',
                  active
                    ? 'border-primary-500 bg-primary-500/10 text-primary-500'
                    : 'border-border-subtle bg-bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary',
                ].join(' ')}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
                <Badge variant="outline">{tab.count}</Badge>
              </button>
            )
          })}
        </div>

        {activeTab === 'builtin' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {tSafe('toolsCenter.sections.builtinTitle', '内建工具')}
                </h2>
                <p className="text-sm text-text-secondary">
                  {tSafe('toolsCenter.sections.builtinDescription', '这些能力随 runtime 提供，可直接进入 catalog。')}
                </p>
              </div>
            </div>
            {renderToolList(
              builtinTools,
              tSafe('toolsCenter.empty.builtinTitle', '暂无内建工具'),
              tSafe('toolsCenter.empty.builtinDescription', '当前 runtime 没有返回任何内建工具。')
            )}
          </div>
        ) : null}

        {activeTab === 'mcp' ? (
          <McpServersManager embedded />
        ) : null}

        {activeTab === 'cli' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {tSafe('toolsCenter.sections.cliTitle', 'CLI 工具')}
                </h2>
                <p className="text-sm text-text-secondary">
                  {tSafe('toolsCenter.sections.cliDescription', '本地 harness、命令包装器和通过 package 带入的工具。')}
                </p>
              </div>
              <Link href="/skills" className="inline-flex">
                <Button variant="tertiary" rightIcon={<ExternalLink size={14} />}>
                  {tSafe('toolsCenter.actions.openSkills', '查看技能包')}
                </Button>
              </Link>
            </div>
            {renderToolList(
              cliTools,
              tSafe('toolsCenter.empty.cliTitle', '暂无 CLI 工具'),
              tSafe('toolsCenter.empty.cliDescription', '当前没有检测到来自本地 harness 或 package 的 CLI 工具。')
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
