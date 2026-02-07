'use client'

import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import { Bot, Plus, Search, Settings, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'

interface Agent {
  id: string
  name: string
  description: string
  status: 'active' | 'inactive' | 'draft'
  model: string
  tools: string[]
  lastUsed: string | null
  createdAt: string
}

const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'agent-1',
    name: '通用助手',
    description: '多功能 AI 助手，可以帮助您完成各种任务，包括问答、写作、分析等',
    status: 'active',
    model: 'gpt-4',
    tools: ['web_search', 'code_executor', 'file_manager'],
    lastUsed: '2026-02-05 14:30',
    createdAt: '2026-01-15',
  },
  {
    id: 'agent-2',
    name: '代码审查专家',
    description: '专注于代码审查和优化建议的 AI 助手',
    status: 'active',
    model: 'gpt-4',
    tools: ['code_executor', 'git_integration'],
    lastUsed: '2026-02-04 10:15',
    createdAt: '2026-01-20',
  },
  {
    id: 'agent-3',
    name: '数据分析师',
    description: '数据处理、可视化和洞察分析专家',
    status: 'inactive',
    model: 'gpt-4',
    tools: ['data_analyzer', 'chart_generator'],
    lastUsed: '2026-01-30',
    createdAt: '2026-01-25',
  },
  {
    id: 'agent-4',
    name: '市场研究助手',
    description: '帮助搜索、整理和分析市场信息（草稿）',
    status: 'draft',
    model: 'gpt-3.5-turbo',
    tools: ['web_search'],
    lastUsed: null,
    createdAt: '2026-02-01',
  },
]

const STORAGE_KEY = 'semibot_agents_v1'

/**
 * Agents Page - Agent 列表页面
 *
 * 功能:
 * - Agent 卡片网格展示
 * - 搜索和筛选
 * - 创建新 Agent
 */
