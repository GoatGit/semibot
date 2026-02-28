'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Cpu,
  KeyRound,
  Webhook,
  Wrench,
  RefreshCw,
  Loader2,
  Plus,
  Trash2,
  TestTube2,
  Pencil,
  MessageSquare,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { apiClient } from '@/lib/api'
import { formatRuntimeStatusError } from '@/lib/runtime-status'
import { useLocale } from '@/components/providers/LocaleProvider'

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

interface LlmProviderConfigEntry {
  apiKeyConfigured: boolean
  apiKeyPreview: string | null
  baseUrl: string
}

interface LlmConfigData {
  defaultModel: string
  fallbackModel: string
  providers: {
    openai: LlmProviderConfigEntry
    anthropic: LlmProviderConfigEntry
    google: LlmProviderConfigEntry
    custom: LlmProviderConfigEntry
  }
}

interface ToolItem {
  id: string
  name: string
  type: string
  description?: string
  config?: {
    timeout?: number
    retryAttempts?: number
    requiresApproval?: boolean
    riskLevel?: 'low' | 'medium' | 'high' | 'critical'
    approvalScope?: ApprovalScope
    approvalDedupeKeys?: string[]
    rateLimit?: number
    apiEndpoint?: string
    apiKey?: string
    rootPath?: string
    maxReadBytes?: number
    headless?: boolean
    browserType?: 'chromium' | 'firefox' | 'webkit'
    allowLocalhost?: boolean
    allowedDomains?: string[]
    blockedDomains?: string[]
    maxTextLength?: number
    maxResponseChars?: number
    maxRows?: number
    defaultDatabase?: string
    allowedDatabases?: string[]
  }
  isBuiltin: boolean
  isActive: boolean
}

interface RuntimeSkillsData {
  available: boolean
  tools: string[]
  skills: string[]
  source: string
  error?: string
}

type ConfigTab = 'llm' | 'tools' | 'gateways' | 'apiKeys' | 'webhooks'
type SectionKey = 'llm' | 'tools' | 'gateways' | 'apiKeys' | 'webhooks'
type ProviderKey = keyof LlmConfigData['providers']
type ApprovalScope = 'call' | 'action' | 'target' | 'session' | 'session_action' | 'tool'
type GatewayProvider = 'feishu' | 'telegram'
type GatewayFilter = 'all' | GatewayProvider
type GatewayAddressingMode = 'mention_only' | 'all_messages'
type GatewayProactiveMode = 'silent' | 'risk_based' | 'always'
type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

interface GatewayAddressingPolicy {
  mode?: GatewayAddressingMode
  allowReplyToBot?: boolean
  executeOnUnaddressed?: boolean
  commandPrefixes?: string[]
  sessionContinuationWindowSec?: number
}

interface GatewayProactivePolicy {
  mode?: GatewayProactiveMode
  minRiskToNotify?: RiskLevel
}

interface GatewayContextPolicy {
  ttlDays?: number
  maxRecentMessages?: number
  summarizeEveryNMessages?: number
}

interface GatewayItem {
  id: string
  instanceKey?: string
  provider: GatewayProvider
  displayName: string
  isDefault?: boolean
  isActive: boolean
  mode: string
  riskLevel: RiskLevel
  requiresApproval: boolean
  status: 'ready' | 'disabled' | 'not_configured'
  config: Record<string, unknown>
  addressingPolicy?: GatewayAddressingPolicy
  proactivePolicy?: GatewayProactivePolicy
  contextPolicy?: GatewayContextPolicy
  updatedAt: string
}

interface GatewayBatchResult {
  action: 'enable' | 'disable' | 'delete'
  requested: string[]
  targets: string[]
  changed: string[]
  unchanged: string[]
  blocked: Array<{ instanceId: string; reason: string }>
  missing: string[]
  failed: Array<{ instanceId: string; error: string }>
}

type GatewayChatBinding = {
  chatId: string
  agentId: string
}

type GatewayForm = {
  id?: string
  instanceKey: string
  provider: GatewayProvider
  isDefault: boolean
  displayName: string
  agentId: string
  isActive: boolean
  verifyToken: string
  clearVerifyToken: boolean
  webhookUrl: string
  botToken: string
  clearBotToken: boolean
  webhookSecret: string
  clearWebhookSecret: boolean
  defaultChatId: string
  allowedChatIds: string
  chatBindings: GatewayChatBinding[]
  notifyEventTypes: string
  addressingMode: GatewayAddressingMode
  allowReplyToBot: boolean
  executeOnUnaddressed: boolean
  commandPrefixes: string
  sessionContinuationWindowSec: string
  proactiveMode: GatewayProactiveMode
  minRiskToNotify: RiskLevel
  contextTtlDays: string
  contextMaxRecentMessages: string
  contextSummarizeEveryNMessages: string
}

type ToolForm = {
  id?: string
  name: string
  type: string
  timeoutMs: string
  requiresApproval: boolean
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  approvalScope: ApprovalScope
  approvalDedupeKeys: string
  apiEndpoint: string
  apiKey: string
  rootPath: string
  maxReadBytes: string
  headless: boolean
  browserType: 'chromium' | 'firefox' | 'webkit'
  allowLocalhost: boolean
  allowedDomains: string
  blockedDomains: string
  maxTextLength: string
  maxResponseChars: string
  sqlMaxRows: string
  sqlDefaultDatabase: string
  sqlAllowedDatabases: string
}

const DEFAULT_EVENTS = ['chat.message.completed', 'task.completed', 'task.failed']
const MIN_WEBHOOK_SECRET_LENGTH = 16
const MIN_BUILTIN_TOOLS = [
  'search',
  'code_executor',
  'file_io',
  'browser_automation',
  'http_client',
  'web_fetch',
  'json_transform',
  'csv_xlsx',
  'pdf_report',
  'sql_query_readonly',
]
const HIGH_RISK_DEFAULT_TOOLS = [
  'code_executor',
  'file_io',
  'browser_automation',
  'http_client',
  'csv_xlsx',
  'sql_query_readonly',
]
const TOOLS_WITHOUT_API_CREDENTIALS = [
  'code_executor',
  'file_io',
  'browser_automation',
  'web_fetch',
  'json_transform',
  'csv_xlsx',
  'pdf_report',
]
const NON_TOOL_SKILLS = ['xlsx', 'pdf']

function formatDate(dateString: string | undefined, locale: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!dateString) return t('config.common.notSet')
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return t('config.common.notSet')
  return date.toLocaleString(locale)
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

function parseGatewayChatBindings(raw: unknown): GatewayChatBinding[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const chatId = String(row.chatId || row.chat_id || '').trim()
        const agentId = String(row.agentId || row.agent_id || '').trim()
        if (!chatId || !agentId) return null
        return { chatId, agentId }
      })
      .filter((row): row is GatewayChatBinding => Boolean(row))
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .map(([chatId, agentId]) => {
        const normalizedChatId = String(chatId || '').trim()
        const normalizedAgentId = String(agentId || '').trim()
        if (!normalizedChatId || !normalizedAgentId) return null
        return { chatId: normalizedChatId, agentId: normalizedAgentId }
      })
      .filter((row): row is GatewayChatBinding => Boolean(row))
  }
  return []
}

function parseGatewayAllowedChatIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
}

function parseGatewayChatBindingImportText(
  text: string,
  defaultAgentId: string
): { rows: GatewayChatBinding[]; invalidLines: string[] } {
  const rows: GatewayChatBinding[] = []
  const invalidLines: string[] = []
  const fallbackAgent = defaultAgentId.trim() || 'semibot'
  const lines = text.split('\n').map((line) => line.trim())

  for (const line of lines) {
    if (!line) continue
    const separators = ['=', '->', '\t', ',']
    let chatId = ''
    let agentId = ''

    for (const sep of separators) {
      if (!line.includes(sep)) continue
      const [left, right] = line.split(sep, 2)
      chatId = String(left || '').trim()
      agentId = String(right || '').trim()
      break
    }

    if (!chatId) {
      chatId = line
      agentId = fallbackAgent
    } else if (!agentId) {
      agentId = fallbackAgent
    }

    if (!chatId || !agentId) {
      invalidLines.push(line)
      continue
    }
    rows.push({ chatId, agentId })
  }

  return { rows, invalidLines }
}

function normalizeGatewayChatBindings(rows: GatewayChatBinding[]): {
  normalized: GatewayChatBinding[]
  duplicateChatIds: string[]
  partialCount: number
} {
  const byChatId = new Map<string, string>()
  const duplicateChatIds: string[] = []
  let partialCount = 0

  for (const row of rows) {
    const chatId = String(row.chatId || '').trim()
    const agentId = String(row.agentId || '').trim()
    if (!chatId && !agentId) continue
    if (!chatId || !agentId) {
      partialCount += 1
      continue
    }
    if (byChatId.has(chatId) && !duplicateChatIds.includes(chatId)) {
      duplicateChatIds.push(chatId)
    }
    byChatId.set(chatId, agentId)
  }

  const normalized = Array.from(byChatId.entries()).map(([chatId, agentId]) => ({ chatId, agentId }))
  return { normalized, duplicateChatIds, partialCount }
}

function mergeTools(runtimeTools: string[], dbTools: ToolItem[]): ToolItem[] {
  const runtimeFiltered = runtimeTools.filter((name) => !NON_TOOL_SKILLS.includes(name))
  const dbFiltered = dbTools.filter((item) => !NON_TOOL_SKILLS.includes(item.name))
  const byName = new Map(dbFiltered.map((item) => [item.name, item]))
  const merged: ToolItem[] = runtimeFiltered.map((name) => {
    const db = byName.get(name)
    return {
      id: db?.id || `builtin:${name}`,
      name,
      type: db?.type || 'builtin',
      description: db?.description || '',
      config: db?.config || {},
      isBuiltin: true,
      isActive: db?.isActive ?? true,
    }
  })

  for (const item of dbFiltered) {
    if (!runtimeFiltered.includes(item.name)) {
      merged.push(item)
    }
  }
  return merged
}

