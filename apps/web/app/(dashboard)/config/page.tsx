'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Cpu,
  KeyRound,
  Webhook,
  FileText,
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
import { Select, type SelectGroup, type SelectOption } from '@/components/ui/Select'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'
import { toast } from '@/stores/toastStore'

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
  displayName?: string
}

const MODEL_BINDING_DELIMITER = '::'

function encodeModelBinding(providerKey: string, modelId: string): string {
  return `${providerKey}${MODEL_BINDING_DELIMITER}${modelId}`
}

function decodeModelBinding(value: string): { providerKey: string; modelId: string } | null {
  const idx = value.indexOf(MODEL_BINDING_DELIMITER)
  if (idx <= 0) return null
  const providerKey = value.slice(0, idx).trim()
  const modelId = value.slice(idx + MODEL_BINDING_DELIMITER.length).trim()
  if (!providerKey || !modelId) return null
  return { providerKey, modelId }
}

type NodeModelConfig = {
  model?: string
  temperature?: number
}

type ModelRolesConfig = {
  plan?: NodeModelConfig
  act?: NodeModelConfig
  textProcessing?: NodeModelConfig
}

function normalizeNodeModelConfig(raw: unknown): NodeModelConfig {
  if (!raw || typeof raw !== 'object') return {}
  const data = raw as Record<string, unknown>
  const model = typeof data.model === 'string' ? data.model.trim() : ''
  const temperature = typeof data.temperature === 'number' ? data.temperature : undefined
  return {
    model: model || undefined,
    temperature,
  }
}

function normalizeModelRoles(raw: unknown): ModelRolesConfig {
  if (!raw || typeof raw !== 'object') return { plan: {}, act: {}, textProcessing: {} }
  const data = raw as Record<string, unknown>
  return {
    plan: normalizeNodeModelConfig(data.plan),
    act: normalizeNodeModelConfig(data.act),
    textProcessing: normalizeNodeModelConfig(data.textProcessing ?? data.text_processing),
  }
}

interface LlmConfigData {
  defaultModel: string
  defaultProviderKey?: string
  fallbackModel: string
  fallbackProviderKey?: string
  modelRoles?: ModelRolesConfig
  providers: Record<string, LlmProviderConfigEntry>
}

interface ToolItem {
  id: string
  name: string
  type: string
  description?: string
  config?: {
    timeout?: number
    retryAttempts?: number
    authType?: 'none' | 'bearer' | 'basic' | 'api_key'
    authHeader?: string
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
    connections?: Record<string, string>
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

interface EvolutionCapabilityDoc {
  id: string
  capabilityType: 'hands' | 'reflex' | 'spine' | 'guard' | 'mind'
  version: string
  content: string
  updatedAt: string
}
type EvolutionCapabilityType = 'hands' | 'reflex' | 'spine' | 'guard' | 'mind'

interface EnvVarItem {
  name: string
  value: string
  isSensitive: boolean
  hasValue: boolean
}

type ConfigTab =
  | 'llm'
  | 'channels'
  | 'apiKeys'
  | 'webhooks'
  | 'envVars'
  | 'evolutionCapabilities'
type ApprovalScope = 'call' | 'action' | 'target' | 'session' | 'session_action' | 'tool'
type SectionKey =
  | 'llm'
  | 'tools'
  | 'channels'
  | 'apiKeys'
  | 'webhooks'
  | 'envVars'
  | 'evolutionCapabilities'
type ProviderKey = string
type ProviderType = 'openai' | 'anthropic' | 'google' | 'kimi' | 'qwen' | 'minimax' | 'xai' | 'custom'
type GatewayProvider = 'feishu' | 'telegram' | 'discord' | 'whatsapp' | 'imessage'
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

type GatewayBotBinding = {
  botId: string
  agentId: string
}

type GatewayForm = {
  id?: string
  instanceKey: string
  provider: GatewayProvider
  mode: 'webhook' | 'long_connection' | 'gateway'
  isDefault: boolean
  displayName: string
  agentId: string
  isActive: boolean
  verifyToken: string
  clearVerifyToken: boolean
  webhookUrl: string
  sdkEnabled: boolean
  appId: string
  appSecret: string
  clearAppSecret: boolean
  receiveIdType: 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email'
  defaultReceiveId: string
  sdkDomain: 'feishu' | 'lark'
  botToken: string
  clearBotToken: boolean
  defaultChannelId: string
  allowedChannelIds: string
  allowedGuildIds: string
  botUserId: string
  webhookSecret: string
  clearWebhookSecret: boolean
  sessionName: string
  linkedPhone: string
  bridgeUrl: string
  defaultHandle: string
  botBindings: GatewayBotBinding[]
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

const DEFAULT_EVENTS = ['chat.message.completed', 'task.completed', 'task.failed']
const MIN_WEBHOOK_SECRET_LENGTH = 16

const EVOLUTION_CAPABILITY_TYPES: EvolutionCapabilityType[] = ['hands', 'reflex', 'spine', 'guard', 'mind']
const PROVIDER_TYPE_OPTIONS: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google AI' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'qwen', label: 'Qwen' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'xai', label: 'xAI' },
  { value: 'custom', label: 'Custom' },
]

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

function parseGatewayBotBindings(raw: unknown): GatewayBotBinding[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const row = item as Record<string, unknown>
        const botId = String(row.botId || row.bot_id || '').trim()
        const agentId = String(row.agentId || row.agent_id || '').trim()
        if (!botId || !agentId) return null
        return { botId, agentId }
      })
      .filter((row): row is GatewayBotBinding => Boolean(row))
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .map(([botId, agentId]) => {
        const normalizedBotId = String(botId || '').trim()
        const normalizedAgentId = String(agentId || '').trim()
        if (!normalizedBotId || !normalizedAgentId) return null
        return { botId: normalizedBotId, agentId: normalizedAgentId }
      })
      .filter((row): row is GatewayBotBinding => Boolean(row))
  }
  return []
}

function parseGatewayBotBindingImportText(
  text: string,
  defaultAgentId: string
): { rows: GatewayBotBinding[]; invalidLines: string[] } {
  const rows: GatewayBotBinding[] = []
  const invalidLines: string[] = []
  const fallbackAgent = defaultAgentId.trim() || 'semibot'
  const lines = text.split('\n').map((line) => line.trim())

  for (const line of lines) {
    if (!line) continue
    const separators = ['=', '->', '\t', ',']
    let botId = ''
    let agentId = ''

    for (const sep of separators) {
      if (!line.includes(sep)) continue
      const [left, right] = line.split(sep, 2)
      botId = String(left || '').trim()
      agentId = String(right || '').trim()
      break
    }

    if (!botId) {
      botId = line
      agentId = fallbackAgent
    } else if (!agentId) {
      agentId = fallbackAgent
    }

    if (!botId || !agentId) {
      invalidLines.push(line)
      continue
    }
    rows.push({ botId, agentId })
  }

  return { rows, invalidLines }
}

function normalizeGatewayBotBindings(rows: GatewayBotBinding[]): {
  normalized: GatewayBotBinding[]
  duplicateBotIds: string[]
  partialCount: number
} {
  const byBotId = new Map<string, string>()
  const duplicateBotIds: string[] = []
  let partialCount = 0

  for (const row of rows) {
    const botId = String(row.botId || '').trim()
    const agentId = String(row.agentId || '').trim()
    if (!botId && !agentId) continue
    if (!botId || !agentId) {
      partialCount += 1
      continue
    }
    if (byBotId.has(botId) && !duplicateBotIds.includes(botId)) {
      duplicateBotIds.push(botId)
    }
    byBotId.set(botId, agentId)
  }

  const normalized = Array.from(byBotId.entries()).map(([botId, agentId]) => ({ botId, agentId }))
  return { normalized, duplicateBotIds, partialCount }
}

