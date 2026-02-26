'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Wrench, RefreshCw, AlertCircle, Cpu } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { apiClient } from '@/lib/api'

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

export default function ToolsPage() {
  const router = useRouter()
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

      if (toolsRes.status === 'fulfilled' && toolsRes.value.success) {
        setTools(toolsRes.value.data || [])
      } else {
        setTools([])
      }

      if (runtimeRes.status === 'fulfilled' && runtimeRes.value.success) {
        setRuntime(runtimeRes.value.data)
      } else {
        setRuntime({
          available: false,
          tools: [],
          skills: [],
          source: '',
          error: 'Runtime 未连接',
        })
      }

      if (
        (toolsRes.status === 'rejected' || !toolsRes.value.success) &&
        (runtimeRes.status === 'rejected' || !runtimeRes.value.success)
      ) {
        setError('工具数据加载失败，请检查 API 与 Runtime 状态')
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const stats = useMemo(() => {
    const dbActive = tools.filter((item) => item.isActive).length
    return {
      runtimeTools: runtime.tools.length,
      dbTools: tools.length,
      dbActive,
    }
  }, [runtime.tools.length, tools])

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                  <Wrench size={22} className="text-primary-400" />
                  Tools 能力中心
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  查看 Runtime 内置工具与数据库工具定义，确保执行能力可用。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />}
                  onClick={() => void loadData()}
                >
                  刷新
                </Button>
                <Button onClick={() => router.push('/config')}>进入配置管理</Button>
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
          <StatCard label="Runtime Tools" value={stats.runtimeTools} />
          <StatCard label="DB Tools" value={stats.dbTools} />
          <StatCard label="Active DB Tools" value={stats.dbActive} />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card className="border-border-default">
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Cpu size={18} className="text-primary-400" />
                  Runtime 内置工具
                </h2>
                <Badge variant={runtime.available ? 'success' : 'outline'}>
                  {runtime.available ? '已连接' : '未连接'}
                </Badge>
              </div>
              {runtime.error && (
                <p className="mt-2 text-xs text-warning-500">{runtime.error}</p>
              )}
              <p className="mt-2 text-xs text-text-tertiary break-all">
                source: {runtime.source || '--'}
              </p>

              {isLoading ? (
                <p className="mt-4 text-sm text-text-secondary">加载中...</p>
              ) : runtime.tools.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {runtime.tools.map((name) => (
                    <span
                      key={name}
                      className="rounded border border-border-subtle bg-bg-surface px-2 py-1 text-xs text-text-secondary"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-text-secondary">暂无 Runtime 工具数据</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-border-default">
            <CardContent className="p-5">
              <h2 className="text-lg font-semibold text-text-primary">数据库工具</h2>
              {isLoading ? (
                <p className="mt-4 text-sm text-text-secondary">加载中...</p>
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
                          {tool.isBuiltin && <Badge variant="outline">内置</Badge>}
                          <Badge variant={tool.isActive ? 'success' : 'outline'}>
                            {tool.isActive ? '启用' : '停用'}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-text-secondary">暂无数据库工具</p>
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
