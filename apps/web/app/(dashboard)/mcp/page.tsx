'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Search,
  Plus,
  RefreshCw,
  Trash2,
  Loader2,
  Plug,
  Terminal,
  Globe,
  Radio,
  ChevronDown,
  ChevronUp,
  Wrench,
  FolderOpen,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

interface McpServer {
  id: string
  name: string
  description?: string
  transport: 'stdio' | 'sse' | 'streamable_http'
  endpoint: string
  authType?: 'none' | 'api_key' | 'oauth'
  authConfig?: {
    apiKey?: string
  }
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  tools: McpTool[]
  resources?: McpResource[]
  lastConnectedAt?: string
}
type TransportType = 'stdio' | 'sse' | 'streamable_http'

const TRANSPORT_OPTIONS: {
  value: TransportType
  label: string
  icon: React.ReactNode
  description: string
}[] = [
  {
    value: 'stdio',
    label: 'Stdio',
    icon: <Terminal size={16} />,
    description: '本地命令行进程，适用于本地安装的 MCP Server',
  },
  {
    value: 'sse',
    label: 'SSE',
    icon: <Radio size={16} />,
    description: '通过 Server-Sent Events 连接远程 MCP Server（旧版协议）',
  },
  {
    value: 'streamable_http',
    label: 'Streamable HTTP',
    icon: <Globe size={16} />,
    description: '通过 Streamable HTTP 连接远程 MCP Server（推荐）',
  },
]

const TRANSPORT_HINTS: Record<
  TransportType,
  { endpointLabel: string; endpointPlaceholder: string; endpointHint: string; showApiKey: boolean; apiKeyHint: string }
> = {
  stdio: {
    endpointLabel: '命令',
    endpointPlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/dir',
    endpointHint:
      '输入完整的可执行命令。将 command 和 args 用空格拼接，例如：uvx mcp-server-time --local-timezone=Asia/Shanghai',
    showApiKey: true,
    apiKeyHint: '可选。会通过 MCP_API_KEY 环境变量传递给子进程',
  },
  sse: {
    endpointLabel: 'SSE URL',
    endpointPlaceholder: 'https://mcp-server.example.com/sse',
    endpointHint: '输入 MCP Server 的 SSE 端点 URL，通常以 /sse 结尾。适用于旧版 MCP Server',
    showApiKey: true,
    apiKeyHint: '可选。会通过 Authorization: Bearer <key> 请求头发送',
  },
  streamable_http: {
    endpointLabel: 'HTTP URL',
    endpointPlaceholder: 'https://mcp-server.example.com/mcp',
    endpointHint: '输入 MCP Server 的 HTTP 端点 URL，通常以 /mcp 结尾。这是 MCP 协议推荐的远程连接方式',
    showApiKey: true,
    apiKeyHint: '可选。会通过 Authorization: Bearer <key> 请求头发送',
  },
}

const STATUS_MAP: Record<string, { label: string; color: string; dot: string }> = {
  connected: { label: '已连接', color: 'text-success-500', dot: 'bg-success-500' },
  connecting: { label: '连接中', color: 'text-warning-500', dot: 'bg-warning-500' },
  error: { label: '连接失败', color: 'text-error-500', dot: 'bg-error-500' },
  disconnected: { label: '未连接', color: 'text-text-tertiary', dot: 'bg-text-tertiary' },
}

function ServerFormModal({
  title,
  saving,
  formState,
  setFormState,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  title: string
  saving: boolean
  formState: {
    name: string
    description: string
    endpoint: string
    transport: TransportType
    apiKey: string
  }
  setFormState: React.Dispatch<
    React.SetStateAction<{
      name: string
      description: string
      endpoint: string
      transport: TransportType
      apiKey: string
    }>
  >
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
}) {
  const hints = TRANSPORT_HINTS[formState.transport]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg rounded-lg bg-bg-surface border border-border-default p-6 space-y-5">
        <h3 className="text-lg font-semibold text-text-primary">{title}</h3>

        {/* 传输类型选择 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">传输类型</label>
          <div className="grid grid-cols-3 gap-2">
            {TRANSPORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFormState((s) => ({ ...s, transport: opt.value }))}
                disabled={saving}
                className={clsx(
                  'flex flex-col items-center gap-1.5 p-3 rounded-md border text-sm transition-all',
                  formState.transport === opt.value
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-border-default bg-bg-surface text-text-secondary hover:border-border-strong'
                )}
              >
                {opt.icon}
                <span className="font-medium">{opt.label}</span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-text-tertiary">
            {TRANSPORT_OPTIONS.find((o) => o.value === formState.transport)?.description}
          </p>
        </div>

        {/* 名称 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">名称</label>
          <Input
            placeholder="例如：filesystem、github、time"
            value={formState.name}
            onChange={(e) => setFormState((s) => ({ ...s, name: e.target.value }))}
            disabled={saving}
          />
        </div>

        {/* 描述 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            描述 <span className="text-text-tertiary font-normal">（可选）</span>
          </label>
          <Input
            placeholder="简要描述此 MCP Server 的用途"
            value={formState.description}
            onChange={(e) => setFormState((s) => ({ ...s, description: e.target.value }))}
            disabled={saving}
          />
        </div>

        {/* 端点 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">{hints.endpointLabel}</label>
          <Input
            placeholder={hints.endpointPlaceholder}
            value={formState.endpoint}
            onChange={(e) => setFormState((s) => ({ ...s, endpoint: e.target.value }))}
            disabled={saving}
          />
          <p className="mt-1.5 text-xs text-text-tertiary">{hints.endpointHint}</p>
        </div>

        {/* API Key */}
        {hints.showApiKey && (
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              API Key <span className="text-text-tertiary font-normal">（可选）</span>
            </label>
            <Input
              type="password"
              placeholder="sk-..."
              value={formState.apiKey}
              onChange={(e) => setFormState((s) => ({ ...s, apiKey: e.target.value }))}
              disabled={saving}
            />
            <p className="mt-1.5 text-xs text-text-tertiary">{hints.apiKeyHint}</p>
          </div>
        )}

        {/* 按钮 */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={onSubmit} loading={saving} disabled={!formState.name.trim() || !formState.endpoint.trim()}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function parseJsonField<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed as T[]
    } catch { /* ignore */ }
  }
  return []
}

