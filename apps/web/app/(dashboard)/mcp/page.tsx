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
import { Modal } from '@/components/ui/Modal'
import { Tooltip } from '@/components/ui/Tooltip'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'

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
  isSystem?: boolean
}
type TransportType = 'stdio' | 'sse' | 'streamable_http'
type Translate = (key: string, params?: Record<string, string | number>) => string

function getTransportOptions(t: Translate): {
  value: TransportType
  label: string
  icon: React.ReactNode
  description: string
}[] {
  return [
    {
      value: 'stdio',
      label: 'Stdio',
      icon: <Terminal size={16} />,
      description: t('mcp.transport.stdio.description'),
    },
    {
      value: 'sse',
      label: 'SSE',
      icon: <Radio size={16} />,
      description: t('mcp.transport.sse.description'),
    },
    {
      value: 'streamable_http',
      label: 'Streamable HTTP',
      icon: <Globe size={16} />,
      description: t('mcp.transport.streamableHttp.description'),
    },
  ]
}

function getTransportHints(t: Translate): Record<
  TransportType,
  { endpointLabel: string; endpointPlaceholder: string; endpointHint: string; showApiKey: boolean; apiKeyHint: string }
>
{
  return {
    stdio: {
      endpointLabel: t('mcp.form.endpointLabel.command'),
      endpointPlaceholder: 'npx -y @modelcontextprotocol/server-filesystem /path/to/dir',
      endpointHint: t('mcp.form.endpointHint.command'),
      showApiKey: true,
      apiKeyHint: t('mcp.form.apiKeyHint.stdio'),
    },
    sse: {
      endpointLabel: 'SSE URL',
      endpointPlaceholder: 'https://mcp-server.example.com/sse',
      endpointHint: t('mcp.form.endpointHint.sse'),
      showApiKey: true,
      apiKeyHint: t('mcp.form.apiKeyHint.http'),
    },
    streamable_http: {
      endpointLabel: 'HTTP URL',
      endpointPlaceholder: 'https://mcp-server.example.com/mcp',
      endpointHint: t('mcp.form.endpointHint.streamableHttp'),
      showApiKey: true,
      apiKeyHint: t('mcp.form.apiKeyHint.http'),
    },
  }
}

function getStatusMap(t: Translate): Record<string, { label: string; color: string; dot: string }> {
  return {
    connected: { label: t('mcp.status.connected'), color: 'text-success-500', dot: 'bg-success-500' },
    connecting: { label: t('mcp.status.connecting'), color: 'text-warning-500', dot: 'bg-warning-500' },
    error: { label: t('mcp.status.error'), color: 'text-error-500', dot: 'bg-error-500' },
    disconnected: { label: t('mcp.status.disconnected'), color: 'text-text-tertiary', dot: 'bg-text-tertiary' },
  }
}

