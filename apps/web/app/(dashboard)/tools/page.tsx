'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Wrench, RefreshCw, AlertCircle, CircleHelp, ExternalLink, Pencil, Trash2, Plus } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select, type SelectGroup, type SelectOption } from '@/components/ui/Select'

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
    return payload.response?.data?.error?.message || payload.response?.data?.message || payload.message || fallback
  }
  return fallback
}

import { Tooltip } from '@/components/ui/Tooltip'
import { EmptyStateActions } from '@/components/ui/EmptyStateActions'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { PageHelpStrip } from '@/components/ui/PageHelpStrip'
import { apiClient } from '@/lib/api'
import { formatRuntimeStatusError } from '@/lib/runtime-status'
import { useLocale } from '@/components/providers/LocaleProvider'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface ToolItem {
  id: string
  name: string
  type: string
  description?: string
  isBuiltin: boolean
  isActive: boolean
  schema?: {
    parameters?: Record<string, unknown>
  }
  config?: Record<string, any>
}

type ToolParameterSchema = {
  type?: unknown
  description?: unknown
  enum?: unknown
}

type ToolParameterSummarySection = {
  title: string
  items: string[]
}

type ApprovalScope = 'call' | 'action' | 'target' | 'session' | 'session_action' | 'tool'
type SqlConnectionRow = {
  alias: string
  dsn: string
}
type ToolForm = {
  id?: string
  name: string
  type: string
  timeoutMs: string
  retryAttempts: string
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
  httpAuthType: 'none' | 'bearer' | 'basic' | 'api_key'
  httpAuthHeader: string
  sqlMaxRows: string
  sqlDefaultDatabase: string
  sqlAllowedDatabases: string
  sqlConnectionsRows: SqlConnectionRow[]
}

const HIGH_RISK_DEFAULT_TOOLS = [
  'code_executor',
  'file_io',
  'semi_browser',
  'http_client',
  'csv_xlsx',
  'sql_query_readonly',
  'rule_authoring',
]
const TOOLS_WITH_EXECUTION_TUNING = [
  'code_executor',
  'semi_browser',
  'http_client',
  'web_fetch',
  'text_processing',
  'memory',
  'sql_query_readonly',
]
const DEFAULT_APPROVAL_DEDUPE_OPTIONS = ['', 'action,target', 'action', 'tool']
const TOOLS_WITHOUT_API_CREDENTIALS = [
  'code_executor',
  'file_io',
  'semi_browser',
  'web_fetch',
  'json_transform',
  'text_processing',
  'memory',
  'csv_xlsx',
  'pdf_report',
  'rule_authoring',
]
const TOOL_MAX_READ_BYTES_OPTIONS = ['', '4096', '16384', '65536', '262144', '1048576']
const TOOL_MAX_TEXT_LENGTH_OPTIONS = ['', '2000', '5000', '10000', '20000', '50000', '100000', '200000']
const TOOL_MAX_RESPONSE_CHARS_OPTIONS = ['', '2000', '5000', '10000', '20000', '50000', '100000', '200000']
const TOOL_SQL_MAX_ROWS_OPTIONS = ['', '100', '500', '1000', '2000', '5000']
const TOOL_APPROVAL_DEDUPE_OPTIONS: Record<string, string[]> = {
  semi_browser: ['', 'action,target', 'action', 'target', 'tool'],
  file_io: ['', 'action,target', 'target', 'tool'],
  code_executor: ['', 'action', 'tool'],
  rule_authoring: ['', 'action,target', 'action', 'tool'],
}

function parseBooleanFlag(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'n', 'off', ''].includes(normalized)) return false
  }
  return Boolean(value)
}

interface RuntimeSkillsData {
  available: boolean
  tools: string[]
  skills: string[]
  source: string
  error?: string
}
const MIN_BUILTIN_TOOLS = [
  'search',
  'code_executor',
  'file_io',
  'semi_browser',
  'http_client',
  'web_fetch',
  'json_transform',
  'text_processing',
  'memory',
  'csv_xlsx',
  'pdf_report',
  'sql_query_readonly',
]
const NON_TOOL_SKILLS = ['xlsx', 'pdf']