function ToolsList({ tools: rawTools, resources: rawResources }: { tools: unknown; resources?: unknown }) {
  const [expanded, setExpanded] = useState(false)
  const tools = parseJsonField<McpTool>(rawTools)
  const resources = parseJsonField<McpResource>(rawResources)
  const hasContent = tools.length > 0 || resources.length > 0

  if (!hasContent) {
    return (
      <p className="text-xs text-text-tertiary mt-3 italic">尚未同步工具列表，点击「同步」获取</p>
    )
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        <Wrench size={12} />
        <span>{tools.length} 个工具</span>
        {resources.length > 0 && (
          <>
            <span className="text-text-tertiary mx-1">·</span>
            <FolderOpen size={12} />
            <span>{resources.length} 个资源</span>
          </>
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
          {tools.map((tool) => (
            <div
              key={tool.name}
              className="flex items-start gap-2 px-2 py-1.5 rounded bg-bg-base text-xs"
            >
              <Wrench size={11} className="text-primary-400 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <span className="font-mono font-medium text-text-primary">{tool.name}</span>
                {tool.description && (
                  <p className="text-text-tertiary mt-0.5 line-clamp-2">{tool.description}</p>
                )}
              </div>
            </div>
          ))}
          {resources.map((resource) => (
            <div
              key={resource.uri}
              className="flex items-start gap-2 px-2 py-1.5 rounded bg-bg-base text-xs"
            >
              <FolderOpen size={11} className="text-accent-400 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <span className="font-mono font-medium text-text-primary">{resource.name}</span>
                {resource.description && (
                  <p className="text-text-tertiary mt-0.5 line-clamp-2">{resource.description}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const EMPTY_FORM = { name: '', description: '', endpoint: '', transport: 'stdio' as TransportType, apiKey: '' }

export default function McpPage() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [editingServerId, setEditingServerId] = useState<string | null>(null)
  const [formState, setFormState] = useState(EMPTY_FORM)

  const loadServers = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await apiClient.get<ApiResponse<McpServer[]>>('/mcp', {
        params: { page: 1, limit: 100 },
      })
      if (response.success) {
        setServers(response.data || [])
      }
    } catch (err) {
      console.error('[MCP] 加载失败:', err)
      setError('加载 MCP Servers 失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  const filteredServers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return servers
    return servers.filter((server) => {
      return (
        server.name.toLowerCase().includes(query) ||
        (server.description || '').toLowerCase().includes(query) ||
        server.endpoint.toLowerCase().includes(query)
      )
    })
  }, [servers, searchQuery])

  const buildPayload = () => {
    const payload: Record<string, unknown> = {
      name: formState.name.trim(),
      endpoint: formState.endpoint.trim(),
      transport: formState.transport,
    }
    if (formState.description.trim()) {
      payload.description = formState.description.trim()
    }
    if (formState.apiKey.trim()) {
      payload.authType = 'api_key'
      payload.authConfig = { apiKey: formState.apiKey.trim() }
    }
    return payload
  }

  const handleCreate = async () => {
    if (!formState.name.trim() || !formState.endpoint.trim()) return
    try {
      setSaving(true)
      await apiClient.post<ApiResponse<McpServer>>('/mcp', buildPayload())
      setFormState(EMPTY_FORM)
      setShowCreate(false)
      await loadServers()
    } catch (err) {
      console.error('[MCP] 创建失败:', err)
      setError('创建 MCP Server 失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (serverId: string) => {
    try {
      setSaving(true)
      await apiClient.delete(`/mcp/${serverId}`)
      await loadServers()
    } catch (err) {
      console.error('[MCP] 删除失败:', err)
      setError('删除 MCP Server 失败')
    } finally {
      setSaving(false)
    }
  }

  const handleTestConnection = async (serverId: string) => {
    try {
      setTestingId(serverId)
      await apiClient.post(`/mcp/${serverId}/test`)
      await loadServers()
    } catch (err) {
      console.error('[MCP] 连接测试失败:', err)
      setError('连接测试失败')
    } finally {
      setTestingId(null)
    }
  }

  const openEditModal = (server: McpServer) => {
    setEditingServerId(server.id)
    setFormState({
      name: server.name,
      description: server.description || '',
      endpoint: server.endpoint,
      transport: server.transport,
      apiKey: server.authConfig?.apiKey || '',
    })
    setShowEdit(true)
  }

  const handleUpdate = async () => {
    if (!editingServerId || !formState.name.trim() || !formState.endpoint.trim()) return
    try {
      setSaving(true)
      await apiClient.put<ApiResponse<McpServer>>(`/mcp/${editingServerId}`, buildPayload())
      setShowEdit(false)
      setEditingServerId(null)
      setFormState(EMPTY_FORM)
      await loadServers()
    } catch (err) {
      console.error('[MCP] 更新失败:', err)
      setError('更新 MCP Server 失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">MCP Servers</h1>
            <p className="text-sm text-text-secondary mt-1">
              管理 Model Context Protocol 服务器，为 Agent 提供外部工具和资源
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={loadServers}>
              刷新
            </Button>
            <Button
              leftIcon={<Plus size={16} />}
              onClick={() => {
                setFormState(EMPTY_FORM)
                setShowCreate(true)
              }}
            >
              添加服务器
            </Button>
          </div>
        </div>
        <div className="mt-4 max-w-md">
          <Input
            placeholder="搜索服务器..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search size={16} />}
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 p-3 rounded-md bg-error-500/10 border border-error-500/30 text-sm text-error-500 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-error-500/60 hover:text-error-500 text-xs">
              关闭
            </button>
          </div>
        )}

        {loading ? (
          <div className="h-40 flex items-center justify-center text-text-secondary">
            <Loader2 size={18} className="animate-spin mr-2" />
            加载中...
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-text-secondary gap-2">
            <Plug size={24} className="text-text-tertiary" />
            <span>暂无 MCP 服务</span>
            <Button size="sm" variant="secondary" onClick={() => setShowCreate(true)}>
              添加第一个服务器
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredServers.map((server) => {
              const transportOpt = TRANSPORT_OPTIONS.find((o) => o.value === server.transport)
              const statusInfo = STATUS_MAP[server.status] || STATUS_MAP.disconnected

              return (
                <Card key={server.id}>
                  <CardContent>
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-md bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                          {transportOpt?.icon || <Plug size={16} className="text-primary-400" />}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-text-primary">{server.name}</div>
                          <div className="text-xs text-text-secondary mt-0.5">
                            {server.description || '无描述'}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-base text-text-tertiary border border-border-subtle font-mono">
                              {transportOpt?.label || server.transport}
                            </span>
                            <div className="flex items-center gap-1">
                              <span className={clsx('w-1.5 h-1.5 rounded-full', statusInfo.dot)} />
                              <span className={clsx('text-[11px]', statusInfo.color)}>{statusInfo.label}</span>
                            </div>
                          </div>
                          <div className="text-[11px] text-text-tertiary mt-1.5 break-all line-clamp-2 font-mono">
                            {server.endpoint}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDelete(server.id)}
                        disabled={saving}
                        className="p-1.5 text-text-tertiary hover:text-error-500 flex-shrink-0"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* 工具和资源列表 */}
                    <ToolsList tools={server.tools || []} resources={server.resources} />

                    <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEditModal(server)}
                        disabled={saving}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleTestConnection(server.id)}
                        disabled={saving || testingId === server.id}
                        leftIcon={testingId === server.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      >
                        测试并同步
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {showCreate && (
        <ServerFormModal
          title="添加 MCP 服务器"
          saving={saving}
          formState={formState}
          setFormState={setFormState}
          onSubmit={handleCreate}
          onCancel={() => {
            setShowCreate(false)
            setFormState(EMPTY_FORM)
          }}
          submitLabel="创建"
        />
      )}

      {showEdit && (
        <ServerFormModal
          title="编辑 MCP 服务器"
          saving={saving}
          formState={formState}
          setFormState={setFormState}
          onSubmit={handleUpdate}
          onCancel={() => {
            setShowEdit(false)
            setEditingServerId(null)
            setFormState(EMPTY_FORM)
          }}
          submitLabel="保存"
        />
      )}
    </div>
  )
}
