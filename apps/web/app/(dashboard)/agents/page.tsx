"use client"

import { useEffect, useState, useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import { Bot, Plus, Search, Settings, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'
import type { ApiResponse, Agent } from '@/types'
import { useLLMModels, type LLMModel } from '@/hooks/useLLMModels'

export default function AgentsPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create')
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
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
  const [pageIndex, setPageIndex] = useState(1)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)

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
      setStatusMessage({ type: 'error', text: '加载失败，请重试' })
    } finally {
      setIsLoading(false)
    }
  }, [])

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
    setStatusMessage(null)
    setFormMode('create')
    setEditingAgentId(null)
    // 使用第一个可用模型作为默认值
    const defaultModel = llmModels.length > 0 ? llmModels[0].modelId : ''
    setFormValues({ name: '', description: '', model: defaultModel, systemPrompt: '' })
    setFormErrors({})
    setShowForm(true)
  }

  const openEditForm = (agent: Agent) => {
    setStatusMessage(null)
    setFormMode('edit')
    setEditingAgentId(agent.id)
    // 如果 agent 的模型不在可用列表中，使用第一个可用模型
    const agentModel = agent.config?.model || ''
    const isModelAvailable = llmModels.some(m => m.modelId === agentModel)
    const defaultModel = llmModels.length > 0 ? llmModels[0].modelId : ''
    setFormValues({
      name: agent.name,
      description: agent.description || '',
      model: isModelAvailable ? agentModel : defaultModel,
      systemPrompt: agent.systemPrompt || '',
    })
    setFormErrors({})
    setShowForm(true)
  }

  const handleSave = async () => {
    setStatusMessage(null)
    const errors: Record<string, string> = {}
    if (!formValues.name.trim()) {
      errors.name = '名称不能为空'
    }
    if (!formValues.model) {
      errors.model = '请选择可用模型'
    }
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setIsSubmitting(true)
    try {
      if (formMode === 'create') {
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
          setStatusMessage({ type: 'success', text: '创建成功' })
          setShowForm(false)
        }
      } else if (editingAgentId) {
        const response = await apiClient.patch<ApiResponse<Agent>>(`/agents/${editingAgentId}`, {
          name: formValues.name.trim(),
          description: formValues.description.trim(),
          systemPrompt: formValues.systemPrompt,
          config: {
            model: formValues.model,
          },
        })

        if (response.success && response.data) {
          const updatedAgent = response.data
          setAgents((prev) =>
            prev.map((agent) => (agent.id === editingAgentId ? updatedAgent : agent))
          )
          setStatusMessage({ type: 'success', text: '更新成功' })
          setShowForm(false)
        }
      }
    } catch (err) {
      console.error('[Agents] 保存失败:', err)
      setStatusMessage({ type: 'error', text: '保存失败，请重试' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    setShowForm(false)
    setFormErrors({})
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
      setStatusMessage({ type: 'success', text: '已删除' })
      setConfirmDelete(null)
    } catch (err) {
      console.error('[Agents] 删除失败:', err)
      setStatusMessage({ type: 'error', text: '删除失败，请重试' })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 头部 */}
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Agents</h1>
            <p className="text-sm text-text-secondary mt-1">
              管理您的 AI Agent，共 {agents.length} 个
            </p>
          </div>
          <Button
            leftIcon={<Plus size={16} />}
            data-testid="create-agent-btn"
            onClick={openCreateForm}
          >
            新建代理
          </Button>
        </div>

        {statusMessage && (
          <div className={clsx(
            "mt-3 rounded-md px-3 py-2 border",
            statusMessage.type === 'success'
              ? "bg-success-500/10 border-success-500/20 text-success-500"
              : "bg-error-500/10 border-error-500/20 text-error-500"
          )}>
            <p className="text-sm">{statusMessage.text}</p>
          </div>
        )}

        {/* 搜索和筛选 */}
        <div className="flex items-center gap-4 mt-4">
          <div className="flex-1 max-w-md">
            <Input
              placeholder="搜索 Agent..."
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
                {status === 'all' && '全部'}
                {status === 'active' && '运行中'}
                {status === 'inactive' && '已停用'}
                <span className="ml-1 text-xs text-text-tertiary">
                  ({status === 'all' ? statusCounts.all : status === 'active' ? statusCounts.active : statusCounts.inactive})
                </span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Agent 卡片网格 */}
      <div className="flex-1 overflow-y-auto p-6">
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
                onEdit={() => openEditForm(agent)}
                onDelete={() => handleDelete(agent)}
              />
            ))}
          </div>
        )}

        {!isLoading && filteredAgents.length > 0 && totalPages > 1 && (
          <div
            data-testid="pagination"
            className="flex items-center justify-center gap-3 mt-6"
            role="navigation"
            aria-label="分页"
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPageIndex((prev) => Math.max(1, prev - 1))}
              disabled={pageIndex <= 1}
            >
              上一页
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
              下一页
            </Button>
          </div>
        )}
      </div>

      {showForm && (
        <AgentFormModal
          mode={formMode}
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
  onEdit: () => void
  onDelete: () => void
}

function AgentCard({ agent, onEdit, onDelete }: AgentCardProps) {
  const isActive = agent.isActive

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
                <h3
                  className="text-sm font-semibold text-text-primary"
                  data-testid="agent-name"
                >
                  {agent.name}
                </h3>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', isActive ? 'bg-success-500' : 'bg-neutral-500')} />
                  <span
                    className={clsx('text-xs', isActive ? 'text-success-500' : 'text-text-tertiary')}
                  >
                    {isActive ? '运行中' : '已停用'}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
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
            </div>
          </div>

          {/* 描述 */}
          <p
            className="text-sm text-text-secondary line-clamp-2 mb-4 h-10"
            data-testid="agent-description"
          >
            {agent.description || '暂无描述'}
          </p>

          {/* 标签 */}
          <div className="flex flex-wrap gap-1.5 mb-4 h-6 overflow-hidden">
            <span className="px-2 py-0.5 text-xs bg-bg-elevated text-text-secondary rounded">
              {agent.config?.model || 'gpt-4o'}
            </span>
            {agent.skills?.slice(0, 2).map((skill) => (
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
            <span>创建于 {new Date(agent.createdAt).toLocaleDateString()}</span>
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
  return (
    <div className="flex flex-col items-center justify-center h-full py-12">
      <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-4">
        <Bot size={32} className="text-text-tertiary" />
      </div>
      {hasSearch ? (
        <>
          <h3 className="text-lg font-medium text-text-primary">未找到匹配的 Agent</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">尝试调整搜索条件或筛选器</p>
          <Button variant="secondary" onClick={onClear}>
            清除筛选
          </Button>
        </>
      ) : (
        <>
          <h3 className="text-lg font-medium text-text-primary">暂无 Agent</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">创建您的第一个 AI Agent 开始使用</p>
          <Button leftIcon={<Plus size={16} />} onClick={onCreate}>新建代理</Button>
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
  // 按 Provider 分组模型
  const groupedModels = models.reduce<Record<string, LLMModel[]>>((acc, model) => {
    const provider = model.providerName || 'Other'
    if (!acc[provider]) {
      acc[provider] = []
    }
    acc[provider].push(model)
    return acc
  }, {})
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        className="w-full max-w-lg rounded-lg bg-bg-surface border border-border-default p-6 space-y-4"
      >
        <h2 className="text-lg font-semibold text-text-primary">
          {mode === 'create' ? '创建代理' : '编辑代理'}
        </h2>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="agent-name"
              className="block text-sm font-medium text-text-secondary mb-1.5"
            >
              名称
            </label>
            <Input
              id="agent-name"
              placeholder="代理名称"
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
              描述
            </label>
            <textarea
              id="agent-description"
              placeholder="描述"
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
              模型
            </label>
            <select
              id="agent-model"
              data-testid="model-select"
              value={values.model}
              onChange={(e) => onChange((prev) => ({ ...prev, model: e.target.value }))}
              disabled={isSubmitting || modelsLoading || models.length === 0}
              className={clsx(
                'w-full px-3 py-2 rounded-md',
                'bg-bg-surface border border-border-default',
                'text-text-primary',
                'focus:outline-none focus:border-primary-500',
                'transition-all duration-fast'
              )}
            >
              {modelsLoading ? (
                <option value="">加载中...</option>
              ) : modelsError ? (
                <option value="">模型列表加载失败，请检查后端接口</option>
              ) : models.length === 0 ? (
                <option value="">暂无可用模型，请检查 LLM Provider 配置</option>
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
            {errors.model && (
              <p className="text-xs text-error-500 mt-1">{errors.model}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="agent-system-prompt"
              className="block text-sm font-medium text-text-secondary mb-1.5"
            >
              系统提示词
            </label>
            <textarea
              id="agent-system-prompt"
              placeholder="系统提示"
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

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" type="button" onClick={onCancel} disabled={isSubmitting}>
            取消
          </Button>
          <Button type="button" onClick={onSave} loading={isSubmitting}>
            {mode === 'create' ? '创建' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface ConfirmDeleteModalProps {
  agentName: string
  isDeleting: boolean
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmDeleteModal({ agentName, isDeleting, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
        <h3 className="text-lg font-semibold text-text-primary">删除代理</h3>
        <p className="text-sm text-text-secondary">
          删除“{agentName}”后无法恢复。
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onCancel} disabled={isDeleting}>
            取消
          </Button>
          <Button variant="destructive" type="button" onClick={onConfirm} loading={isDeleting}>
            确认
          </Button>
        </div>
      </div>
    </div>
  )
}
