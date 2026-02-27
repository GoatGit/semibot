'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  KeyRound,
  Building2,
  Webhook,
  Plus,
  Pencil,
  Trash2,
  TestTube2,
  Loader2,
  Cpu,
  Wrench,
  RefreshCw,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { apiClient } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'

interface ApiResponse<T> {
  success: boolean
  data: T
  meta?: {
    total?: number
    page?: number
    limit?: number
    totalPages?: number
  }
}

interface Organization {
  id: string
  name: string
  slug: string
  plan: string
  settings?: Record<string, unknown>
}

interface ApiKeyItem {
  id: string
  name: string
  keyPrefix: string
  permissions: string[]
  lastUsedAt?: string
  expiresAt?: string
  isActive: boolean
}

interface CreatedApiKey extends ApiKeyItem {
  key: string
}

interface WebhookItem {
  id: string
  url: string
  events: string[]
  isActive: boolean
  createdAt: string
}

interface LlmProviderStatus {
  name: string
  displayName: string
  available: boolean
  models: string[]
}

interface ToolItem {
  id: string
  name: string
  type: string
  description?: string
  schema?: {
    parameters?: Record<string, unknown>
    returns?: Record<string, unknown>
  }
  config?: {
    timeout?: number
    retryAttempts?: number
    requiresApproval?: boolean
    rateLimit?: number
  }
  isBuiltin: boolean
  isActive: boolean
  createdAt?: string
  updatedAt?: string
}

interface RuntimeSkillsData {
  available: boolean
  tools: string[]
  skills: string[]
  source: string
  error?: string
}

const DEFAULT_EVENTS = ['chat.message.completed', 'task.completed', 'task.failed']
const MIN_WEBHOOK_SECRET_LENGTH = 16
type ConfigTab = 'organization' | 'apiKeys' | 'webhooks' | 'capabilities'
type SectionKey = 'organization' | 'apiKeys' | 'webhooks' | 'llmProviders' | 'tools'
type ToolForm = {
  id?: string
  name: string
  type: string
  description: string
  timeoutMs: string
}

function formatDate(dateString?: string): string {
  if (!dateString) return '未设置'
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '未设置'
  return date.toLocaleString('zh-CN')
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const payload = error as {
      message?: string
      response?: {
        data?: {
          error?: { message?: string }
          message?: string
        }
      }
    }
    if (payload.response?.data?.error?.message) return payload.response.data.error.message
    if (payload.response?.data?.message) return payload.response.data.message
    if (payload.message) return payload.message
  }
  return fallback
}