function getToolParameterSummarySections(
  tool: ToolItem,
  tSafe: (key: string, fallback: string, params?: Record<string, string | number>) => string
): ToolParameterSummarySection[] {
  const parameters = tool.schema?.parameters
  if (!parameters || typeof parameters !== 'object') return []
  const parameterRecord = parameters as {
    required?: unknown
    properties?: Record<string, ToolParameterSchema>
  }
  const required = Array.isArray(parameterRecord.required)
    ? new Set(parameterRecord.required.filter((item): item is string => typeof item === 'string'))
    : new Set<string>()
  const properties = parameterRecord.properties
  if (!properties || typeof properties !== 'object') return []

  const requiredItems: string[] = []
  const optionalItems: string[] = []
  const operationGroups = new Map<string, string[]>()

  const renderItem = (name: string, schema: ToolParameterSchema, isRequired: boolean): string => {
    const description = typeof schema?.description === 'string' ? schema.description.trim() : ''
    const enumValues = Array.isArray(schema?.enum)
      ? schema.enum.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
      : []
    const typeLabel = typeof schema?.type === 'string' ? ` (${schema.type})` : ''
    const enumLabel = enumValues.length > 0 ? ` [${enumValues.join(' | ')}]` : ''
    const base = `${isRequired ? `${name}*` : name}${typeLabel}${enumLabel}`
    return description ? `${base}: ${description}` : base
  }

  const pushOperationItem = (operation: string, item: string) => {
    const existing = operationGroups.get(operation) || []
    existing.push(item)
    operationGroups.set(operation, existing)
  }

  Object.entries(properties).forEach(([name, schema]) => {
    const item = renderItem(name, schema, required.has(name))
    const description = typeof schema?.description === 'string' ? schema.description : ''
    const operationMatches = Array.from(description.matchAll(/operation=([a-z_]+)/g)).map((match) => match[1])
    const usedOnlyMatches = Array.from(description.matchAll(/Used only for (?:operation=)?([a-z_]+)/gi)).map(
      (match) => match[1]
    )
    const groupMatches = [...operationMatches, ...usedOnlyMatches].map((value) => value.toLowerCase())

    if (required.has(name)) {
      requiredItems.push(item)
      return
    }
    if (groupMatches.length > 0) {
      Array.from(new Set(groupMatches)).forEach((operation) => pushOperationItem(operation, item))
      return
    }
    optionalItems.push(item)
  })

  const sections: ToolParameterSummarySection[] = []
  if (requiredItems.length > 0) {
    sections.push({
      title: tSafe('toolsPage.parameterSummary.required', 'Required'),
      items: requiredItems,
    })
  }
  Array.from(operationGroups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([operation, items]) => {
      sections.push({
        title: tSafe('toolsPage.parameterSummary.operationGroup', 'Operation: {name}', {
          name: operation,
        }),
        items,
      })
    })
  if (optionalItems.length > 0) {
    sections.push({
      title: tSafe('toolsPage.parameterSummary.optional', 'Optional'),
      items: optionalItems,
    })
  }
  return sections
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
      isBuiltin: true,
      isActive: db?.isActive ?? true,
      schema: db?.schema,
      config: db?.config,
    }
  })
  for (const item of dbFiltered) {
    if (!runtimeFiltered.includes(item.name)) {
      merged.push(item)
    }
  }
  return merged
}

function getLocalizedToolDescription(
  tool: ToolItem,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (!tool.isBuiltin) return tool.description || ''
  const key = `toolsPage.builtinDescriptions.${tool.name}`
  const localized = t(key)
  if (localized !== key) return localized
  return tool.description || ''
}