function ServerFormModal({
  title,
  saving,
  formState,
  setFormState,
  onSubmit,
  onCancel,
  submitLabel,
  showIsSystem,
}: {
  title: string
  saving: boolean
  formState: {
    name: string
    description: string
    endpoint: string
    transport: TransportType
    apiKey: string
    isSystem: boolean
  }
  setFormState: React.Dispatch<
    React.SetStateAction<{
      name: string
      description: string
      endpoint: string
      transport: TransportType
      apiKey: string
      isSystem: boolean
    }>
  >
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
  showIsSystem?: boolean
}) {
  const { t } = useLocale()
  const hints = getTransportHints(t)[formState.transport]
  const transportOptions = getTransportOptions(t)

  return (
    <Modal
      open={true}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSubmit} loading={saving} disabled={!formState.name.trim() || !formState.endpoint.trim()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* 传输类型选择 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">{t('mcp.form.transport')}</label>
          <div className="grid grid-cols-3 gap-2">
            {transportOptions.map((opt) => (
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
            {transportOptions.find((o) => o.value === formState.transport)?.description}
          </p>
        </div>

        {/* 名称 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">{t('mcp.form.name')}</label>
          <Input
            placeholder={t('mcp.form.namePlaceholder')}
            value={formState.name}
            onChange={(e) => setFormState((s) => ({ ...s, name: e.target.value }))}
            disabled={saving}
          />
        </div>

        {/* 描述 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t('mcp.form.description')} <span className="text-text-tertiary font-normal">{t('mcp.form.optional')}</span>
          </label>
          <Input
            placeholder={t('mcp.form.descriptionPlaceholder')}
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
              API Key <span className="text-text-tertiary font-normal">{t('mcp.form.optional')}</span>
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

        {/* 系统 MCP 勾选 */}
        {showIsSystem && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formState.isSystem}
              onChange={(e) => setFormState((s) => ({ ...s, isSystem: e.target.checked }))}
              disabled={saving}
              className="rounded border-border-default"
            />
            <span className="text-sm text-text-secondary">{t('mcp.form.systemMcp')}</span>
          </label>
        )}
      </div>
    </Modal>
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
  const { t } = useLocale()
  const [expanded, setExpanded] = useState(false)
  const tools = parseJsonField<McpTool>(rawTools)
  const resources = parseJsonField<McpResource>(rawResources)
  const hasContent = tools.length > 0 || resources.length > 0

  if (!hasContent) {
    return (
      <p className="text-xs text-text-tertiary mt-3 italic">{t('mcp.tools.notSynced')}</p>
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
        <span>{t('mcp.tools.count', { count: tools.length })}</span>
        {resources.length > 0 && (
          <>
            <span className="text-text-tertiary mx-1">·</span>
            <FolderOpen size={12} />
            <span>{t('mcp.resources.count', { count: resources.length })}</span>
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

const EMPTY_FORM = { name: '', description: '', endpoint: '', transport: 'stdio' as TransportType, apiKey: '', isSystem: false }

export default function McpPage() {
  const { t } = useLocale()
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
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([])

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
      setError(t('mcp.error.load'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  const filteredServers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const filtered = query
      ? servers.filter((server) => {
          return (
            server.name.toLowerCase().includes(query) ||
            (server.description || '').toLowerCase().includes(query) ||
            server.endpoint.toLowerCase().includes(query)
          )
        })
      : servers
    // 系统 MCP 排在前面
    return [...filtered].sort((a, b) => {
      if (a.isSystem && !b.isSystem) return -1
      if (!a.isSystem && b.isSystem) return 1
      return 0
    })
  }, [servers, searchQuery])

  const filteredServerIds = useMemo(() => filteredServers.map((server) => server.id), [filteredServers])
  const selectedCount = selectedServerIds.length
  const allFilteredSelected =
    filteredServerIds.length > 0 && filteredServerIds.every((id) => selectedServerIds.includes(id))

  useEffect(() => {
    const validIds = new Set(servers.map((server) => server.id))
    setSelectedServerIds((prev) => prev.filter((id) => validIds.has(id)))
  }, [servers])

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
    if (formState.isSystem) {
      payload.isSystem = true
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
      setError(t('mcp.error.create'))
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
      setError(t('mcp.error.delete'))
    } finally {
      setSaving(false)
    }
  }

  const toggleSelectServer = (serverId: string) => {
    setSelectedServerIds((prev) =>
      prev.includes(serverId) ? prev.filter((id) => id !== serverId) : [...prev, serverId]
    )
  }

  const toggleSelectAllFiltered = () => {
    setSelectedServerIds((prev) => {
      if (allFilteredSelected) {
        return prev.filter((id) => !filteredServerIds.includes(id))
      }
      const next = new Set(prev)
      filteredServerIds.forEach((id) => next.add(id))
      return Array.from(next)
    })
  }

  const handleBatchTestConnection = async () => {
    if (selectedServerIds.length === 0) return
    try {
      setSaving(true)
      setError(null)
      const total = selectedServerIds.length
      const results = await Promise.allSettled(
        selectedServerIds.map((id) => apiClient.post(`/mcp/${id}/test`))
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      setSelectedServerIds([])
      await loadServers()
      if (failed > 0) {
        setError(t('mcp.error.batchTest', { failed, total }))
      }
    } finally {
      setSaving(false)
    }
  }

  const handleBatchDelete = async () => {
    if (selectedServerIds.length === 0) return
    if (!confirm(t('mcp.confirm.batchDelete', { count: selectedServerIds.length }))) return

    try {
      setSaving(true)
      setError(null)
      const total = selectedServerIds.length
      const results = await Promise.allSettled(
        selectedServerIds.map((id) => apiClient.delete(`/mcp/${id}`))
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      setSelectedServerIds([])
      await loadServers()
      if (failed > 0) {
        setError(t('mcp.error.batchDelete', { failed, total }))
      }
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
      setError(t('mcp.error.test'))
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
      isSystem: server.isSystem || false,
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
      setError(t('mcp.error.update'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      <div className="mx-auto flex w-full max-w-6xl flex-1 min-h-0 flex-col">
        <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-text-primary">{t('mcp.title')}</h1>
              <p className="text-sm text-text-secondary mt-1">
                {t('mcp.subtitle')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={loadServers}>
                {t('common.refresh')}
              </Button>
              <Button
                leftIcon={<Plus size={16} />}
                onClick={() => {
                  setFormState(EMPTY_FORM)
                  setShowCreate(true)
                }}
              >
                {t('mcp.addServer')}
              </Button>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-4">
            <div className="max-w-md flex-1">
              <Input
                placeholder={t('mcp.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                leftIcon={<Search size={16} />}
              />
            </div>
            {filteredServers.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  data-testid="mcp-select-all"
                  type="checkbox"
                  className="rounded border-border-default"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAllFiltered}
                  disabled={saving}
                />
                {t('mcp.batch.selectAllVisible')}
              </label>
            )}
          </div>

          {selectedCount > 0 && (
            <div className="mt-3 rounded-md border border-primary-500/30 bg-primary-500/10 px-3 py-2 flex flex-wrap items-center gap-2">
              <span className="text-sm text-text-primary">
                {t('mcp.batch.selectedCount', { count: selectedCount })}
              </span>
              <Button
                data-testid="mcp-batch-test-sync"
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={handleBatchTestConnection}
              >
                {t('mcp.batch.testAndSync')}
              </Button>
              <Button
                data-testid="mcp-batch-delete"
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={handleBatchDelete}
              >
                {t('mcp.batch.delete')}
              </Button>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 p-3 rounded-md bg-error-500/10 border border-error-500/30 text-sm text-error-500 flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-error-500/60 hover:text-error-500 text-xs">
                {t('common.close')}
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
            </div>
          ) : filteredServers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12">
              <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-4">
                <Plug size={32} className="text-text-tertiary" />
              </div>
              {searchQuery ? (
                <>
                  <h3 className="text-lg font-medium text-text-primary">{t('mcp.empty.filteredTitle')}</h3>
                  <p className="text-sm text-text-secondary mt-1 mb-4">{t('mcp.empty.filteredDescription')}</p>
                  <Button variant="secondary" onClick={() => setSearchQuery('')}>{t('mcp.empty.clearSearch')}</Button>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-medium text-text-primary">{t('mcp.empty.defaultTitle')}</h3>
                  <p className="text-sm text-text-secondary mt-1 mb-4">{t('mcp.empty.defaultDescription')}</p>
                  <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreate(true)}>{t('mcp.addServer')}</Button>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredServers.map((server) => {
              const transportOpt = getTransportOptions(t).find((o) => o.value === server.transport)
              const statusMap = getStatusMap(t)
              const statusInfo = statusMap[server.status] || statusMap.disconnected

              return (
                <Card key={server.id}>
                  <CardContent>
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 min-w-0">
                        <input
                          data-testid={`mcp-select-${server.id}`}
                          type="checkbox"
                          className="mt-1 rounded border-border-default"
                          checked={selectedServerIds.includes(server.id)}
                          onChange={() => toggleSelectServer(server.id)}
                          disabled={saving || testingId === server.id}
                        />
                        <div className="w-9 h-9 rounded-md bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                          {transportOpt?.icon || <Plug size={16} className="text-primary-400" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-semibold text-text-primary">{server.name}</div>
                            {server.isSystem && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-400 border border-primary-500/20 font-medium">
                                {t('mcp.system')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-text-secondary mt-0.5">
                            {server.description || t('mcp.noDescription')}
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
                      <Tooltip content={t('common.delete')}>
                        <button
                          onClick={() => handleDelete(server.id)}
                          disabled={saving}
                          className="p-1.5 text-text-tertiary hover:text-error-500 flex-shrink-0"
                        >
                          <Trash2 size={14} />
                        </button>
                      </Tooltip>
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
                        {t('common.edit')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleTestConnection(server.id)}
                        disabled={saving || testingId === server.id}
                        leftIcon={testingId === server.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      >
                        {t('mcp.testAndSync')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <ServerFormModal
          title={t('mcp.modal.addTitle')}
          saving={saving}
          formState={formState}
          setFormState={setFormState}
          onSubmit={handleCreate}
          onCancel={() => {
            setShowCreate(false)
            setFormState(EMPTY_FORM)
          }}
          submitLabel={t('common.create')}
          showIsSystem={true}
        />
      )}

      {showEdit && (
        <ServerFormModal
          title={t('mcp.modal.editTitle')}
          saving={saving}
          formState={formState}
          setFormState={setFormState}
          onSubmit={handleUpdate}
          onCancel={() => {
            setShowEdit(false)
            setEditingServerId(null)
            setFormState(EMPTY_FORM)
          }}
          submitLabel={t('common.save')}
          showIsSystem={true}
        />
      )}
    </div>
  )
}
