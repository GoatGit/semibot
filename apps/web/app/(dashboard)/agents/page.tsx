"use client"

import { useEffect, useState, useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { Bot, Plus, Search, Settings, Trash2, Loader2, Power } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { Select, type SelectGroup } from '@/components/ui/Select'
import { Tooltip } from '@/components/ui/Tooltip'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { ApiResponse, Agent } from '@/types'
import { useLLMModels, type LLMModel } from '@/hooks/useLLMModels'
import { useLocale } from '@/components/providers/LocaleProvider'

export default function AgentsPage() {
  const router = useRouter()
  const { locale, t } = useLocale()
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formValues, setFormValues] = useState({
    name: '',
    description: '',
    model: '',  // 将在模型列表加载后设置默认值
    systemPrompt: '',
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isToggling, setIsToggling] = useState(false)
  const [pageIndex, setPageIndex] = useState(1)

  // 获取 LLM 模型列表
  const { models: llmModels, loading: modelsLoading, error: modelsError } = useLLMModels()

  // 加载 Agent 列表
  const loadAgents = useCallback(async () => {
    try {
      setIsLoading(true)
      const response = await apiClient.get<ApiResponse<Agent[]>>('/agents')
      if (response.success && response.data) {
        setAgents(response.data)
      }
    } catch (err) {
      console.error('[Agents] 加载失败:', err)
      toast.error(t('agents.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    setPageIndex(1)
  }, [searchQuery, statusFilter])

  // 过滤和分页
  const filteredAgents = agents.filter((agent) => {
    const matchesSearch =
      agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (agent.description || '').toLowerCase().includes(searchQuery.toLowerCase())

    // API 返回的 isActive 是 boolean，这里做个转换
    const agentStatus = agent.isActive ? 'active' : 'inactive'
    const matchesStatus = statusFilter === 'all' || agentStatus === statusFilter

    return matchesSearch && matchesStatus
  })

  const statusCounts = {
    all: agents.length,
    active: agents.filter((a) => a.isActive).length,
    inactive: agents.filter((a) => !a.isActive).length,
  }

  const pageSize = 6
  const totalPages = Math.max(1, Math.ceil(filteredAgents.length / pageSize))
  const safePageIndex = Math.min(pageIndex, totalPages)
  const pagedAgents = filteredAgents.slice(
    (safePageIndex - 1) * pageSize,
    safePageIndex * pageSize
  )

  const openCreateForm = () => {
    const defaultModel = llmModels.length > 0 ? llmModels[0].modelId : ''
    setFormValues({ name: '', description: '', model: defaultModel, systemPrompt: '' })
    setFormErrors({})
    setShowForm(true)
  }

  const openEditForm = (agent: Agent) => {
    router.push(`/agents/${agent.id}`)
  }

  const handleSave = async () => {
    const errors: Record<string, string> = {}
    if (!formValues.name.trim()) {
      errors.name = t('agents.error.nameRequired')
    }
    if (!formValues.model) {
      errors.model = t('agents.error.modelRequired')
    }
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setIsSubmitting(true)
    try {
      const response = await apiClient.post<ApiResponse<Agent>>('/agents', {
        name: formValues.name.trim(),
        description: formValues.description.trim(),
        systemPrompt: formValues.systemPrompt,
        config: {
          model: formValues.model,
        },
        isActive: true,
      })

      if (response.success && response.data) {
        const newAgent = response.data
        setAgents((prev) => [newAgent, ...prev])
        toast.success(t('agents.toast.created'))
        setShowForm(false)
      }
    } catch (err) {
      console.error('[Agents] 保存失败:', err)
      toast.error(t('agents.error.save'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    setShowForm(false)
    setFormErrors({})
  }

  const handleToggleActive = async (agent: Agent) => {
    setIsToggling(true)
    try {
      await apiClient.put(`/agents/${agent.id}`, { isActive: !agent.isActive })
      setAgents((prev) => prev.map((a) => a.id === agent.id ? { ...a, isActive: !a.isActive } : a))
    } catch (err) {
      console.error('[Agents] 切换状态失败:', err)
      toast.error(t('agents.error.toggle'))
    } finally {
      setIsToggling(false)
    }
  }

  const handleDelete = (agent: Agent) => {
    setConfirmDelete(agent)
  }

  const confirmDeleteAgent = async () => {
    if (!confirmDelete) return

    setIsDeleting(true)
    try {
      await apiClient.delete(`/agents/${confirmDelete.id}`)
      setAgents((prev) => prev.filter((agent) => agent.id !== confirmDelete.id))
      toast.success(t('agents.toast.deleted'))
      setConfirmDelete(null)
    } catch (err) {
      console.error('[Agents] 删除失败:', err)
      toast.error(t('agents.error.delete'))
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        {/* 头部 */}
        <header className="border-b border-border-subtle pb-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-text-primary">Agents</h1>
              <p className="text-sm text-text-secondary mt-1">
                {t('agents.header.prefix')} {agents.length} {t('agents.header.suffix')}
              </p>
            </div>
            <Button
              leftIcon={<Plus size={16} />}
              data-testid="create-agent-btn"
              onClick={openCreateForm}
            >
              {t('agents.new')}
            </Button>
          </div>

          {/* 搜索和筛选 */}
          <div className="flex items-center gap-4 mt-4">
            <div className="flex-1 max-w-md">
              <Input
                placeholder={t('agents.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                leftIcon={<Search size={16} />}
                data-testid="agent-search"
              />
            </div>

            <div className="flex items-center gap-2">
              {(['all', 'active', 'inactive'] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={clsx(
                    'px-3 py-1.5 rounded-md text-sm font-medium',
                    'transition-colors duration-fast',
                    statusFilter === status
                      ? 'bg-primary-500/20 text-primary-400'
                      : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                  )}
                >
                  {status === 'all' && (t('agents.filter.all'))}
                  {status === 'active' && (t('agents.filter.active'))}
                  {status === 'inactive' && (t('agents.filter.inactive'))}
                  <span className="ml-1 text-xs text-text-tertiary">
                    ({status === 'all' ? statusCounts.all : status === 'active' ? statusCounts.active : statusCounts.inactive})
                  </span>
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* Agent 卡片网格 */}
        <div>
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
            </div>
          ) : filteredAgents.length === 0 ? (
            <EmptyState
              hasSearch={searchQuery.length > 0 || statusFilter !== 'all'}
              onClear={() => {
                setSearchQuery('')
                setStatusFilter('all')
              }}
              onCreate={openCreateForm}
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {pagedAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  locale={locale}
                  onEdit={() => openEditForm(agent)}
                  onDelete={() => handleDelete(agent)}
                  onToggleActive={() => handleToggleActive(agent)}
                  isToggling={isToggling}
                />
              ))}
            </div>
          )}

          {!isLoading && filteredAgents.length > 0 && totalPages > 1 && (
            <div
              data-testid="pagination"
              className="flex items-center justify-center gap-3 mt-6"
              role="navigation"
              aria-label={t('agents.pagination.label')}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPageIndex((prev) => Math.max(1, prev - 1))}
                disabled={pageIndex <= 1}
              >
                {t('agents.pagination.prev')}
              </Button>
              <span className="text-sm text-text-secondary">
                {safePageIndex} / {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPageIndex((prev) => Math.min(totalPages, prev + 1))}
                disabled={pageIndex >= totalPages}
              >
                {t('agents.pagination.next')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {showForm && (
        <AgentFormModal
          mode="create"
          values={formValues}
          errors={formErrors}
          isSubmitting={isSubmitting}
          models={llmModels}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onChange={setFormValues}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          agentName={confirmDelete.name}
          isDeleting={isDeleting}
          onConfirm={confirmDeleteAgent}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

interface AgentCardProps {
  agent: Agent
  locale: string
  onEdit: () => void
  onDelete: () => void
  onToggleActive: () => void
  isToggling: boolean
}

function AgentCard({ agent, locale, onEdit, onDelete, onToggleActive, isToggling }: AgentCardProps) {
  const { t } = useLocale()
  const isActive = agent.isActive
  const isSystem = agent.isSystem === true

  return (
    <Card interactive className="relative" data-testid="agent-card">
      <CardContent>
        <div className="block">
          {/* 头部 */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary-500/20 flex items-center justify-center">
                <Bot size={20} className="text-primary-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3
                    className="text-sm font-semibold text-text-primary"
                    data-testid="agent-name"
                  >
                    {agent.name}
                  </h3>
                  {isSystem && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium bg-primary-500/20 text-primary-400 rounded">
                      {t('agents.system')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', isActive ? 'bg-success-500' : 'bg-neutral-500')} />
                  <span
                    className={clsx('text-xs', isActive ? 'text-success-500' : 'text-text-tertiary')}
                  >
                    {isActive ? (t('agents.filter.active')) : (t('agents.filter.inactive'))}
                  </span>
                </div>
              </div>
            </div>
            {!isSystem && (
              <div className="flex items-center gap-1">
                <Tooltip content={isActive ? (t('agents.action.disable')) : (t('agents.action.enable'))}>
                  <button
                    type="button"
                    data-testid="toggle-agent-btn"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onToggleActive()
                    }}
                    disabled={isToggling}
                    className={clsx(
                      'p-1.5 rounded-md',
                      'transition-colors duration-fast',
                      isToggling
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-interactive-hover',
                      isActive ? 'text-success-500' : 'text-text-tertiary hover:text-text-primary'
                    )}
                  >
                    <Power size={16} />
                  </button>
                </Tooltip>
                <Tooltip content={t('common.edit')}>
                  <button
                    type="button"
                    data-testid="edit-agent-btn"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onEdit()
                    }}
                    className={clsx(
                      'p-1.5 rounded-md',
                      'text-text-tertiary hover:text-text-primary hover:bg-interactive-hover',
                      'transition-colors duration-fast'
                    )}
                  >
                    <Settings size={16} />
                  </button>
                </Tooltip>
                <Tooltip content={t('common.delete')}>
                  <button
                    type="button"
                    data-testid="delete-agent-btn"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onDelete()
                    }}
                    className={clsx(
                      'p-1.5 rounded-md',
                      'text-text-tertiary hover:text-error-500 hover:bg-error-500/10',
                      'transition-colors duration-fast'
                    )}
                  >
                    <Trash2 size={16} />
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          {/* 描述 */}
          <p
            className="text-sm text-text-secondary line-clamp-2 mb-4 h-10"
            data-testid="agent-description"
          >
            {agent.description || (t('agents.noDescription'))}
          </p>

          {/* 标签 */}
          <div className="flex flex-wrap gap-1.5 mb-4 h-6 overflow-hidden">
            <span className="px-2 py-0.5 text-xs bg-bg-elevated text-text-secondary rounded">
              {agent.config?.model || 'gpt-4o'}
            </span>
            {agent.skills?.slice(0, 2).map((skill: string) => (
              <span
                key={skill}
                className="px-2 py-0.5 text-xs bg-bg-elevated text-text-secondary rounded"
              >
                {skill}
              </span>
            ))}
          </div>

          {/* 底部信息 */}
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>{t('agents.createdOn')} {new Date(agent.createdAt).toLocaleDateString(locale)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

interface EmptyStateProps {
  hasSearch: boolean
  onClear: () => void
  onCreate: () => void
}

function EmptyState({ hasSearch, onClear, onCreate }: EmptyStateProps) {
  const { t } = useLocale()
  return (
    <div className="flex flex-col items-center justify-center h-full py-12">
      <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-4">
        <Bot size={32} className="text-text-tertiary" />
      </div>
      {hasSearch ? (
        <>
          <h3 className="text-lg font-medium text-text-primary">{t('agents.empty.filteredTitle')}</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">{t('agents.empty.filteredDescription')}</p>
          <Button variant="secondary" onClick={onClear}>
            {t('agents.empty.clearFilters')}
          </Button>
        </>
      ) : (
        <>
          <h3 className="text-lg font-medium text-text-primary">{t('agents.empty.defaultTitle')}</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">{t('agents.empty.defaultDescription')}</p>
          <Button leftIcon={<Plus size={16} />} onClick={onCreate}>{t('agents.new')}</Button>
        </>
      )}
    </div>
  )
}

interface AgentFormModalProps {
  mode: 'create' | 'edit'
  values: {
    name: string
    description: string
    model: string
    systemPrompt: string
  }
  errors: Record<string, string>
  isSubmitting: boolean
  models: LLMModel[]
  modelsLoading: boolean
  modelsError: Error | null
  onChange: Dispatch<SetStateAction<{
    name: string
    description: string
    model: string
    systemPrompt: string
  }>>
  onSave: () => void
  onCancel: () => void
}

function AgentFormModal({
  mode,
  values,
  errors,
  isSubmitting,
  models,
  modelsLoading,
  modelsError,
  onChange,
  onSave,
  onCancel,
}: AgentFormModalProps) {
  const { t } = useLocale()
  // 按 Provider 分组模型
  const groupedModels = models.reduce<Record<string, LLMModel[]>>((acc, model) => {
    const provider = model.providerName || 'Other'
    if (!acc[provider]) {
      acc[provider] = []
    }
    acc[provider].push(model)
    return acc
  }, {})

  const modelOptions: SelectGroup[] = Object.entries(groupedModels).map(([providerName, providerModels]) => ({
    label: providerName,
    options: providerModels.map((model) => ({
      value: model.modelId,
      label: model.displayName,
    })),
  }))
  return (
    <Modal
      open={true}
      onClose={onCancel}
      title={mode === 'create' ? (t('agents.modal.createTitle')) : (t('agents.modal.editTitle'))}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onCancel} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={onSave} loading={isSubmitting}>
            {mode === 'create' ? (t('common.create')) : (t('common.save'))}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="agent-name"
            className="block text-sm font-medium text-text-secondary mb-1.5"
          >
            {t('agent.name')}
          </label>
          <Input
            id="agent-name"
            placeholder={t('agents.modal.namePlaceholder')}
            value={values.name}
            onChange={(e) => onChange((prev) => ({ ...prev, name: e.target.value }))}
            className={errors.name ? 'border-error-500' : ''}
            disabled={isSubmitting}
          />
          {errors.name && (
            <p className="text-xs text-error-500 mt-1">{errors.name}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="agent-description"
            className="block text-sm font-medium text-text-secondary mb-1.5"
          >
            {t('agent.description')}
          </label>
          <textarea
            id="agent-description"
            placeholder={t('agent.description')}
            value={values.description}
            onChange={(e) => onChange((prev) => ({ ...prev, description: e.target.value }))}
            disabled={isSubmitting}
            className={clsx(
              'w-full h-24 px-3 py-2 rounded-md resize-none',
              'bg-bg-surface border border-border-default',
              'text-text-primary placeholder:text-text-tertiary',
              'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
              'transition-all duration-fast'
            )}
          />
        </div>

        <div>
          <label
            htmlFor="agent-model"
            className="block text-sm font-medium text-text-secondary mb-1.5"
          >
            {t('agent.model')}
          </label>
          <Select
            id="agent-model"
            data-testid="model-select"
            value={values.model}
            onChange={(val) => onChange((prev) => ({ ...prev, model: val }))}
            disabled={isSubmitting || modelsLoading || models.length === 0}
            options={modelOptions}
            placeholder={
              modelsLoading
                ? (t('common.loading'))
                : modelsError
                  ? (t('agents.modal.modelsLoadFailed'))
                  : models.length === 0
                    ? (t('agents.modal.noModels'))
                    : (t('agents.modal.selectModel'))
            }
            error={!!errors.model}
            errorMessage={errors.model}
          />
        </div>

        <div>
          <label
            htmlFor="agent-system-prompt"
            className="block text-sm font-medium text-text-secondary mb-1.5"
          >
            {t('agent.systemPrompt')}
          </label>
          <textarea
            id="agent-system-prompt"
            placeholder={t('agents.modal.systemPromptPlaceholder')}
            value={values.systemPrompt}
            onChange={(e) => onChange((prev) => ({ ...prev, systemPrompt: e.target.value }))}
            disabled={isSubmitting}
            className={clsx(
              'w-full h-24 px-3 py-2 rounded-md resize-none',
              'bg-bg-surface border border-border-default',
              'text-text-primary placeholder:text-text-tertiary',
              'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
              'transition-all duration-fast'
            )}
          />
        </div>
      </div>
    </Modal>
  )
}

interface ConfirmDeleteModalProps {
  agentName: string
  isDeleting: boolean
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmDeleteModal({ agentName, isDeleting, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  const { t } = useLocale()
  return (
    <Modal
      open={true}
      onClose={onCancel}
      title={t('agents.deleteModal.title')}
      maxWidth="sm"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onCancel} disabled={isDeleting}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" type="button" onClick={onConfirm} loading={isDeleting}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">
        <>{t('agents.deleteModal.description', { name: agentName })}</>
      </p>
    </Modal>
  )
}
