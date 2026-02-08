'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Search, Plus, RefreshCw, Trash2, Loader2, Plug } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface McpServer {
  id: string
  name: string
  description?: string
  transport: 'stdio' | 'http' | 'websocket'
  endpoint: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  tools: Array<{ name: string }>
  resources?: Array<{ uri: string; name: string }>
  lastConnectedAt?: string
}

interface McpConnectionTestResult {
  success: boolean
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>
  message?: string
}

export default function McpPage() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEndpoint, setNewEndpoint] = useState('')
  const [newTransport, setNewTransport] = useState<'stdio' | 'http' | 'websocket'>('stdio')
  const [editingServerId, setEditingServerId] = useState<string | null>(null)

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

  const handleCreate = async () => {
    if (!newName.trim() || !newEndpoint.trim()) return
    try {
      setSaving(true)
      await apiClient.post<ApiResponse<McpServer>>('/mcp', {
        name: newName.trim(),
        endpoint: newEndpoint.trim(),
        transport: newTransport,
      })
      setNewName('')
      setNewEndpoint('')
      setNewTransport('stdio')
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
      setSaving(true)
      await apiClient.post(`/mcp/${serverId}/test`)
      await loadServers()
    } catch (err) {
      console.error('[MCP] 连接测试失败:', err)
      setError('连接测试失败')
    } finally {
      setSaving(false)
    }
  }

  const openEditModal = (server: McpServer) => {
    setEditingServerId(server.id)
    setNewName(server.name)
    setNewEndpoint(server.endpoint)
    setNewTransport(server.transport)
    setShowEdit(true)
  }

  const handleUpdate = async () => {
    if (!editingServerId || !newName.trim() || !newEndpoint.trim()) return
    try {
      setSaving(true)
      await apiClient.put<ApiResponse<McpServer>>(`/mcp/${editingServerId}`, {
        name: newName.trim(),
        endpoint: newEndpoint.trim(),
        transport: newTransport,
      })
      setShowEdit(false)
      setEditingServerId(null)
      await loadServers()
    } catch (err) {
      console.error('[MCP] 更新失败:', err)
      setError('更新 MCP Server 失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async (serverId: string) => {
    try {
      setSaving(true)
      const testResponse = await apiClient.post<ApiResponse<McpConnectionTestResult>>(`/mcp/${serverId}/test`)
      const tools = testResponse.data?.tools ?? []
      const resources = testResponse.data?.resources ?? []
      await apiClient.post(`/mcp/${serverId}/sync`, { tools, resources })
      await loadServers()
    } catch (err) {
      console.error('[MCP] 同步失败:', err)
      setError('同步 MCP 工具/资源失败')
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
            <p className="text-sm text-text-secondary mt-1">共 {servers.length} 个服务</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={loadServers}>
              刷新
            </Button>
            <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreate(true)}>
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
          <div className="mb-4 p-3 rounded-md bg-error-500/10 border border-error-500/30 text-sm text-error-500">
            {error}
          </div>
        )}

        {loading ? (
          <div className="h-40 flex items-center justify-center text-text-secondary">
            <Loader2 size={18} className="animate-spin mr-2" />
            加载中...
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-text-secondary">
            暂无 MCP 服务
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredServers.map((server) => (
              <Card key={server.id}>
                <CardContent>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-md bg-primary-500/20 flex items-center justify-center">
                        <Plug size={16} className="text-primary-400" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-text-primary">{server.name}</div>
                        <div className="text-xs text-text-secondary mt-1">
                          {server.description || '无描述'}
                        </div>
                        <div className="text-[11px] text-text-tertiary mt-2 break-all">
                          {server.endpoint}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(server.id)}
                      disabled={saving}
                      className="p-1.5 text-text-tertiary hover:text-error-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="mt-4 flex items-center justify-between">
                    <span
                      className={clsx(
                        'text-xs',
                        server.status === 'connected'
                          ? 'text-success-500'
                          : server.status === 'error'
                            ? 'text-error-500'
                            : 'text-text-tertiary'
                      )}
                    >
                      {server.status}
                    </span>
                    <div className="flex items-center gap-2">
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
                        disabled={saving}
                      >
                        测试
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleSync(server.id)}
                        disabled={saving}
                      >
                        同步
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">添加 MCP 服务器</h3>
            <Input
              placeholder="服务器名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={saving}
            />
            <Input
              placeholder="服务端点（stdio命令或HTTP地址）"
              value={newEndpoint}
              onChange={(e) => setNewEndpoint(e.target.value)}
              disabled={saving}
            />
            <select
              value={newTransport}
              onChange={(e) => setNewTransport(e.target.value as typeof newTransport)}
              disabled={saving}
              className={clsx(
                'w-full px-3 py-2 rounded-md',
                'bg-bg-surface border border-border-default text-text-primary',
                'focus:outline-none focus:border-primary-500'
              )}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="websocket">websocket</option>
            </select>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowCreate(false)} disabled={saving}>
                取消
              </Button>
              <Button onClick={handleCreate} loading={saving}>
                创建
              </Button>
            </div>
          </div>
        </div>
      )}

      {showEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">编辑 MCP 服务器</h3>
            <Input
              placeholder="服务器名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={saving}
            />
            <Input
              placeholder="服务端点（stdio命令或HTTP地址）"
              value={newEndpoint}
              onChange={(e) => setNewEndpoint(e.target.value)}
              disabled={saving}
            />
            <select
              value={newTransport}
              onChange={(e) => setNewTransport(e.target.value as typeof newTransport)}
              disabled={saving}
              className={clsx(
                'w-full px-3 py-2 rounded-md',
                'bg-bg-surface border border-border-default text-text-primary',
                'focus:outline-none focus:border-primary-500'
              )}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="websocket">websocket</option>
            </select>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowEdit(false)} disabled={saving}>
                取消
              </Button>
              <Button onClick={handleUpdate} loading={saving}>
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
