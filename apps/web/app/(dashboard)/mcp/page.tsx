'use client'

import { useState } from 'react'
import clsx from 'clsx'
import {
  Search,
  Plus,
  Server,
  Plug,
  MoreVertical,
  Settings,
  Trash2,
  RefreshCw,
  Terminal,
  Globe,
  Zap,
  ExternalLink,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'

interface McpServer {
  id: string
  name: string
  description: string
  type: 'stdio' | 'sse' | 'http'
  status: 'connected' | 'disconnected' | 'error'
  endpoint: string
  tools: string[]
  lastConnected: string | null
  createdAt: string
}

const mockServers: McpServer[] = [
  {
    id: 'mcp-filesystem',
    name: 'Filesystem',
    description: '文件系统访问，支持读写文件和目录操作',
    type: 'stdio',
    status: 'connected',
    endpoint: 'npx -y @anthropic/mcp-server-filesystem',
    tools: ['read_file', 'write_file', 'list_directory', 'create_directory'],
    lastConnected: '2026-02-05 14:30',
    createdAt: '2026-01-15',
  },
  {
    id: 'mcp-github',
    name: 'GitHub',
    description: 'GitHub API 集成，支持仓库、Issue 和 PR 操作',
    type: 'stdio',
    status: 'connected',
    endpoint: 'npx -y @anthropic/mcp-server-github',
    tools: ['search_repositories', 'get_file_contents', 'create_issue', 'list_commits'],
    lastConnected: '2026-02-05 10:15',
    createdAt: '2026-01-20',
  },
  {
    id: 'mcp-postgres',
    name: 'PostgreSQL',
    description: 'PostgreSQL 数据库连接和查询',
    type: 'stdio',
    status: 'disconnected',
    endpoint: 'npx -y @anthropic/mcp-server-postgres',
    tools: ['query', 'list_tables', 'describe_table'],
    lastConnected: '2026-01-30',
    createdAt: '2026-01-25',
  },
  {
    id: 'mcp-puppeteer',
    name: 'Puppeteer',
    description: '浏览器自动化，网页截图和数据抓取',
    type: 'stdio',
    status: 'error',
    endpoint: 'npx -y @anthropic/mcp-server-puppeteer',
    tools: ['navigate', 'screenshot', 'click', 'fill'],
    lastConnected: null,
    createdAt: '2026-02-01',
  },
  {
    id: 'mcp-custom-api',
    name: 'Custom API Server',
    description: '自定义 HTTP API 服务器',
    type: 'http',
    status: 'connected',
    endpoint: 'http://localhost:3100/mcp',
    tools: ['custom_tool_1', 'custom_tool_2'],
    lastConnected: '2026-02-05 12:00',
    createdAt: '2026-02-03',
  },
]

type StatusFilter = 'all' | 'connected' | 'disconnected' | 'error'

/**
 * MCP Page - MCP 服务器管理页面
 *
 * 功能:
 * - MCP 服务器卡片网格展示
 * - 搜索和状态筛选
 * - 连接/断开服务器
 * - 添加新服务器
 */
export default function McpPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [servers, setServers] = useState<McpServer[]>(mockServers)
  const [showAddModal, setShowAddModal] = useState(false)
  const [newServerName, setNewServerName] = useState('')
  const [newServerEndpoint, setNewServerEndpoint] = useState('')
  const [newServerType, setNewServerType] = useState<'stdio' | 'sse' | 'http'>('stdio')

  const handleAddServer = () => {
    if (!newServerName.trim() || !newServerEndpoint.trim()) return

    const newServer: McpServer = {
      id: `mcp-${Date.now()}`,
      name: newServerName,
      description: '自定义 MCP 服务器',
      type: newServerType,
      status: 'disconnected',
      endpoint: newServerEndpoint,
      tools: [],
      lastConnected: null,
      createdAt: new Date().toISOString().split('T')[0],
    }

    setServers((prev) => [...prev, newServer])
    setNewServerName('')
    setNewServerEndpoint('')
    setNewServerType('stdio')
    setShowAddModal(false)
  }

  const filteredServers = servers.filter((server) => {
    const matchesSearch =
      server.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      server.description.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesStatus = statusFilter === 'all' || server.status === statusFilter

    return matchesSearch && matchesStatus
  })

  const statusCounts = {
    all: servers.length,
    connected: servers.filter((s) => s.status === 'connected').length,
    disconnected: servers.filter((s) => s.status === 'disconnected').length,
    error: servers.filter((s) => s.status === 'error').length,
  }

  const reconnectServer = (serverId: string) => {
    setServers((prev) =>
      prev.map((server) =>
        server.id === serverId
          ? { ...server, status: 'connected' as const, lastConnected: new Date().toLocaleString() }
          : server
      )
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 头部 */}
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">MCP Servers</h1>
            <p className="text-sm text-text-secondary mt-1">
              管理 Model Context Protocol 服务器，共 {servers.length} 个
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" leftIcon={<RefreshCw size={16} />}>
              刷新状态
            </Button>
            <Button leftIcon={<Plus size={16} />} onClick={() => setShowAddModal(true)}>添加服务器</Button>
          </div>
        </div>

        {/* 搜索和筛选 */}
        <div className="flex items-center gap-4 mt-4">
          <div className="flex-1 max-w-md">
            <Input
              placeholder="搜索服务器..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search size={16} />}
            />
          </div>

          <div className="flex items-center gap-2">
            {(
              [
                { key: 'all', label: '全部' },
                { key: 'connected', label: '已连接' },
                { key: 'disconnected', label: '断开' },
                { key: 'error', label: '错误' },
              ] as const
            ).map((filter) => (
              <button
                key={filter.key}
                onClick={() => setStatusFilter(filter.key)}
                className={clsx(
                  'px-3 py-1.5 rounded-md text-sm font-medium',
                  'transition-colors duration-fast',
                  statusFilter === filter.key
                    ? 'bg-primary-500/20 text-primary-400'
                    : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                )}
              >
                {filter.label}
                <span className="ml-1 text-xs text-text-tertiary">
                  ({statusCounts[filter.key]})
                </span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 服务器卡片网格 */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredServers.length === 0 ? (
          <EmptyState
            hasSearch={searchQuery.length > 0 || statusFilter !== 'all'}
            onClear={() => {
              setSearchQuery('')
              setStatusFilter('all')
            }}
            onAdd={() => setShowAddModal(true)}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredServers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                onReconnect={() => reconnectServer(server.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 添加服务器模态框 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-surface border border-border-default rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-primary">添加 MCP 服务器</h2>
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
                  服务器名称 <span className="text-error-500">*</span>
                </label>
                <Input
                  placeholder="输入服务器名称"
                  value={newServerName}
                  onChange={(e) => setNewServerName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">
                  连接类型
                </label>
                <div className="flex gap-2">
                  {(['stdio', 'http', 'sse'] as const).map((type) => (
                    <button
                      key={type}
                      onClick={() => setNewServerType(type)}
                      className={clsx(
                        'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                        newServerType === type
                          ? 'bg-primary-500/20 text-primary-400'
                          : 'bg-bg-elevated text-text-secondary hover:text-text-primary'
                      )}
                    >
                      {type.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">
                  Endpoint <span className="text-error-500">*</span>
                </label>
                <Input
                  placeholder={newServerType === 'stdio' ? 'npx -y @anthropic/mcp-server-xxx' : 'http://localhost:3100/mcp'}
                  value={newServerEndpoint}
                  onChange={(e) => setNewServerEndpoint(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle">
              <Button variant="secondary" onClick={() => setShowAddModal(false)}>
                取消
              </Button>
              <Button onClick={handleAddServer} disabled={!newServerName.trim() || !newServerEndpoint.trim()}>
                添加
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface ServerCardProps {
  server: McpServer
  onReconnect: () => void
}

function ServerCard({ server, onReconnect }: ServerCardProps) {
  const [showMenu, setShowMenu] = useState(false)

  const typeConfig = {
    stdio: { label: 'STDIO', icon: <Terminal size={14} />, color: 'text-info-500 bg-info-500/10' },
    sse: { label: 'SSE', icon: <Zap size={14} />, color: 'text-warning-500 bg-warning-500/10' },
    http: { label: 'HTTP', icon: <Globe size={14} />, color: 'text-primary-400 bg-primary-500/10' },
  }

  const statusConfig = {
    connected: {
      label: '已连接',
      dotColor: 'bg-success-500',
      textColor: 'text-success-500',
    },
    disconnected: {
      label: '断开',
      dotColor: 'bg-neutral-500',
      textColor: 'text-text-tertiary',
    },
    error: {
      label: '错误',
      dotColor: 'bg-error-500',
      textColor: 'text-error-500',
    },
  }

  const type = typeConfig[server.type]
  const status = statusConfig[server.status]

  return (
    <Card interactive className="relative">
      <CardContent>
        {/* 头部 */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div
              className={clsx(
                'w-10 h-10 rounded-lg flex items-center justify-center',
                server.status === 'connected'
                  ? 'bg-primary-500/20 text-primary-400'
                  : 'bg-neutral-700 text-text-tertiary'
              )}
            >
              <Server size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">{server.name}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={clsx('w-1.5 h-1.5 rounded-full', status.dotColor)} />
                <span className={clsx('text-xs', status.textColor)}>{status.label}</span>
                <span className={clsx('text-xs px-1.5 py-0.5 rounded flex items-center gap-1', type.color)}>
                  {type.icon}
                  {type.label}
                </span>
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
                <MenuButton icon={<RefreshCw size={14} />} label="测试连接" onClick={onReconnect} />
                <MenuButton icon={<Settings size={14} />} label="配置" />
                <MenuButton icon={<ExternalLink size={14} />} label="查看工具" />
                <div className="my-1 border-t border-border-subtle" />
                <MenuButton icon={<Trash2 size={14} />} label="删除" danger />
              </div>
            )}
          </div>
        </div>

        {/* 描述 */}
        <p className="text-sm text-text-secondary line-clamp-2 mb-4">{server.description}</p>

        {/* 端点 */}
        <div className="mb-4">
          <div className="text-xs text-text-tertiary mb-1">Endpoint</div>
          <div className="text-xs text-text-secondary font-mono bg-bg-elevated px-2 py-1.5 rounded truncate">
            {server.endpoint}
          </div>
        </div>

        {/* 工具标签 */}
        {server.tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {server.tools.slice(0, 3).map((tool) => (
              <span
                key={tool}
                className="px-2 py-0.5 text-xs bg-bg-elevated text-text-secondary rounded"
              >
                {tool}
              </span>
            ))}
            {server.tools.length > 3 && (
              <span className="px-2 py-0.5 text-xs bg-bg-elevated text-text-tertiary rounded">
                +{server.tools.length - 3}
              </span>
            )}
          </div>
        )}

        {/* 底部 */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-tertiary">
            {server.lastConnected ? `最后连接 ${server.lastConnected}` : '从未连接'}
          </span>

          {/* 连接按钮 */}
          <button
            onClick={onReconnect}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
              'transition-colors duration-fast',
              server.status === 'connected'
                ? 'bg-success-500/10 text-success-500'
                : 'bg-primary-500/10 text-primary-400 hover:bg-primary-500/20'
            )}
          >
            <Plug size={14} />
            {server.status === 'connected' ? '已连接' : '连接'}
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
  onClick?: () => void
}

function MenuButton({ icon, label, danger = false, onClick }: MenuButtonProps) {
  return (
    <button
      onClick={onClick}
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
        <Server size={32} className="text-text-tertiary" />
      </div>
      {hasSearch ? (
        <>
          <h3 className="text-lg font-medium text-text-primary">未找到匹配的服务器</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">尝试调整搜索条件或筛选器</p>
          <Button variant="secondary" onClick={onClear}>
            清除筛选
          </Button>
        </>
      ) : (
        <>
          <h3 className="text-lg font-medium text-text-primary">暂无 MCP 服务器</h3>
          <p className="text-sm text-text-secondary mt-1 mb-4">添加服务器以扩展 Agent 能力</p>
          <Button leftIcon={<Plus size={16} />} onClick={onAdd}>添加服务器</Button>
        </>
      )}
    </div>
  )
}