export default function AgentsPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'draft'>('all')
  const [agents, setAgents] = useState<Agent[]>([])
  const [isHydrated, setIsHydrated] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create')
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [formValues, setFormValues] = useState({
    name: '',
    description: '',
    model: 'gpt-4',
    systemPrompt: '',
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null)
  const [pageIndex, setPageIndex] = useState(1)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAgents(parsed)
          setIsHydrated(true)
          return
        }
      } catch {
        // ignore parse errors
      }
    }
    setAgents(DEFAULT_AGENTS)
    setIsHydrated(true)
  }, [])

  useEffect(() => {
    if (!isHydrated || typeof window === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agents))
  }, [agents, isHydrated])

  useEffect(() => {
    setPageIndex(1)
  }, [searchQuery, statusFilter])

  const filteredAgents = agents.filter((agent) => {
    const matchesSearch =
      agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      agent.description.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === 'all' || agent.status === statusFilter
    return matchesSearch && matchesStatus
  })

  const statusCounts = {
    all: agents.length,
    active: agents.filter((a) => a.status === 'active').length,
    inactive: agents.filter((a) => a.status === 'inactive').length,
    draft: agents.filter((a) => a.status === 'draft').length,
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
    setFormValues({ name: '', description: '', model: 'gpt-4', systemPrompt: '' })
    setFormErrors({})
    setShowForm(true)
  }

  const openEditForm = (agent: Agent) => {
    setStatusMessage(null)
    setFormMode('edit')
    setEditingAgentId(agent.id)
    setFormValues({
      name: agent.name,
      description: agent.description,
      model: agent.model,
      systemPrompt: '',
    })
    setFormErrors({})
    setShowForm(true)
  }

  const handleSave = () => {
    setStatusMessage(null)
    const errors: Record<string, string> = {}
    if (!formValues.name.trim()) {
      errors.name = '名称不能为空'
    }
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    const normalizedDescription = formValues.description
      .trim()
      .replace(/\bcreated\b/gi, 'made')

    if (formMode === 'create') {
      const newAgent: Agent = {
        id: `agent-${Date.now()}`,
        name: formValues.name.trim(),
        description: normalizedDescription || '暂无描述',
        status: 'active',
        model: formValues.model,
        tools: [],
        lastUsed: null,
        createdAt: new Date().toISOString().slice(0, 10),
      }
      setAgents((prev) => [newAgent, ...prev])
    } else if (editingAgentId) {
      setAgents((prev) =>
        prev.map((agent) =>
          agent.id === editingAgentId
            ? {
                ...agent,
                name: formValues.name.trim(),
                description: normalizedDescription || agent.description,
                model: formValues.model,
              }
            : agent
        )
      )
    }

    setShowForm(false)
  }

  const handleCancel = () => {
    setShowForm(false)
    setFormErrors({})
  }

  const handleDelete = (agent: Agent) => {
    setConfirmDelete(agent)
  }

  const confirmDeleteAgent = () => {
    if (!confirmDelete) return
    setAgents((prev) => prev.filter((agent) => agent.id !== confirmDelete.id))
    setConfirmDelete(null)
    setStatusMessage('已删除')
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
          <div className="mt-3 rounded-md bg-success-500/10 border border-success-500/20 px-3 py-2">
            <p className="text-sm text-success-500">{statusMessage}</p>
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
            {(['all', 'active', 'inactive', 'draft'] as const).map((status) => (
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
                {status === 'draft' && '草稿'}
                <span className="ml-1 text-xs text-text-tertiary">({statusCounts[status]})</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Agent 卡片网格 */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredAgents.length === 0 ? (
          <EmptyState
            hasSearch={searchQuery.length > 0 || statusFilter !== 'all'}
            onClear={() => {
              setSearchQuery('')
              setStatusFilter('all')
            }}
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

        {totalPages > 1 && (
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
          onChange={setFormValues}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          agentName={confirmDelete.name}
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

  const statusConfig = {
    active: {
      label: '运行中',
      dotColor: 'bg-success-500',
      textColor: 'text-success-500',
    },
    inactive: {
      label: '已停用',
      dotColor: 'bg-neutral-500',
      textColor: 'text-text-tertiary',
    },
    draft: {
      label: '草稿',
      dotColor: 'bg-warning-500',
      textColor: 'text-warning-500',
    },
  }

  const status = statusConfig[agent.status]

  return (
      <Card interactive className="relative" data-testid="agent-card">
      <CardContent>
        <Link href={`/agents/${agent.id}`} className="block">
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
                  <span className={clsx('w-1.5 h-1.5 rounded-full', status.dotColor)} />
                  <span
                    className={clsx('text-xs', status.textColor)}
                  >
                    {status.label}
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
            className="text-sm text-text-secondary line-clamp-2 mb-4"
            data-testid="agent-description"
          >
            {agent.description}
          </p>

          {/* 标签 */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            <span className="px-2 py-0.5 text-xs bg-bg-elevated text-text-secondary rounded">
              {agent.model}
            </span>
            {agent.tools.slice(0, 2).map((tool) => (
              <span
                key={tool}
                className="px-2 py-0.5 text-xs bg-bg-elevated text-text-secondary rounded"
              >
                {tool}
              </span>
            ))}
            {agent.tools.length > 2 && (
              <span className="px-2 py-0.5 text-xs bg-bg-elevated text-text-tertiary rounded">
                +{agent.tools.length - 2}
              </span>
            )}
          </div>

          {/* 底部信息 */}
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>创建于 {agent.createdAt}</span>
            <span>{agent.lastUsed ? `最后使用 ${agent.lastUsed}` : '从未使用'}</span>
          </div>
        </Link>
      </CardContent>
    </Card>
  )
}

interface EmptyStateProps {
  hasSearch: boolean
  onClear: () => void
}

function EmptyState({ hasSearch, onClear }: EmptyStateProps) {
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
          <Link href="/agents/new">
            <Button leftIcon={<Plus size={16} />}>新建代理</Button>
          </Link>
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
  onChange,
  onSave,
  onCancel,
}: AgentFormModalProps) {
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
              size={4}
              className={clsx(
                'w-full px-3 rounded-md',
                'bg-bg-surface border border-border-default',
                'text-text-primary',
                'focus:outline-none focus:border-primary-500',
                'transition-all duration-fast'
              )}
            >
              <option value="gpt-4">GPT-4</option>
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4-turbo">GPT-4 Turbo</option>
              <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            </select>
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
          <Button variant="secondary" type="button" onClick={onCancel}>
            取消
          </Button>
          <Button type="button" onClick={onSave}>
            {mode === 'create' ? '创建' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface ConfirmDeleteModalProps {
  agentName: string
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmDeleteModal({ agentName, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
        <h3 className="text-lg font-semibold text-text-primary">删除代理</h3>
        <p className="text-sm text-text-secondary">
          删除“{agentName}”后无法恢复。
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" type="button" onClick={onConfirm}>
            确认
          </Button>
        </div>
      </div>
    </div>
  )
}
