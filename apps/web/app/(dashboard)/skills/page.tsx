'use client'

import { useState } from 'react'
import clsx from 'clsx'
import {
  Search,
  Plus,
  Download,
  Sparkles,
  Code,
  Globe,
  FileText,
  Database,
  MoreVertical,
  Settings,
  Trash2,
  ExternalLink,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'

interface Skill {
  id: string
  name: string
  description: string
  icon: string
  version: string
  author?: string
  category: 'builtin' | 'custom' | 'community' | 'third-party'
  enabled: boolean
  triggers?: string[]
  createdAt: string
}

const mockSkills: Skill[] = [
  {
    id: 'skill-web-search',
    name: 'Web Search',
    description: '搜索互联网获取最新信息，支持多种搜索引擎',
    icon: 'globe',
    category: 'builtin',
    enabled: true,
    version: '1.0.0',
    triggers: ['搜索', 'search', '查找'],
    createdAt: '2026-01-01',
  },
  {
    id: 'skill-code-executor',
    name: 'Code Executor',
    description: '在沙箱环境中安全执行 Python、JavaScript 等代码',
    icon: 'code',
    category: 'builtin',
    enabled: true,
    version: '1.0.0',
    triggers: ['运行代码', 'execute', '执行'],
    createdAt: '2026-01-01',
  },
  {
    id: 'skill-file-manager',
    name: 'File Manager',
    description: '文件读写、目录管理和文件操作能力',
    icon: 'file',
    category: 'builtin',
    enabled: true,
    version: '1.0.0',
    triggers: ['文件', 'file', '读取'],
    createdAt: '2026-01-01',
  },
  {
    id: 'skill-data-query',
    name: 'Data Query',
    description: '数据库查询和数据分析能力',
    icon: 'database',
    category: 'builtin',
    enabled: false,
    version: '1.0.0',
    triggers: ['查询', 'query', 'SQL'],
    createdAt: '2026-01-01',
  },
  {
    id: 'skill-github',
    name: 'GitHub Integration',
    description: '与 GitHub 仓库交互，搜索代码、创建 Issue、管理 PR',
    icon: 'code',
    category: 'third-party',
    enabled: true,
    version: '2.1.0',
    author: 'Anthropic',
    triggers: ['github', 'repo', '仓库'],
    createdAt: '2026-02-01',
  },
  {
    id: 'skill-notion',
    name: 'Notion Sync',
    description: '与 Notion 工作区同步，读写页面和数据库',
    icon: 'file',
    category: 'community',
    enabled: false,
    version: '1.5.0',
    author: 'Community',
    triggers: ['notion', '笔记'],
    createdAt: '2026-01-20',
  },
]

type CategoryFilter = 'all' | 'enabled' | 'disabled' | 'builtin' | 'custom' | 'third-party'

/**
 * Skills Page - 技能管理页面
 *
 * 功能:
 * - 技能卡片网格展示
 * - 搜索和分类筛选
 * - 启用/禁用切换
 * - 添加第三方技能
 */
export default function SkillsPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [skills, setSkills] = useState<Skill[]>(mockSkills)
  const [showAddModal, setShowAddModal] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillDescription, setNewSkillDescription] = useState('')

  const handleAddSkill = () => {
    if (!newSkillName.trim()) return

    const newSkill: Skill = {
      id: `skill-${Date.now()}`,
      name: newSkillName,
      description: newSkillDescription || '自定义技能',
      icon: 'default',
      version: '1.0.0',
      category: 'custom',
      enabled: true,
      triggers: [],
      createdAt: new Date().toISOString().split('T')[0],
    }

    setSkills((prev) => [...prev, newSkill])
    setNewSkillName('')
    setNewSkillDescription('')
    setShowAddModal(false)
  }

  const filteredSkills = skills.filter((skill) => {
    const matchesSearch =
      skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description.toLowerCase().includes(searchQuery.toLowerCase())

    let matchesCategory = true
    if (categoryFilter === 'enabled') {
      matchesCategory = skill.enabled
    } else if (categoryFilter === 'disabled') {
      matchesCategory = !skill.enabled
    } else if (categoryFilter !== 'all') {
      matchesCategory = skill.category === categoryFilter
    }

    return matchesSearch && matchesCategory
  })

  const categoryCounts = {
    all: skills.length,
    enabled: skills.filter((s) => s.enabled).length,
    disabled: skills.filter((s) => !s.enabled).length,
    builtin: skills.filter((s) => s.category === 'builtin').length,
    custom: skills.filter((s) => s.category === 'custom').length,
    'third-party': skills.filter((s) => s.category === 'third-party' || s.category === 'community').length,
  }

  const toggleSkill = (skillId: string) => {
    setSkills((prev) =>
      prev.map((skill) => (skill.id === skillId ? { ...skill, enabled: !skill.enabled } : skill))
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 头部 */}
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Skills</h1>
            <p className="text-sm text-text-secondary mt-1">
              管理您的 Agent 技能，共 {skills.length} 个
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" leftIcon={<Download size={16} />}>
              导入
            </Button>
            <Button leftIcon={<Plus size={16} />} onClick={() => setShowAddModal(true)}>添加技能</Button>
          </div>
        </div>

        {/* 搜索和筛选 */}
        <div className="flex items-center gap-4 mt-4">
          <div className="flex-1 max-w-md">
            <Input
              placeholder="搜索技能..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search size={16} />}
            />
          </div>

          <div className="flex items-center gap-2">
            {(
              [
                { key: 'all', label: '全部' },
                { key: 'enabled', label: '已启用' },
                { key: 'disabled', label: '已禁用' },
                { key: 'builtin', label: '内置' },
                { key: 'third-party', label: '第三方' },
              ] as const
            ).map((filter) => (
              <button
                key={filter.key}
                onClick={() => setCategoryFilter(filter.key)}
                className={clsx(
                  'px-3 py-1.5 rounded-md text-sm font-medium',
                  'transition-colors duration-fast',
                  categoryFilter === filter.key
                    ? 'bg-primary-500/20 text-primary-400'
                    : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                )}
              >
                {filter.label}
                <span className="ml-1 text-xs text-text-tertiary">
                  ({categoryCounts[filter.key]})
                </span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 技能卡片网格 */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredSkills.length === 0 ? (
          <EmptyState
            hasSearch={searchQuery.length > 0 || categoryFilter !== 'all'}
            onClear={() => {
              setSearchQuery('')
              setCategoryFilter('all')
            }}
            onAdd={() => setShowAddModal(true)}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSkills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} onToggle={() => toggleSkill(skill.id)} />
            ))}
          </div>
        )}
      </div>

      {/* 添加技能模态框 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-surface border border-border-default rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-primary">添加技能</h2>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-interactive-hover transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">
                  技能名称 <span className="text-error-500">*</span>
                </label>
                <Input
                  placeholder="输入技能名称"
                  value={newSkillName}
                  onChange={(e) => setNewSkillName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">
                  技能描述
                </label>
                <Input
                  placeholder="输入技能描述"
                  value={newSkillDescription}
                  onChange={(e) => setNewSkillDescription(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle">
              <Button variant="secondary" onClick={() => setShowAddModal(false)}>
                取消
              </Button>
              <Button onClick={handleAddSkill} disabled={!newSkillName.trim()}>
                添加
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface SkillCardProps {
  skill: Skill
  onToggle: () => void
}

function SkillCard({ skill, onToggle }: SkillCardProps) {
  const [showMenu, setShowMenu] = useState(false)

  const iconMap: Record<string, React.ReactNode> = {
    globe: <Globe size={20} />,
    code: <Code size={20} />,
    file: <FileText size={20} />,
    database: <Database size={20} />,
    default: <Sparkles size={20} />,
  }

  const categoryConfig = {
    builtin: { label: '内置', color: 'text-info-500 bg-info-500/10' },
    custom: { label: '自定义', color: 'text-success-500 bg-success-500/10' },
    community: { label: '社区', color: 'text-warning-500 bg-warning-500/10' },
    'third-party': { label: '第三方', color: 'text-primary-400 bg-primary-500/10' },
  }

  const category = categoryConfig[skill.category]

  return (
    <Card interactive className="relative">
      <CardContent>
        {/* 头部 */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div
              className={clsx(
                'w-10 h-10 rounded-lg flex items-center justify-center',
                skill.enabled ? 'bg-primary-500/20 text-primary-400' : 'bg-neutral-700 text-text-tertiary'
              )}
            >
              {iconMap[skill.icon] || iconMap.default}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">{skill.name}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={clsx('text-xs px-1.5 py-0.5 rounded', category.color)}>
                  {category.label}
                </span>
                <span className="text-xs text-text-tertiary">v{skill.version}</span>
              </div>
            </div>
          </div>

          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
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
                <MenuButton icon={<Settings size={14} />} label="配置" />
                <MenuButton icon={<ExternalLink size={14} />} label="查看详情" />
                {skill.category !== 'builtin' && (
                  <>
                    <div className="my-1 border-t border-border-subtle" />
                    <MenuButton icon={<Trash2 size={14} />} label="删除" danger />
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 描述 */}
        <p className="text-sm text-text-secondary line-clamp-2 mb-4">{skill.description}</p>

        {/* 触发词标签 */}
        {skill.triggers && skill.triggers.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {skill.triggers.slice(0, 3).map((trigger) => (
              <span
                key={trigger}
                className="px-2 py-0.5 text-xs bg-bg-elevated text-text-secondary rounded"
              >
                {trigger}
              </span>
            ))}
            {skill.triggers.length > 3 && (
              <span className="px-2 py-0.5 text-xs bg-bg-elevated text-text-tertiary rounded">
                +{skill.triggers.length - 3}
              </span>
            )}
          </div>
        )}

        {/* 底部 */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-tertiary">
            {skill.author ? `by ${skill.author}` : `创建于 ${skill.createdAt}`}
          </span>

          {/* 开关 */}
          <button
            onClick={onToggle}
            className={clsx(
              'relative w-11 h-6 rounded-full transition-colors duration-fast',
              skill.enabled ? 'bg-primary-500' : 'bg-neutral-600'
            )}
            role="switch"
            aria-checked={skill.enabled}
          >
            <span
              className={clsx(
                'absolute top-1 left-1 w-4 h-4 rounded-full bg-white',
                'transition-transform duration-fast',
                skill.enabled && 'translate-x-5'
              )}
            />
          </button>
        </div>
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
  onAdd: () => void
}

function EmptyState({ hasSearch, onClear, onAdd }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-12">
      <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-4">
        <Sparkles size={32} className="text-text-tertiary" />
      </div>
      {hasSearch ? (
        <>
          <h3 className="text-lg font-medium text-text-primary">未找到匹配的技能</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">尝试调整搜索条件或筛选器</p>
          <Button variant="secondary" onClick={onClear}>
            清除筛选
          </Button>
        </>
      ) : (
        <>
          <h3 className="text-lg font-medium text-text-primary">暂无技能</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">添加技能以扩展 Agent 能力</p>
          <Button leftIcon={<Plus size={16} />} onClick={onAdd}>添加技能</Button>
        </>
      )}
    </div>
  )
}
