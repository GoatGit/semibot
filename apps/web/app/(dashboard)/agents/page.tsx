'use client'

import { useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import { Bot, Plus, Search, MoreVertical, Play, Pause, Settings, Trash2, Copy } from 'lucide-react'
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

const mockAgents: Agent[] = [
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
  const [agents] = useState<Agent[]>(mockAgents)

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
          <Link href="/agents/new">
            <Button leftIcon={<Plus size={16} />}>创建 Agent</Button>
          </Link>
        </div>

        {/* 搜索和筛选 */}
        <div className="flex items-center gap-4 mt-4">
          <div className="flex-1 max-w-md">
            <Input
              placeholder="搜索 Agent..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search size={16} />}
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
            {filteredAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface AgentCardProps {
  agent: Agent
}

function AgentCard({ agent }: AgentCardProps) {
  const [showMenu, setShowMenu] = useState(false)

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
    <Card interactive className="relative">
      <CardContent>
        <Link href={`/agents/${agent.id}`} className="block">
          {/* 头部 */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary-500/20 flex items-center justify-center">
                <Bot size={20} className="text-primary-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">{agent.name}</h3>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', status.dotColor)} />
                  <span className={clsx('text-xs', status.textColor)}>{status.label}</span>
                </div>
              </div>
            </div>

            <div className="relative">
              <button
                onClick={(e) => {
                  e.preventDefault()
                  setShowMenu(!showMenu)
                }}
                className={clsx(
                  'p-1.5 rounded-md',
                  'text-text-tertiary hover:text-text-primary hover:bg-interactive-hover',
                  'transition-colors duration-fast'
                )}
              >
                <MoreVertical size={16} />
              </button>

              {showMenu && (
                <div
                  className={clsx(
                    'absolute right-0 top-full mt-1 w-40 py-1',
                    'bg-bg-elevated border border-border-default rounded-lg shadow-lg',
                    'z-10'
                  )}
                >
                  <MenuButton icon={<Play size={14} />} label="启动" />
                  <MenuButton icon={<Pause size={14} />} label="停用" />
                  <MenuButton icon={<Copy size={14} />} label="复制" />
                  <MenuButton icon={<Settings size={14} />} label="设置" />
                  <div className="my-1 border-t border-border-subtle" />
                  <MenuButton icon={<Trash2 size={14} />} label="删除" danger />
                </div>
              )}
            </div>
          </div>

          {/* 描述 */}
          <p className="text-sm text-text-secondary line-clamp-2 mb-4">{agent.description}</p>

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

interface MenuButtonProps {
  icon: React.ReactNode
  label: string
  danger?: boolean
}

function MenuButton({ icon, label, danger = false }: MenuButtonProps) {
  return (
    <button
      className={clsx(
        'flex items-center gap-2 w-full px-3 py-2 text-sm',
        'transition-colors duration-fast',
        danger
          ? 'text-error-500 hover:bg-error-500/10'
          : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
      )}
    >
      {icon}
      {label}
    </button>
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
            <Button leftIcon={<Plus size={16} />}>创建 Agent</Button>
          </Link>
        </>
      )}
    </div>
  )
}