export default function ToolsPage() {
  const router = useRouter()
  const { t } = useLocale()
  const [tools, setTools] = useState<ToolItem[]>([])
  const [runtime, setRuntime] = useState<RuntimeSkillsData>({
    available: false,
    tools: [],
    skills: [],
    source: '',
  })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showEditTool, setShowEditTool] = useState(false)
  const [savingTool, setSavingTool] = useState(false)
  const [toolForm, setToolForm] = useState<ToolForm>({
    name: '',
    type: 'custom',
    timeoutMs: '',
    retryAttempts: '',
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
    httpAuthType: 'none',
    httpAuthHeader: 'X-API-Key',
    sqlMaxRows: '',
    sqlDefaultDatabase: '',
    sqlAllowedDatabases: '',
    sqlConnectionsRows: [],
  })
  
  const tSafe = (key: string, fallback: string, params?: Record<string, string | number>) => {
    const value = t(key, params)
    return value === key ? fallback : value
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
      retryAttempts:
        typeof tool.config?.retryAttempts === 'number'
          ? String(tool.config.retryAttempts)
          : '',
      requiresApproval: parseBooleanFlag(tool.config?.requiresApproval, HIGH_RISK_DEFAULT_TOOLS.includes(tool.name)),
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
      httpAuthType: (tool.config?.authType || 'none') as 'none' | 'bearer' | 'basic' | 'api_key',
      httpAuthHeader: tool.config?.authHeader || 'X-API-Key',
      sqlMaxRows:
        typeof tool.config?.maxRows === 'number'
          ? String(tool.config.maxRows)
          : '',
      sqlDefaultDatabase: tool.config?.defaultDatabase || '',
      sqlAllowedDatabases: Array.isArray(tool.config?.allowedDatabases)
        ? tool.config.allowedDatabases.join(',')
        : '',
      sqlConnectionsRows:
        tool.config?.connections && typeof tool.config.connections === 'object'
          ? Object.entries(tool.config.connections).map(([alias, dsn]) => ({
              alias: String(alias || ''),
              dsn: String(dsn || ''),
            }))
          : [],
    })
    setShowEditTool(true)
  }

  const saveToolConfig = async () => {
    const supportsApiCredentials = !TOOLS_WITHOUT_API_CREDENTIALS.includes(toolForm.name)
    const showApiKeyInput = supportsApiCredentials && toolForm.name !== 'sql_query_readonly'
    const isBrowserTool = toolForm.name === 'semi_browser'
    const isHttpFetchTool = toolForm.name === 'http_client' || toolForm.name === 'web_fetch'
    const isHttpClientTool = toolForm.name === 'http_client'
    const isSqlReadonlyTool = toolForm.name === 'sql_query_readonly'
    const timeout = toolForm.timeoutMs.trim()
    if (timeout && (!/^\d+$/.test(timeout) || Number(timeout) < 1000)) {
      setError(t('config.errors.timeoutInvalid'))
      return
    }
    const retryAttempts = toolForm.retryAttempts.trim()
    if (retryAttempts && (!/^\d+$/.test(retryAttempts) || Number(retryAttempts) < 0 || Number(retryAttempts) > 5)) {
      setError(t('config.errors.retryAttemptsInvalid'))
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
    const httpAuthHeader = toolForm.httpAuthHeader.trim()
    if (isHttpClientTool && toolForm.httpAuthType === 'api_key' && !httpAuthHeader) {
      setError(t('config.errors.httpAuthHeaderRequired'))
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
    let sqlConnectionsPayload: Record<string, string> | undefined
    if (isSqlReadonlyTool) {
      const normalized: Record<string, string> = {}
      const duplicateAliases = new Set<string>()
      let invalidRowCount = 0
      for (const row of toolForm.sqlConnectionsRows) {
        const alias = row.alias.trim()
        const dsn = row.dsn.trim()
        if (!alias && !dsn) continue
        if (!alias || !dsn) {
          invalidRowCount += 1
          continue
        }
        if (Object.prototype.hasOwnProperty.call(normalized, alias)) {
          duplicateAliases.add(alias)
          continue
        }
        normalized[alias] = dsn
      }
      if (invalidRowCount > 0) {
        setError(t('config.errors.sqlConnectionsRowInvalid', { count: invalidRowCount }))
        return
      }
      if (duplicateAliases.size > 0) {
        setError(
          t('config.errors.sqlConnectionsDuplicateAlias', {
            count: duplicateAliases.size,
          })
        )
        return
      }
      sqlConnectionsPayload = normalized
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
        ...(retryAttempts ? { retryAttempts: Number(retryAttempts) } : {}),
        requiresApproval: toolForm.requiresApproval,
        riskLevel: toolForm.riskLevel,
        approvalScope: toolForm.approvalScope,
        approvalDedupeKeys,
        ...(endpoint ? { apiEndpoint: endpoint } : {}),
        ...(showApiKeyInput && toolForm.apiKey.trim()
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
        ...(isHttpClientTool ? { authType: toolForm.httpAuthType } : {}),
        ...(isHttpClientTool && toolForm.httpAuthType === 'api_key' && httpAuthHeader
          ? { authHeader: httpAuthHeader }
          : {}),
        ...(isSqlReadonlyTool && sqlMaxRows ? { maxRows: Number(sqlMaxRows) } : {}),
        ...(isSqlReadonlyTool && toolForm.sqlDefaultDatabase.trim()
          ? { defaultDatabase: toolForm.sqlDefaultDatabase.trim() }
          : {}),
        ...(isSqlReadonlyTool ? { allowedDatabases: parseCommaList(toolForm.sqlAllowedDatabases) } : {}),
        ...(isSqlReadonlyTool && sqlConnectionsPayload ? { connections: sqlConnectionsPayload } : {}),
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

      await loadData()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.updateToolConfig')))
    } finally {
      setSavingTool(false)
    }
  }

  
  
  
  
  const addSqlConnectionRow = useCallback(() => {
    setToolForm((prev) => ({
      ...prev,
      sqlConnectionsRows: [...prev.sqlConnectionsRows, { alias: '', dsn: '' }],
    }))
  }, [])

  const updateSqlConnectionRow = useCallback((index: number, key: 'alias' | 'dsn', value: string) => {
    setToolForm((prev) => ({
      ...prev,
      sqlConnectionsRows: prev.sqlConnectionsRows.map((row, idx) => (idx === index ? { ...row, [key]: value } : row)),
    }))
  }, [])

  const removeSqlConnectionRow = useCallback((index: number) => {
    setToolForm((prev) => ({
      ...prev,
      sqlConnectionsRows: prev.sqlConnectionsRows.filter((_, idx) => idx !== index),
    }))
  }, [])

  const sqlDefaultDatabaseOptions = useMemo(() => {
    const aliases = toolForm.sqlConnectionsRows
      .map((row) => row.alias.trim())
      .filter(Boolean)
    const set = new Set(aliases)
    const current = toolForm.sqlDefaultDatabase.trim()
    if (current) set.add(current)
    return Array.from(set)
  }, [toolForm.sqlConnectionsRows, toolForm.sqlDefaultDatabase])

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
      await loadData()
    } catch (err) {
      setError(getErrorMessage(err, t('config.errors.updateToolStatus')))
    }
  }


  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const [toolsRes, runtimeRes] = await Promise.allSettled([
        apiClient.get<ApiResponse<ToolItem[]>>('/tools', { params: { page: 1, limit: 100 } }),
        apiClient.get<ApiResponse<RuntimeSkillsData>>('/runtime/skills'),
      ])

      const dbTools = toolsRes.status === 'fulfilled' && toolsRes.value.success ? (toolsRes.value.data || []) : []
      const runtimeData: RuntimeSkillsData =
        runtimeRes.status === 'fulfilled' && runtimeRes.value.success
          ? runtimeRes.value.data
          : {
              available: false,
              tools: [],
              skills: [],
              source: '',
              error: t('toolsPage.runtimeUnavailable'),
            }
      const unifiedTools = Array.from(new Set([...(runtimeData.tools || []), ...MIN_BUILTIN_TOOLS])).filter(
        (name) => !NON_TOOL_SKILLS.includes(name)
      )
      setRuntime({ ...runtimeData, tools: unifiedTools })
      setTools(mergeTools(unifiedTools, dbTools))

      if (
        (toolsRes.status === 'rejected' || !toolsRes.value.success) &&
        (runtimeRes.status === 'rejected' || !runtimeRes.value.success)
      ) {
        setError(t('toolsPage.error.load'))
      }
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const stats = useMemo(() => {
    const active = tools.filter((item) => item.isActive).length
    return {
      allTools: tools.length,
      active,
      runtimeConnected: runtime.available ? 1 : 0,
    }
  }, [runtime.available, tools])

  const runtimeErrorText = useMemo(
    () => formatRuntimeStatusError(runtime.error, runtime.source),
    [runtime.error, runtime.source]
  )

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                  <Wrench size={22} className="text-primary-400" />
                  {t('toolsPage.title')}
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  {t('toolsPage.subtitle')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />}
                  onClick={() => void loadData()}
                >
                  {t('common.refresh')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <PageHelpStrip text={t('help.nav.tools')} ctaLabel={t('nav.helpCenter')} />

        {error && (
          <InlineErrorAlert message={error} />
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <StatCard label={t('toolsPage.stats.total')} value={stats.allTools} />
          <StatCard label={t('toolsPage.stats.enabled')} value={stats.active} />
        </div>

        <div className="grid grid-cols-1 gap-4">
          <Card className="border-border-default">
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-text-primary">{t('toolsPage.configTitle')}</h2>
                <Tooltip
                  content={
                    runtime.available
                      ? t('toolsPage.connected')
                      : runtimeErrorText || t('toolsPage.runtimeUnavailable')
                  }
                >
                  <div>
                    <Badge variant={runtime.available ? 'success' : 'outline'}>
                      {runtime.available ? t('toolsPage.connected') : t('toolsPage.disconnected')}
                    </Badge>
                  </div>
                </Tooltip>
              </div>
              <div className="mt-3 rounded-md border border-border-subtle bg-bg-elevated/70 px-3 py-2 text-xs text-text-secondary">
                {t('help.nav.tools')}
              </div>
              {runtimeErrorText && (
                <p className="mt-2 text-xs text-warning-500">{runtimeErrorText}</p>
              )}
              {isLoading ? (
                <p className="mt-4 text-sm text-text-secondary">{t('common.loading')}</p>
              ) : tools.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {tools.map((tool) => {
                    const description = getLocalizedToolDescription(tool, t)
                    const parameterSummarySections = getToolParameterSummarySections(tool, tSafe)
                    return (
                      <div
                        key={tool.id}
                        className="rounded-md border border-border-subtle bg-bg-surface px-3 py-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-text-primary">
                              {tool.name}
                            </p>
                            <p className="mt-1 text-xs text-text-tertiary">
                              {description || ''}
                            </p>
                            {parameterSummarySections.length > 0 ? (
                              <div className="mt-2 space-y-1">
                                {parameterSummarySections.map((section) => (
                                  <div key={section.title} className="space-y-1">
                                    <p className="text-[11px] font-medium text-text-secondary">{section.title}</p>
                                    {section.items.map((line) => (
                                      <p key={line} className="text-[11px] text-text-tertiary">
                                        {line}
                                      </p>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={tool.isActive ? 'success' : 'outline'}>
                              {tool.isActive ? t('toolsPage.enabled') : t('toolsPage.disabled')}
                            </Badge>
                            <Button 
                              variant="tertiary" 
                              size="sm" 
                              className="h-8 w-8 p-0" 
                              onClick={() => openEditToolDialog(tool)}
                              title={t('common.edit')}
                            >
                              <Pencil size={14} className="text-text-secondary hover:text-text-primary" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="mt-4">
                  <EmptyStateActions
                    message={t('toolsPage.empty')}
                    actions={(
                      <>
                        <Button size="xs" onClick={() => void loadData()}>{t('common.refresh')}</Button>
                      </>
                    )}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      <Modal
        open={showEditTool}
        onClose={() => setShowEditTool(false)}
        title={t('config.modals.tool.title')}
        description={toolForm.id || ''}
        maxWidth="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowEditTool(false)} disabled={savingTool}>
              {t('common.cancel')}
            </Button>
            <Button data-testid="tool-save-button" onClick={saveToolConfig} loading={savingTool}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-text-tertiary">
            {t('config.modals.tool.description')}
          </p>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.nameLabel', 'name')}</p>
            <Input
              placeholder={t('config.modals.tool.namePlaceholder')}
              value={toolForm.name}
              disabled
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.typeLabel', 'type')}</p>
            <Input
              placeholder={t('config.modals.tool.typePlaceholder')}
              value={toolForm.type}
              disabled
            />
          </div>
          {TOOLS_WITH_EXECUTION_TUNING.includes(toolForm.name) ? (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{t('config.modals.tool.timeoutLabel')}</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.timeoutMs}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, timeoutMs: e.target.value }))}
                >
                  <option value="">{t('config.modals.tool.timeoutDefault')}</option>
                  <option value="30000">30s</option>
                  <option value="60000">60s</option>
                  <option value="120000">120s</option>
                  <option value="300000">300s</option>
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{t('config.modals.tool.retryAttemptsLabel')}</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.retryAttempts}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, retryAttempts: e.target.value }))}
                >
                  <option value="">{t('config.modals.tool.retryAttemptsDefault')}</option>
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </div>
            </>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={toolForm.requiresApproval}
              onChange={(e) => setToolForm((prev) => ({ ...prev, requiresApproval: e.target.checked }))}
            />
            {t('config.modals.tool.hitl')}
          </label>
          <p className="text-[11px] text-text-tertiary">{t('config.modals.tool.hitlHint')}</p>
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
              <option value="low">{tSafe('config.common.riskLevels.low', 'low')}</option>
              <option value="medium">{tSafe('config.common.riskLevels.medium', 'medium')}</option>
              <option value="high">{tSafe('config.common.riskLevels.high', 'high')}</option>
              <option value="critical">{tSafe('config.common.riskLevels.critical', 'critical')}</option>
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
          {toolForm.requiresApproval ? (
            <div className="space-y-1">
              <p className="text-xs text-text-tertiary">{t('config.modals.tool.approvalDedupeKeysLabel')}</p>
              <select
                className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                value={toolForm.approvalDedupeKeys}
                onChange={(e) => setToolForm((prev) => ({ ...prev, approvalDedupeKeys: e.target.value }))}
              >
                {(TOOL_APPROVAL_DEDUPE_OPTIONS[toolForm.name] || DEFAULT_APPROVAL_DEDUPE_OPTIONS).map((value) => (
                  <option key={value || 'default'} value={value}>
                    {value || t('config.modals.tool.approvalDedupeDefault')}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {!TOOLS_WITHOUT_API_CREDENTIALS.includes(toolForm.name) ? (
            <>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.apiEndpointLabel', 'apiEndpoint')}</p>
                <Input
                  placeholder={t('config.modals.tool.apiEndpointPlaceholder')}
                  value={toolForm.apiEndpoint}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, apiEndpoint: e.target.value }))}
                />
              </div>
              {toolForm.name !== 'sql_query_readonly' ? (
                <div className="space-y-1">
                  <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.apiKeyLabel', 'apiKey')}</p>
                  <Input
                    type="password"
                    placeholder={t('config.modals.tool.apiKeyPlaceholder')}
                    value={toolForm.apiKey}
                    onChange={(e) => setToolForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-text-tertiary">
              {t('config.modals.tool.noApiNeeded', { tool: toolForm.name })}
            </p>
          )}
          {toolForm.name === 'semi_browser' ? (
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
                  <option value="chromium">{tSafe('config.modals.tool.browser.browserTypes.chromium', 'chromium')}</option>
                  <option value="firefox">{tSafe('config.modals.tool.browser.browserTypes.firefox', 'firefox')}</option>
                  <option value="webkit">{tSafe('config.modals.tool.browser.browserTypes.webkit', 'webkit')}</option>
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.browser.allowedDomainsLabel', 'allowedDomains')}</p>
                <Input
                  data-testid="tool-browser-allowed-domains-input"
                  placeholder={t('config.modals.tool.browser.allowedDomainsPlaceholder')}
                  value={toolForm.allowedDomains}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, allowedDomains: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.browser.blockedDomainsLabel', 'blockedDomains')}</p>
                <Input
                  data-testid="tool-browser-blocked-domains-input"
                  placeholder={t('config.modals.tool.browser.blockedDomainsPlaceholder')}
                  value={toolForm.blockedDomains}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, blockedDomains: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.browser.maxTextLengthLabel', 'maxTextLength')}</p>
                <select
                  data-testid="tool-browser-max-text-length-input"
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.maxTextLength}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, maxTextLength: e.target.value }))}
                >
                  <option value="">{tSafe('config.modals.tool.browser.maxTextLengthDefault', 'Use default maxTextLength')}</option>
                  {TOOL_MAX_TEXT_LENGTH_OPTIONS.filter((value) => value).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                  {toolForm.maxTextLength &&
                  !TOOL_MAX_TEXT_LENGTH_OPTIONS.includes(toolForm.maxTextLength) ? (
                    <option value={toolForm.maxTextLength}>{`${tSafe('config.common.customValue', 'Custom')}: ${toolForm.maxTextLength}`}</option>
                  ) : null}
                </select>
              </div>
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
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.http.allowedDomainsLabel', 'allowedDomains')}</p>
                <Input
                  placeholder={t('config.modals.tool.http.allowedDomainsPlaceholder')}
                  value={toolForm.allowedDomains}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, allowedDomains: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.http.blockedDomainsLabel', 'blockedDomains')}</p>
                <Input
                  placeholder={t('config.modals.tool.http.blockedDomainsPlaceholder')}
                  value={toolForm.blockedDomains}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, blockedDomains: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.http.maxResponseCharsLabel', 'maxResponseChars')}</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.maxResponseChars}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, maxResponseChars: e.target.value }))}
                >
                  <option value="">{tSafe('config.modals.tool.http.maxResponseCharsDefault', 'Use default maxResponseChars')}</option>
                  {TOOL_MAX_RESPONSE_CHARS_OPTIONS.filter((value) => value).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                  {toolForm.maxResponseChars &&
                  !TOOL_MAX_RESPONSE_CHARS_OPTIONS.includes(toolForm.maxResponseChars) ? (
                    <option value={toolForm.maxResponseChars}>{`${tSafe('config.common.customValue', 'Custom')}: ${toolForm.maxResponseChars}`}</option>
                  ) : null}
                </select>
              </div>
              {toolForm.name === 'http_client' ? (
                <>
                  <div className="space-y-1">
                    <p className="text-xs text-text-tertiary">{t('config.modals.tool.http.authType')}</p>
                    <select
                      className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                      value={toolForm.httpAuthType}
                      onChange={(e) =>
                        setToolForm((prev) => ({
                          ...prev,
                          httpAuthType: e.target.value as 'none' | 'bearer' | 'basic' | 'api_key',
                        }))
                      }
                    >
                      <option value="none">{t('config.modals.tool.http.authTypes.none')}</option>
                      <option value="bearer">{t('config.modals.tool.http.authTypes.bearer')}</option>
                      <option value="basic">{t('config.modals.tool.http.authTypes.basic')}</option>
                      <option value="api_key">{t('config.modals.tool.http.authTypes.apiKey')}</option>
                    </select>
                  </div>
                  {toolForm.httpAuthType === 'api_key' ? (
                    <div className="space-y-1">
                      <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.http.authHeaderLabel', 'authHeader')}</p>
                      <Input
                        placeholder={t('config.modals.tool.http.authHeaderPlaceholder')}
                        value={toolForm.httpAuthHeader}
                        onChange={(e) => setToolForm((prev) => ({ ...prev, httpAuthHeader: e.target.value }))}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          {toolForm.name === 'sql_query_readonly' ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.sql.maxRowsLabel', 'maxRows')}</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.sqlMaxRows}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, sqlMaxRows: e.target.value }))}
                >
                  <option value="">{tSafe('config.modals.tool.sql.maxRowsDefault', 'Use default maxRows')}</option>
                  {TOOL_SQL_MAX_ROWS_OPTIONS.filter((value) => value).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                  {toolForm.sqlMaxRows && !TOOL_SQL_MAX_ROWS_OPTIONS.includes(toolForm.sqlMaxRows) ? (
                    <option value={toolForm.sqlMaxRows}>{`${tSafe('config.common.customValue', 'Custom')}: ${toolForm.sqlMaxRows}`}</option>
                  ) : null}
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.sql.defaultDatabaseLabel', 'defaultDatabase')}</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.sqlDefaultDatabase}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, sqlDefaultDatabase: e.target.value }))}
                >
                  <option value="">{tSafe('config.modals.tool.sql.defaultDatabaseDefault', 'Use runtime default')}</option>
                  {sqlDefaultDatabaseOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.sql.allowedDatabasesLabel', 'allowedDatabases')}</p>
                <Input
                  placeholder={t('config.modals.tool.sql.allowedDatabasesPlaceholder')}
                  value={toolForm.sqlAllowedDatabases}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, sqlAllowedDatabases: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{t('config.modals.tool.sql.connectionsLabel')}</p>
                <div className="space-y-2">
                  <div className="hidden md:grid md:grid-cols-[180px_1fr_auto] gap-2">
                    <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.sql.connectionAliasLabel', 'alias')}</p>
                    <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.sql.connectionDsnLabel', 'dsn')}</p>
                    <span />
                  </div>
                  {toolForm.sqlConnectionsRows.map((row, index) => (
                    <div key={index} className="grid grid-cols-1 gap-2 md:grid-cols-[180px_1fr_auto]">
                      <Input
                        placeholder={t('config.modals.tool.sql.connectionAliasPlaceholder')}
                        value={row.alias}
                        onChange={(e) => updateSqlConnectionRow(index, 'alias', e.target.value)}
                      />
                      <Input
                        placeholder={t('config.modals.tool.sql.connectionDsnPlaceholder')}
                        value={row.dsn}
                        onChange={(e) => updateSqlConnectionRow(index, 'dsn', e.target.value)}
                      />
                      <Button
                        variant="secondary"
                        onClick={() => removeSqlConnectionRow(index)}
                        className="md:w-auto w-full"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ))}
                  <Button variant="secondary" onClick={addSqlConnectionRow} className="w-full">
                    <Plus size={14} className="mr-1" />
                    {t('config.modals.tool.sql.addConnection')}
                  </Button>
                </div>
                <p className="text-[11px] text-text-tertiary">{t('config.modals.tool.sql.connectionsHint')}</p>
              </div>
            </div>
          ) : null}
          {toolForm.name === 'file_io' ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.rootPathLabel', 'rootPath')}</p>
                <Input
                  placeholder={t('config.modals.tool.rootPathPlaceholder')}
                  value={toolForm.rootPath}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, rootPath: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-text-tertiary">{tSafe('config.modals.tool.maxReadBytesLabel', 'maxReadBytes')}</p>
                <select
                  className="w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary"
                  value={toolForm.maxReadBytes}
                  onChange={(e) => setToolForm((prev) => ({ ...prev, maxReadBytes: e.target.value }))}
                >
                  <option value="">{tSafe('config.modals.tool.maxReadBytesDefault', 'Use default maxReadBytes')}</option>
                  {TOOL_MAX_READ_BYTES_OPTIONS.filter((value) => value).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                  {toolForm.maxReadBytes && !TOOL_MAX_READ_BYTES_OPTIONS.includes(toolForm.maxReadBytes) ? (
                    <option value={toolForm.maxReadBytes}>{`${tSafe('config.common.customValue', 'Custom')}: ${toolForm.maxReadBytes}`}</option>
                  ) : null}
                </select>
              </div>
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="border-border-default">
      <CardContent className="p-4">
        <p className="text-sm text-text-secondary">{label}</p>
        <p className="mt-2 text-2xl font-semibold text-text-primary">{value}</p>
      </CardContent>
    </Card>
  )
}