export default function ConfigPage() {
  const user = useAuthStore((s) => s.user)
  const isOwner = user?.role === 'owner'

  const [activeTab, setActiveTab] = useState<ConfigTab>('organization')
  const [loading, setLoading] = useState(true)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sectionLoading, setSectionLoading] = useState<Record<SectionKey, boolean>>({
    organization: false,
    apiKeys: false,
    webhooks: false,
    llmProviders: false,
    tools: false,
  })
  const [sectionErrors, setSectionErrors] = useState<{
    organization: string | null
    apiKeys: string | null
    webhooks: string | null
    llmProviders: string | null
    tools: string | null
  }>({
    organization: null,
    apiKeys: null,
    webhooks: null,
    llmProviders: null,
    tools: null,
  })

  const [org, setOrg] = useState<Organization | null>(null)
  const [orgName, setOrgName] = useState('')
  const [orgSettingsText, setOrgSettingsText] = useState('{}')
  const [savingOrg, setSavingOrg] = useState(false)

  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([])
  const [showCreateKey, setShowCreateKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState('')
  const [creatingKey, setCreatingKey] = useState(false)
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null)

  const [webhooks, setWebhooks] = useState<WebhookItem[]>([])
  const [llmProviders, setLlmProviders] = useState<LlmProviderStatus[]>([])
  const [tools, setTools] = useState<ToolItem[]>([])
  const [runtimeSkills, setRuntimeSkills] = useState<RuntimeSkillsData>({
    available: false,
    tools: [],
    skills: [],
    source: '',
  })
  const [showCreateWebhook, setShowCreateWebhook] = useState(false)
  const [creatingWebhook, setCreatingWebhook] = useState(false)
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null)
  const [webhookForm, setWebhookForm] = useState({
    url: '',
    secret: '',
    eventsText: DEFAULT_EVENTS.join(','),
  })
  const [showCreateTool, setShowCreateTool] = useState(false)
  const [showEditTool, setShowEditTool] = useState(false)
  const [savingTool, setSavingTool] = useState(false)
  const [toolForm, setToolForm] = useState<ToolForm>({
    name: '',
    type: 'custom',
    description: '',
    timeoutMs: '',
  })

  const setSectionLoadingFlag = useCallback((section: SectionKey, value: boolean) => {
    setSectionLoading((prev) => ({ ...prev, [section]: value }))
  }, [])

  const loadOrganization = useCallback(async () => {
    setSectionLoadingFlag('organization', true)
    try {
      const response = await apiClient.get<ApiResponse<Organization>>('/organizations/current')
      if (!response.success) {
        throw new Error('组织配置加载失败')
      }
      setOrg(response.data)
      setOrgName(response.data.name || '')
      setOrgSettingsText(JSON.stringify(response.data.settings || {}, null, 2))
      setSectionErrors((prev) => ({ ...prev, organization: null }))
    } catch (err) {
      setOrg(null)
      setSectionErrors((prev) => ({
        ...prev,
        organization: getErrorMessage(err, '组织配置加载失败'),
      }))
    } finally {
      setSectionLoadingFlag('organization', false)
    }
  }, [setSectionLoadingFlag])

  const loadApiKeys = useCallback(async () => {
    setSectionLoadingFlag('apiKeys', true)
    try {
      const response = await apiClient.get<ApiResponse<ApiKeyItem[]>>('/api-keys')
      if (!response.success) {
        throw new Error('API Key 列表加载失败')
      }
      setApiKeys(response.data || [])
      setSectionErrors((prev) => ({ ...prev, apiKeys: null }))
    } catch (err) {
      setApiKeys([])
      setSectionErrors((prev) => ({
        ...prev,
        apiKeys: getErrorMessage(err, 'API Key 列表加载失败'),
      }))
    } finally {
      setSectionLoadingFlag('apiKeys', false)
    }
  }, [setSectionLoadingFlag])

  const loadWebhooks = useCallback(async () => {
    setSectionLoadingFlag('webhooks', true)
    try {
      const response = await apiClient.get<ApiResponse<WebhookItem[]>>('/webhooks', {
        params: { page: 1, limit: 50 },
      })
      if (!response.success) {
        throw new Error('Webhook 列表加载失败')
      }
      setWebhooks(response.data || [])
      setSectionErrors((prev) => ({ ...prev, webhooks: null }))
    } catch (err) {
      setWebhooks([])
      setSectionErrors((prev) => ({
        ...prev,
        webhooks: getErrorMessage(err, 'Webhook 列表加载失败'),
      }))
    } finally {
      setSectionLoadingFlag('webhooks', false)
    }
  }, [setSectionLoadingFlag])

  const loadLlmProviders = useCallback(async () => {
    setSectionLoadingFlag('llmProviders', true)
    try {
      const response = await apiClient.get<ApiResponse<LlmProviderStatus[]>>('/llm-providers/status')
      if (!response.success) {
        throw new Error('LLM Provider 状态加载失败')
      }
      setLlmProviders(response.data || [])
      setSectionErrors((prev) => ({ ...prev, llmProviders: null }))
    } catch (err) {
      setLlmProviders([])
      setSectionErrors((prev) => ({
        ...prev,
        llmProviders: getErrorMessage(err, 'LLM Provider 状态加载失败'),
      }))
    } finally {
      setSectionLoadingFlag('llmProviders', false)
    }
  }, [setSectionLoadingFlag])

  const loadTools = useCallback(async () => {
    setSectionLoadingFlag('tools', true)
    try {
      const [toolsRes, runtimeRes] = await Promise.allSettled([
        apiClient.get<ApiResponse<ToolItem[]>>('/tools', { params: { page: 1, limit: 100 } }),
        apiClient.get<ApiResponse<RuntimeSkillsData>>('/runtime/skills'),
      ])

      if (toolsRes.status === 'fulfilled' && toolsRes.value.success) {
        setTools(toolsRes.value.data || [])
        setSectionErrors((prev) => ({ ...prev, tools: null }))
      } else {
        setTools([])
        setSectionErrors((prev) => ({ ...prev, tools: 'Tools 列表加载失败' }))
      }

      if (runtimeRes.status === 'fulfilled' && runtimeRes.value.success) {
        setRuntimeSkills(runtimeRes.value.data)
      } else {
        setRuntimeSkills({
          available: false,
          tools: [],
          skills: [],
          source: '',
          error: 'Runtime 内置工具读取失败',
        })
      }
    } catch (err) {
      setTools([])
      setSectionErrors((prev) => ({
        ...prev,
        tools: getErrorMessage(err, 'Tools 列表加载失败'),
      }))
    } finally {
      setSectionLoadingFlag('tools', false)
    }
  }, [setSectionLoadingFlag])

  const loadCapabilities = useCallback(async () => {
    await Promise.all([loadLlmProviders(), loadTools()])
  }, [loadLlmProviders, loadTools])

  const loadData = useCallback(async () => {
    setRefreshingAll(true)
    setError(null)
    await Promise.all([loadOrganization(), loadApiKeys(), loadWebhooks(), loadCapabilities()])
    setLoading(false)
    setRefreshingAll(false)
  }, [loadApiKeys, loadCapabilities, loadOrganization, loadWebhooks])

  useEffect(() => {
    loadData()
  }, [loadData])

  const saveOrganization = async () => {
    try {
      setSavingOrg(true)
      setError(null)
      let parsed: Record<string, unknown>
      try {
        parsed = orgSettingsText.trim() ? JSON.parse(orgSettingsText) : {}
      } catch {
        setError('组织 Settings 不是合法 JSON，请先修正再保存')
        return
      }

      const response = await apiClient.put<ApiResponse<Organization>>('/organizations/current', {
        name: orgName.trim(),
        settings: parsed,
      })
      if (response.success) {
        setOrg((prev) => (prev ? { ...prev, name: orgName.trim(), settings: parsed } : prev))
      }
    } catch (err) {
      setError(getErrorMessage(err, '保存组织配置失败'))
    } finally {
      setSavingOrg(false)
    }
  }

  const createApiKey = async () => {
    if (!newKeyName.trim()) return
    try {
      setCreatingKey(true)
      setError(null)
      const response = await apiClient.post<ApiResponse<CreatedApiKey>>('/api-keys', {
        name: newKeyName.trim(),
        expiresAt: newKeyExpiresAt ? new Date(newKeyExpiresAt).toISOString() : undefined,
      })
      if (response.success) {
        setCreatedKey(response.data)
        setShowCreateKey(false)
        setNewKeyName('')
        setNewKeyExpiresAt('')
        await loadApiKeys()
      }
    } catch (err) {
      setError(getErrorMessage(err, '创建 API Key 失败'))
    } finally {
      setCreatingKey(false)
    }
  }

  const removeApiKey = async (id: string) => {
    if (!window.confirm('确认删除这个 API Key 吗？删除后无法恢复。')) return
    try {
      setError(null)
      await apiClient.delete('/api-keys/' + id)
      await loadApiKeys()
    } catch (err) {
      setError(getErrorMessage(err, '删除 API Key 失败'))
    }
  }

  const createWebhook = async () => {
    try {
      setCreatingWebhook(true)
      setError(null)
      if (!/^https?:\/\/.+/i.test(webhookForm.url.trim())) {
        setError('Webhook URL 必须是 http(s) 地址')
        return
      }
      if (webhookForm.secret.trim().length < MIN_WEBHOOK_SECRET_LENGTH) {
        setError(`Webhook secret 至少 ${MIN_WEBHOOK_SECRET_LENGTH} 个字符`)
        return
      }
      const events = webhookForm.eventsText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      if (events.length === 0) {
        setError('至少需要一个事件名称')
        return
      }
      await apiClient.post('/webhooks', {
        url: webhookForm.url.trim(),
        secret: webhookForm.secret.trim(),
        events,
      })
      setShowCreateWebhook(false)
      setWebhookForm({ url: '', secret: '', eventsText: DEFAULT_EVENTS.join(',') })
      await loadWebhooks()
    } catch (err) {
      setError(getErrorMessage(err, '创建 Webhook 失败'))
    } finally {
      setCreatingWebhook(false)
    }
  }

  const toggleWebhook = async (item: WebhookItem) => {
    try {
      setError(null)
      await apiClient.patch('/webhooks/' + item.id, { isActive: !item.isActive })
      await loadWebhooks()
    } catch (err) {
      setError(getErrorMessage(err, '更新 Webhook 失败'))
    }
  }

  const testWebhook = async (id: string) => {
    try {
      setTestingWebhookId(id)
      setError(null)
      await apiClient.post('/webhooks/' + id + '/test')
    } catch (err) {
      setError(getErrorMessage(err, '测试 Webhook 失败'))
    } finally {
      setTestingWebhookId(null)
    }
  }

  const removeWebhook = async (id: string) => {
    if (!window.confirm('确认删除这个 Webhook 吗？删除后无法恢复。')) return
    try {
      setError(null)
      await apiClient.delete('/webhooks/' + id)
      await loadWebhooks()
    } catch (err) {
      setError(getErrorMessage(err, '删除 Webhook 失败'))
    }
  }

  const openCreateToolDialog = () => {
    setToolForm({
      name: '',
      type: 'custom',
      description: '',
      timeoutMs: '',
    })
    setShowCreateTool(true)
  }

  const openEditToolDialog = (tool: ToolItem) => {
    setToolForm({
      id: tool.id,
      name: tool.name,
      type: tool.type || 'custom',
      description: tool.description || '',
      timeoutMs: tool.config?.timeout ? String(tool.config.timeout) : '',
    })
    setShowEditTool(true)
  }

  const saveTool = async (mode: 'create' | 'edit') => {
    if (!toolForm.name.trim() || !toolForm.type.trim()) {
      setError('工具名称和类型不能为空')
      return
    }

    const timeout = toolForm.timeoutMs.trim()
    if (timeout && (!/^\d+$/.test(timeout) || Number(timeout) < 1000)) {
      setError('timeout 必须是 >= 1000 的整数（毫秒）')
      return
    }

    const payload = {
      name: toolForm.name.trim(),
      type: toolForm.type.trim(),
      description: toolForm.description.trim() || undefined,
      config: timeout ? { timeout: Number(timeout) } : undefined,
    }

    try {
      setSavingTool(true)
      setError(null)

      if (mode === 'create') {
        await apiClient.post('/tools', payload)
        setShowCreateTool(false)
      } else {
        if (!toolForm.id) {
          setError('缺少工具 ID，无法保存')
          return
        }
        await apiClient.put('/tools/' + toolForm.id, payload)
        setShowEditTool(false)
      }

      await loadTools()
    } catch (err) {
      setError(getErrorMessage(err, mode === 'create' ? '创建工具失败' : '更新工具失败'))
    } finally {
      setSavingTool(false)
    }
  }

  const toggleToolStatus = async (tool: ToolItem) => {
    if (tool.isBuiltin) return
    try {
      setError(null)
      await apiClient.put('/tools/' + tool.id, { isActive: !tool.isActive })
      await loadTools()
    } catch (err) {
      setError(getErrorMessage(err, '更新工具状态失败'))
    }
  }

  const removeTool = async (tool: ToolItem) => {
    if (tool.isBuiltin) return
    if (!window.confirm(`确认删除工具“${tool.name}”吗？删除后无法恢复。`)) return
    try {
      setError(null)
      await apiClient.delete('/tools/' + tool.id)
      await loadTools()
    } catch (err) {
      setError(getErrorMessage(err, '删除工具失败'))
    }
  }

  const permissionHint = useMemo(() => {
    if (isOwner) return null
    return '你当前不是 owner 角色，部分平台级配置可能无权限。'
  }, [isOwner])

  const activeToolsCount = useMemo(
    () => tools.filter((tool) => tool.isActive).length,
    [tools]
  )

  const tabs = useMemo(
    () => [
      { id: 'organization' as const, label: '组织', count: org ? 1 : 0 },
      { id: 'apiKeys' as const, label: 'API Keys', count: apiKeys.length },
      { id: 'webhooks' as const, label: 'Webhooks', count: webhooks.length },
      {
        id: 'capabilities' as const,
        label: '能力',
        count:
          llmProviders.filter((item) => item.available).length +
          activeToolsCount +
          runtimeSkills.tools.length,
      },
    ],
    [activeToolsCount, apiKeys.length, llmProviders, org, runtimeSkills.tools.length, webhooks.length]
  )

  const isAnySectionLoading = Object.values(sectionLoading).some(Boolean)

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">配置管理</h1>
            <p className="mt-1 text-sm text-text-secondary">
              统一管理组织配置、API Key、Webhook 与能力状态。
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={loadData}
            leftIcon={<Loader2 size={16} className={refreshingAll || isAnySectionLoading ? 'animate-spin' : ''} />}
          >
            刷新
          </Button>
        </div>

        {permissionHint && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            {permissionHint}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors duration-fast',
                activeTab === tab.id
                  ? 'border-primary-500 bg-primary-500/10 text-primary-300'
                  : 'border-border-default text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
              )}
            >
              <span>{tab.label}</span>
              <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs">{tab.count}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <Card className="border-border-default">
            <CardContent className="flex items-center justify-center py-16">
              <Loader2 size={22} className="animate-spin text-primary-500" />
              <span className="ml-2 text-sm text-text-secondary">加载配置中...</span>
            </CardContent>
          </Card>
        ) : (
          <>
            {activeTab === 'organization' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Building2 size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">组织配置</h2>
                    </div>
                    <Button
                      size="xs"
                      variant="tertiary"
                      leftIcon={<RefreshCw size={13} className={sectionLoading.organization ? 'animate-spin' : ''} />}
                      onClick={loadOrganization}
                    >
                      刷新
                    </Button>
                  </div>
                  {sectionErrors.organization && (
                    <p className="text-xs text-warning-500">{sectionErrors.organization}</p>
                  )}
                  <Input
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="组织名称"
                    disabled={sectionLoading.organization}
                  />
                  <div className="space-y-2">
                    <p className="text-xs text-text-tertiary">Settings(JSON)</p>
                    <textarea
                      value={orgSettingsText}
                      onChange={(e) => setOrgSettingsText(e.target.value)}
                      className={clsx(
                        'min-h-40 w-full rounded-md border border-border-default bg-bg-surface p-3',
                        'font-mono text-xs text-text-primary focus:outline-none focus:border-primary-500'
                      )}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-text-tertiary">
                    <span>Slug: {org?.slug || '--'}</span>
                    <span>Plan: {org?.plan || '--'}</span>
                  </div>
                  <Button
                    onClick={saveOrganization}
                    loading={savingOrg}
                    disabled={sectionLoading.organization || !org}
                  >
                    保存组织配置
                  </Button>
                </CardContent>
              </Card>
            )}

            {activeTab === 'apiKeys' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <KeyRound size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">API Keys</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCw size={13} className={sectionLoading.apiKeys ? 'animate-spin' : ''} />}
                        onClick={loadApiKeys}
                      >
                        刷新
                      </Button>
                      <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setShowCreateKey(true)}>
                        新建 Key
                      </Button>
                    </div>
                  </div>
                  {sectionErrors.apiKeys && (
                    <p className="text-xs text-warning-500">{sectionErrors.apiKeys}</p>
                  )}
                  <div className="space-y-2">
                    {sectionLoading.apiKeys && apiKeys.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        正在加载 API Key...
                      </p>
                    ) : apiKeys.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border-default bg-bg-surface px-4 py-6 text-center">
                        <p className="text-sm text-text-secondary">暂无 API Key</p>
                        <p className="mt-1 text-xs text-text-tertiary">用于第三方调用 Semibot API</p>
                      </div>
                    ) : (
                      apiKeys.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-text-primary">{item.name}</p>
                              <p className="text-xs text-text-tertiary">{item.keyPrefix}...</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={item.isActive ? 'success' : 'outline'}>
                                {item.isActive ? '启用' : '停用'}
                              </Badge>
                              <button
                                type="button"
                                className="rounded p-1.5 text-text-tertiary hover:bg-interactive-hover hover:text-error-500"
                                onClick={() => removeApiKey(item.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                          <div className="mt-2 text-xs text-text-tertiary">
                            最近使用: {formatDate(item.lastUsedAt)} · 过期: {formatDate(item.expiresAt)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'webhooks' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Webhook size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">Webhooks</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCw size={13} className={sectionLoading.webhooks ? 'animate-spin' : ''} />}
                        onClick={loadWebhooks}
                      >
                        刷新
                      </Button>
                      <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setShowCreateWebhook(true)}>
                        新建 Webhook
                      </Button>
                    </div>
                  </div>
                  {sectionErrors.webhooks && (
                    <p className="text-xs text-warning-500">{sectionErrors.webhooks}</p>
                  )}
                  <div className="space-y-2">
                    {sectionLoading.webhooks && webhooks.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        正在加载 Webhook...
                      </p>
                    ) : webhooks.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border-default bg-bg-surface px-4 py-6 text-center">
                        <p className="text-sm text-text-secondary">暂无 Webhook</p>
                        <p className="mt-1 text-xs text-text-tertiary">可用于事件推送到飞书、钉钉或自建服务</p>
                      </div>
                    ) : (
                      webhooks.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-text-primary">{item.url}</p>
                              <p className="mt-1 text-xs text-text-tertiary">
                                事件: {item.events.join(', ')} · 创建时间: {formatDate(item.createdAt)}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={item.isActive ? 'success' : 'outline'}>
                                {item.isActive ? '启用' : '停用'}
                              </Badge>
                              <Button
                                size="xs"
                                variant="tertiary"
                                onClick={() => testWebhook(item.id)}
                                disabled={testingWebhookId === item.id}
                              >
                                <TestTube2 size={13} />
                              </Button>
                              <Button size="xs" variant="tertiary" onClick={() => toggleWebhook(item)}>
                                {item.isActive ? '停用' : '启用'}
                              </Button>
                              <button
                                type="button"
                                className="rounded p-1.5 text-text-tertiary hover:bg-interactive-hover hover:text-error-500"
                                onClick={() => removeWebhook(item.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'capabilities' && (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card className="border-border-default">
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Cpu size={18} className="text-primary-400" />
                        <h2 className="text-lg font-semibold text-text-primary">LLM Provider 状态</h2>
                      </div>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCw size={13} className={sectionLoading.llmProviders ? 'animate-spin' : ''} />}
                        onClick={loadLlmProviders}
                      >
                        刷新
                      </Button>
                    </div>
                    {sectionErrors.llmProviders && (
                      <p className="text-xs text-warning-500">{sectionErrors.llmProviders}</p>
                    )}
                    <div className="rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-xs text-text-tertiary">
                      当前为运行时只读状态。可通过后端环境变量配置（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`CUSTOM_LLM_API_KEY`、`CUSTOM_LLM_BASE_URL`）。
                    </div>
                    <div className="space-y-2">
                      {sectionLoading.llmProviders && llmProviders.length === 0 ? (
                        <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                          正在加载 Provider 状态...
                        </p>
                      ) : llmProviders.length === 0 ? (
                        <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                          暂无 Provider 状态
                        </p>
                      ) : (
                        llmProviders.map((provider) => (
                          <div
                            key={provider.name}
                            className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium text-text-primary">{provider.displayName}</p>
                              <Badge variant={provider.available ? 'success' : 'outline'}>
                                {provider.available ? '可用' : '未配置'}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-text-tertiary">模型数: {provider.models?.length ?? 0}</p>
                            {provider.models?.length ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary">
                                  查看模型列表
                                </summary>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {provider.models.map((model) => (
                                    <span
                                      key={model}
                                      className="rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-tertiary"
                                    >
                                      {model}
                                    </span>
                                  ))}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border-default">
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Wrench size={18} className="text-primary-400" />
                        <h2 className="text-lg font-semibold text-text-primary">Tools</h2>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-tertiary">活跃 {activeToolsCount}</span>
                        <Button
                          size="xs"
                          variant="tertiary"
                          leftIcon={<RefreshCw size={13} className={sectionLoading.tools ? 'animate-spin' : ''} />}
                          onClick={loadTools}
                        >
                          刷新
                        </Button>
                        <Button size="xs" leftIcon={<Plus size={13} />} onClick={openCreateToolDialog}>
                          新建
                        </Button>
                      </div>
                    </div>
                    {sectionErrors.tools && (
                      <p className="text-xs text-warning-500">{sectionErrors.tools}</p>
                    )}
                    <div className="space-y-3">
                      <div className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-text-primary">Runtime 内置工具</p>
                          <Badge variant={runtimeSkills.available ? 'success' : 'outline'}>
                            {runtimeSkills.available ? '已连接' : '未连接'}
                          </Badge>
                        </div>
                        {runtimeSkills.error ? (
                          <p className="mt-2 text-xs text-warning-500">{runtimeSkills.error}</p>
                        ) : null}
                        {runtimeSkills.tools.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {runtimeSkills.tools.map((toolName) => (
                              <span
                                key={toolName}
                                className="rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-tertiary"
                              >
                                {toolName}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-text-tertiary">暂无内置工具数据</p>
                        )}
                      </div>

                      <div className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3">
                        <p className="text-sm font-medium text-text-primary">数据库工具（可编辑）</p>
                        <div className="mt-2 space-y-2">
                          {sectionLoading.tools && tools.length === 0 ? (
                            <p className="text-sm text-text-secondary">正在加载工具列表...</p>
                          ) : tools.length === 0 ? (
                            <p className="text-sm text-text-secondary">暂无数据库工具，可点击“新建”添加</p>
                          ) : (
                            tools.map((tool) => (
                              <div
                                key={tool.id}
                                className="rounded-md border border-border-subtle bg-bg-elevated px-3 py-3"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-text-primary">{tool.name}</p>
                                    <p className="mt-1 text-xs text-text-tertiary">
                                      {tool.type}
                                      {tool.description ? ` · ${tool.description}` : ''}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    {tool.isBuiltin && <Badge variant="outline">内置</Badge>}
                                    <Badge variant={tool.isActive ? 'success' : 'outline'}>
                                      {tool.isActive ? '启用' : '停用'}
                                    </Badge>
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center gap-2">
                                  {!tool.isBuiltin && (
                                    <>
                                      <Button
                                        size="xs"
                                        variant="tertiary"
                                        leftIcon={<Pencil size={12} />}
                                        onClick={() => openEditToolDialog(tool)}
                                      >
                                        编辑
                                      </Button>
                                      <Button size="xs" variant="tertiary" onClick={() => toggleToolStatus(tool)}>
                                        {tool.isActive ? '停用' : '启用'}
                                      </Button>
                                      <Button
                                        size="xs"
                                        variant="tertiary"
                                        leftIcon={<Trash2 size={12} />}
                                        onClick={() => removeTool(tool)}
                                      >
                                        删除
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        open={showCreateKey}
        onClose={() => setShowCreateKey(false)}
        title="创建 API Key"
        description="完整密钥只会展示一次。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreateKey(false)}>
              取消
            </Button>
            <Button onClick={createApiKey} loading={creatingKey} disabled={!newKeyName.trim()}>
              创建
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            placeholder="Key 名称"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
          />
          <Input
            type="datetime-local"
            value={newKeyExpiresAt}
            onChange={(e) => setNewKeyExpiresAt(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={showCreateWebhook}
        onClose={() => setShowCreateWebhook(false)}
        title="创建 Webhook"
        description="events 用逗号分隔，最少一个事件。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreateWebhook(false)}>
              取消
            </Button>
            <Button
              onClick={createWebhook}
              loading={creatingWebhook}
              disabled={!webhookForm.url.trim() || !webhookForm.secret.trim()}
            >
              创建
            </Button>
          </>
        }
        maxWidth="lg"
      >
        <div className="space-y-4">
          <Input
            placeholder="https://example.com/webhook"
            value={webhookForm.url}
            onChange={(e) => setWebhookForm((prev) => ({ ...prev, url: e.target.value }))}
          />
          <Input
            placeholder="secret(至少16字符)"
            value={webhookForm.secret}
            onChange={(e) => setWebhookForm((prev) => ({ ...prev, secret: e.target.value }))}
          />
          <Input
            placeholder="event.a,event.b"
            value={webhookForm.eventsText}
            onChange={(e) => setWebhookForm((prev) => ({ ...prev, eventsText: e.target.value }))}
          />
        </div>
      </Modal>

      <Modal
        open={showCreateTool}
        onClose={() => setShowCreateTool(false)}
        title="新建工具"
        description="创建一个可在平台中启用的数据库工具定义。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreateTool(false)} disabled={savingTool}>
              取消
            </Button>
            <Button onClick={() => saveTool('create')} loading={savingTool}>
              创建
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            placeholder="工具名称（如 stock_researcher）"
            value={toolForm.name}
            onChange={(e) => setToolForm((prev) => ({ ...prev, name: e.target.value }))}
          />
          <Input
            placeholder="工具类型（如 custom / api）"
            value={toolForm.type}
            onChange={(e) => setToolForm((prev) => ({ ...prev, type: e.target.value }))}
          />
          <Input
            placeholder="描述（可选）"
            value={toolForm.description}
            onChange={(e) => setToolForm((prev) => ({ ...prev, description: e.target.value }))}
          />
          <Input
            placeholder="timeout 毫秒（可选，>=1000）"
            value={toolForm.timeoutMs}
            onChange={(e) => setToolForm((prev) => ({ ...prev, timeoutMs: e.target.value }))}
          />
        </div>
      </Modal>

      <Modal
        open={showEditTool}
        onClose={() => setShowEditTool(false)}
        title="编辑工具"
        description={toolForm.id || ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowEditTool(false)} disabled={savingTool}>
              取消
            </Button>
            <Button onClick={() => saveTool('edit')} loading={savingTool}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            placeholder="工具名称"
            value={toolForm.name}
            onChange={(e) => setToolForm((prev) => ({ ...prev, name: e.target.value }))}
          />
          <Input
            placeholder="工具类型"
            value={toolForm.type}
            onChange={(e) => setToolForm((prev) => ({ ...prev, type: e.target.value }))}
          />
          <Input
            placeholder="描述（可选）"
            value={toolForm.description}
            onChange={(e) => setToolForm((prev) => ({ ...prev, description: e.target.value }))}
          />
          <Input
            placeholder="timeout 毫秒（可选，>=1000）"
            value={toolForm.timeoutMs}
            onChange={(e) => setToolForm((prev) => ({ ...prev, timeoutMs: e.target.value }))}
          />
        </div>
      </Modal>

      <Modal
        open={!!createdKey}
        onClose={() => setCreatedKey(null)}
        title="API Key 已创建"
        description="请立即保存，关闭后不再显示。"
        footer={
          <Button onClick={() => setCreatedKey(null)}>我已保存</Button>
        }
      >
        <div className="rounded-md border border-border-subtle bg-bg-surface p-3">
          <p className="text-xs text-text-tertiary">完整密钥</p>
          <p className="mt-2 break-all font-mono text-sm text-primary-300">{createdKey?.key}</p>
        </div>
      </Modal>
    </div>
  )
}