export default function ConfigPage() {
  const { locale, t } = useLocale()
  const tSafe = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const value = t(key, params)
      return value === key ? fallback : value
    },
    [t]
  )
  const evolutionUiText = useMemo(() => {
    return {
      tab: tSafe('config.evolutionCapabilities.tab', '进化'),
      title: tSafe('config.evolutionCapabilities.title', '进化中心'),
      description: tSafe(
        'config.evolutionCapabilities.description',
        '统一管理 5 类进化对象，可分别编辑与切换版本。保存后自动累加版本号。'
      ),
      hands: tSafe('config.evolutionCapabilities.hands', 'Hands（执行能力）'),
      reflex: tSafe('config.evolutionCapabilities.reflex', 'Reflex（规则模板）'),
      spine: tSafe('config.evolutionCapabilities.spine', 'Spine（规划规范）'),
      guard: tSafe('config.evolutionCapabilities.guard', 'Guard（工具策略）'),
      mind: tSafe('config.evolutionCapabilities.mind', 'Mind（全局行为）'),
      version: tSafe('config.evolutionCapabilities.version', '版本'),
      updatedAt: tSafe('config.evolutionCapabilities.updatedAt', '更新时间'),
      history: tSafe('config.evolutionCapabilities.history', '历史版本'),
      placeholder: tSafe('config.evolutionCapabilities.placeholder', '输入能力内容...'),
      rollbackTo: tSafe('config.evolutionCapabilities.rollbackTo', '切换到'),
      rollback: tSafe('config.evolutionCapabilities.rollback', '切换版本'),
    }
  }, [tSafe])
  const [activeTab, setActiveTab] = useState<ConfigTab>('llm')
  const [loading, setLoading] = useState(true)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sectionLoading, setSectionLoading] = useState<Record<SectionKey, boolean>>({
    llm: false,
    tools: false,
    channels: false,
    apiKeys: false,
    webhooks: false,
    envVars: false,
    evolutionCapabilities: false,
  })
  const [sectionErrors, setSectionErrors] = useState<Record<SectionKey, string | null>>({
    llm: null,
    tools: null,
    channels: null,
    apiKeys: null,
    webhooks: null,
    envVars: null,
    evolutionCapabilities: null,
  })

  const [llmProviders, setLlmProviders] = useState<LlmProviderStatus[]>([])
  const [llmConfig, setLlmConfig] = useState<LlmConfigData | null>(null)
  const [modelRoleDefaults, setModelRoleDefaults] = useState<ModelRolesConfig>({
    plan: {},
    act: {},
    textProcessing: {},
  })
  const [savingModelDefaults, setSavingModelDefaults] = useState(false)
  const [showProviderConfigModal, setShowProviderConfigModal] = useState(false)
  const [providerConfigSaving, setProviderConfigSaving] = useState(false)
  const [providerConfigForm, setProviderConfigForm] = useState({
    provider: 'openai' as ProviderKey,
    providerType: 'custom' as ProviderType,
    providerId: '',
    apiKey: '',
    baseUrl: '',
    clearApiKey: false,
  })

  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([])
  const [gateways, setGateways] = useState<GatewayItem[]>([])
  const [gatewayFilter, setGatewayFilter] = useState<GatewayFilter>('all')
  const [restartingRuntime, setRestartingRuntime] = useState(false)
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([])
  const [gatewayBatchLoading, setGatewayBatchLoading] = useState(false)
  const [showGatewayModal, setShowGatewayModal] = useState(false)
  const [savingGateway, setSavingGateway] = useState(false)
  const [testingGateway, setTestingGateway] = useState<string | null>(null)
  const [gatewayBindingsImportText, setGatewayBindingsImportText] = useState('')
  const [gatewayForm, setGatewayForm] = useState<GatewayForm>({
    id: undefined,
    instanceKey: '',
    provider: 'feishu',
    mode: 'long_connection',
    isDefault: false,
    displayName: '',
    agentId: 'semibot',
    isActive: false,
    verifyToken: '',
    clearVerifyToken: false,
    webhookUrl: '',
    sdkEnabled: false,
    appId: '',
    appSecret: '',
    clearAppSecret: false,
    receiveIdType: 'chat_id',
    defaultReceiveId: '',
    sdkDomain: 'feishu',
    botToken: '',
    clearBotToken: false,
    defaultChannelId: '',
    allowedChannelIds: '',
    allowedGuildIds: '',
    botUserId: '',
    webhookSecret: '',
    clearWebhookSecret: false,
    sessionName: '',
    linkedPhone: '',
    bridgeUrl: '',
    defaultHandle: '',
    botBindings: [],
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
  const [envVars, setEnvVars] = useState<EnvVarItem[]>([])
  const [envVarForm, setEnvVarForm] = useState({
    name: '',
    value: '',
    isSensitive: false,
    clearValue: false,
    editingName: '',
  })
  const [showEnvVarModal, setShowEnvVarModal] = useState(false)
  const [savingEnvVar, setSavingEnvVar] = useState(false)
  const [showCreateWebhook, setShowCreateWebhook] = useState(false)
  const [creatingWebhook, setCreatingWebhook] = useState(false)
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null)
  const [webhookForm, setWebhookForm] = useState({
    url: '',
    secret: '',
    eventsText: DEFAULT_EVENTS.join(','),
  })
  const [evolutionCapabilities, setEvolutionCapabilities] = useState<Record<EvolutionCapabilityType, EvolutionCapabilityDoc>>({
    hands: { id: '', capabilityType: 'hands', version: 'v0', content: '', updatedAt: '' },
    reflex: { id: '', capabilityType: 'reflex', version: 'v0', content: '', updatedAt: '' },
    spine: { id: '', capabilityType: 'spine', version: 'v0', content: '', updatedAt: '' },
    guard: { id: '', capabilityType: 'guard', version: 'v0', content: '', updatedAt: '' },
    mind: { id: '', capabilityType: 'mind', version: 'v0', content: '', updatedAt: '' },
  })
  const [evolutionCapabilityDrafts, setEvolutionCapabilityDrafts] = useState<Record<EvolutionCapabilityType, string>>({
    hands: '',
    reflex: '',
    spine: '',
    guard: '',
    mind: '',
  })
  const [evolutionCapabilityVersions, setEvolutionCapabilityVersions] = useState<Record<EvolutionCapabilityType, EvolutionCapabilityDoc[]>>({
    hands: [],
    reflex: [],
    spine: [],
    guard: [],
    mind: [],
  })
  const [evolutionHistoryExpanded, setEvolutionHistoryExpanded] = useState<Record<EvolutionCapabilityType, boolean>>({
    hands: false,
    reflex: false,
    spine: false,
    guard: false,
    mind: false,
  })
  const [evolutionSwitchVersion, setEvolutionSwitchVersion] = useState<Record<EvolutionCapabilityType, string>>({
    hands: '',
    reflex: '',
    spine: '',
    guard: '',
    mind: '',
  })
  const [savingEvolutionCapability, setSavingEvolutionCapability] = useState<EvolutionCapabilityType | null>(null)
  const [switchingEvolutionCapability, setSwitchingEvolutionCapability] = useState<EvolutionCapabilityType | null>(null)

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
      setModelRoleDefaults(normalizeModelRoles(configRes.data.modelRoles))
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

      void runtimeRes

      setSectionErrors((prev) => ({
        ...prev,
        tools:
          toolsRes.status === 'fulfilled' && toolsRes.value.success
            ? null
            : t('config.errors.toolsConfigLoad'),
      }))
    } catch (err) {
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

  const loadEnvVars = useCallback(async () => {
    setSectionLoadingFlag('envVars', true)
    try {
      const response = await apiClient.get<ApiResponse<EnvVarItem[]>>('/llm-providers/env-vars')
      if (!response.success) {
        throw new Error(tSafe('config.errors.envVarsLoad', '环境变量加载失败'))
      }
      setEnvVars(response.data || [])
      setSectionErrors((prev) => ({ ...prev, envVars: null }))
    } catch (err) {
      setEnvVars([])
      setSectionErrors((prev) => ({
        ...prev,
        envVars: getErrorMessage(err, tSafe('config.errors.envVarsLoad', '环境变量加载失败')),
      }))
    } finally {
      setSectionLoadingFlag('envVars', false)
    }
  }, [setSectionLoadingFlag, tSafe])

  const loadEvolutionCapabilities = useCallback(async () => {
    setSectionLoadingFlag('evolutionCapabilities', true)
    try {
      const response = await apiClient.get<ApiResponse<EvolutionCapabilityDoc[]>>('/evolution-capabilities')
      if (!response.success) {
        throw new Error(t('config.errors.evolutionCapabilitiesLoad'))
      }
      const docs = response.data || []
      const merged: Record<EvolutionCapabilityType, EvolutionCapabilityDoc> = {
        hands: { id: '', capabilityType: 'hands', version: 'v0', content: '', updatedAt: '' },
        reflex: { id: '', capabilityType: 'reflex', version: 'v0', content: '', updatedAt: '' },
        spine: { id: '', capabilityType: 'spine', version: 'v0', content: '', updatedAt: '' },
        guard: { id: '', capabilityType: 'guard', version: 'v0', content: '', updatedAt: '' },
        mind: { id: '', capabilityType: 'mind', version: 'v0', content: '', updatedAt: '' },
      }
      for (const doc of docs) {
        if (EVOLUTION_CAPABILITY_TYPES.includes(doc.capabilityType)) {
          merged[doc.capabilityType] = doc
        }
      }
      setEvolutionCapabilities(merged)
      setEvolutionCapabilityDrafts({
        hands: merged.hands.content || '',
        reflex: merged.reflex.content || '',
        spine: merged.spine.content || '',
        guard: merged.guard.content || '',
        mind: merged.mind.content || '',
      })
      setSectionErrors((prev) => ({ ...prev, evolutionCapabilities: null }))
    } catch (err) {
      setSectionErrors((prev) => ({
        ...prev,
        evolutionCapabilities: getErrorMessage(err, t('config.errors.evolutionCapabilitiesLoad')),
      }))
    } finally {
      setSectionLoadingFlag('evolutionCapabilities', false)
    }
  }, [setSectionLoadingFlag, t])

  const loadEvolutionCapabilityVersions = useCallback(async (docType: EvolutionCapabilityType) => {
    try {
      const response = await apiClient.get<ApiResponse<EvolutionCapabilityDoc[]>>(
        `/evolution-capabilities/${docType}/versions`,
        { params: { limit: 20 } }
      )
      if (!response.success) {
        throw new Error(t('config.errors.evolutionCapabilitiesLoad'))
      }
      const versions = response.data || []
      setEvolutionCapabilityVersions((prev) => ({ ...prev, [docType]: versions }))
      setEvolutionSwitchVersion((prev) => ({
        ...prev,
        [docType]: versions[0]?.version || '',
      }))
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.evolutionCapabilitiesLoad')))
    }
  }, [t])

  const openCreateEnvVarModal = useCallback(() => {
    setEnvVarForm({
      name: '',
      value: '',
      isSensitive: false,
      clearValue: false,
      editingName: '',
    })
    setShowEnvVarModal(true)
  }, [])

  const openEditEnvVarModal = useCallback((envVar: EnvVarItem) => {
    setEnvVarForm({
      name: envVar.name,
      value: '',
      isSensitive: envVar.isSensitive,
      clearValue: false,
      editingName: envVar.name,
    })
    setShowEnvVarModal(true)
  }, [])

  const closeEnvVarModal = useCallback(() => {
    setShowEnvVarModal(false)
  }, [])

  const saveEnvVar = useCallback(async () => {
    const isEditing = Boolean(envVarForm.editingName)
    const normalizedName = envVarForm.name.trim().toUpperCase()
    if (!isEditing && !normalizedName) {
      toast.error(tSafe('config.envVars.errors.nameRequired', '请输入变量名称'))
      return
    }
    setSavingEnvVar(true)
    try {
      const payload: Record<string, unknown> = {
        isSensitive: envVarForm.isSensitive,
      }
      if (envVarForm.clearValue) {
        payload.clear = true
      } else if (envVarForm.value !== '') {
        payload.value = envVarForm.value
      }
      const response = (isEditing
        ? await apiClient.put(`/llm-providers/env-vars/${envVarForm.editingName}`, payload)
        : await apiClient.post('/llm-providers/env-vars', {
            name: normalizedName,
            ...payload,
          })) as { success?: boolean }
      if (!response.success) {
        throw new Error(tSafe('config.envVars.errors.save', '环境变量保存失败'))
      }
      toast.success(tSafe('config.envVars.saved', '环境变量已保存'))
      setShowEnvVarModal(false)
      loadEnvVars()
    } catch (err) {
      toast.error(getErrorMessage(err, tSafe('config.envVars.errors.save', '环境变量保存失败')))
    } finally {
      setSavingEnvVar(false)
    }
  }, [envVarForm, loadEnvVars, tSafe])

  const deleteEnvVar = useCallback(
    async (name: string) => {
      if (!window.confirm(tSafe('config.envVars.confirmDelete', '确认删除环境变量 {name} 吗？', { name }))) {
        return
      }
      try {
        const response = (await apiClient.delete(`/llm-providers/env-vars/${name}`)) as { success?: boolean }
        if (!response.success) {
          throw new Error(tSafe('config.envVars.errors.delete', '环境变量删除失败'))
        }
        toast.success(tSafe('config.envVars.deleted', '环境变量已删除'))
        loadEnvVars()
      } catch (err) {
        toast.error(getErrorMessage(err, tSafe('config.envVars.errors.delete', '环境变量删除失败')))
      }
    },
    [loadEnvVars, tSafe]
  )

  const loadGateways = useCallback(async () => {
    setSectionLoadingFlag('channels', true)
    try {
      const response = await apiClient.get<ApiResponse<GatewayItem[]>>('/channels')
      if (!response.success) {
        throw new Error(t('config.errors.channelsLoad'))
      }
      setGateways(response.data || [])
      setSectionErrors((prev) => ({ ...prev, channels: null }))
    } catch (err) {
      setGateways([])
      setSectionErrors((prev) => ({
        ...prev,
        channels: getErrorMessage(err, t('config.errors.channelsLoad')),
      }))
    } finally {
      setSectionLoadingFlag('channels', false)
    }
  }, [setSectionLoadingFlag, t])

  const loadData = useCallback(async () => {
    setRefreshingAll(true)
    setError(null)
    await Promise.all([
      loadLlmData(),
      loadTools(),
      loadGateways(),
      loadApiKeys(),
      loadWebhooks(),
      loadEnvVars(),
      loadEvolutionCapabilities(),
    ])
    setLoading(false)
    setRefreshingAll(false)
  }, [loadApiKeys, loadEnvVars, loadEvolutionCapabilities, loadGateways, loadLlmData, loadTools, loadWebhooks])

  const restartRuntime = useCallback(async () => {
    if (restartingRuntime) return
    setRestartingRuntime(true)
    try {
      await apiClient.post('/runtime/restart', {})
      toast.success('运行时重启已触发', 'Runtime 会在后台重启，请等待片刻后再下发新任务。')
    } catch (error) {
      const message = error instanceof Error ? error.message : '重启请求失败'
      toast.error('运行时重启失败', message)
    } finally {
      setRestartingRuntime(false)
    }
  }, [restartingRuntime])

  useEffect(() => {
    loadData()
  }, [loadData])

  const saveModelConfig = async () => {
    try {
      setSavingModelDefaults(true)
      setError(null)
      await apiClient.put('/llm-providers/config', {
        modelRoles: modelRoleDefaults,
      })
      await loadLlmData()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.saveDefaultModel')))
    } finally {
      setSavingModelDefaults(false)
    }
  }

  const handleRoleModelDefaultChange = useCallback(
    (role: keyof ModelRolesConfig, patch: NodeModelConfig) => {
      setModelRoleDefaults((prev) => ({ ...prev, [role]: patch }))
    },
    []
  )

  const saveEvolutionCapability = async (docType: EvolutionCapabilityType) => {
    try {
      setSavingEvolutionCapability(docType)
      setError(null)
      await apiClient.put<ApiResponse<EvolutionCapabilityDoc>>(`/evolution-capabilities/${docType}`, {
        content: evolutionCapabilityDrafts[docType],
        changeNote: 'updated via evolution center',
      })
      await loadEvolutionCapabilities()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.evolutionCapabilitiesSave')))
    } finally {
      setSavingEvolutionCapability((current) => (current === docType ? null : current))
    }
  }

  const switchEvolutionCapabilityVersion = async (docType: EvolutionCapabilityType) => {
    const targetVersion = evolutionSwitchVersion[docType]?.trim()
    if (!targetVersion) return
    try {
      setSwitchingEvolutionCapability(docType)
      setError(null)
      await apiClient.post<ApiResponse<EvolutionCapabilityDoc>>(`/evolution-capabilities/${docType}/switch`, {
        targetVersion,
        reason: 'switch via evolution center',
      })
      await loadEvolutionCapabilities()
      await loadEvolutionCapabilityVersions(docType)
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.evolutionCapabilitiesSave')))
    } finally {
      setSwitchingEvolutionCapability((current) => (current === docType ? null : current))
    }
  }

  const openProviderConfigDialog = (provider: ProviderKey) => {
    const cfg = llmConfig?.providers[provider]
    const matched = provider.match(/^(openai|anthropic|google|kimi|qwen|minimax|xai|custom):(.+)$/)
    setProviderConfigForm({
      provider,
      providerType: (matched?.[1] as ProviderType | undefined) || 'custom',
      providerId: matched?.[2] || '',
      apiKey: '',
      baseUrl: cfg?.baseUrl || '',
      clearApiKey: false,
    })
    setShowProviderConfigModal(true)
  }

  const openCreateProviderInstanceDialog = () => {
    setProviderConfigForm({
      provider: 'new',
      providerType: 'custom',
      providerId: '',
      apiKey: '',
      baseUrl: '',
      clearApiKey: false,
    })
    setShowProviderConfigModal(true)
  }

  const saveProviderConfig = async () => {
    const isCreateProviderInstance = providerConfigForm.provider === 'new'
    const targetProvider =
      isCreateProviderInstance
        ? `${providerConfigForm.providerType}:${providerConfigForm.providerId.trim()}`
        : providerConfigForm.provider
    if (!targetProvider || targetProvider === 'new' || /^(openai|anthropic|google|kimi|qwen|minimax|xai|custom):\s*$/.test(targetProvider)) {
      setError(tSafe('config.errors.providerIdRequired', '请填写 Provider 实例 ID'))
      return
    }

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
          [targetProvider]: payloadProvider,
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
    const notifyEventTypes = Array.isArray(cfg.notifyEventTypes)
      ? (cfg.notifyEventTypes as unknown[]).map((item) => String(item)).join(',')
      : ''
    const botBindings = parseGatewayBotBindings(cfg.botBindings)
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
    const receiveIdTypeRaw = String(cfg.receiveIdType || 'chat_id').trim().toLowerCase()
    const receiveIdType: GatewayForm['receiveIdType'] =
      receiveIdTypeRaw === 'open_id' ||
      receiveIdTypeRaw === 'user_id' ||
      receiveIdTypeRaw === 'union_id' ||
      receiveIdTypeRaw === 'email'
        ? receiveIdTypeRaw
        : 'chat_id'
    setGatewayForm({
      id: gateway.id,
      instanceKey: gateway.instanceKey || '',
      provider: gateway.provider,
      mode:
        String(gateway.mode || '').trim().toLowerCase() === 'long_connection'
          ? 'long_connection'
          : String(gateway.mode || '').trim().toLowerCase() === 'gateway'
            ? 'gateway'
          : 'webhook',
      isDefault: gateway.isDefault === true,
      displayName: gateway.displayName || gateway.provider,
      agentId: String(cfg.agentId || cfg.defaultAgentId || 'semibot'),
      isActive: gateway.isActive,
      verifyToken: '',
      clearVerifyToken: false,
      webhookUrl: String(cfg.webhookUrl || ''),
      sdkEnabled: Boolean(cfg.sdkEnabled),
      appId: String(cfg.appId || ''),
      appSecret: '',
      clearAppSecret: false,
      receiveIdType,
      defaultReceiveId: String(cfg.defaultReceiveId || ''),
      sdkDomain: String(cfg.sdkDomain || 'feishu') === 'lark' ? 'lark' : 'feishu',
      botToken: '',
      clearBotToken: false,
      defaultChannelId: String(cfg.defaultChannelId || ''),
      allowedChannelIds: Array.isArray(cfg.allowedChannelIds) ? cfg.allowedChannelIds.map((v) => String(v)).join(',') : '',
      allowedGuildIds: Array.isArray(cfg.allowedGuildIds) ? cfg.allowedGuildIds.map((v) => String(v)).join(',') : '',
      botUserId: String(cfg.botUserId || ''),
      webhookSecret: '',
      clearWebhookSecret: false,
      sessionName: String(cfg.sessionName || ''),
      linkedPhone: String(cfg.linkedPhone || ''),
      bridgeUrl: String(cfg.bridgeUrl || ''),
      defaultHandle: String(cfg.defaultHandle || ''),
      botBindings,
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
    const defaultDisplayName =
      provider === 'telegram'
        ? 'Telegram'
        : provider === 'discord'
          ? 'Discord'
          : provider === 'whatsapp'
            ? 'WhatsApp'
            : provider === 'imessage'
              ? 'iMessage'
              : 'Feishu'
    const defaultAddressingMode: GatewayAddressingMode =
      provider === 'telegram' || provider === 'whatsapp' ? 'all_messages' : 'mention_only'
    setGatewayForm({
      id: undefined,
      instanceKey: '',
      provider,
      mode: provider === 'feishu' ? 'long_connection' : provider === 'telegram' ? 'webhook' : 'gateway',
      isDefault: false,
      displayName: defaultDisplayName,
      agentId: 'semibot',
      isActive: false,
      verifyToken: '',
      clearVerifyToken: false,
      webhookUrl: '',
      sdkEnabled: true,
      appId: '',
      appSecret: '',
      clearAppSecret: false,
      receiveIdType: 'chat_id',
      defaultReceiveId: '',
      sdkDomain: 'feishu',
      botToken: '',
      clearBotToken: false,
      defaultChannelId: '',
      allowedChannelIds: '',
      allowedGuildIds: '',
      botUserId: '',
      webhookSecret: '',
      clearWebhookSecret: false,
      sessionName: '',
      linkedPhone: '',
      bridgeUrl: '',
      defaultHandle: '',
      botBindings: [],
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
    const isFeishu = gatewayForm.provider === 'feishu'
    const isDiscord = gatewayForm.provider === 'discord'
    const isWhatsApp = gatewayForm.provider === 'whatsapp'
    const isIMessage = gatewayForm.provider === 'imessage'
    if (isFeishu && gatewayForm.mode === 'long_connection' && !gatewayForm.sdkEnabled) {
      setError(tSafe('config.errors.feishuLongConnectionRequiresSdk', '长连接模式需要启用 Feishu SDK'))
      return
    }
    if (isFeishu && gatewayForm.sdkEnabled) {
      if (!gatewayForm.appId.trim()) {
        setError(tSafe('config.errors.feishuAppIdRequired', '启用 Feishu SDK 时必须填写 App ID'))
        return
      }
      if (!gatewayForm.appSecret.trim() && !gatewayForm.id) {
        setError(tSafe('config.errors.feishuAppSecretRequired', '启用 Feishu SDK 时必须填写 App Secret'))
        return
      }
      if (!gatewayForm.defaultReceiveId.trim()) {
        setError(tSafe('config.errors.feishuDefaultReceiveIdRequired', '启用 Feishu SDK 时建议填写默认接收 ID'))
        return
      }
    }
    const normalizedAgentId = gatewayForm.agentId.trim()
    const botBindingInput = gatewayForm.botBindings.map((row) => ({
      botId: row.botId.trim(),
      agentId: row.agentId.trim(),
    }))
    const normalizedBindingsResult = normalizeGatewayBotBindings(botBindingInput)
    if (normalizedBindingsResult.partialCount > 0) {
      setError(t('config.errors.gatewayBindingsPartial', { count: normalizedBindingsResult.partialCount }))
      return
    }
    if (
      normalizedBindingsResult.duplicateBotIds.length > 0 &&
      !window.confirm(
        t('config.confirm.gatewayBindingsDuplicate', {
          count: normalizedBindingsResult.duplicateBotIds.length,
        })
      )
    ) {
      return
    }
    const payload: Record<string, unknown> = {
      displayName: gatewayForm.displayName.trim() || gatewayForm.provider,
      isDefault: gatewayForm.isDefault,
      isActive: gatewayForm.isActive,
      mode: gatewayForm.mode,
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
              botBindings: normalizedBindingsResult.normalized,
              notifyEventTypes: parseCommaList(gatewayForm.notifyEventTypes),
            }
          : isDiscord
            ? {
                ...(gatewayForm.botToken.trim() && !gatewayForm.clearBotToken
                  ? { botToken: gatewayForm.botToken.trim() }
                  : {}),
                ...(gatewayForm.defaultChannelId.trim() ? { defaultChannelId: gatewayForm.defaultChannelId.trim() } : {}),
                allowedChannelIds: parseCommaList(gatewayForm.allowedChannelIds),
                allowedGuildIds: parseCommaList(gatewayForm.allowedGuildIds),
                ...(gatewayForm.botUserId.trim() ? { botUserId: gatewayForm.botUserId.trim() } : {}),
                botBindings: normalizedBindingsResult.normalized,
                notifyEventTypes: parseCommaList(gatewayForm.notifyEventTypes),
              }
            : isWhatsApp
              ? {
                  ...(gatewayForm.sessionName.trim() ? { sessionName: gatewayForm.sessionName.trim() } : {}),
                  ...(gatewayForm.linkedPhone.trim() ? { linkedPhone: gatewayForm.linkedPhone.trim() } : {}),
                  botBindings: normalizedBindingsResult.normalized,
                  notifyEventTypes: parseCommaList(gatewayForm.notifyEventTypes),
                }
              : isIMessage
                ? {
                    ...(gatewayForm.bridgeUrl.trim() ? { bridgeUrl: gatewayForm.bridgeUrl.trim() } : {}),
                    ...(gatewayForm.defaultHandle.trim() ? { defaultHandle: gatewayForm.defaultHandle.trim() } : {}),
                    botBindings: normalizedBindingsResult.normalized,
                    notifyEventTypes: parseCommaList(gatewayForm.notifyEventTypes),
                  }
          : {
              ...(gatewayForm.verifyToken.trim() && !gatewayForm.clearVerifyToken
                ? { verifyToken: gatewayForm.verifyToken.trim() }
                : {}),
              ...(gatewayForm.webhookUrl.trim() ? { webhookUrl: gatewayForm.webhookUrl.trim() } : {}),
              sdkEnabled: gatewayForm.sdkEnabled,
              ...(gatewayForm.appId.trim() ? { appId: gatewayForm.appId.trim() } : {}),
              ...(gatewayForm.appSecret.trim() && !gatewayForm.clearAppSecret
                ? { appSecret: gatewayForm.appSecret.trim() }
                : {}),
              receiveIdType: gatewayForm.receiveIdType,
              ...(gatewayForm.defaultReceiveId.trim() ? { defaultReceiveId: gatewayForm.defaultReceiveId.trim() } : {}),
              sdkDomain: gatewayForm.sdkDomain,
              botBindings: normalizedBindingsResult.normalized,
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
    if (isFeishu && gatewayForm.clearVerifyToken) clearFields.push('verifyToken')
    if (isFeishu && gatewayForm.clearAppSecret) clearFields.push('appSecret')
    if ((isTelegram || isDiscord) && gatewayForm.clearBotToken) clearFields.push('botToken')
    if (isTelegram && gatewayForm.clearWebhookSecret) clearFields.push('webhookSecret')
    if (clearFields.length > 0) {
      payload.clearFields = clearFields
    }

    try {
      setSavingGateway(true)
      setError(null)
      if (gatewayForm.id) {
        await apiClient.post('/control/channels/update', {
          payload: {
            instance_id: gatewayForm.id,
            patch: payload,
          },
        })
      } else {
        await apiClient.post('/control/channels/create', {
          payload: {
            provider: gatewayForm.provider,
            instanceKey: gatewayForm.instanceKey.trim() || undefined,
            ...payload,
          },
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

  const addGatewayBotBinding = useCallback(() => {
    setGatewayForm((prev) => ({
      ...prev,
      botBindings: [...prev.botBindings, { botId: '', agentId: prev.agentId.trim() || 'semibot' }],
    }))
  }, [])

  const updateGatewayBotBinding = useCallback((index: number, key: 'botId' | 'agentId', value: string) => {
    setGatewayForm((prev) => ({
      ...prev,
      botBindings: prev.botBindings.map((row, idx) => (idx === index ? { ...row, [key]: value } : row)),
    }))
  }, [])

  const removeGatewayBotBinding = useCallback((index: number) => {
    setGatewayForm((prev) => ({
      ...prev,
      botBindings: prev.botBindings.filter((_, idx) => idx !== index),
    }))
  }, [])





  const applyGatewayBindingsImport = useCallback(() => {
    const parsed = parseGatewayBotBindingImportText(
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
      botBindings: [...prev.botBindings, ...parsed.rows],
    }))
    setGatewayBindingsImportText('')
  }, [gatewayBindingsImportText, gatewayForm.agentId, t])

  const testGateway = async (gateway: GatewayItem) => {
    try {
      setTestingGateway(gateway.id)
      setError(null)
      const isTelegram = gateway.provider === 'telegram'
      const isDiscord = gateway.provider === 'discord'
      const payload = isTelegram
        ? { text: 'Semibot 通道连通性测试' }
        : isDiscord
          ? { text: 'Semibot 通道连通性测试' }
          : { title: 'Semibot 通道连通性测试', content: '这是一次通道连通性测试消息。' }
      await apiClient.post(`/channels/${gateway.id}/test`, payload)
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
      await apiClient.post('/control/channels/delete', {
        payload: {
          instance_id: gateway.id,
        },
      })
      await loadGateways()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.deleteGateway')))
    }
  }

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
        setError(t('config.channels.batchSelectHint'))
        return
      }

      let targets = selectedGatewayItems
      if (action === 'delete') {
        targets = selectedGatewayItems.filter((item) => !item.isDefault)
        if (targets.length === 0) {
          setError(t('config.channels.batchNoDeletable'))
          return
        }
        if (!window.confirm(t('config.confirm.deleteGateways', { count: targets.length }))) {
          return
        }
      }

      try {
        setGatewayBatchLoading(true)
        setError(null)
        const settled = await Promise.allSettled(
          targets.map((item) =>
            apiClient.post(`/control/channels/${action}`, {
              payload: { instance_id: item.id },
            })
          )
        )
        const changed = settled.filter((item) => item.status === 'fulfilled').length
        const failed = settled.length - changed
        if (failed > 0) {
          setError(
            t('config.channels.batchPartialFailed', {
              success: changed,
              failed,
            })
          )
        }
        if (action === 'delete') {
          const deletedIds = new Set(
            targets
              .filter((_, idx) => settled[idx]?.status === 'fulfilled')
              .map((item) => item.id)
          )
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
      setError(t('config.channels.batchSelectHint'))
      return
    }
    try {
      setGatewayBatchLoading(true)
      setError(null)
      const settled = await Promise.allSettled(
        selectedGatewayItems.map((item) => {
          const payload =
            item.provider === 'telegram'
              ? { text: 'Semibot 通道连通性测试' }
              : { title: 'Semibot 通道连通性测试', content: '这是一次通道连通性测试消息。' }
          return apiClient.post(`/channels/${item.id}/test`, payload)
        })
      )
      const failed = settled.filter((result) => result.status === 'rejected').length
      if (failed > 0) {
        setError(
          t('config.channels.batchTestPartialFailed', {
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

  const llmStatusMap = useMemo(() => {
    const map = new Map<string, LlmProviderStatus>()
    llmProviders.forEach((item) => map.set(item.name, item))
    return map
  }, [llmProviders])

  const visibleProviderEntries = useMemo(() => {
    const entries = Object.entries(llmConfig?.providers || {}) as Array<[ProviderKey, LlmProviderConfigEntry]>
    // V2 policy: provider list only shows user-created provider instances (type:id).
    // Built-in preset keys (openai/anthropic/google/...) are hidden until an instance is created.
    // Backward compatibility: keep legacy `custom` entry visible when it was already configured.
    return entries.filter(([providerKey, cfg]) => providerKey.includes(':') || (providerKey === 'custom' && cfg.apiKeyConfigured))
  }, [llmConfig])

  const availableModelOptions = useMemo<(SelectOption | SelectGroup)[]>(() => {
    const grouped = llmProviders
      .map((provider) => {
        const models = Array.from(new Set((provider.models || []).filter(Boolean))).sort((a, b) => a.localeCompare(b))
        if (models.length === 0) return null
        const providerName = provider.displayName?.trim() || provider.name
        const providerKey = provider.name?.trim() || provider.displayName?.trim() || 'provider'
        const label = providerName === providerKey ? providerName : `${providerName} (${providerKey})`
        return {
          label,
          options: models.map((model) => ({ value: encodeModelBinding(providerKey, model), label: model })),
        } satisfies SelectGroup
      })
      .filter((item): item is SelectGroup => Boolean(item))

    grouped.sort((a, b) => a.label.localeCompare(b.label))
    return grouped
  }, [llmProviders])

  const availableModelValueSet = useMemo(() => {
    const values = new Set<string>()
    for (const item of availableModelOptions) {
      if ('options' in item) {
        for (const option of item.options) values.add(option.value)
      } else {
        values.add(item.value)
      }
    }
    return values
  }, [availableModelOptions])

  const activeGatewaysCount = useMemo(
    () => filteredGateways.filter((item) => item.isActive).length,
    [filteredGateways]
  )
  const selectedGatewayCount = useMemo(() => selectedGatewayItems.length, [selectedGatewayItems])

  const tabs = useMemo(
    () => [
      {
        id: 'llm' as const,
        label: tSafe('config.tabs.llm', 'LLM'),
        count: visibleProviderEntries.length,
      },
      { id: 'channels' as const, label: tSafe('config.tabs.channels', 'Channels'), count: gateways.length },
      { id: 'apiKeys' as const, label: tSafe('config.tabs.apiKeys', 'API Keys'), count: apiKeys.length },
      { id: 'webhooks' as const, label: tSafe('config.tabs.webhooks', 'Webhooks'), count: webhooks.length },
      { id: 'envVars' as const, label: tSafe('config.tabs.envVars', '环境变量'), count: envVars.length },
      { id: 'evolutionCapabilities' as const, label: evolutionUiText.tab, count: 5 },
    ],
    [
      apiKeys.length,
      evolutionUiText.tab,
      envVars.length,
      gateways.length,
      tSafe,
      visibleProviderEntries.length,
      webhooks.length,
    ]
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
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={loadData}
              leftIcon={<Loader2 size={16} className={refreshingAll || isAnySectionLoading ? 'animate-spin' : ''} />}
            >
              {t('common.refresh')}
            </Button>
            <Button
              variant="secondary"
              onClick={restartRuntime}
              disabled={restartingRuntime}
              leftIcon={<RefreshCw size={16} className={restartingRuntime ? 'animate-spin' : ''} />}
            >
              {restartingRuntime ? tSafe('config.runtime.restart.running', '重启中…') : tSafe('config.runtime.restart.label', '重启runtime')}
            </Button>
          </div>
        </div>

        {error && (
          <InlineErrorAlert message={error} />
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
                    <p className="text-sm text-text-secondary">
                      {tSafe('agentsDetail.modelRolesDescription', '为 Plan、Act、Text Processing 分别指定模型和 temperature，留空则继承系统默认行为')}
                    </p>
                    <div className="space-y-5">
                      <ConfigRoleModelRow
                        role="plan"
                        label={tSafe('agentsDetail.modelRolesPlan', 'Plan 节点')}
                        config={modelRoleDefaults.plan ?? {}}
                        options={availableModelOptions}
                        availableModelValueSet={availableModelValueSet}
                        onChange={handleRoleModelDefaultChange}
                        tSafe={tSafe}
                      />
                      <ConfigRoleModelRow
                        role="act"
                        label={tSafe('agentsDetail.modelRolesAct', 'Act / Respond 节点')}
                        config={modelRoleDefaults.act ?? {}}
                        options={availableModelOptions}
                        availableModelValueSet={availableModelValueSet}
                        onChange={handleRoleModelDefaultChange}
                        tSafe={tSafe}
                      />
                      <ConfigRoleModelRow
                        role="textProcessing"
                        label={tSafe('agentsDetail.modelRolesTextProcessing', 'Text Processing 工具')}
                        config={modelRoleDefaults.textProcessing ?? {}}
                        options={availableModelOptions}
                        availableModelValueSet={availableModelValueSet}
                        onChange={handleRoleModelDefaultChange}
                        tSafe={tSafe}
                      />
                    </div>
                    <Button
                      data-testid="llm-save-routing-button"
                      onClick={saveModelConfig}
                      loading={savingModelDefaults}
                    >
                      {t('config.llm.saveRouting')}
                    </Button>
                  </CardContent>
                </Card>

                <Card className="border-border-default">
                  <CardContent className="p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-lg font-semibold text-text-primary">{t('config.llm.providerConfig')}</h2>
                      <Button size="xs" variant="tertiary" leftIcon={<Plus size={12} />} onClick={openCreateProviderInstanceDialog}>
                        {tSafe('config.llm.addProviderInstance', '新增 Provider 实例')}
                      </Button>
                    </div>
                    {visibleProviderEntries.map(([providerKey, cfg]) => {
                      const status = llmStatusMap.get(providerKey)
                      if (!cfg) return null
                      const providerId = providerKey.includes(':') ? providerKey.split(':').slice(1).join(':') : ''

                      return (
                        <div
                          key={providerKey}
                          className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-text-primary">
                              {cfg.displayName || status?.displayName || providerKey}
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
                            {tSafe('config.llm.apiKeyLabel', 'API Key')}:{' '}
                            {cfg.apiKeyConfigured ? (cfg.apiKeyPreview || t('config.status.configured')) : t('config.status.notConfigured')}
                          </p>
                          {providerId ? (
                            <p className="mt-1 text-xs text-text-tertiary">
                              {tSafe('config.llm.providerIdLabel', 'Provider ID')}: {providerId}
                            </p>
                          ) : null}
                          <p className="mt-1 truncate text-xs text-text-tertiary">
                            {tSafe('config.llm.endpointLabel', 'Endpoint')}: {cfg.baseUrl || t('config.common.notSet')}
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
                    {visibleProviderEntries.length === 0 && (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {tSafe('config.llm.noConfiguredProviders', '暂无 Provider 实例，请先新增 Provider 实例。')}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}




            {activeTab === 'channels' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <MessageSquare size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">{t('config.channels.title')}</h2>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-tertiary">
                        {t('config.channels.activeCount', { count: activeGatewaysCount })}
                      </span>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<Plus size={13} />}
                        onClick={() => openCreateGatewayDialog('telegram')}
                      >
                        {t('config.channels.newTelegram')}
                      </Button>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<Plus size={13} />}
                        onClick={() => openCreateGatewayDialog('feishu')}
                      >
                        {t('config.channels.newFeishu')}
                      </Button>
                      <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCw size={13} className={sectionLoading.channels ? 'animate-spin' : ''} />}
                        onClick={loadGateways}
                        disabled={gatewayBatchLoading}
                      >
                        {t('common.refresh')}
                      </Button>
                    </div>
                  </div>
                  {sectionErrors.channels && (
                    <p className="text-xs text-warning-500">{sectionErrors.channels}</p>
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
                      {t('config.channels.filterAll')}
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
                      {t('config.channels.filterTelegram')}
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
                      {t('config.channels.filterFeishu')}
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
                      {t('config.channels.selectAllVisible')}
                    </label>
                  )}
                  {selectedGatewayCount > 0 && (
                    <div className="rounded-md border border-primary-500/30 bg-primary-500/10 px-3 py-2 flex flex-wrap items-center gap-2">
                      <span className="text-sm text-text-primary">
                        {t('config.channels.selectedCount', { count: selectedGatewayCount })}
                      </span>
                      <Button
                        data-testid="gateways-batch-enable"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchAction('enable')}
                      >
                        {t('config.channels.batchEnable')}
                      </Button>
                      <Button
                        data-testid="gateways-batch-disable"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchAction('disable')}
                      >
                        {t('config.channels.batchDisable')}
                      </Button>
                      <Button
                        data-testid="gateways-batch-test"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchTest()}
                      >
                        {t('config.channels.batchTest')}
                      </Button>
                      <Button
                        data-testid="gateways-batch-delete"
                        size="xs"
                        variant="tertiary"
                        disabled={gatewayBatchLoading}
                        onClick={() => void runGatewayBatchAction('delete')}
                      >
                        {t('config.channels.batchDelete')}
                      </Button>
                    </div>
                  )}
                  <div className="space-y-2">
                    {sectionLoading.channels && gateways.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.channels.loading')}
                      </p>
                    ) : filteredGateways.length === 0 ? (
                      <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3 text-sm text-text-secondary">
                        {t('config.channels.empty')}
                      </p>
                    ) : (
                      filteredGateways.map((item) => {
                        const itemBindings = parseGatewayBotBindings(item.config?.botBindings)
                        const defaultAgentId = String(item.config?.agentId || item.config?.defaultAgentId || 'semibot')
                        const previewBindings = itemBindings.slice(0, 3)
                        const previewText = previewBindings.map((row) => `${row.botId}→${row.agentId}`).join(' · ')
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
                                    {item.instanceKey ? ` · ${item.instanceKey}` : ''} · {tSafe('config.common.status', '状态')}: {item.status} ·{' '}
                                    {t('config.channels.agent')}: {defaultAgentId} · {t('config.channels.updatedAt')}:{' '}
                                    {formatDate(item.updatedAt, locale, t)}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {item.isDefault && <Badge variant="outline">{t('config.channels.defaultTag')}</Badge>}
                                <Badge variant={item.isActive ? 'success' : 'outline'}>
                                  {item.isActive ? t('config.status.enabled') : t('config.status.disabled')}
                                </Badge>
                                <Button
                                  size="xs"
                                  variant="tertiary"
                                  leftIcon={<Pencil size={12} />}
                                  onClick={() => openGatewayDialog(item)}
                                  disabled={gatewayBatchLoading}
                                >
                                  {t('common.edit')}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="tertiary"
                                  onClick={() => testGateway(item)}
                                  disabled={testingGateway === item.id || gatewayBatchLoading}
                                >
                                  {t('config.channels.test')}
                                </Button>
                                {!item.isDefault && (
                                  <Button
                                    size="xs"
                                    variant="tertiary"
                                    leftIcon={<Trash2 size={12} />}
                                    onClick={() => removeGateway(item)}
                                    disabled={gatewayBatchLoading}
                                  >
                                    {t('common.delete')}
                                  </Button>
                                )}
                              </div>
                            </div>

                            <div className="mt-3 rounded-md border border-border-subtle px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs text-text-secondary">
                                  {t('config.channels.botBindingsSummary', { count: itemBindings.length })}
                                </p>
                                <p className="text-xs text-text-tertiary">
                                  {t('config.channels.agent')}: {defaultAgentId}
                                </p>
                              </div>
                              <p className="mt-1 text-xs text-text-tertiary">
                                {itemBindings.length > 0 ? (
                                  <>
                                    {previewText}
                                    {hasMorePreview ? ` · ${t('config.channels.botBindingsMore', { count: itemBindings.length - previewBindings.length })}` : ''}
                                  </>
                                ) : (
                                  t('config.channels.botBindingsNone')
                                )}
                              </p>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeTab === 'evolutionCapabilities' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileText size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">
                        {evolutionUiText.title}
                      </h2>
                    </div>
                    <Button
                      size="xs"
                      variant="tertiary"
                      leftIcon={<RefreshCw size={13} className={sectionLoading.evolutionCapabilities ? 'animate-spin' : ''} />}
                      onClick={loadEvolutionCapabilities}
                    >
                      {t('common.refresh')}
                    </Button>
                  </div>
                  <p className="text-sm text-text-secondary">
                    {evolutionUiText.description}
                  </p>
                  {sectionErrors.evolutionCapabilities && (
                    <p className="text-xs text-warning-500">{sectionErrors.evolutionCapabilities}</p>
                  )}
                  {EVOLUTION_CAPABILITY_TYPES.map((docType) => (
                    <div
                      key={docType}
                      className="space-y-2 rounded-lg border border-border-subtle bg-bg-surface p-4"
                      data-testid={`evolution-capability-card-${docType}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-text-primary">
                            {docType === 'hands'
                              ? evolutionUiText.hands
                              : docType === 'reflex'
                                ? evolutionUiText.reflex
                                : docType === 'spine'
                                  ? evolutionUiText.spine
                                  : docType === 'guard'
                                    ? evolutionUiText.guard
                                    : evolutionUiText.mind}
                          </p>
                          <p className="text-xs text-text-tertiary">
                            {evolutionUiText.version}: {evolutionCapabilities[docType].version || 'v0'} · {evolutionUiText.updatedAt}:{' '}
                            {formatDate(evolutionCapabilities[docType].updatedAt, locale, t)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="xs"
                            variant="tertiary"
                            data-testid={`evolution-capability-history-${docType}`}
                            onClick={async () => {
                              const nextExpanded = !evolutionHistoryExpanded[docType]
                              setEvolutionHistoryExpanded((prev) => ({ ...prev, [docType]: nextExpanded }))
                              if (nextExpanded) {
                                await loadEvolutionCapabilityVersions(docType)
                              }
                            }}
                          >
                            {evolutionUiText.history}
                          </Button>
                          <Button
                            size="sm"
                            data-testid={`evolution-capability-save-${docType}`}
                            onClick={() => void saveEvolutionCapability(docType)}
                            loading={savingEvolutionCapability === docType}
                          >
                            {t('common.save')}
                          </Button>
                        </div>
                      </div>
                      <textarea
                        data-testid={`evolution-capability-textarea-${docType}`}
                        className="min-h-[300px] w-full resize-y rounded-lg border border-border-default bg-bg-surface px-4 py-3 text-sm leading-6 text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-primary-400 focus:ring-2 focus:ring-primary-400/30"
                        placeholder={evolutionUiText.placeholder}
                        value={evolutionCapabilityDrafts[docType]}
                        onChange={(e) =>
                          setEvolutionCapabilityDrafts((prev) => ({ ...prev, [docType]: e.target.value }))
                        }
                      />
                      <p className="text-[11px] text-text-tertiary">
                        {tSafe('config.evolutionCapabilities.contentLabel', '能力内容')}
                      </p>
                      {evolutionHistoryExpanded[docType] && (
                        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-default bg-bg-surface px-3 py-2">
                          <span className="text-xs text-text-secondary">
                            {evolutionUiText.rollbackTo}
                          </span>
                          <select
                            className="rounded-md border border-border-default bg-bg-surface px-2 py-1 text-xs text-text-primary"
                            value={evolutionSwitchVersion[docType]}
                            onChange={(e) =>
                              setEvolutionSwitchVersion((prev) => ({ ...prev, [docType]: e.target.value }))
                            }
                          >
                            {evolutionCapabilityVersions[docType].map((doc) => (
                              <option key={`${docType}-${doc.version}`} value={doc.version}>
                                {doc.version} · {formatDate(doc.updatedAt, locale, t)}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="xs"
                            variant="tertiary"
                            data-testid={`evolution-capability-rollback-${docType}`}
                            onClick={() => void switchEvolutionCapabilityVersion(docType)}
                            loading={switchingEvolutionCapability === docType}
                            disabled={!evolutionSwitchVersion[docType]}
                          >
                            {evolutionUiText.rollback}
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {activeTab === 'apiKeys' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <KeyRound size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">{tSafe('config.apiKeys.title', 'API Keys')}</h2>
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
                      <h2 className="text-lg font-semibold text-text-primary">{tSafe('config.webhooks.title', 'Webhooks')}</h2>
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

            {activeTab === 'envVars' && (
              <Card className="border-border-default">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <KeyRound size={18} className="text-primary-400" />
                      <h2 className="text-lg font-semibold text-text-primary">
                        {tSafe('config.envVars.title', '环境变量')}
                      </h2>
                    </div>
                    <Button size="xs" variant="tertiary" onClick={openCreateEnvVarModal}>
                      {tSafe('config.envVars.add', '新增环境变量')}
                    </Button>
                  </div>
                  <p className="text-sm text-text-secondary">
                    {tSafe(
                      'config.envVars.description',
                      '展示 .env.local 中的环境变量，敏感字段会以 {redacted} 脱敏，请谨慎修改。',
                      { redacted: '__SEMIBOT_REDACTED__' }
                    )}
                  </p>
                  {sectionErrors.envVars && (
                    <p className="text-xs text-warning-500">{sectionErrors.envVars}</p>
                  )}
                  {sectionLoading.envVars ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 size={20} className="animate-spin text-primary-500" />
                    </div>
                  ) : envVars.length === 0 ? (
                    <p className="text-sm text-text-secondary">
                      {tSafe('config.envVars.empty', '暂无环境变量，点击新增以创建。')}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {envVars.map((item) => (
                        <div
                          key={item.name}
                          className="rounded-lg border border-border-subtle bg-bg-surface px-4 py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="truncate text-sm font-medium text-text-primary">{item.name}</p>
                                <Badge variant={item.isSensitive ? 'error' : 'outline'}>
                                  {item.isSensitive
                                    ? tSafe('config.envVars.sensitive', '敏感字段')
                                    : tSafe('config.envVars.regular', '普通字段')}
                                </Badge>
                                <Badge variant={item.hasValue ? 'success' : 'outline'}>
                                  {item.hasValue
                                    ? tSafe('config.envVars.hasValue', '已配置')
                                    : tSafe('config.envVars.noValue', '未配置')}
                                </Badge>
                              </div>
                              <p className="mt-2 text-xs text-text-tertiary break-words">
                                {item.value || t('config.common.notSet')}
                              </p>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              <Button size="xs" variant="tertiary" onClick={() => openEditEnvVarModal(item)}>
                                {t('common.edit')}
                              </Button>
                              <Button size="xs" variant="destructive" onClick={() => deleteEnvVar(item.name)}>
                                {t('common.delete')}
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
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
        description={providerConfigForm.provider === 'new' ? `${providerConfigForm.providerType}:<provider-id>` : providerConfigForm.provider}
        maxWidth="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowProviderConfigModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="provider-save-button"
              onClick={saveProviderConfig}
              loading={providerConfigSaving}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {providerConfigForm.provider === 'new' && (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">
                  {tSafe('config.modals.provider.providerTypeLabel', 'Provider 类型')}
                </p>
                <Select
                  data-testid="provider-type-select"
                  value={providerConfigForm.providerType}
                  onChange={(value) =>
                    setProviderConfigForm((prev) => ({ ...prev, providerType: value as ProviderType }))
                  }
                  options={PROVIDER_TYPE_OPTIONS}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">
                  {tSafe('config.modals.provider.customIdLabel', 'Provider 实例 ID')}
                </p>
                <Input
                  data-testid="provider-custom-id-input"
                  placeholder={tSafe('config.modals.provider.customIdPlaceholder', 'Provider 实例 ID（示例: primary）')}
                  value={providerConfigForm.providerId}
                  onChange={(e) => setProviderConfigForm((prev) => ({ ...prev, providerId: e.target.value }))}
                />
                <p className="text-xs text-text-secondary">
                  {tSafe('config.modals.provider.customIdHelp', '用于生成键名 <type>:<provider-id>，建议使用小写字母、数字与连字符。')}
                </p>
              </div>
            </>
          )}
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">
              {tSafe('config.modals.provider.apiKeyLabel', 'API Key')}
            </p>
            <Input
              data-testid="provider-api-key-input"
              type="password"
              placeholder={t('config.modals.provider.apiKeyPlaceholder')}
              value={providerConfigForm.apiKey}
              onChange={(e) => setProviderConfigForm((prev) => ({ ...prev, apiKey: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">
              {tSafe('config.modals.provider.endpointLabel', 'Endpoint / Base URL')}
            </p>
            <Input
              data-testid="provider-endpoint-input"
              placeholder={t('config.modals.tool.apiEndpointPlaceholder')}
              value={providerConfigForm.baseUrl}
              onChange={(e) => setProviderConfigForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
            />
          </div>
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
        open={showGatewayModal}
        onClose={() => setShowGatewayModal(false)}
        title={t('config.modals.gateway.title')}
        description={gatewayForm.provider}
        maxWidth="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowGatewayModal(false)} disabled={savingGateway}>
              {t('common.cancel')}
            </Button>
            <Button data-testid="gateway-save-button" onClick={saveGatewayConfig} loading={savingGateway}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {!gatewayForm.id && (
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.instanceKeyLabel', 'instanceKey')}</p>
              <Input
                placeholder={t('config.modals.gateway.instanceKeyPlaceholder')}
                value={gatewayForm.instanceKey}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, instanceKey: e.target.value }))}
              />
            </div>
          )}
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.displayNameLabel', 'displayName')}</p>
            <Input
              data-testid="gateway-display-name-input"
              placeholder={t('config.modals.gateway.displayNamePlaceholder')}
              value={gatewayForm.displayName}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, displayName: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.agentIdLabel', 'agentId')}</p>
            <Input
              data-testid="gateway-agent-id-input"
              placeholder={t('config.modals.gateway.agentIdPlaceholder')}
              value={gatewayForm.agentId}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, agentId: e.target.value }))}
            />
          </div>
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
          {gatewayForm.provider === 'feishu' ? (
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">
                {tSafe('config.modals.gateway.feishu.modeLabel', '接入模式')}
              </p>
              <select
                className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                value={gatewayForm.mode}
                onChange={(e) =>
                  setGatewayForm((prev) => ({
                    ...prev,
                    mode: e.target.value === 'webhook' ? 'webhook' : 'long_connection',
                  }))
                }
              >
                <option value="long_connection">
                  {tSafe('config.modals.gateway.feishu.modeLongConnection', '长连接（推荐）')}
                </option>
                <option value="webhook">{tSafe('config.modals.gateway.feishu.modeWebhook', 'Webhook')}</option>
              </select>
            </div>
          ) : null}
          {gatewayForm.provider === 'telegram' ? (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.telegram.botTokenLabel', 'botToken')}</p>
                <Input
                  data-testid="gateway-telegram-bot-token-input"
                  type="password"
                  placeholder={t('config.modals.gateway.telegram.botTokenPlaceholder')}
                  value={gatewayForm.botToken}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, botToken: e.target.value }))}
                />
              </div>
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
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.telegram.webhookSecretLabel', 'webhookSecret')}</p>
                <Input
                  type="password"
                  placeholder={t('config.modals.gateway.telegram.webhookSecretPlaceholder')}
                  value={gatewayForm.webhookSecret}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, webhookSecret: e.target.value }))}
                />
              </div>
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
            </>
          ) : gatewayForm.provider === 'discord' ? (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">接入模式</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={gatewayForm.mode}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, mode: e.target.value === 'webhook' ? 'webhook' : 'gateway' }))}
                >
                  <option value="gateway">Gateway（推荐）</option>
                  <option value="webhook">Webhook（预留）</option>
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">Bot Token</p>
                <Input
                  type="password"
                  placeholder="Discord Bot Token"
                  value={gatewayForm.botToken}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, botToken: e.target.value }))}
                />
              </div>
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
                {tSafe('config.modals.gateway.telegram.clearBotToken', '清空已有 Bot Token')}
              </label>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">defaultChannelId</p>
                <Input
                  placeholder="默认 Channel ID"
                  value={gatewayForm.defaultChannelId}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, defaultChannelId: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">allowedChannelIds</p>
                <Input
                  placeholder="可选，逗号分隔"
                  value={gatewayForm.allowedChannelIds}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, allowedChannelIds: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">allowedGuildIds</p>
                <Input
                  placeholder="可选，逗号分隔"
                  value={gatewayForm.allowedGuildIds}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, allowedGuildIds: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">botUserId</p>
                <Input
                  placeholder="Bot User ID"
                  value={gatewayForm.botUserId}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, botUserId: e.target.value }))}
                />
              </div>
            </>
          ) : gatewayForm.provider === 'whatsapp' ? (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">接入模式</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={gatewayForm.mode}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, mode: e.target.value === 'webhook' ? 'webhook' : 'gateway' }))}
                >
                  <option value="gateway">Gateway / Baileys</option>
                  <option value="webhook">Webhook（预留）</option>
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">sessionName</p>
                <Input
                  placeholder="Baileys session name"
                  value={gatewayForm.sessionName}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, sessionName: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">linkedPhone</p>
                <Input
                  placeholder="已配对手机号（可选）"
                  value={gatewayForm.linkedPhone}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, linkedPhone: e.target.value }))}
                />
              </div>
            </>
          ) : gatewayForm.provider === 'imessage' ? (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">接入模式</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={gatewayForm.mode}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, mode: e.target.value === 'webhook' ? 'webhook' : 'gateway' }))}
                >
                  <option value="gateway">Gateway / BlueBubbles</option>
                  <option value="webhook">Webhook（预留）</option>
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">bridgeUrl</p>
                <Input
                  placeholder="BlueBubbles / bridge URL"
                  value={gatewayForm.bridgeUrl}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, bridgeUrl: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">defaultHandle</p>
                <Input
                  placeholder="默认手机号 / 邮箱 / handle"
                  value={gatewayForm.defaultHandle}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, defaultHandle: e.target.value }))}
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.feishu.verifyTokenLabel', 'verifyToken')}</p>
                <Input
                  type="password"
                  placeholder={t('config.modals.gateway.feishu.verifyTokenPlaceholder')}
                  value={gatewayForm.verifyToken}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, verifyToken: e.target.value }))}
                />
              </div>
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
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.feishu.webhookUrlLabel', 'webhookUrl')}</p>
                <Input
                  placeholder={t('config.modals.gateway.feishu.webhookUrlPlaceholder')}
                  value={gatewayForm.webhookUrl}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, webhookUrl: e.target.value }))}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={gatewayForm.sdkEnabled}
                  onChange={(e) =>
                    setGatewayForm((prev) => ({
                      ...prev,
                      sdkEnabled: e.target.checked,
                    }))
                  }
                />
                {tSafe('config.modals.gateway.feishu.sdkEnabledLabel', '启用 Feishu Node SDK')}
              </label>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.feishu.appIdLabel', 'appId')}</p>
                <Input
                  placeholder={tSafe('config.modals.gateway.feishu.appIdPlaceholder', 'cli_a***')}
                  value={gatewayForm.appId}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, appId: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.feishu.appSecretLabel', 'appSecret')}</p>
                <Input
                  type="password"
                  placeholder={tSafe('config.modals.gateway.feishu.appSecretPlaceholder', '输入 App Secret（留空保持不变）')}
                  value={gatewayForm.appSecret}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, appSecret: e.target.value }))}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={gatewayForm.clearAppSecret}
                  onChange={(e) =>
                    setGatewayForm((prev) => ({
                      ...prev,
                      clearAppSecret: e.target.checked,
                    }))
                  }
                />
                {tSafe('config.modals.gateway.feishu.clearAppSecret', '清空已有 App Secret')}
              </label>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs text-text-tertiary">
                    {tSafe('config.modals.gateway.feishu.receiveIdTypeLabel', 'receiveIdType')}
                  </p>
                  <select
                    className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                    value={gatewayForm.receiveIdType}
                    onChange={(e) =>
                      setGatewayForm((prev) => ({
                        ...prev,
                        receiveIdType: e.target.value as GatewayForm['receiveIdType'],
                      }))
                    }
                  >
                    <option value="chat_id">chat_id</option>
                    <option value="open_id">open_id</option>
                    <option value="user_id">user_id</option>
                    <option value="union_id">union_id</option>
                    <option value="email">email</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-text-tertiary">
                    {tSafe('config.modals.gateway.feishu.sdkDomainLabel', 'sdkDomain')}
                  </p>
                  <select
                    className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                    value={gatewayForm.sdkDomain}
                    onChange={(e) =>
                      setGatewayForm((prev) => ({
                        ...prev,
                        sdkDomain: e.target.value === 'lark' ? 'lark' : 'feishu',
                      }))
                    }
                  >
                    <option value="feishu">feishu</option>
                    <option value="lark">lark</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">
                  {tSafe('config.modals.gateway.feishu.defaultReceiveIdLabel', 'defaultReceiveId')}
                </p>
                <Input
                  placeholder={tSafe('config.modals.gateway.feishu.defaultReceiveIdPlaceholder', '默认接收对象 ID（chat/user）')}
                  value={gatewayForm.defaultReceiveId}
                  onChange={(e) => setGatewayForm((prev) => ({ ...prev, defaultReceiveId: e.target.value }))}
                />
              </div>
            </>
          )}
          <div className="space-y-2 rounded-md border border-border-default p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-text-primary">{t('config.modals.gateway.botBindingsTitle')}</p>
              <Button
                type="button"
                size="xs"
                variant="tertiary"
                data-testid="gateway-chat-binding-add"
                onClick={() => addGatewayBotBinding()}
              >
                {t('config.modals.gateway.addBotBinding')}
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.importBindingsLabel', '导入绑定')}</p>
              <textarea
                className="w-full rounded-lg border border-border-default bg-bg-surface px-3 py-2 text-xs text-text-primary outline-none transition placeholder:text-text-tertiary focus:border-primary-400 focus:ring-2 focus:ring-primary-400/30"
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
            {gatewayForm.botBindings.length === 0 ? (
              <p className="text-xs text-text-secondary">{t('config.modals.gateway.botBindingsEmpty')}</p>
            ) : (
              <div className="space-y-2">
                <div className="hidden md:grid md:grid-cols-[1fr_1fr_auto] gap-2">
                  <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.botIdLabel', 'botId')}</p>
                  <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.botBindingAgentLabel', 'agentId')}</p>
                  <span />
                </div>
                {gatewayForm.botBindings.map((row, index) => (
                  <div key={`chat-binding-${index}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                    <Input
                      data-testid={`gateway-chat-binding-chat-${index}`}
                      placeholder={t('config.modals.gateway.botIdPlaceholder')}
                      value={row.botId}
                      onChange={(e) => updateGatewayBotBinding(index, 'botId', e.target.value)}
                    />
                    <Input
                      data-testid={`gateway-chat-binding-agent-${index}`}
                      placeholder={t('config.modals.gateway.botBindingAgentPlaceholder')}
                      value={row.agentId}
                      onChange={(e) => updateGatewayBotBinding(index, 'agentId', e.target.value)}
                    />
                    <Button
                      type="button"
                      size="xs"
                      variant="tertiary"
                      data-testid={`gateway-chat-binding-remove-${index}`}
                      onClick={() => removeGatewayBotBinding(index)}
                    >
                      {t('config.modals.gateway.removeBotBinding')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.gateway.notifyEventTypesLabel', 'notifyEventTypes')}</p>
            <Input
              data-testid="gateway-notify-event-types-input"
              placeholder={t('config.modals.gateway.notifyEventTypesPlaceholder')}
              value={gatewayForm.notifyEventTypes}
              onChange={(e) => setGatewayForm((prev) => ({ ...prev, notifyEventTypes: e.target.value }))}
            />
          </div>

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
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{tSafe('config.modals.gateway.addressing.commandPrefixesLabel', 'commandPrefixes')}</p>
              <Input
                data-testid="gateway-command-prefixes-input"
                placeholder={t('config.modals.gateway.addressing.commandPrefixesPlaceholder')}
                value={gatewayForm.commandPrefixes}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, commandPrefixes: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{tSafe('config.modals.gateway.addressing.sessionContinuationWindowSecLabel', 'sessionContinuationWindowSec')}</p>
              <Input
                data-testid="gateway-session-window-input"
                type="number"
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
                <option value="low">{tSafe('config.common.riskLevels.low', 'low')}</option>
                <option value="medium">{tSafe('config.common.riskLevels.medium', 'medium')}</option>
                <option value="high">{tSafe('config.common.riskLevels.high', 'high')}</option>
                <option value="critical">{tSafe('config.common.riskLevels.critical', 'critical')}</option>
              </select>
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border-default p-3">
            <p className="text-sm font-medium text-text-primary">{t('config.modals.gateway.context.title')}</p>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{tSafe('config.modals.gateway.context.ttlDaysLabel', 'ttlDays')}</p>
              <Input
                data-testid="gateway-context-ttl-days-input"
                type="number"
                placeholder={t('config.modals.gateway.context.ttlDaysPlaceholder')}
                value={gatewayForm.contextTtlDays}
                onChange={(e) => setGatewayForm((prev) => ({ ...prev, contextTtlDays: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{tSafe('config.modals.gateway.context.maxRecentMessagesLabel', 'maxRecentMessages')}</p>
              <Input
                data-testid="gateway-context-max-recent-input"
                type="number"
                placeholder={t('config.modals.gateway.context.maxRecentMessagesPlaceholder')}
                value={gatewayForm.contextMaxRecentMessages}
                onChange={(e) =>
                  setGatewayForm((prev) => ({
                    ...prev,
                    contextMaxRecentMessages: e.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-text-secondary">{tSafe('config.modals.gateway.context.summarizeEveryNMessagesLabel', 'summarizeEveryNMessages')}</p>
              <Input
                data-testid="gateway-context-summarize-every-n-input"
                type="number"
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
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.apiKey.nameLabel', 'Key Name')}</p>
            <Input
              placeholder={t('config.modals.apiKey.namePlaceholder')}
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.apiKey.expiresAtLabel', 'Expires At')}</p>
            <Input
              type="datetime-local"
              value={newKeyExpiresAt}
              onChange={(e) => setNewKeyExpiresAt(e.target.value)}
            />
          </div>
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
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.webhook.urlLabel', 'Webhook URL')}</p>
            <Input
              placeholder={t('config.modals.webhook.urlPlaceholder')}
              value={webhookForm.url}
              onChange={(e) => setWebhookForm((prev) => ({ ...prev, url: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.webhook.secretLabel', 'Secret')}</p>
            <Input
              placeholder={t('config.modals.webhook.secretPlaceholder')}
              value={webhookForm.secret}
              onChange={(e) => setWebhookForm((prev) => ({ ...prev, secret: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.webhook.eventsLabel', 'Events')}</p>
            <Input
              placeholder={t('config.modals.webhook.eventsPlaceholder')}
              value={webhookForm.eventsText}
              onChange={(e) => setWebhookForm((prev) => ({ ...prev, eventsText: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={showEnvVarModal}
        onClose={closeEnvVarModal}
        title={
          envVarForm.editingName
            ? tSafe('config.envVars.modalTitleEdit', '编辑环境变量')
            : tSafe('config.envVars.modalTitleCreate', '新增环境变量')
        }
        description={
          envVarForm.editingName
            ? tSafe('config.envVars.modalDescriptionEdit', '更新 {name} 的配置', { name: envVarForm.editingName })
            : tSafe('config.envVars.modalDescriptionCreate', '从 .env.local 中新增一个变量')
        }
        maxWidth="md"
        footer={
          <>
            <Button variant="secondary" onClick={closeEnvVarModal} disabled={savingEnvVar}>
              {t('common.cancel')}
            </Button>
            <Button onClick={saveEnvVar} loading={savingEnvVar}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.envVars.modalNameLabel', '变量名')}</p>
            <Input
              placeholder={tSafe('config.envVars.modalNamePlaceholder', '示例：OPENAI_API_KEY')}
              value={envVarForm.name}
              disabled={Boolean(envVarForm.editingName)}
              onChange={(e) =>
                setEnvVarForm((prev) => ({ ...prev, name: e.target.value.toUpperCase() }))
              }
            />
            {!envVarForm.editingName && (
              <p className="text-xs text-text-secondary">{tSafe('config.envVars.modalNameHelp', '变量名必须由大写字母、数字或下划线组成')}</p>
            )}
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.envVars.modalValueLabel', '变量值')}</p>
            <Input
              placeholder={tSafe('config.envVars.modalValuePlaceholder', '输入新值以覆盖（非敏感字段可留空）')}
              type="text"
              value={envVarForm.value}
              onChange={(e) => setEnvVarForm((prev) => ({ ...prev, value: e.target.value }))}
              disabled={envVarForm.clearValue}
            />
            <p className="text-xs text-text-secondary">
              {tSafe(
                'config.envVars.modalValueHint',
                '敏感字段列表会被脱敏显示，若不想修改当前值请保持为空，或勾选清空。'
              )}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={envVarForm.isSensitive}
              onChange={(e) =>
                setEnvVarForm((prev) => ({ ...prev, isSensitive: e.target.checked }))
              }
            />
            {tSafe('config.envVars.modalSensitive', '标记为敏感字段')}
          </label>
          {envVarForm.editingName && (
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={envVarForm.clearValue}
                onChange={(e) =>
                  setEnvVarForm((prev) => ({
                    ...prev,
                    clearValue: e.target.checked,
                    value: e.target.checked ? '' : prev.value,
                  }))
                }
              />
              {tSafe('config.envVars.modalClear', '清空当前值')}
            </label>
          )}
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

function ConfigRoleModelRow({
  role,
  label,
  config,
  options,
  availableModelValueSet,
  onChange,
  tSafe,
}: {
  role: keyof ModelRolesConfig
  label: string
  config: NodeModelConfig
  options: (SelectOption | SelectGroup)[]
  availableModelValueSet: Set<string>
  onChange: (role: keyof ModelRolesConfig, patch: NodeModelConfig) => void
  tSafe: (key: string, fallback: string, params?: Record<string, string | number>) => string
}) {
  const currentBinding = useMemo(() => {
    if (!config.model) return ''
    const matched = Array.from(availableModelValueSet).find((value) => value.endsWith(`${MODEL_BINDING_DELIMITER}${config.model}`))
    return matched || ''
  }, [availableModelValueSet, config.model])

  const isCustomModel = Boolean(config.model) && !currentBinding
  const [customMode, setCustomMode] = useState(isCustomModel)

  useEffect(() => {
    if (isCustomModel) {
      setCustomMode(true)
    } else if (config.model) {
      setCustomMode(false)
    }
  }, [config.model, isCustomModel])

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-text-secondary">{label}</div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">{tSafe('agentsDetail.modelRolesModelLabel', '模型')}</p>
          <Select
            value={customMode ? '__custom__' : currentBinding}
            onChange={(value) => {
              if (value === '__custom__') {
                setCustomMode(true)
                return
              }
              const binding = decodeModelBinding(value)
              if (!binding) return
              setCustomMode(false)
              onChange(role, { ...config, model: binding.modelId })
            }}
            options={[
              ...options,
              { value: '__custom__', label: tSafe('config.common.customValue', 'Custom') },
            ]}
            placeholder={tSafe('agentsDetail.modelRolesModelPlaceholder', '留空使用全局模型')}
          />
          {customMode && (
            <Input
              placeholder={tSafe('agentsDetail.modelRolesModelPlaceholder', '留空使用全局模型')}
              value={config.model ?? ''}
              onChange={(e) => onChange(role, { ...config, model: e.target.value || undefined })}
            />
          )}
        </div>
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">{tSafe('agentsDetail.modelRolesTemperatureLabel', 'Temperature')}</p>
          <Input
            type="number"
            min={0}
            max={2}
            step={0.1}
            placeholder={tSafe('agentsDetail.modelRolesTemperaturePlaceholder', '留空使用默认值')}
            value={config.temperature ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              onChange(role, { ...config, temperature: raw === '' ? undefined : parseFloat(raw) })
            }}
          />
        </div>
      </div>
    </div>
  )
}
