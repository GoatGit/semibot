'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import clsx from 'clsx'
import { ArrowLeft, Save, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardDescription, CardContent } from '@/components/ui/Card'
import { Select, type SelectGroup } from '@/components/ui/Select'
import { apiClient } from '@/lib/api'
import { useLLMModels } from '@/hooks/useLLMModels'
import { useSkillDefinitions } from '@/hooks/useSkillDefinitions'
import { useMcpServers } from '@/hooks/useMcpServers'
import type { ApiResponse, Agent } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

interface AgentFormValues {
  name: string
  description: string
  systemPrompt: string
  model: string
  temperature: number
  maxTokens: number
  runtimeType: 'semigraph' | 'openclaw'
}

const EMPTY_VALUES: AgentFormValues = {
  name: '',
  description: '',
  systemPrompt: '',
  model: '',
  temperature: 0.7,
  maxTokens: 4096,
  runtimeType: 'semigraph',
}

export default function AgentDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { t } = useLocale()
  const agentId = params.agentId as string
  const isNew = agentId === 'new'
  const { models, loading: modelsLoading } = useLLMModels()

  const [values, setValues] = useState<AgentFormValues>(EMPTY_VALUES)
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(!isNew)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { definitions: availableSkillDefs, loading: skillsLoading, fetchDefinitions } = useSkillDefinitions({
    limit: 100,
    isActive: true,
  })

  useEffect(() => {
    fetchDefinitions()
  }, [fetchDefinitions])
  const { servers: availableMcpServers, loading: mcpLoading } = useMcpServers()

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

  const modelOptions: SelectGroup[] = useMemo(() => {
    const groups = Object.entries(groupedModels).map(([providerName, providerModels]) => ({
      label: providerName,
      options: providerModels.map((model) => ({
        value: model.modelId,
        label: model.displayName,
      })),
    }))
    // If current value is not in the list, add it as a standalone option
    if (values.model && !models.some((m) => m.modelId === values.model)) {
      groups.unshift({
        label: t('agentsDetail.current'),
        options: [{ value: values.model, label: t('agentsDetail.currentModelNotInList', { model: values.model }) }],
      })
    }
    return groups
  }, [groupedModels, models, values.model, t])

  // 新建时：等 models 加载完后设置默认模型
  useEffect(() => {
    if (isNew && models.length > 0) {
      setValues((prev) => ({
        ...prev,
        model: prev.model || models[0]?.modelId || '',
      }))
      setIsLoading(false)
    }
  }, [isNew, models])

  // 编辑时：只在 agentId 变化时加载一次，不依赖 models
  useEffect(() => {
    if (isNew) return

    let cancelled = false
    const loadAgent = async () => {
      try {
        setIsLoading(true)
        setError(null)
        const response = await apiClient.get<ApiResponse<Agent & {
          mcpServerIds?: string[]
          runtimeType?: 'semigraph' | 'openclaw'
        }>>(`/agents/${agentId}`)
        if (!response.success || !response.data || cancelled) {
          return
        }

        const agent = response.data
        setValues({
          name: agent.name || '',
          description: agent.description || '',
          systemPrompt: agent.systemPrompt || '',
          model: agent.config?.model || '',
          temperature: agent.config?.temperature ?? 0.7,
          maxTokens: agent.config?.maxTokens ?? 4096,
          runtimeType: agent.runtimeType ?? 'semigraph',
        })
        setSelectedSkills(agent.skills || [])
        setSelectedMcpServerIds(agent.mcpServerIds || [])
      } catch (err) {
        console.error('[AgentDetail] 加载失败:', err)
        if (!cancelled) {
          setError(t('agentsDetail.error.load'))
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
  }, [agentId, isNew, t])

  const handleSave = async () => {
    if (!values.name.trim()) {
      setError(t('agentsDetail.error.nameRequired'))
      return
    }
    if (!values.model) {
      setError(t('agentsDetail.error.modelRequired'))
      return
    }

    try {
      setIsSaving(true)
      setError(null)

      const payload = {
        name: values.name.trim(),
        description: values.description.trim(),
        systemPrompt: values.systemPrompt.trim(),
        runtimeType: values.runtimeType,
        config: {
          model: values.model,
          temperature: values.temperature,
          maxTokens: values.maxTokens,
        },
        skills: selectedSkills,
        mcpServerIds: selectedMcpServerIds,
      }

      if (isNew) {
        const response = await apiClient.post<ApiResponse<Agent>>('/agents', payload)
        if (!response.success || !response.data) {
          throw new Error(t('agentsDetail.error.createFailed'))
        }
      } else {
        const response = await apiClient.put<ApiResponse<Agent>>(`/agents/${agentId}`, payload)
        if (!response.success || !response.data) {
          throw new Error(t('agentsDetail.error.updateFailed'))
        }
      }

      router.push('/agents')
    } catch (err) {
      console.error('[AgentDetail] 保存失败:', err)
      setError(t('agentsDetail.error.save'))
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
              {isNew ? t('agentsDetail.createTitle') : t('agentsDetail.editTitle')}
            </h1>
          </div>
          <Button onClick={handleSave} loading={isSaving} leftIcon={<Save size={16} />}>
            {isNew ? t('common.create') : t('common.save')}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <Card className="max-w-3xl">
          <CardHeader>
            <div className="text-lg font-semibold text-text-primary">{t('agentsDetail.basicConfig')}</div>
            <CardDescription>{t('agentsDetail.basicConfigDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-48 flex items-center justify-center text-text-secondary">
                <Loader2 size={20} className="animate-spin mr-2" />
                {t('common.loading')}
              </div>
            ) : (
              <div className="space-y-4">
                {error && (
                  <div className="p-3 rounded-md bg-error-500/10 border border-error-500/30 text-sm text-error-500">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">{t('agent.name')}</label>
                  <Input
                    value={values.name}
                    onChange={(e) => setValues((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder={t('agentsDetail.namePlaceholder')}
                    disabled={isSaving}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">{t('agent.description')}</label>
                  <textarea
                    value={values.description}
                    onChange={(e) => setValues((prev) => ({ ...prev, description: e.target.value }))}
                    placeholder={t('agentsDetail.descriptionPlaceholder')}
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
                  <label className="block text-sm font-medium text-text-primary mb-1.5">{t('agent.model')}</label>
                  <Select
                    value={values.model}
                    onChange={(val) => setValues((prev) => ({ ...prev, model: val }))}
                    disabled={isSaving || modelsLoading || models.length === 0}
                    options={modelOptions}
                    placeholder={
                      modelsLoading
                        ? t('common.loading')
                        : models.length === 0
                          ? t('agentsDetail.noModels')
                          : t('agentsDetail.selectModel')
                    }
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">{t('agent.runtimeEngine')}</label>
                  <Select
                    value={values.runtimeType}
                    onChange={(val) => setValues((prev) => ({
                      ...prev,
                      runtimeType: (val === 'openclaw' ? 'openclaw' : 'semigraph'),
                    }))}
                    disabled={isSaving}
                    options={[
                      { value: 'semigraph', label: 'Semigraph' },
                      { value: 'openclaw', label: 'OpenClaw' },
                    ]}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">{t('agent.systemPrompt')}</label>
                  <textarea
                    value={values.systemPrompt}
                    onChange={(e) => setValues((prev) => ({ ...prev, systemPrompt: e.target.value }))}
                    placeholder={t('agentsDetail.systemPromptPlaceholder')}
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

        <Card className="max-w-3xl mt-6">
          <CardHeader>
            <div className="text-lg font-semibold text-text-primary">{t('agentsDetail.skillsTitle')}</div>
            <CardDescription>{t('agentsDetail.skillsDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {skillsLoading ? (
              <div className="h-20 flex items-center justify-center text-text-secondary">
                <Loader2 size={16} className="animate-spin mr-2" />
                {t('agentsDetail.loadingSkills')}
              </div>
            ) : availableSkillDefs.length === 0 ? (
              <div className="text-sm text-text-tertiary">{t('agentsDetail.noSkills')}</div>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {availableSkillDefs.map((def) => (
                  <label
                    key={def.id}
                    className={clsx(
                      'flex items-center gap-3 p-2 rounded-md cursor-pointer',
                      'hover:bg-interactive-hover',
                      selectedSkills.includes(def.id) && 'bg-primary-500/5'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSkills.includes(def.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedSkills((prev) => [...prev, def.id])
                        } else {
                          setSelectedSkills((prev) => prev.filter((id) => id !== def.id))
                        }
                      }}
                      disabled={isSaving}
                      className="rounded border-border-default"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-text-primary truncate">{def.name}</span>
                        {def.isPublic && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-500 shrink-0">
                            {t('agentsDetail.builtin')}
                          </span>
                        )}
                      </div>
                      {def.description && (
                        <div className="text-xs text-text-tertiary truncate">{def.description}</div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="max-w-3xl mt-6">
          <CardHeader>
            <div className="text-lg font-semibold text-text-primary">{t('agentsDetail.mcpTitle')}</div>
            <CardDescription>{t('agentsDetail.mcpDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {mcpLoading ? (
              <div className="h-20 flex items-center justify-center text-text-secondary">
                <Loader2 size={16} className="animate-spin mr-2" />
                {t('agentsDetail.loadingMcp')}
              </div>
            ) : availableMcpServers.length === 0 ? (
              <div className="text-sm text-text-tertiary">{t('agentsDetail.noMcp')}</div>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {availableMcpServers.map((server) => (
                  <label
                    key={server.id}
                    className={clsx(
                      'flex items-center gap-3 p-2 rounded-md cursor-pointer',
                      'hover:bg-interactive-hover',
                      selectedMcpServerIds.includes(server.id) && 'bg-primary-500/5'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedMcpServerIds.includes(server.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedMcpServerIds((prev) => [...prev, server.id])
                        } else {
                          setSelectedMcpServerIds((prev) => prev.filter((id) => id !== server.id))
                        }
                      }}
                      disabled={isSaving}
                      className="rounded border-border-default"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-text-primary truncate">{server.name}</span>
                        {server.isSystem && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-500 shrink-0">
                            {t('agentsDetail.system')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-text-tertiary truncate">
                        {server.transport} · {server.endpoint}
                      </div>
                    </div>
                    <span
                      className={clsx(
                        'text-xs px-1.5 py-0.5 rounded',
                        server.status === 'connected'
                          ? 'bg-success-500/10 text-success-500'
                          : 'bg-text-tertiary/10 text-text-tertiary'
                      )}
                    >
                      {server.status}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