export default function ConfigPage() {
  const { locale, t } = useLocale()
  const [activeTab, setActiveTab] = useState<ConfigTab>('llm')
  const [loading, setLoading] = useState(true)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sectionLoading, setSectionLoading] = useState<Record<SectionKey, boolean>>({
    llm: false,
    tools: false,
    gateways: false,
    apiKeys: false,
    webhooks: false,
  })
  const [sectionErrors, setSectionErrors] = useState<Record<SectionKey, string | null>>({
    llm: null,
    tools: null,
    gateways: null,
    apiKeys: null,
    webhooks: null,
  })

  const [llmProviders, setLlmProviders] = useState<LlmProviderStatus[]>([])
  const [llmConfig, setLlmConfig] = useState<LlmConfigData | null>(null)
  const [modelDefaults, setModelDefaults] = useState({ defaultModel: '', fallbackModel: '' })
  const [savingModelDefaults, setSavingModelDefaults] = useState(false)
  const [showProviderConfigModal, setShowProviderConfigModal] = useState(false)
  const [providerConfigSaving, setProviderConfigSaving] = useState(false)
  const [providerConfigForm, setProviderConfigForm] = useState({
    provider: 'openai' as ProviderKey,
    apiKey: '',
    baseUrl: '',
    clearApiKey: false,
  })

  const [tools, setTools] = useState<ToolItem[]>([])
  const [runtimeSkills, setRuntimeSkills] = useState<RuntimeSkillsData>({
    available: false,
    tools: [],
    skills: [],
    source: '',
  })
  const [showEditTool, setShowEditTool] = useState(false)
  const [savingTool, setSavingTool] = useState(false)
  const [toolForm, setToolForm] = useState<ToolForm>({
    name: '',
    type: 'custom',
    timeoutMs: '',
    requiresApproval: false,
    riskLevel: 'low',
    approvalScope: 'session',
    approvalDedupeKeys: '',
    apiEndpoint: '',
    apiKey: '',
    rootPath: '',
    maxReadBytes: '',
    headless: true,
    browserType: 'chromium',
    allowLocalhost: false,
    allowedDomains: '',
    blockedDomains: '',
    maxTextLength: '',
    maxResponseChars: '',
    sqlMaxRows: '',
    sqlDefaultDatabase: '',
    sqlAllowedDatabases: '',
  })

  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([])
  const [gateways, setGateways] = useState<GatewayItem[]>([])
  const [gatewayFilter, setGatewayFilter] = useState<GatewayFilter>('all')
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([])
  const [gatewayBatchLoading, setGatewayBatchLoading] = useState(false)
  const [showGatewayModal, setShowGatewayModal] = useState(false)
  const [savingGateway, setSavingGateway] = useState(false)
  const [testingGateway, setTestingGateway] = useState<string | null>(null)
  const [gatewayBindingsImportText, setGatewayBindingsImportText] = useState('')
  const [quickBindingsEditingId, setQuickBindingsEditingId] = useState<string | null>(null)
  const [quickBindingsDraft, setQuickBindingsDraft] = useState<GatewayChatBinding[]>([])
  const [quickBindingsImportText, setQuickBindingsImportText] = useState('')
  const [quickBindingsSavingId, setQuickBindingsSavingId] = useState<string | null>(null)
  const [gatewayForm, setGatewayForm] = useState<GatewayForm>({
    id: undefined,
    instanceKey: '',
    provider: 'feishu',
    isDefault: false,
    displayName: '',
    agentId: 'semibot',
    isActive: false,
    verifyToken: '',
    clearVerifyToken: false,
    webhookUrl: '',
    botToken: '',
    clearBotToken: false,
    webhookSecret: '',
    clearWebhookSecret: false,
    defaultChatId: '',
    allowedChatIds: '',
    chatBindings: [],
    notifyEventTypes: '',
    addressingMode: 'mention_only',
    allowReplyToBot: true,
    executeOnUnaddressed: false,
    commandPrefixes: '/ask,/run,/approve,/reject',
    sessionContinuationWindowSec: '300',
    proactiveMode: 'silent',
    minRiskToNotify: 'high',
    contextTtlDays: '30',
    contextMaxRecentMessages: '200',
    contextSummarizeEveryNMessages: '50',
  })

  const [showCreateKey, setShowCreateKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyExpiresAt, setNewKeyExpiresAt] = useState('')
  const [creatingKey, setCreatingKey] = useState(false)
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null)

  const [webhooks, setWebhooks] = useState<WebhookItem[]>([])
  const [showCreateWebhook, setShowCreateWebhook] = useState(false)
  const [creatingWebhook, setCreatingWebhook] = useState(false)
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null)
  const [webhookForm, setWebhookForm] = useState({
    url: '',
    secret: '',
    eventsText: DEFAULT_EVENTS.join(','),
  })

  const setSectionLoadingFlag = useCallback((section: SectionKey, value: boolean) => {
    setSectionLoading((prev) => ({ ...prev, [section]: value }))
  }, [])

  const loadLlmData = useCallback(async () => {
    setSectionLoadingFlag('llm', true)
    try {
      const [statusRes, configRes] = await Promise.all([
        apiClient.get<ApiResponse<LlmProviderStatus[]>>('/llm-providers/status'),
        apiClient.get<ApiResponse<LlmConfigData>>('/llm-providers/config'),
      ])

      if (!statusRes.success || !configRes.success) {
        throw new Error(t('config.errors.llmLoad'))
      }

      setLlmProviders(statusRes.data || [])
      setLlmConfig(configRes.data)
      setModelDefaults({
        defaultModel: configRes.data.defaultModel || '',
        fallbackModel: configRes.data.fallbackModel || '',
      })
      setSectionErrors((prev) => ({ ...prev, llm: null }))
    } catch (err) {
      setSectionErrors((prev) => ({
        ...prev,
        llm: getErrorMessage(err, t('config.errors.llmLoad')),
      }))
    } finally {
      setSectionLoadingFlag('llm', false)
    }
  }, [setSectionLoadingFlag, t])

  const loadTools = useCallback(async () => {
    setSectionLoadingFlag('tools', true)
    try {
      const [toolsRes, runtimeRes] = await Promise.allSettled([
        apiClient.get<ApiResponse<ToolItem[]>>('/tools', { params: { page: 1, limit: 100 } }),
        apiClient.get<ApiResponse<RuntimeSkillsData>>('/runtime/skills'),
      ])

      const dbTools =
        toolsRes.status === 'fulfilled' && toolsRes.value.success ? (toolsRes.value.data || []) : []
      const runtimeData: RuntimeSkillsData =
        runtimeRes.status === 'fulfilled' && runtimeRes.value.success
          ? runtimeRes.value.data
          : {
              available: false,
              tools: [],
              skills: [],
              source: '',
              error: t('config.errors.runtimeToolsLoad'),
            }

      const unifiedTools = Array.from(
        new Set([...(runtimeData.tools || []), ...MIN_BUILTIN_TOOLS])
      ).filter((name) => !NON_TOOL_SKILLS.includes(name))
      setRuntimeSkills({ ...runtimeData, tools: unifiedTools })
      setTools(mergeTools(unifiedTools, dbTools))
      setSectionErrors((prev) => ({
        ...prev,
        tools:
          toolsRes.status === 'fulfilled' && toolsRes.value.success
            ? null
            : t('config.errors.toolsConfigLoad'),
      }))
    } catch (err) {
      setTools([])
      setSectionErrors((prev) => ({
        ...prev,
        tools: getErrorMessage(err, t('config.errors.toolsLoad')),
      }))
    } finally {
      setSectionLoadingFlag('tools', false)
    }
  }, [setSectionLoadingFlag, t])

  const loadApiKeys = useCallback(async () => {
    setSectionLoadingFlag('apiKeys', true)
    try {
      const response = await apiClient.get<ApiResponse<ApiKeyItem[]>>('/api-keys')
      if (!response.success) {
        throw new Error(t('config.errors.apiKeysLoad'))
      }
      setApiKeys(response.data || [])
      setSectionErrors((prev) => ({ ...prev, apiKeys: null }))
    } catch (err) {
      setApiKeys([])
      setSectionErrors((prev) => ({
        ...prev,
        apiKeys: getErrorMessage(err, t('config.errors.apiKeysLoad')),
      }))
    } finally {
      setSectionLoadingFlag('apiKeys', false)
    }
  }, [setSectionLoadingFlag, t])

  const loadWebhooks = useCallback(async () => {
    setSectionLoadingFlag('webhooks', true)
    try {
      const response = await apiClient.get<ApiResponse<WebhookItem[]>>('/webhooks', {
        params: { page: 1, limit: 50 },
      })
      if (!response.success) {
        throw new Error(t('config.errors.webhooksLoad'))
      }
      setWebhooks(response.data || [])
      setSectionErrors((prev) => ({ ...prev, webhooks: null }))
    } catch (err) {
      setWebhooks([])
      setSectionErrors((prev) => ({
        ...prev,
        webhooks: getErrorMessage(err, t('config.errors.webhooksLoad')),
      }))
    } finally {
      setSectionLoadingFlag('webhooks', false)
    }
  }, [setSectionLoadingFlag, t])

  const loadGateways = useCallback(async () => {
    setSectionLoadingFlag('gateways', true)
    try {
      const response = await apiClient.get<ApiResponse<GatewayItem[]>>('/gateways/instances')
      if (!response.success) {
        throw new Error(t('config.errors.gatewaysLoad'))
      }
      setGateways(response.data || [])
      setSectionErrors((prev) => ({ ...prev, gateways: null }))
    } catch (err) {
      setGateways([])
      setSectionErrors((prev) => ({
        ...prev,
        gateways: getErrorMessage(err, t('config.errors.gatewaysLoad')),
      }))
    } finally {
      setSectionLoadingFlag('gateways', false)
    }
  }, [setSectionLoadingFlag, t])

  const loadData = useCallback(async () => {
    setRefreshingAll(true)
    setError(null)
    await Promise.all([loadLlmData(), loadTools(), loadGateways(), loadApiKeys(), loadWebhooks()])
    setLoading(false)
    setRefreshingAll(false)
  }, [loadApiKeys, loadGateways, loadLlmData, loadTools, loadWebhooks])

  useEffect(() => {
    loadData()
  }, [loadData])

  const saveModelConfig = async () => {
    try {
      setSavingModelDefaults(true)
      setError(null)
      await apiClient.put('/llm-providers/config', {
        defaultModel: modelDefaults.defaultModel.trim(),
        fallbackModel: modelDefaults.fallbackModel.trim(),
      })
      await loadLlmData()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.saveDefaultModel')))
    } finally {
      setSavingModelDefaults(false)
    }
  }

  const openProviderConfigDialog = (provider: ProviderKey) => {
    const cfg = llmConfig?.providers[provider]
    setProviderConfigForm({
      provider,
      apiKey: '',
      baseUrl: cfg?.baseUrl || '',
      clearApiKey: false,
    })
    setShowProviderConfigModal(true)
  }

  const saveProviderConfig = async () => {
    const payloadProvider = {
      baseUrl: providerConfigForm.baseUrl.trim(),
      clearApiKey: providerConfigForm.clearApiKey,
      ...(providerConfigForm.apiKey.trim() ? { apiKey: providerConfigForm.apiKey.trim() } : {}),
    }

    try {
      setProviderConfigSaving(true)
      setError(null)
      await apiClient.put('/llm-providers/config', {
        providers: {
          [providerConfigForm.provider]: payloadProvider,
        },
      })
      setShowProviderConfigModal(false)
      await loadLlmData()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.saveProvider')))
    } finally {
      setProviderConfigSaving(false)
    }
  }

  const openEditToolDialog = (tool: ToolItem) => {
    const allowedDomains = Array.isArray(tool.config?.allowedDomains)
      ? tool.config?.allowedDomains.join(',')
      : ''
    const blockedDomains = Array.isArray(tool.config?.blockedDomains)
      ? tool.config?.blockedDomains.join(',')
      : ''
    setToolForm({
      id: tool.id,
      name: tool.name,
      type: tool.type || 'custom',
      timeoutMs: tool.config?.timeout ? String(tool.config.timeout) : '',
      requiresApproval: Boolean(tool.config?.requiresApproval),
      riskLevel: (tool.config?.riskLevel || (HIGH_RISK_DEFAULT_TOOLS.includes(tool.name) ? 'high' : 'low')) as
        | 'low'
        | 'medium'
        | 'high'
        | 'critical',
      approvalScope: (tool.config?.approvalScope || 'session') as ApprovalScope,
      approvalDedupeKeys: Array.isArray(tool.config?.approvalDedupeKeys)
        ? tool.config.approvalDedupeKeys.join(',')
        : '',
      apiEndpoint: tool.config?.apiEndpoint || '',
      apiKey: '',
      rootPath: tool.config?.rootPath || '',
      maxReadBytes:
        typeof tool.config?.maxReadBytes === 'number'
          ? String(tool.config.maxReadBytes)
          : '',
      headless: tool.config?.headless ?? true,
      browserType: tool.config?.browserType || 'chromium',
      allowLocalhost: tool.config?.allowLocalhost ?? false,
      allowedDomains,
      blockedDomains,
      maxTextLength:
        typeof tool.config?.maxTextLength === 'number'
          ? String(tool.config.maxTextLength)
          : '',
      maxResponseChars:
        typeof tool.config?.maxResponseChars === 'number'
          ? String(tool.config.maxResponseChars)
          : '',
      sqlMaxRows:
        typeof tool.config?.maxRows === 'number'
          ? String(tool.config.maxRows)
          : '',
      sqlDefaultDatabase: tool.config?.defaultDatabase || '',
      sqlAllowedDatabases: Array.isArray(tool.config?.allowedDatabases)
        ? tool.config.allowedDatabases.join(',')
        : '',
    })
    setShowEditTool(true)
  }

  const saveToolConfig = async () => {
    const supportsApiCredentials = !TOOLS_WITHOUT_API_CREDENTIALS.includes(toolForm.name)
    const isBrowserTool = toolForm.name === 'browser_automation'
    const isHttpFetchTool = toolForm.name === 'http_client' || toolForm.name === 'web_fetch'
    const isSqlReadonlyTool = toolForm.name === 'sql_query_readonly'
    const timeout = toolForm.timeoutMs.trim()
    if (timeout && (!/^\d+$/.test(timeout) || Number(timeout) < 1000)) {
      setError(t('config.errors.timeoutInvalid'))
      return
    }

    const endpoint = supportsApiCredentials ? toolForm.apiEndpoint.trim() : ''
    if (endpoint) {
      try {
        // eslint-disable-next-line no-new
        new URL(endpoint)
      } catch {
        setError(t('config.errors.apiEndpointInvalid'))
        return
      }
    }

    const maxReadBytes = toolForm.maxReadBytes.trim()
    if (maxReadBytes && (!/^\d+$/.test(maxReadBytes) || Number(maxReadBytes) < 1)) {
      setError(t('config.errors.maxReadBytesInvalid'))
      return
    }

    const maxTextLength = toolForm.maxTextLength.trim()
    if (
      isBrowserTool &&
      maxTextLength &&
      (!/^\d+$/.test(maxTextLength) || Number(maxTextLength) < 100 || Number(maxTextLength) > 500000)
    ) {
      setError(t('config.errors.maxTextLengthInvalid'))
      return
    }

    const maxResponseChars = toolForm.maxResponseChars.trim()
    if (
      isHttpFetchTool &&
      maxResponseChars &&
      (!/^\d+$/.test(maxResponseChars) || Number(maxResponseChars) < 100 || Number(maxResponseChars) > 500000)
    ) {
      setError(t('config.errors.maxResponseCharsInvalid'))
      return
    }

    const sqlMaxRows = toolForm.sqlMaxRows.trim()
    if (
      isSqlReadonlyTool &&
      sqlMaxRows &&
      (!/^\d+$/.test(sqlMaxRows) || Number(sqlMaxRows) < 1 || Number(sqlMaxRows) > 5000)
    ) {
      setError(t('config.errors.maxRowsInvalid'))
      return
    }

    const parseCommaList = (value: string): string[] =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    const approvalDedupeKeys = parseCommaList(toolForm.approvalDedupeKeys)

    const payload = {
      config: {
        ...(timeout ? { timeout: Number(timeout) } : {}),
        requiresApproval: toolForm.requiresApproval,
        riskLevel: toolForm.riskLevel,
        approvalScope: toolForm.approvalScope,
        approvalDedupeKeys,
        ...(endpoint ? { apiEndpoint: endpoint } : {}),
        ...(supportsApiCredentials && toolForm.apiKey.trim()
          ? { apiKey: toolForm.apiKey.trim() }
          : {}),
        ...(toolForm.name === 'file_io' && toolForm.rootPath.trim()
          ? { rootPath: toolForm.rootPath.trim() }
          : {}),
        ...(toolForm.name === 'file_io' && maxReadBytes
          ? { maxReadBytes: Number(maxReadBytes) }
          : {}),
        ...(isBrowserTool ? { headless: toolForm.headless } : {}),
        ...(isBrowserTool ? { browserType: toolForm.browserType } : {}),
        ...(isBrowserTool ? { allowLocalhost: toolForm.allowLocalhost } : {}),
        ...(isBrowserTool ? { allowedDomains: parseCommaList(toolForm.allowedDomains) } : {}),
        ...(isBrowserTool ? { blockedDomains: parseCommaList(toolForm.blockedDomains) } : {}),
        ...(isBrowserTool && maxTextLength ? { maxTextLength: Number(maxTextLength) } : {}),
        ...(isHttpFetchTool ? { allowLocalhost: toolForm.allowLocalhost } : {}),
        ...(isHttpFetchTool ? { allowedDomains: parseCommaList(toolForm.allowedDomains) } : {}),
        ...(isHttpFetchTool ? { blockedDomains: parseCommaList(toolForm.blockedDomains) } : {}),
        ...(isHttpFetchTool && maxResponseChars ? { maxResponseChars: Number(maxResponseChars) } : {}),
        ...(isSqlReadonlyTool && sqlMaxRows ? { maxRows: Number(sqlMaxRows) } : {}),
        ...(isSqlReadonlyTool && toolForm.sqlDefaultDatabase.trim()
          ? { defaultDatabase: toolForm.sqlDefaultDatabase.trim() }
          : {}),
        ...(isSqlReadonlyTool ? { allowedDatabases: parseCommaList(toolForm.sqlAllowedDatabases) } : {}),
      },
    }

    try {
      setSavingTool(true)
      setError(null)

      if (!toolForm.id) {
        setError(t('config.errors.missingToolId'))
        return
      }
      if (toolForm.id.startsWith('builtin:')) {
        await apiClient.put('/tools/by-name/' + encodeURIComponent(toolForm.name), payload)
      } else {
        await apiClient.put('/tools/' + toolForm.id, payload)
      }
      setShowEditTool(false)

      await loadTools()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.updateToolConfig')))
    } finally {
      setSavingTool(false)
    }
  }

  const toggleToolStatus = async (tool: ToolItem) => {
    try {
      setError(null)
      if (tool.id.startsWith('builtin:')) {
        await apiClient.put('/tools/by-name/' + encodeURIComponent(tool.name), {
          isActive: !tool.isActive,
        })
      } else {
        await apiClient.put('/tools/' + tool.id, { isActive: !tool.isActive })
      }
      await loadTools()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.updateToolStatus')))
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
      setError(getErrorMessage(err, t('config.errors.createApiKey')))
    } finally {
      setCreatingKey(false)
    }
  }

  const removeApiKey = async (id: string) => {
    if (!window.confirm(t('config.confirm.deleteApiKey'))) return
    try {
      setError(null)
      await apiClient.delete('/api-keys/' + id)
      await loadApiKeys()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.deleteApiKey')))
    }
  }

  const createWebhook = async () => {
    try {
      setCreatingWebhook(true)
      setError(null)
      if (!/^https?:\/\/.+/i.test(webhookForm.url.trim())) {
        setError(t('config.errors.webhookUrlInvalid'))
        return
      }
      if (webhookForm.secret.trim().length < MIN_WEBHOOK_SECRET_LENGTH) {
        setError(t('config.errors.webhookSecretMin', { min: MIN_WEBHOOK_SECRET_LENGTH }))
        return
      }
      const events = webhookForm.eventsText
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      if (events.length === 0) {
        setError(t('config.errors.webhookEventRequired'))
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
      setError(getErrorMessage(err, t('config.errors.createWebhook')))
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
      setError(getErrorMessage(err, t('config.errors.updateWebhook')))
    }
  }

  const testWebhook = async (id: string) => {
    try {
      setTestingWebhookId(id)
      setError(null)
      await apiClient.post('/webhooks/' + id + '/test')
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.testWebhook')))
    } finally {
      setTestingWebhookId(null)
    }
  }

  const removeWebhook = async (id: string) => {
    if (!window.confirm(t('config.confirm.deleteWebhook'))) return
    try {
      setError(null)
      await apiClient.delete('/webhooks/' + id)
      await loadWebhooks()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.deleteWebhook')))
    }
  }

  const openGatewayDialog = (gateway: GatewayItem) => {
    const cfg = gateway.config || {}
    const allowedChatIds = Array.isArray(cfg.allowedChatIds)
      ? (cfg.allowedChatIds as unknown[]).map((item) => String(item)).join(',')
      : ''
    const notifyEventTypes = Array.isArray(cfg.notifyEventTypes)
      ? (cfg.notifyEventTypes as unknown[]).map((item) => String(item)).join(',')
      : ''
    const chatBindings = parseGatewayChatBindings(cfg.chatBindings)
    const addressingPolicyRaw =
      gateway.addressingPolicy && typeof gateway.addressingPolicy === 'object'
        ? gateway.addressingPolicy
        : (cfg.addressingPolicy as GatewayAddressingPolicy | undefined)
    const proactivePolicyRaw =
      gateway.proactivePolicy && typeof gateway.proactivePolicy === 'object'
        ? gateway.proactivePolicy
        : (cfg.proactivePolicy as GatewayProactivePolicy | undefined)
    const contextPolicyRaw =
      gateway.contextPolicy && typeof gateway.contextPolicy === 'object'
        ? gateway.contextPolicy
        : (cfg.contextPolicy as GatewayContextPolicy | undefined)
    const defaultAddressingMode: GatewayAddressingMode = gateway.provider === 'telegram' ? 'all_messages' : 'mention_only'
    const addressingMode =
      addressingPolicyRaw?.mode === 'all_messages' || addressingPolicyRaw?.mode === 'mention_only'
        ? addressingPolicyRaw.mode
        : defaultAddressingMode
    const proactiveMode =
      proactivePolicyRaw?.mode === 'silent' ||
      proactivePolicyRaw?.mode === 'risk_based' ||
      proactivePolicyRaw?.mode === 'always'
        ? proactivePolicyRaw.mode
        : 'silent'
    const minRiskToNotify: RiskLevel =
      proactivePolicyRaw?.minRiskToNotify === 'low' ||
      proactivePolicyRaw?.minRiskToNotify === 'medium' ||
      proactivePolicyRaw?.minRiskToNotify === 'high' ||
      proactivePolicyRaw?.minRiskToNotify === 'critical'
        ? proactivePolicyRaw.minRiskToNotify
        : 'high'
    const commandPrefixes = Array.isArray(addressingPolicyRaw?.commandPrefixes)
      ? (addressingPolicyRaw?.commandPrefixes || []).map((item) => String(item)).join(',')
      : '/ask,/run,/approve,/reject'
    setGatewayForm({
      id: gateway.id,
      instanceKey: gateway.instanceKey || '',
      provider: gateway.provider,
      isDefault: gateway.isDefault === true,
      displayName: gateway.displayName || gateway.provider,
      agentId: String(cfg.agentId || cfg.defaultAgentId || 'semibot'),
      isActive: gateway.isActive,
      verifyToken: '',
      clearVerifyToken: false,
      webhookUrl: String(cfg.webhookUrl || ''),
      botToken: '',
      clearBotToken: false,
      webhookSecret: '',
      clearWebhookSecret: false,
      defaultChatId: String(cfg.defaultChatId || ''),
      allowedChatIds,
      chatBindings,
      notifyEventTypes,
      addressingMode,
      allowReplyToBot: addressingPolicyRaw?.allowReplyToBot ?? true,
      executeOnUnaddressed: addressingPolicyRaw?.executeOnUnaddressed ?? false,
      commandPrefixes,
      sessionContinuationWindowSec: String(addressingPolicyRaw?.sessionContinuationWindowSec ?? 300),
      proactiveMode,
      minRiskToNotify,
      contextTtlDays: String(contextPolicyRaw?.ttlDays ?? 30),
      contextMaxRecentMessages: String(contextPolicyRaw?.maxRecentMessages ?? 200),
      contextSummarizeEveryNMessages: String(contextPolicyRaw?.summarizeEveryNMessages ?? 50),
    })
    setGatewayBindingsImportText('')
    setShowGatewayModal(true)
  }

  const openCreateGatewayDialog = (provider: GatewayProvider) => {
    const defaultDisplayName = provider === 'telegram' ? 'Telegram' : 'Feishu'
    const defaultAddressingMode: GatewayAddressingMode = provider === 'telegram' ? 'all_messages' : 'mention_only'
    setGatewayForm({
      id: undefined,
      instanceKey: '',
      provider,
      isDefault: false,
      displayName: defaultDisplayName,
      agentId: 'semibot',
      isActive: false,
      verifyToken: '',
      clearVerifyToken: false,
      webhookUrl: '',
      botToken: '',
      clearBotToken: false,
      webhookSecret: '',
      clearWebhookSecret: false,
      defaultChatId: '',
      allowedChatIds: '',
      chatBindings: [],
      notifyEventTypes: '',
      addressingMode: defaultAddressingMode,
      allowReplyToBot: true,
      executeOnUnaddressed: false,
      commandPrefixes: '/ask,/run,/approve,/reject',
      sessionContinuationWindowSec: '300',
      proactiveMode: 'silent',
      minRiskToNotify: 'high',
      contextTtlDays: '30',
      contextMaxRecentMessages: '200',
      contextSummarizeEveryNMessages: '50',
    })
    setGatewayBindingsImportText('')
    setShowGatewayModal(true)
  }

  const saveGatewayConfig = async () => {
    const parseCommaList = (value: string): string[] =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    const parsePositiveInt = (value: string, fallback: number): number => {
      const parsed = Number.parseInt(value.trim(), 10)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }

    const isTelegram = gatewayForm.provider === 'telegram'
    const normalizedAgentId = gatewayForm.agentId.trim()
    const chatBindingInput = gatewayForm.chatBindings.map((row) => ({
      chatId: row.chatId.trim(),
      agentId: row.agentId.trim(),
    }))
    const normalizedBindingsResult = normalizeGatewayChatBindings(chatBindingInput)
    if (normalizedBindingsResult.partialCount > 0) {
      setError(t('config.errors.gatewayBindingsPartial', { count: normalizedBindingsResult.partialCount }))
      return
    }
    if (
      normalizedBindingsResult.duplicateChatIds.length > 0 &&
      !window.confirm(
        t('config.confirm.gatewayBindingsDuplicate', {
          count: normalizedBindingsResult.duplicateChatIds.length,
        })
      )
    ) {
      return
    }
    if (isTelegram) {
      const allowedSet = new Set(parseCommaList(gatewayForm.allowedChatIds))
      if (allowedSet.size > 0) {
        const outsideAllowed = normalizedBindingsResult.normalized.filter((row) => !allowedSet.has(row.chatId))
        if (
          outsideAllowed.length > 0 &&
          !window.confirm(
            t('config.confirm.gatewayBindingsOutsideAllowed', {
              count: outsideAllowed.length,
            })
          )
        ) {
          return
        }
      }
    }
    const payload: Record<string, unknown> = {
      displayName: gatewayForm.displayName.trim() || gatewayForm.provider,
      isDefault: gatewayForm.isDefault,
      isActive: gatewayForm.isActive,
      config: {
        ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
        ...(isTelegram
          ? {
              ...(gatewayForm.botToken.trim() && !gatewayForm.clearBotToken
                ? { botToken: gatewayForm.botToken.trim() }
                : {}),
              ...(gatewayForm.webhookSecret.trim() && !gatewayForm.clearWebhookSecret
                ? { webhookSecret: gatewayForm.webhookSecret.trim() }
                : {}),
              ...(gatewayForm.defaultChatId.trim() ? { defaultChatId: gatewayForm.defaultChatId.trim() } : {}),
              allowedChatIds: parseCommaList(gatewayForm.allowedChatIds),
              chatBindings: normalizedBindingsResult.normalized,
              notifyEventTypes: parseCommaList(gatewayForm.notifyEventTypes),
            }
          : {
              ...(gatewayForm.verifyToken.trim() && !gatewayForm.clearVerifyToken
                ? { verifyToken: gatewayForm.verifyToken.trim() }
                : {}),
              ...(gatewayForm.webhookUrl.trim() ? { webhookUrl: gatewayForm.webhookUrl.trim() } : {}),
              chatBindings: normalizedBindingsResult.normalized,
              notifyEventTypes: parseCommaList(gatewayForm.notifyEventTypes),
            }),
      },
      addressingPolicy: {
        mode: gatewayForm.addressingMode,
        allowReplyToBot: gatewayForm.allowReplyToBot,
        executeOnUnaddressed: gatewayForm.executeOnUnaddressed,
        commandPrefixes: parseCommaList(gatewayForm.commandPrefixes),
        sessionContinuationWindowSec: parsePositiveInt(gatewayForm.sessionContinuationWindowSec, 300),
      },
      proactivePolicy: {
        mode: gatewayForm.proactiveMode,
        minRiskToNotify: gatewayForm.minRiskToNotify,
      },
      contextPolicy: {
        ttlDays: parsePositiveInt(gatewayForm.contextTtlDays, 30),
        maxRecentMessages: parsePositiveInt(gatewayForm.contextMaxRecentMessages, 200),
        summarizeEveryNMessages: parsePositiveInt(gatewayForm.contextSummarizeEveryNMessages, 50),
      },
    }
    const clearFields: string[] = []
    if (!normalizedAgentId) {
      clearFields.push('agentId', 'defaultAgentId')
    }
    if (!isTelegram && gatewayForm.clearVerifyToken) clearFields.push('verifyToken')
    if (isTelegram && gatewayForm.clearBotToken) clearFields.push('botToken')
    if (isTelegram && gatewayForm.clearWebhookSecret) clearFields.push('webhookSecret')
    if (clearFields.length > 0) {
      payload.clearFields = clearFields
    }

    try {
      setSavingGateway(true)
      setError(null)
      if (gatewayForm.id) {
        await apiClient.put(`/gateways/instances/${gatewayForm.id}`, payload)
      } else {
        await apiClient.post('/gateways/instances', {
          provider: gatewayForm.provider,
          instanceKey: gatewayForm.instanceKey.trim() || undefined,
          ...payload,
        })
      }
      setShowGatewayModal(false)
      await loadGateways()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.updateGateway')))
    } finally {
      setSavingGateway(false)
    }
  }

  const addGatewayChatBinding = useCallback(() => {
    setGatewayForm((prev) => ({
      ...prev,
      chatBindings: [...prev.chatBindings, { chatId: '', agentId: prev.agentId.trim() || 'semibot' }],
    }))
  }, [])

  const updateGatewayChatBinding = useCallback((index: number, key: 'chatId' | 'agentId', value: string) => {
    setGatewayForm((prev) => ({
      ...prev,
      chatBindings: prev.chatBindings.map((row, idx) => (idx === index ? { ...row, [key]: value } : row)),
    }))
  }, [])

  const removeGatewayChatBinding = useCallback((index: number) => {
    setGatewayForm((prev) => ({
      ...prev,
      chatBindings: prev.chatBindings.filter((_, idx) => idx !== index),
    }))
  }, [])

  const applyGatewayBindingsImport = useCallback(() => {
    const parsed = parseGatewayChatBindingImportText(
      gatewayBindingsImportText,
      gatewayForm.agentId.trim() || 'semibot'
    )
    if (parsed.invalidLines.length > 0) {
      setError(t('config.errors.gatewayBindingsImportInvalid', { count: parsed.invalidLines.length }))
      return
    }
    if (parsed.rows.length === 0) return
    setGatewayForm((prev) => ({
      ...prev,
      chatBindings: [...prev.chatBindings, ...parsed.rows],
    }))
    setGatewayBindingsImportText('')
  }, [gatewayBindingsImportText, gatewayForm.agentId, t])

  const testGateway = async (gateway: GatewayItem) => {
    try {
      setTestingGateway(gateway.id)
      setError(null)
      const isTelegram = gateway.provider === 'telegram'
      const payload = isTelegram
        ? { text: 'Semibot gateway test' }
        : { title: 'Semibot gateway test', content: 'Gateway connectivity test' }
      await apiClient.post(`/gateways/instances/${gateway.id}/test`, payload)
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.testGateway')))
    } finally {
      setTestingGateway(null)
    }
  }

  const removeGateway = async (gateway: GatewayItem) => {
    if (!window.confirm(t('config.confirm.deleteGateway'))) return
    try {
      setError(null)
      await apiClient.delete(`/gateways/instances/${gateway.id}`)
      await loadGateways()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.deleteGateway')))
    }
  }

  const startQuickBindingsEdit = useCallback((gateway: GatewayItem) => {
    const bindings = parseGatewayChatBindings(gateway.config?.chatBindings)
    setQuickBindingsEditingId(gateway.id)
    setQuickBindingsDraft(bindings)
    setQuickBindingsImportText('')
  }, [])

  const cancelQuickBindingsEdit = useCallback(() => {
    setQuickBindingsEditingId(null)
    setQuickBindingsDraft([])
    setQuickBindingsImportText('')
  }, [])

  const addQuickBindingsRow = useCallback((defaultAgentId: string) => {
    setQuickBindingsDraft((prev) => [...prev, { chatId: '', agentId: defaultAgentId || 'semibot' }])
  }, [])

  const updateQuickBindingsRow = useCallback((index: number, key: 'chatId' | 'agentId', value: string) => {
    setQuickBindingsDraft((prev) => prev.map((row, idx) => (idx === index ? { ...row, [key]: value } : row)))
  }, [])

  const removeQuickBindingsRow = useCallback((index: number) => {
    setQuickBindingsDraft((prev) => prev.filter((_, idx) => idx !== index))
  }, [])

  const applyQuickBindingsImport = useCallback(
    (defaultAgentId: string) => {
      const parsed = parseGatewayChatBindingImportText(
        quickBindingsImportText,
        defaultAgentId.trim() || 'semibot'
      )
      if (parsed.invalidLines.length > 0) {
        setError(t('config.errors.gatewayBindingsImportInvalid', { count: parsed.invalidLines.length }))
        return
      }
      if (parsed.rows.length === 0) return
      setQuickBindingsDraft((prev) => [...prev, ...parsed.rows])
      setQuickBindingsImportText('')
    },
    [quickBindingsImportText, t]
  )

  const saveQuickBindings = useCallback(
    async (gatewayId: string) => {
      try {
        setQuickBindingsSavingId(gatewayId)
        setError(null)
        const gateway = gateways.find((item) => item.id === gatewayId)
        const normalized = normalizeGatewayChatBindings(
          quickBindingsDraft.map((row) => ({
            chatId: row.chatId.trim(),
            agentId: row.agentId.trim(),
          }))
        )
        if (normalized.partialCount > 0) {
          setError(t('config.errors.gatewayBindingsPartial', { count: normalized.partialCount }))
          return
        }
        if (
          normalized.duplicateChatIds.length > 0 &&
          !window.confirm(
            t('config.confirm.gatewayBindingsDuplicate', {
              count: normalized.duplicateChatIds.length,
            })
          )
        ) {
          return
        }
        if (gateway?.provider === 'telegram') {
          const allowed = new Set(parseGatewayAllowedChatIds(gateway.config?.allowedChatIds))
          if (allowed.size > 0) {
            const outsideAllowed = normalized.normalized.filter((row) => !allowed.has(row.chatId))
            if (
              outsideAllowed.length > 0 &&
              !window.confirm(
                t('config.confirm.gatewayBindingsOutsideAllowed', {
                  count: outsideAllowed.length,
                })
              )
            ) {
              return
            }
          }
        }
        await apiClient.put(`/gateways/instances/${gatewayId}`, {
          config: {
            chatBindings: normalized.normalized,
          },
        })
        await loadGateways()
        setQuickBindingsEditingId(null)
        setQuickBindingsDraft([])
        setQuickBindingsImportText('')
      } catch (err) {
        setError(getErrorMessage(err, t('config.errors.updateGateway')))
      } finally {
        setQuickBindingsSavingId(null)
      }
    },
    [gateways, loadGateways, quickBindingsDraft, t]
  )

  const toggleGatewaySelected = useCallback((id: string) => {
    setSelectedGatewayIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }, [])

  const filteredGateways = useMemo(
    () => (gatewayFilter === 'all' ? gateways : gateways.filter((item) => item.provider === gatewayFilter)),
    [gatewayFilter, gateways]
  )

  const allGatewaysSelected = useMemo(
    () =>
      filteredGateways.length > 0 &&
      filteredGateways.every((item) => selectedGatewayIds.includes(item.id)),
    [filteredGateways, selectedGatewayIds]
  )

  const toggleSelectAllGateways = useCallback(() => {
    setSelectedGatewayIds((prev) => {
      if (filteredGateways.length === 0) return prev
      const filteredIds = filteredGateways.map((item) => item.id)
      const allSelected = filteredIds.every((id) => prev.includes(id))
      if (allSelected) return prev.filter((id) => !filteredIds.includes(id))
      return Array.from(new Set([...prev, ...filteredIds]))
    })
  }, [filteredGateways])

  const selectedGatewayItems = useMemo(
    () => filteredGateways.filter((item) => selectedGatewayIds.includes(item.id)),
    [filteredGateways, selectedGatewayIds]
  )

  const runGatewayBatchAction = useCallback(
    async (action: 'enable' | 'disable' | 'delete') => {
      if (selectedGatewayItems.length === 0) {
        setError(t('config.gateways.batchSelectHint'))
        return
      }

      let targets = selectedGatewayItems
      if (action === 'delete') {
        targets = selectedGatewayItems.filter((item) => !item.isDefault)
        if (targets.length === 0) {
          setError(t('config.gateways.batchNoDeletable'))
          return
        }
        if (!window.confirm(t('config.confirm.deleteGateways', { count: targets.length }))) {
          return
        }
      }

      try {
        setGatewayBatchLoading(true)
        setError(null)
        const response = await apiClient.post<ApiResponse<GatewayBatchResult>>('/gateways/instances/batch', {
          action,
          instanceIds: targets.map((item) => item.id),
          ignoreMissing: true,
        })
        if (!response.success) {
          throw new Error(t('config.errors.updateGateway'))
        }
        const failed = (response.data.failed?.length || 0) + (response.data.blocked?.length || 0)
        if (failed > 0) {
          setError(
            t('config.gateways.batchPartialFailed', {
              success: response.data.changed?.length || 0,
              failed,
            })
          )
        }
        if (action === 'delete') {
          const deletedIds = new Set(response.data.changed || [])
          setSelectedGatewayIds((prev) => prev.filter((id) => !deletedIds.has(id)))
        }
        await loadGateways()
      } catch (err) {
        setError(getErrorMessage(err, t('config.errors.updateGateway')))
      } finally {
        setGatewayBatchLoading(false)
      }
    },
    [loadGateways, selectedGatewayItems, t]
  )

  const runGatewayBatchTest = useCallback(async () => {
    if (selectedGatewayItems.length === 0) {
      setError(t('config.gateways.batchSelectHint'))
      return
    }
    try {
      setGatewayBatchLoading(true)
      setError(null)
      const settled = await Promise.allSettled(
        selectedGatewayItems.map((item) => {
          const payload =
            item.provider === 'telegram'
              ? { text: 'Semibot gateway test' }
              : { title: 'Semibot gateway test', content: 'Gateway connectivity test' }
          return apiClient.post(`/gateways/instances/${item.id}/test`, payload)
        })
      )
      const failed = settled.filter((result) => result.status === 'rejected').length
      if (failed > 0) {
        setError(
          t('config.gateways.batchTestPartialFailed', {
            success: selectedGatewayItems.length - failed,
            failed,
          })
        )
      }
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.testGateway')))
    } finally {
      setGatewayBatchLoading(false)
    }
  }, [selectedGatewayItems, t])

  useEffect(() => {
    setSelectedGatewayIds((prev) => prev.filter((id) => gateways.some((item) => item.id === id)))
  }, [gateways])

  useEffect(() => {
    if (!quickBindingsEditingId) return
    const exists = gateways.some((item) => item.id === quickBindingsEditingId)
    if (!exists) {
      setQuickBindingsEditingId(null)
      setQuickBindingsDraft([])
      setQuickBindingsImportText('')
    }
  }, [gateways, quickBindingsEditingId])

  const llmStatusMap = useMemo(() => {
    const map = new Map<string, LlmProviderStatus>()
    llmProviders.forEach((item) => map.set(item.name, item))
    return map
  }, [llmProviders])

  const activeToolsCount = useMemo(
    () => tools.filter((tool) => tool.isActive).length,
    [tools]
  )
  const activeGatewaysCount = useMemo(
    () => filteredGateways.filter((item) => item.isActive).length,
    [filteredGateways]
  )
  const selectedGatewayCount = useMemo(() => selectedGatewayItems.length, [selectedGatewayItems])
  const runtimeSkillsErrorText = useMemo(
    () => formatRuntimeStatusError(runtimeSkills.error, runtimeSkills.source),
    [runtimeSkills.error, runtimeSkills.source]
  )

  const tabs = useMemo(
    () => [
      {
        id: 'llm' as const,
        label: 'LLM',
        count: llmProviders.filter((item) => item.available).length,
      },
      {
        id: 'tools' as const,
        label: 'Tools',
        count: tools.length,
      },
      { id: 'gateways' as const, label: 'Gateways', count: gateways.length },
      { id: 'apiKeys' as const, label: 'API Keys', count: apiKeys.length },
      { id: 'webhooks' as const, label: 'Webhooks', count: webhooks.length },
    ],
    [apiKeys.length, gateways.length, llmProviders, tools.length, webhooks.length]
  )

  const isAnySectionLoading = Object.values(sectionLoading).some(Boolean)

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{t('config.header.title')}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t('config.header.subtitle')}
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={loadData}
            leftIcon={<Loader2 size={16} className={refreshingAll || isAnySectionLoading ? 'animate-spin' : ''} />}
          >
            {t('common.refresh')}
          </Button>
        </div>

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
              <span className="ml-2 text-sm text-text-secondary">{t('config.loading')}</span>
            </CardContent>
          </Card>
        ) : (
          <>
            {activeTab === 'llm' && (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card className="border-border-default">
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Cpu size={18} className="text-primary-400" />
                        <h2 className="text-lg font-semibold text-text-primary">{t('config.llm.routingDefaults')}</h2>
                      </div>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCw size={13} className={sectionLoading.llm ? 'animate-spin' : ''} />}
                        onClick={loadLlmData}
                      >
                        {t('common.refresh')}
                      </Button>
                    </div>
                    {sectionErrors.llm && (
                      <p className="text-xs text-warning-500">{sectionErrors.llm}</p>
                    )}
                    <Input
                      placeholder="DEFAULT_LLM_MODEL"
                      value={modelDefaults.defaultModel}
                      onChange={(e) =>
                        setModelDefaults((prev) => ({ ...prev, defaultModel: e.target.value }))
                      }
                    />
                    <Input
                      placeholder="FALLBACK_LLM_MODEL"
                      value={modelDefaults.fallbackModel}
                      onChange={(e) =>
                        setModelDefaults((prev) => ({ ...prev, fallbackModel: e.target.value }))
                      }
                    />
                    <Button
                      onClick={saveModelConfig}
                      loading={savingModelDefaults}
                    >
                      {t('config.llm.saveRouting')}
                    </Button>
                  </CardContent>
                </Card>

                <Card className="border-border-default">
                  <CardContent className="p-5 space-y-3">
                    <h2 className="text-lg font-semibold text-text-primary">{t('config.llm.providerConfig')}</h2>
                    {(Object.keys(llmConfig?.providers || {}) as ProviderKey[]).map((providerKey) => {
                      const cfg = llmConfig?.providers[providerKey]
                      const status = llmStatusMap.get(providerKey)
                      if (!cfg) return null

                      return (
                        <div
                          key={providerKey}
                          className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-text-primary">
                              {status?.displayName || providerKey}
                            </p>
                            <div className="flex items-center gap-2">
                              <Badge variant={status?.available ? 'success' : 'outline'}>
                                {status?.available ? t('config.status.available') : t('config.status.notConfigured')}
                              </Badge>
                              <Button
                                size="xs"
                                variant="tertiary"
                                leftIcon={<Pencil size={12} />}
                                onClick={() => openProviderConfigDialog(providerKey)}
                              >
                                {t('common.edit')}
                              </Button>
                            </div>
                          </div>
                          <p className="mt-1 text-xs text-text-tertiary">
                            API Key: {cfg.apiKeyConfigured ? (cfg.apiKeyPreview || t('config.status.configured')) : t('config.status.notConfigured')}
                          </p>
                          <p className="mt-1 truncate text-xs text-text-tertiary">
                            Endpoint: {cfg.baseUrl || t('config.common.notSet')}
                          </p>
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary">
                              {t('config.llm.viewModels')}（{status?.models?.length ?? 0}）
                            </summary>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {(status?.models || []).map((model) => (
                                <span
                                  key={model}
                                  className="rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-tertiary"
                                >
                                  {model}
                                </span>
                              ))}
                            </div>
                          </details>
                        </div>
                      )
                    })}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeTab === 'tools' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Wrench size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">Tools</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-tertiary">{t('config.tools.activeCount', { count: activeToolsCount })}</span>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCw size={13} className={sectionLoading.tools ? 'animate-spin' : ''} />}
                        onClick={loadTools}
                      >
                        {t('common.refresh')}
                      </Button>
                    </div>
                  </div>

                  {sectionErrors.tools && (
                    <p className="text-xs text-warning-500">{sectionErrors.tools}</p>
                  )}

                  <div className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-text-primary">{t('config.tools.configTitle')}</p>
                      <Badge variant={runtimeSkills.available ? 'success' : 'outline'}>
                        {runtimeSkills.available ? t('config.status.connected') : t('config.status.disconnected')}
                      </Badge>
                    </div>
                    {runtimeSkillsErrorText && (
                      <p className="mt-2 text-xs text-warning-500">{runtimeSkillsErrorText}</p>
                    )}
                    <div className="mt-2 space-y-2">
                      {sectionLoading.tools && tools.length === 0 ? (
                        <p className="text-sm text-text-secondary">{t('config.tools.loading')}</p>
                      ) : tools.length === 0 ? (
                        <p className="text-sm text-text-secondary">{t('config.tools.empty')}</p>
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
                                <p className="mt-1 text-xs text-text-tertiary">
                                  {t('config.tools.risk')}: {tool.config?.riskLevel || 'low'} · {t('config.tools.approval')}:{' '}
                                  {tool.config?.requiresApproval ? t('config.tools.on') : t('config.tools.off')}
                                  {tool.config?.requiresApproval
                                    ? ` · ${t('config.tools.approvalScope')}: ${String(tool.config?.approvalScope || 'session')}`
                                    : ''}
                                </p>
                              </div>
                              <div className="flex items-center gap-1">
                                {tool.isBuiltin && <Badge variant="outline">{t('config.tools.builtIn')}</Badge>}
                                <Badge variant={tool.isActive ? 'success' : 'outline'}>
                                  {tool.isActive ? t('config.status.enabled') : t('config.status.disabled')}
                                </Badge>
                              </div>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <Button
                                size="xs"
                                variant="tertiary"
                                leftIcon={<Pencil size={12} />}
                                onClick={() => openEditToolDialog(tool)}
                              >
                                {t('config.tools.configure')}
                              </Button>
                              <Button size="xs" variant="tertiary" onClick={() => toggleToolStatus(tool)}>
                                {tool.isActive ? t('config.tools.disable') : t('config.tools.enable')}
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'gateways' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <MessageSquare size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">{t('config.gateways.title')}</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-tertiary">
                        {t('config.gateways.activeCount', { count: activeGatewaysCount })}
                      </span>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<Plus size={13} />}
                        onClick={() => openCreateGatewayDialog('telegram')}
                      >
                        {t('config.gateways.newTelegram')}
                      </Button>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<Plus size={13} />}
                        onClick={() => openCreateGatewayDialog('feishu')}
                      >
                        {t('config.gateways.newFeishu')}
                      </Button>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCw size={13} className={sectionLoading.gateways ? 'animate-spin' : ''} />}
                        onClick={loadGateways}
                        disabled={gatewayBatchLoading}
                      >
                        {t('common.refresh')}
                      </Button>
                    </div>
                  </div>
                  {sectionErrors.gateways && (
                    <p className="text-xs text-warning-500">{sectionErrors.gateways}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      data-testid="gateways-filter-all"
                      type="button"
                      className={clsx(
                        'rounded-md border px-2.5 py-1 text-xs transition-colors',
                        gatewayFilter === 'all'
                          ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                          : 'border-border-subtle text-text-secondary hover:bg-bg-surface'
                      )}
                      onClick={() => setGatewayFilter('all')}
                      disabled={gatewayBatchLoading}
                    >
                      {t('config.gateways.filterAll')}
                    </button>
                    <button
                      data-testid="gateways-filter-telegram"
                      type="button"
                      className={clsx(
                        'rounded-md border px-2.5 py-1 text-xs transition-colors',
                        gatewayFilter === 'telegram'
                          ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                          : 'border-border-subtle text-text-secondary hover:bg-bg-surface'
                      )}
                      onClick={() => setGatewayFilter('telegram')}
                      disabled={gatewayBatchLoading}
                    >
                      {t('config.gateways.filterTelegram')}
                    </button>
                    <button
                      data-testid="gateways-filter-feishu"
                      type="button"
                      className={clsx(
                        'rounded-md border px-2.5 py-1 text-xs transition-colors',
                        gatewayFilter === 'feishu'
                          ? 'border-primary-500/50 bg-primary-500/10 text-primary-400'
                          : 'border-border-subtle text-text-secondary hover:bg-bg-surface'
                      )}
                      onClick={() => setGatewayFilter('feishu')}
                      disabled={gatewayBatchLoading}
                    >
                      {t('config.gateways.filterFeishu')}
                    </button>
                  </div>
                  {filteredGateways.length > 0 && (
                    <label className="flex items-center gap-2 text-sm text-text-secondary">
                      <input
                        data-testid="gateways-select-all"
                        type="checkbox"
                        className="rounded border-border-default"
                        checked={allGatewaysSelected}
                        onChange={toggleSelectAllGateways}
                        disabled={gatewayBatchLoading}
                      />
                      {t('config.gateways.selectAllVisible')}
                    </label>
                  )}
                  {selectedGatewayCount > 0 && (
                    <div className="rounded-md border border-primary-500/30 bg-primary-500/10 px-3 py-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm text-text-primary">
                        {t('config.gateways.selectedCount', { count: selectedGatewayCount })}
                      </span>
                      <Button
                        data-testid="gateways-batch-enable"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchAction('enable')}
                      >
                        {t('config.gateways.batchEnable')}
                      </Button>
                      <Button
                        data-testid="gateways-batch-disable"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchAction('disable')}
                      >
                        {t('config.gateways.batchDisable')}
                      </Button>
                      <Button
                        data-testid="gateways-batch-test"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchTest()}
                      >
                        {t('config.gateways.batchTest')}
                      </Button>
                      <Button
                        data-testid="gateways-batch-delete"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchAction('delete')}
                      >
                        {t('config.gateways.batchDelete')}
                      </Button>
                    </div>
                  )}
                  <div className="space-y-2">
                    {sectionLoading.gateways && gateways.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.gateways.loading')}
                      </p>
                    ) : filteredGateways.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.gateways.empty')}
                      </p>
                    ) : (
                      filteredGateways.map((item) => {
                        const itemBindings = parseGatewayChatBindings(item.config?.chatBindings)
                        const isQuickEditing = quickBindingsEditingId === item.id
                        const defaultAgentId = String(item.config?.agentId || item.config?.defaultAgentId || 'semibot')
                        const previewBindings = itemBindings.slice(0, 3)
                        const previewText = previewBindings.map((row) => `${row.chatId}→${row.agentId}`).join(' · ')
                        const hasMorePreview = itemBindings.length > previewBindings.length
                        return (
                          <div key={item.id} className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0 flex items-start gap-3">
                                <input
                                  data-testid={`gateway-select-${item.id}`}
                                  type="checkbox"
                                  className="mt-1 rounded border-border-default"
                                  checked={selectedGatewayIds.includes(item.id)}
                                  onChange={() => toggleGatewaySelected(item.id)}
                                  disabled={gatewayBatchLoading}
                                />
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-text-primary">{item.displayName}</p>
                                  <p className="mt-1 text-xs text-text-tertiary">
                                    {item.provider}
                                    {item.instanceKey ? ` · ${item.instanceKey}` : ''} · status: {item.status} ·{' '}
                                    {t('config.gateways.agent')}: {defaultAgentId} · {t('config.gateways.updatedAt')}:{' '}
                                    {formatDate(item.updatedAt, locale, t)}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {item.isDefault && <Badge variant="outline">{t('config.gateways.defaultTag')}</Badge>}
                                <Badge variant={item.isActive ? 'success' : 'outline'}>
                                  {item.isActive ? t('config.status.enabled') : t('config.status.disabled')}
                                </Badge>
                                <Button
                                  size="xs"
                                  variant="tertiary"
                                  leftIcon={<Pencil size={12} />}
                                  onClick={() => openGatewayDialog(item)}
                                  disabled={gatewayBatchLoading || quickBindingsSavingId === item.id}
                                >
                                  {t('common.edit')}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="tertiary"
                                  onClick={() => testGateway(item)}
                                  disabled={testingGateway === item.id || gatewayBatchLoading || quickBindingsSavingId === item.id}
                                >
                                  {t('config.gateways.test')}
                                </Button>
                                {!item.isDefault && (
                                  <Button
                                    size="xs"
                                    variant="tertiary"
                                    leftIcon={<Trash2 size={12} />}
                                    onClick={() => removeGateway(item)}
                                    disabled={gatewayBatchLoading || quickBindingsSavingId === item.id}
                                  >
                                    {t('common.delete')}
                                  </Button>
                                )}
                              </div>
                            </div>

                            <div className="mt-3 rounded-md border border-border-subtle px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs text-text-secondary">
                                  {t('config.gateways.chatBindingsSummary', { count: itemBindings.length })}
                                </p>
                                {!isQuickEditing ? (
                                  <Button
                                    data-testid={`gateway-quick-edit-${item.id}`}
                                    size="xs"
                                    variant="tertiary"
                                    onClick={() => startQuickBindingsEdit(item)}
                                    disabled={gatewayBatchLoading || quickBindingsSavingId === item.id}
                                  >
                                    {t('config.gateways.quickEditBindings')}
                                  </Button>
                                ) : null}
                              </div>
                              {!isQuickEditing ? (
                                <p className="mt-1 text-xs text-text-tertiary">
                                  {itemBindings.length > 0 ? (
                                    <>
                                      {previewText}
                                      {hasMorePreview ? ` · ${t('config.gateways.chatBindingsMore', { count: itemBindings.length - previewBindings.length })}` : ''}
                                    </>
                                  ) : (
                                    t('config.gateways.chatBindingsNone')
                                  )}
                                </p>
                              ) : (
                                <div className="mt-2 space-y-2">
                                  <div className="space-y-2">
                                    <textarea
                                      data-testid={`gateway-quick-import-${item.id}`}
                                      className="w-full rounded-lg border border-border-default bg-bg-canvas px-3 py-2 text-xs text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-primary-400 focus:ring-2 focus:ring-primary-400/30"
                                      rows={3}
                                      placeholder={t('config.gateways.importBindingsPlaceholder')}
                                      value={quickBindingsImportText}
                                      onChange={(e) => setQuickBindingsImportText(e.target.value)}
                                    />
                                    <Button
                                      data-testid={`gateway-quick-import-apply-${item.id}`}
                                      size="xs"
                                      variant="tertiary"
                                      onClick={() => applyQuickBindingsImport(defaultAgentId)}
                                      disabled={quickBindingsSavingId === item.id}
                                    >
                                      {t('config.gateways.applyImportedBindings')}
                                    </Button>
                                  </div>
                                  {quickBindingsDraft.map((row, index) => (
                                    <div key={`quick-binding-${item.id}-${index}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                                      <Input
                                        data-testid={`gateway-quick-chat-${item.id}-${index}`}
                                        placeholder={t('config.modals.gateway.chatIdPlaceholder')}
                                        value={row.chatId}
                                        onChange={(e) => updateQuickBindingsRow(index, 'chatId', e.target.value)}
                                      />
                                      <Input
                                        data-testid={`gateway-quick-agent-${item.id}-${index}`}
                                        placeholder={t('config.modals.gateway.chatBindingAgentPlaceholder')}
                                        value={row.agentId}
                                        onChange={(e) => updateQuickBindingsRow(index, 'agentId', e.target.value)}
                                      />
                                      <Button
                                        data-testid={`gateway-quick-remove-${item.id}-${index}`}
                                        size="xs"
                                        variant="tertiary"
                                        onClick={() => removeQuickBindingsRow(index)}
                                        disabled={quickBindingsSavingId === item.id}
                                      >
                                        {t('config.modals.gateway.removeChatBinding')}
                                      </Button>
                                    </div>
                                  ))}
                                  <div className="flex items-center gap-2">
                                    <Button
                                      data-testid={`gateway-quick-add-${item.id}`}
                                      size="xs"
                                      variant="tertiary"
                                      onClick={() => addQuickBindingsRow(defaultAgentId)}
                                      disabled={quickBindingsSavingId === item.id}
                                    >
                                      {t('config.modals.gateway.addChatBinding')}
                                    </Button>
                                    <Button
                                      data-testid={`gateway-quick-save-${item.id}`}
                                      size="xs"
                                      variant="tertiary"
                                      onClick={() => void saveQuickBindings(item.id)}
                                      disabled={quickBindingsSavingId === item.id}
                                    >
                                      {t('config.gateways.quickSaveBindings')}
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="tertiary"
                                      onClick={() => cancelQuickBindingsEdit()}
                                      disabled={quickBindingsSavingId === item.id}
                                    >
                                      {t('common.cancel')}
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
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
                        {t('common.refresh')}
                      </Button>
                      <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setShowCreateKey(true)}>
                        {t('config.apiKeys.newKey')}
                      </Button>
                    </div>
                  </div>
                  {sectionErrors.apiKeys && (
                    <p className="text-xs text-warning-500">{sectionErrors.apiKeys}</p>
                  )}
                  <div className="space-y-2">
                    {sectionLoading.apiKeys && apiKeys.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.apiKeys.loading')}
                      </p>
                    ) : apiKeys.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.apiKeys.empty')}
                      </p>
                    ) : (
                      apiKeys.map((item) => (
                        <div key={item.id} className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-text-primary">{item.name}</p>
                              <p className="text-xs text-text-tertiary">{item.keyPrefix}...</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={item.isActive ? 'success' : 'outline'}>
                                {item.isActive ? t('config.status.enabled') : t('config.status.disabled')}
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
                          <p className="mt-2 text-xs text-text-tertiary">
                            {t('config.apiKeys.lastUsed')}: {formatDate(item.lastUsedAt, locale, t)} · {t('config.apiKeys.expires')}: {formatDate(item.expiresAt, locale, t)}
                          </p>
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
                        {t('common.refresh')}
                      </Button>
                      <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setShowCreateWebhook(true)}>
                        {t('config.webhooks.newWebhook')}
                      </Button>
                    </div>
                  </div>
                  {sectionErrors.webhooks && (
                    <p className="text-xs text-warning-500">{sectionErrors.webhooks}</p>
                  )}
                  <div className="space-y-2">
                    {sectionLoading.webhooks && webhooks.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.webhooks.loading')}
                      </p>
                    ) : webhooks.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.webhooks.empty')}
                      </p>
                    ) : (
                      webhooks.map((item) => (
                        <div key={item.id} className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-text-primary">{item.url}</p>
                              <p className="mt-1 text-xs text-text-tertiary">
                                {t('config.webhooks.events')}: {item.events.join(', ')} · {t('config.webhooks.createdAt')}: {formatDate(item.createdAt, locale, t)}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={item.isActive ? 'success' : 'outline'}>
                                {item.isActive ? t('config.status.enabled') : t('config.status.disabled')}
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
                                {item.isActive ? t('config.tools.disable') : t('config.tools.enable')}
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
          </>
        )}
      </div>

      <Modal
        open={showProviderConfigModal}
        onClose={() => setShowProviderConfigModal(false)}
        title={t('config.modals.provider.title')}
        description={providerConfigForm.provider}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowProviderConfigModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={saveProviderConfig}
              loading={providerConfigSaving}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            type="password"
            placeholder={t('config.modals.provider.apiKeyPlaceholder')}
            value={providerConfigForm.apiKey}
            onChange={(e) => setProviderConfigForm((prev) => ({ ...prev, apiKey: e.target.value }))}
          />
          <Input
            placeholder="API Endpoint"
            value={providerConfigForm.baseUrl}
            onChange={(e) => setProviderConfigForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
          />
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={providerConfigForm.clearApiKey}
              onChange={(e) =>
                setProviderConfigForm((prev) => ({ ...prev, clearApiKey: e.target.checked }))
              }
            />
            {t('config.modals.provider.clearApiKey')}
          </label>
        </div>
      </Modal>

      <Modal
        open={showEditTool}
        onClose={() => setShowEditTool(false)}
        title={t('config.modals.tool.title')}
        description={toolForm.id || ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowEditTool(false)} disabled={savingTool}>
              {t('common.cancel')}
            </Button>
            <Button onClick={saveToolConfig} loading={savingTool}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-text-tertiary">
            {t('config.modals.tool.description')}
          </p>
          <Input
            placeholder={t('config.modals.tool.namePlaceholder')}
            value={toolForm.name}
            disabled
          />
          <Input
            placeholder={t('config.modals.tool.typePlaceholder')}
            value={toolForm.type}
            disabled
          />
          <Input
            placeholder={t('config.modals.tool.timeoutPlaceholder')}
            value={toolForm.timeoutMs}
            onChange={(e) => setToolForm((prev) => ({ ...prev, timeoutMs: e.target.value }))}
          />
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={toolForm.requiresApproval}
              onChange={(e) => setToolForm((prev) => ({ ...prev, requiresApproval: e.target.checked }))}
            />
            {t('config.modals.tool.hitl')}
          </label>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{t('config.modals.tool.riskLevel')}</p>
            <select
              className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
              value={toolForm.riskLevel}
              onChange={(e) =>
                setToolForm((prev) => ({
                  ...prev,
                  riskLevel: e.target.value as 'low' | 'medium' | 'high' | 'critical',
                }))
              }
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="critical">critical</option>
            </select>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{t('config.modals.tool.approvalScope')}</p>
            <select
              className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
              value={toolForm.approvalScope}
              onChange={(e) =>
                setToolForm((prev) => ({
                  ...prev,
                  approvalScope: e.target.value as ApprovalScope,
                }))
              }
            >
              <option value="session">{t('config.modals.tool.approvalScopes.session')}</option>
              <option value="session_action">{t('config.modals.tool.approvalScopes.sessionAction')}</option>
              <option value="action">{t('config.modals.tool.approvalScopes.action')}</option>
              <option value="target">{t('config.modals.tool.approvalScopes.target')}</option>
              <option value="tool">{t('config.modals.tool.approvalScopes.tool')}</option>
              <option value="call">{t('config.modals.tool.approvalScopes.call')}</option>
            </select>
            <p className="text-[11px] text-text-tertiary">{t('config.modals.tool.approvalScopeHint')}</p>
          </div>
          <Input
            placeholder={t('config.modals.tool.approvalDedupeKeysPlaceholder')}
            value={toolForm.approvalDedupeKeys}
            onChange={(e) => setToolForm((prev) => ({ ...prev, approvalDedupeKeys: e.target.value }))}
          />
          {!TOOLS_WITHOUT_API_CREDENTIALS.includes(toolForm.name) ? (
            <>
              <Input
                placeholder={t('config.modals.tool.apiEndpointPlaceholder')}
                value={toolForm.apiEndpoint}
                onChange={(e) => setToolForm((prev) => ({ ...prev, apiEndpoint: e.target.value }))}
              />
              <Input
                type="password"
                placeholder={t('config.modals.tool.apiKeyPlaceholder')}
                value={toolForm.apiKey}
                onChange={(e) => setToolForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
            </>
          ) : (
            <p className="text-xs text-text-tertiary">
              {t('config.modals.tool.noApiNeeded', { tool: toolForm.name })}
            </p>
          )}
          {toolForm.name === 'browser_automation' ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={toolForm.headless}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, headless: e.target.checked }))}
                />
                {t('config.modals.tool.browser.headless')}
              </label>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={toolForm.allowLocalhost}
                  onChange={(e) =>
                    setToolForm((prev) => ({
                      ...prev,
                      allowLocalhost: e.target.checked,
                    }))
                  }
                />
                {t('config.modals.tool.browser.allowLocalhost')}
              </label>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{t('config.modals.tool.browser.browserType')}</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.browserType}
                  onChange={(e) =>
                    setToolForm((prev) => ({
                      ...prev,
                      browserType: e.target.value as 'chromium' | 'firefox' | 'webkit',
                    }))
                  }
                >
                  <option value="chromium">chromium</option>
                  <option value="firefox">firefox</option>
                  <option value="webkit">webkit</option>
                </select>
              </div>
              <Input
                placeholder={t('config.modals.tool.browser.allowedDomainsPlaceholder')}
                value={toolForm.allowedDomains}
                onChange={(e) => setToolForm((prev) => ({ ...prev, allowedDomains: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.tool.browser.blockedDomainsPlaceholder')}
                value={toolForm.blockedDomains}
                onChange={(e) => setToolForm((prev) => ({ ...prev, blockedDomains: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.tool.browser.maxTextLengthPlaceholder')}
                value={toolForm.maxTextLength}
                onChange={(e) => setToolForm((prev) => ({ ...prev, maxTextLength: e.target.value }))}
              />
            </div>
          ) : null}
          {toolForm.name === 'http_client' || toolForm.name === 'web_fetch' ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={toolForm.allowLocalhost}
                  onChange={(e) =>
                    setToolForm((prev) => ({
                      ...prev,
                      allowLocalhost: e.target.checked,
                    }))
                  }
                />
                {t('config.modals.tool.http.allowLocalhost')}
              </label>
              <Input
                placeholder={t('config.modals.tool.http.allowedDomainsPlaceholder')}
                value={toolForm.allowedDomains}
                onChange={(e) => setToolForm((prev) => ({ ...prev, allowedDomains: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.tool.http.blockedDomainsPlaceholder')}
                value={toolForm.blockedDomains}
                onChange={(e) => setToolForm((prev) => ({ ...prev, blockedDomains: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.tool.http.maxResponseCharsPlaceholder')}
                value={toolForm.maxResponseChars}
                onChange={(e) => setToolForm((prev) => ({ ...prev, maxResponseChars: e.target.value }))}
              />
            </div>
          ) : null}
          {toolForm.name === 'sql_query_readonly' ? (
            <div className="space-y-2">
              <Input
                placeholder={t('config.modals.tool.sql.maxRowsPlaceholder')}
                value={toolForm.sqlMaxRows}
                onChange={(e) => setToolForm((prev) => ({ ...prev, sqlMaxRows: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.tool.sql.defaultDatabasePlaceholder')}
                value={toolForm.sqlDefaultDatabase}
                onChange={(e) => setToolForm((prev) => ({ ...prev, sqlDefaultDatabase: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.tool.sql.allowedDatabasesPlaceholder')}
                value={toolForm.sqlAllowedDatabases}
                onChange={(e) => setToolForm((prev) => ({ ...prev, sqlAllowedDatabases: e.target.value }))}
              />
            </div>
          ) : null}
          {toolForm.name === 'file_io' ? (
            <div className="space-y-2">
              <Input
                placeholder={t('config.modals.tool.rootPathPlaceholder')}
                value={toolForm.rootPath}
                onChange={(e) => setToolForm((prev) => ({ ...prev, rootPath: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.tool.maxReadBytesPlaceholder')}
                value={toolForm.maxReadBytes}
                onChange={(e) => setToolForm((prev) => ({ ...prev, maxReadBytes: e.target.value }))}
              />
            </div>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={showGatewayModal}
        onClose={() => setShowGatewayModal(false)}
        title={t('config.modals.gateway.title')}
        description={gatewayForm.provider}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowGatewayModal(false)} disabled={savingGateway}>
              {t('common.cancel')}
            </Button>
            <Button onClick={saveGatewayConfig} loading={savingGateway}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {!gatewayForm.id && (
            <Input
              placeholder={t('config.modals.gateway.instanceKeyPlaceholder')}
              value={gatewayForm.instanceKey}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, instanceKey: e.target.value }))}
            />
          )}
          <Input
            placeholder={t('config.modals.gateway.displayNamePlaceholder')}
            value={gatewayForm.displayName}
            onChange={(e) => setGatewayForm((prev) => ({ ...prev, displayName: e.target.value }))}
          />
          <Input
            placeholder={t('config.modals.gateway.agentIdPlaceholder')}
            value={gatewayForm.agentId}
            onChange={(e) => setGatewayForm((prev) => ({ ...prev, agentId: e.target.value }))}
          />
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={gatewayForm.isDefault}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, isDefault: e.target.checked }))}
            />
            {t('config.modals.gateway.setDefault')}
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={gatewayForm.isActive}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, isActive: e.target.checked }))}
            />
            {t('config.modals.gateway.enabled')}
          </label>
          {gatewayForm.provider === 'telegram' ? (
            <>
              <Input
                type="password"
                placeholder={t('config.modals.gateway.telegram.botTokenPlaceholder')}
                value={gatewayForm.botToken}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, botToken: e.target.value }))}
              />
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={gatewayForm.clearBotToken}
                  onChange={(e) =>
                    setGatewayForm((prev) => ({
                      ...prev,
                      clearBotToken: e.target.checked,
                    }))
                  }
                />
                {t('config.modals.gateway.telegram.clearBotToken')}
              </label>
              <Input
                type="password"
                placeholder={t('config.modals.gateway.telegram.webhookSecretPlaceholder')}
                value={gatewayForm.webhookSecret}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, webhookSecret: e.target.value }))}
              />
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={gatewayForm.clearWebhookSecret}
                  onChange={(e) =>
                    setGatewayForm((prev) => ({
                      ...prev,
                      clearWebhookSecret: e.target.checked,
                    }))
                  }
                />
                {t('config.modals.gateway.telegram.clearWebhookSecret')}
              </label>
              <Input
                placeholder={t('config.modals.gateway.telegram.defaultChatIdPlaceholder')}
                value={gatewayForm.defaultChatId}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, defaultChatId: e.target.value }))}
              />
              <Input
                placeholder={t('config.modals.gateway.telegram.allowedChatIdsPlaceholder')}
                value={gatewayForm.allowedChatIds}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, allowedChatIds: e.target.value }))}
              />
            </>
          ) : (
            <>
              <Input
                type="password"
                placeholder={t('config.modals.gateway.feishu.verifyTokenPlaceholder')}
                value={gatewayForm.verifyToken}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, verifyToken: e.target.value }))}
              />
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={gatewayForm.clearVerifyToken}
                  onChange={(e) =>
                    setGatewayForm((prev) => ({
                      ...prev,
                      clearVerifyToken: e.target.checked,
                    }))
                  }
                />
                {t('config.modals.gateway.feishu.clearVerifyToken')}
              </label>
              <Input
                placeholder={t('config.modals.gateway.feishu.webhookUrlPlaceholder')}
                value={gatewayForm.webhookUrl}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, webhookUrl: e.target.value }))}
              />
            </>
          )}
          <div className="space-y-2 rounded-md border border-border-default p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-text-primary">{t('config.modals.gateway.chatBindingsTitle')}</p>
              <Button
                type="button"
                size="xs"
                variant="tertiary"
                data-testid="gateway-chat-binding-add"
                onClick={() => addGatewayChatBinding()}
              >
                {t('config.modals.gateway.addChatBinding')}
              </Button>
            </div>
            <div className="space-y-2">
              <textarea
                className="w-full rounded-lg border border-border-default bg-bg-canvas px-3 py-2 text-xs text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-primary-400 focus:ring-2 focus:ring-primary-400/30"
                rows={3}
                placeholder={t('config.modals.gateway.importBindingsPlaceholder')}
                value={gatewayBindingsImportText}
                onChange={(e) => setGatewayBindingsImportText(e.target.value)}
              />
              <Button
                type="button"
                size="xs"
                variant="tertiary"
                onClick={() => applyGatewayBindingsImport()}
              >
                {t('config.modals.gateway.applyImportedBindings')}
              </Button>
            </div>
            {gatewayForm.chatBindings.length === 0 ? (
              <p className="text-xs text-text-secondary">{t('config.modals.gateway.chatBindingsEmpty')}</p>
            ) : (
              <div className="space-y-2">
                {gatewayForm.chatBindings.map((row, index) => (
                  <div key={`chat-binding-${index}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                    <Input
                      data-testid={`gateway-chat-binding-chat-${index}`}
                      placeholder={t('config.modals.gateway.chatIdPlaceholder')}
                      value={row.chatId}
                      onChange={(e) => updateGatewayChatBinding(index, 'chatId', e.target.value)}
                    />
                    <Input
                      data-testid={`gateway-chat-binding-agent-${index}`}
                      placeholder={t('config.modals.gateway.chatBindingAgentPlaceholder')}
                      value={row.agentId}
                      onChange={(e) => updateGatewayChatBinding(index, 'agentId', e.target.value)}
                    />
                    <Button
                      type="button"
                      size="xs"
                      variant="tertiary"
                      data-testid={`gateway-chat-binding-remove-${index}`}
                      onClick={() => removeGatewayChatBinding(index)}
                    >
                      {t('config.modals.gateway.removeChatBinding')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Input
            placeholder={t('config.modals.gateway.notifyEventTypesPlaceholder')}
            value={gatewayForm.notifyEventTypes}
            onChange={(e) => setGatewayForm((prev) => ({ ...prev, notifyEventTypes: e.target.value }))}
          />

          <div className="space-y-2 rounded-md border border-border-default p-3">
            <p className="text-sm font-medium text-text-primary">{t('config.modals.gateway.addressing.title')}</p>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{t('config.modals.gateway.addressing.modeLabel')}</p>
              <select
                className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                value={gatewayForm.addressingMode}
                onChange={(e) =>
                  setGatewayForm((prev) => ({
                    ...prev,
                    addressingMode: e.target.value as GatewayAddressingMode,
                  }))
                }
              >
                <option value="mention_only">{t('config.modals.gateway.addressing.modeMentionOnly')}</option>
                <option value="all_messages">{t('config.modals.gateway.addressing.modeAllMessages')}</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={gatewayForm.allowReplyToBot}
                onChange={(e) =>
                  setGatewayForm((prev) => ({
                    ...prev,
                    allowReplyToBot: e.target.checked,
                  }))
                }
              />
              {t('config.modals.gateway.addressing.allowReplyToBot')}
            </label>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={gatewayForm.executeOnUnaddressed}
                onChange={(e) =>
                  setGatewayForm((prev) => ({
                    ...prev,
                    executeOnUnaddressed: e.target.checked,
                  }))
                }
              />
              {t('config.modals.gateway.addressing.executeOnUnaddressed')}
            </label>
            <Input
              placeholder={t('config.modals.gateway.addressing.commandPrefixesPlaceholder')}
              value={gatewayForm.commandPrefixes}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, commandPrefixes: e.target.value }))}
            />
            <Input
              placeholder={t('config.modals.gateway.addressing.sessionContinuationWindowSecPlaceholder')}
              value={gatewayForm.sessionContinuationWindowSec}
              onChange={(e) =>
                setGatewayForm((prev) => ({
                  ...prev,
                  sessionContinuationWindowSec: e.target.value,
                }))
              }
            />
          </div>

          <div className="space-y-2 rounded-md border border-border-default p-3">
            <p className="text-sm font-medium text-text-primary">{t('config.modals.gateway.proactive.title')}</p>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{t('config.modals.gateway.proactive.modeLabel')}</p>
              <select
                className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                value={gatewayForm.proactiveMode}
                onChange={(e) =>
                  setGatewayForm((prev) => ({
                    ...prev,
                    proactiveMode: e.target.value as GatewayProactiveMode,
                  }))
                }
              >
                <option value="silent">{t('config.modals.gateway.proactive.modeSilent')}</option>
                <option value="risk_based">{t('config.modals.gateway.proactive.modeRiskBased')}</option>
                <option value="always">{t('config.modals.gateway.proactive.modeAlways')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{t('config.modals.gateway.proactive.minRiskToNotifyLabel')}</p>
              <select
                className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                value={gatewayForm.minRiskToNotify}
                onChange={(e) =>
                  setGatewayForm((prev) => ({
                    ...prev,
                    minRiskToNotify: e.target.value as RiskLevel,
                  }))
                }
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="critical">critical</option>
              </select>
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border-default p-3">
            <p className="text-sm font-medium text-text-primary">{t('config.modals.gateway.context.title')}</p>
            <Input
              placeholder={t('config.modals.gateway.context.ttlDaysPlaceholder')}
              value={gatewayForm.contextTtlDays}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, contextTtlDays: e.target.value }))}
            />
            <Input
              placeholder={t('config.modals.gateway.context.maxRecentMessagesPlaceholder')}
              value={gatewayForm.contextMaxRecentMessages}
              onChange={(e) =>
                setGatewayForm((prev) => ({
                  ...prev,
                  contextMaxRecentMessages: e.target.value,
                }))
              }
            />
            <Input
              placeholder={t('config.modals.gateway.context.summarizeEveryNMessagesPlaceholder')}
              value={gatewayForm.contextSummarizeEveryNMessages}
              onChange={(e) =>
                setGatewayForm((prev) => ({
                  ...prev,
                  contextSummarizeEveryNMessages: e.target.value,
                }))
              }
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={showCreateKey}
        onClose={() => setShowCreateKey(false)}
        title={t('config.modals.apiKey.title')}
        description={t('config.modals.apiKey.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreateKey(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={createApiKey} loading={creatingKey} disabled={!newKeyName.trim()}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            placeholder={t('config.modals.apiKey.namePlaceholder')}
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
        title={t('config.modals.webhook.title')}
        description={t('config.modals.webhook.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreateWebhook(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={createWebhook}
              loading={creatingWebhook}
              disabled={!webhookForm.url.trim() || !webhookForm.secret.trim()}
            >
              {t('common.create')}
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
            placeholder={t('config.modals.webhook.secretPlaceholder')}
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
        open={!!createdKey}
        onClose={() => setCreatedKey(null)}
        title={t('config.modals.createdKey.title')}
        description={t('config.modals.createdKey.description')}
        footer={<Button onClick={() => setCreatedKey(null)}>{t('config.modals.createdKey.saved')}</Button>}
      >
        <div className="rounded-md border border-border-subtle bg-bg-surface p-3">
          <p className="text-xs text-text-tertiary">{t('config.modals.createdKey.fullKey')}</p>
          <p className="mt-2 break-all font-mono text-sm text-primary-300">{createdKey?.key}</p>
        </div>
      </Modal>
    </div>
  )
}
