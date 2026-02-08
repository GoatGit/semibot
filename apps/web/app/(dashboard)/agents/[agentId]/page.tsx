'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import clsx from 'clsx'
import { ArrowLeft, Save, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardDescription, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'
import { useLLMModels } from '@/hooks/useLLMModels'
import type { ApiResponse, Agent } from '@/types'

interface AgentFormValues {
  name: string
  description: string
  systemPrompt: string
  model: string
  temperature: number
  maxTokens: number
}

const EMPTY_VALUES: AgentFormValues = {
  name: '',
  description: '',
  systemPrompt: '',
  model: '',
  temperature: 0.7,
  maxTokens: 4096,
}

export default function AgentDetailPage() {
  const params = useParams()
  const router = useRouter()
  const agentId = params.agentId as string
  const isNew = agentId === 'new'
  const { models, loading: modelsLoading } = useLLMModels()

  const [values, setValues] = useState<AgentFormValues>(EMPTY_VALUES)
  const [isLoading, setIsLoading] = useState(!isNew)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const groupedModels = useMemo(() => {
    return models.reduce<Record<string, typeof models>>((acc, model) => {
      const key = model.providerName || model.providerType || 'Other'
      if (!acc[key]) {
        acc[key] = []
      }
      acc[key].push(model)
      return acc
    }, {})
  }, [models])

  useEffect(() => {
    if (isNew) {
      setValues((prev) => ({
        ...prev,
        model: models[0]?.modelId ?? '',
      }))
      setIsLoading(false)
      return
    }

    let cancelled = false
    const loadAgent = async () => {
      try {
        setIsLoading(true)
        setError(null)
        const response = await apiClient.get<ApiResponse<Agent>>(`/agents/${agentId}`)
        if (!response.success || !response.data || cancelled) {
          return
        }

        const agent = response.data
        const model = agent.config?.model || models[0]?.modelId || ''
        setValues({
          name: agent.name || '',
          description: agent.description || '',
          systemPrompt: agent.systemPrompt || '',
          model,
          temperature: agent.config?.temperature ?? 0.7,
          maxTokens: agent.config?.maxTokens ?? 4096,
        })
      } catch (err) {
        console.error('[AgentDetail] 加载失败:', err)
        if (!cancelled) {
          setError('加载 Agent 失败，请稍后重试')
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    loadAgent()
    return () => {
      cancelled = true
    }
  }, [agentId, isNew, models])

  const handleSave = async () => {
    if (!values.name.trim()) {
      setError('名称不能为空')
      return
    }
    if (!values.model) {
      setError('请选择可用模型')
      return
    }

    try {
      setIsSaving(true)
      setError(null)

      const payload = {
        name: values.name.trim(),
        description: values.description.trim(),
        systemPrompt: values.systemPrompt.trim(),
        config: {
          model: values.model,
          temperature: values.temperature,
          maxTokens: values.maxTokens,
        },
      }

      if (isNew) {
        const response = await apiClient.post<ApiResponse<Agent>>('/agents', payload)
        if (!response.success || !response.data) {
          throw new Error('创建失败')
        }
      } else {
        const response = await apiClient.patch<ApiResponse<Agent>>(`/agents/${agentId}`, payload)
        if (!response.success || !response.data) {
          throw new Error('更新失败')
        }
      }

      router.push('/agents')
    } catch (err) {
      console.error('[AgentDetail] 保存失败:', err)
      setError('保存失败，请稍后重试')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/agents"
              className={clsx(
                'p-2 rounded-md',
                'text-text-secondary hover:text-text-primary hover:bg-interactive-hover'
              )}
            >
              <ArrowLeft size={18} />
            </Link>
            <h1 className="text-lg font-semibold text-text-primary">
              {isNew ? '创建 Agent' : '编辑 Agent'}
            </h1>
          </div>
          <Button onClick={handleSave} loading={isSaving} leftIcon={<Save size={16} />}>
            {isNew ? '创建' : '保存'}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <Card className="max-w-3xl">
          <CardHeader>
            <div className="text-lg font-semibold text-text-primary">基础配置</div>
            <CardDescription>使用真实 API 保存 Agent 配置</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-48 flex items-center justify-center text-text-secondary">
                <Loader2 size={20} className="animate-spin mr-2" />
                加载中...
              </div>
            ) : (
              <div className="space-y-4">
                {error && (
                  <div className="p-3 rounded-md bg-error-500/10 border border-error-500/30 text-sm text-error-500">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">名称</label>
                  <Input
                    value={values.name}
                    onChange={(e) => setValues((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="输入 Agent 名称"
                    disabled={isSaving}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">描述</label>
                  <textarea
                    value={values.description}
                    onChange={(e) => setValues((prev) => ({ ...prev, description: e.target.value }))}
                    placeholder="输入描述"
                    disabled={isSaving}
                    className={clsx(
                      'w-full h-24 px-3 py-2 rounded-md resize-none',
                      'bg-bg-surface border border-border-default',
                      'text-text-primary placeholder:text-text-tertiary',
                      'focus:outline-none focus:border-primary-500'
                    )}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">模型</label>
                  <select
                    value={values.model}
                    onChange={(e) => setValues((prev) => ({ ...prev, model: e.target.value }))}
                    disabled={isSaving || modelsLoading || models.length === 0}
                    className={clsx(
                      'w-full px-3 py-2 rounded-md',
                      'bg-bg-surface border border-border-default text-text-primary',
                      'focus:outline-none focus:border-primary-500'
                    )}
                  >
                    {modelsLoading ? (
                      <option value="">加载中...</option>
                    ) : models.length === 0 ? (
                      <option value="">暂无可用模型</option>
                    ) : (
                      Object.entries(groupedModels).map(([providerName, providerModels]) => (
                        <optgroup key={providerName} label={providerName}>
                          {providerModels.map((model) => (
                            <option key={model.modelId} value={model.modelId}>
                              {model.displayName}
                            </option>
                          ))}
                        </optgroup>
                      ))
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">系统提示词</label>
                  <textarea
                    value={values.systemPrompt}
                    onChange={(e) => setValues((prev) => ({ ...prev, systemPrompt: e.target.value }))}
                    placeholder="输入系统提示词"
                    disabled={isSaving}
                    className={clsx(
                      'w-full h-40 px-3 py-2 rounded-md resize-none',
                      'bg-bg-surface border border-border-default',
                      'text-text-primary placeholder:text-text-tertiary',
                      'focus:outline-none focus:border-primary-500'
                    )}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
