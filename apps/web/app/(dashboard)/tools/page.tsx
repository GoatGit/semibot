'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Wrench, RefreshCw, AlertCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { apiClient } from '@/lib/api'
import { formatRuntimeStatusError } from '@/lib/runtime-status'
import { useLocale } from '@/components/providers/LocaleProvider'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface ToolItem {
  id: string
  name: string
  type: string
  description?: string
  isBuiltin: boolean
  isActive: boolean
}

interface RuntimeSkillsData {
  available: boolean
  tools: string[]
  skills: string[]
  source: string
  error?: string
}
const MIN_BUILTIN_TOOLS = ['search', 'code_executor', 'file_io', 'browser_automation']
const NON_TOOL_SKILLS = ['xlsx', 'pdf']

function mergeTools(runtimeTools: string[], dbTools: ToolItem[]): ToolItem[] {
  const runtimeFiltered = runtimeTools.filter((name) => !NON_TOOL_SKILLS.includes(name))
  const dbFiltered = dbTools.filter((item) => !NON_TOOL_SKILLS.includes(item.name))
  const byName = new Map(dbFiltered.map((item) => [item.name, item]))
  const merged: ToolItem[] = runtimeFiltered.map((name) => {
    const db = byName.get(name)
    return {
      id: db?.id || `builtin:${name}`,
      name,
      type: db?.type || 'builtin',
      description: db?.description || '',
      isBuiltin: true,
      isActive: db?.isActive ?? true,
    }
  })
  for (const item of dbFiltered) {
    if (!runtimeFiltered.includes(item.name)) {
      merged.push(item)
    }
  }
  return merged
}

export default function ToolsPage() {
  const router = useRouter()
  const { t } = useLocale()
  const [tools, setTools] = useState<ToolItem[]>([])
  const [runtime, setRuntime] = useState<RuntimeSkillsData>({
    available: false,
    tools: [],
    skills: [],
    source: '',
  })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const [toolsRes, runtimeRes] = await Promise.allSettled([
        apiClient.get<ApiResponse<ToolItem[]>>('/tools', { params: { page: 1, limit: 100 } }),
        apiClient.get<ApiResponse<RuntimeSkillsData>>('/runtime/skills'),
      ])

      const dbTools = toolsRes.status === 'fulfilled' && toolsRes.value.success ? (toolsRes.value.data || []) : []
      const runtimeData: RuntimeSkillsData =
        runtimeRes.status === 'fulfilled' && runtimeRes.value.success
          ? runtimeRes.value.data
          : {
              available: false,
              tools: [],
              skills: [],
              source: '',
              error: t('toolsPage.runtimeUnavailable'),
            }
      const unifiedTools = Array.from(new Set([...(runtimeData.tools || []), ...MIN_BUILTIN_TOOLS])).filter(
        (name) => !NON_TOOL_SKILLS.includes(name)
      )
      setRuntime({ ...runtimeData, tools: unifiedTools })
      setTools(mergeTools(unifiedTools, dbTools))

      if (
        (toolsRes.status === 'rejected' || !toolsRes.value.success) &&
        (runtimeRes.status === 'rejected' || !runtimeRes.value.success)
      ) {
        setError(t('toolsPage.error.load'))
      }
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const stats = useMemo(() => {
    const active = tools.filter((item) => item.isActive).length
    return {
      allTools: tools.length,
      active,
      runtimeConnected: runtime.available ? 1 : 0,
    }
  }, [runtime.available, tools])

  const runtimeErrorText = useMemo(
    () => formatRuntimeStatusError(runtime.error, runtime.source),
    [runtime.error, runtime.source]
  )

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                  <Wrench size={22} className="text-primary-400" />
                  {t('toolsPage.title')}
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  {t('toolsPage.subtitle')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />}
                  onClick={() => void loadData()}
                >
                  {t('common.refresh')}
                </Button>
                <Button onClick={() => router.push('/config')}>{t('toolsPage.openConfig')}</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500 flex items-center gap-2">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatCard label={t('toolsPage.stats.total')} value={stats.allTools} />
          <StatCard label={t('toolsPage.stats.enabled')} value={stats.active} />
          <StatCard label={t('toolsPage.stats.runtimeConnected')} value={stats.runtimeConnected} />
        </div>

        <div className="grid grid-cols-1 gap-4">
          <Card className="border-border-default">
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-text-primary">{t('toolsPage.configTitle')}</h2>
                <Badge variant={runtime.available ? 'success' : 'outline'}>
                  {runtime.available ? t('toolsPage.connected') : t('toolsPage.disconnected')}
                </Badge>
              </div>
              {runtimeErrorText && (
                <p className="mt-2 text-xs text-warning-500">{runtimeErrorText}</p>
              )}
              {isLoading ? (
                <p className="mt-4 text-sm text-text-secondary">{t('common.loading')}</p>
              ) : tools.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {tools.map((tool) => (
                    <div
                      key={tool.id}
                      className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {tool.name}
                          </p>
                          <p className="mt-1 text-xs text-text-tertiary">
                            {tool.type}
                            {tool.description ? ` · ${tool.description}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {tool.isBuiltin && <Badge variant="outline">{t('toolsPage.builtin')}</Badge>}
                          <Badge variant={tool.isActive ? 'success' : 'outline'}>
                            {tool.isActive ? t('toolsPage.enabled') : t('toolsPage.disabled')}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-text-secondary">{t('toolsPage.empty')}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="border-border-default">
      <CardContent className="p-4">
        <p className="text-sm text-text-secondary">{label}</p>
        <p className="mt-2 text-2xl font-semibold text-text-primary">{value}</p>
      </CardContent>
    </Card>
  )
}
