'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw, Server, Wrench, TerminalSquare, ExternalLink, Power, Settings2 } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardContent } from '@/components/ui/Card'
import { InlineErrorAlert } from '@/components/ui/InlineErrorAlert'
import { Modal } from '@/components/ui/Modal'
import { apiClient } from '@/lib/api'
import { useLocale } from '@/components/providers/LocaleProvider'
import { McpServersManager } from '@/components/tools/McpServersManager'
import { toast } from '@/stores/toastStore'

type ToolTab = 'builtin' | 'mcp' | 'cli'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface ToolCatalogItem {
  toolId: string
  toolName: string
  displayName: string
  description: string
  sourceType: 'builtin' | 'mcp' | 'cli'
  providerId?: string | null
}

interface ToolCatalogResponse {
  items: ToolCatalogItem[]
  generatedAt?: string
  source?: string
}

interface ToolRecord {
  id: string
  name: string
  description?: string
  type: string
  schema: Record<string, unknown>
  config: Record<string, unknown>
  isBuiltin: boolean
  isActive: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
}

interface BuiltinToolFormState {
  isActive: boolean
  timeout: string
  retryAttempts: string
  rateLimit: string
  apiEndpoint: string
  apiKey: string
  authType: 'none' | 'bearer' | 'basic' | 'api_key'
  authHeader: string
  requiresApproval: boolean
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  approvalScope: string
  allowLocalhost: boolean
  allowedDomains: string
  blockedDomains: string
  headless: boolean
  browserType: 'chromium' | 'firefox' | 'webkit'
  rootPath: string
  maxReadBytes: string
  maxTextLength: string
  maxResponseChars: string
  maxRows: string
  defaultDatabase: string
}

function getBuiltinFieldVisibility(toolName: string) {
  const normalized = toolName.toLowerCase()
  const base = {
    timeout: true,
    retryAttempts: false,
    rateLimit: true,
    apiEndpoint: false,
    apiKey: false,
    authType: false,
    authHeader: false,
    requiresApproval: true,
    riskLevel: true,
    approvalScope: true,
    allowLocalhost: false,
    allowedDomains: false,
    blockedDomains: false,
    headless: false,
    browserType: false,
    rootPath: false,
    maxReadBytes: false,
    maxTextLength: false,
    maxResponseChars: false,
    maxRows: false,
    defaultDatabase: false,
  }
  if (normalized === 'semi_browser') {
    return { ...base, allowLocalhost: true, allowedDomains: true, blockedDomains: true, headless: true, browserType: true, maxTextLength: true }
  }
  if (normalized === 'web_fetch') {
    return { ...base, retryAttempts: true, allowLocalhost: true, allowedDomains: true, blockedDomains: true, maxResponseChars: true }
  }
  if (normalized === 'http_client') {
    return { ...base, retryAttempts: true, apiEndpoint: true, apiKey: true, authType: true, authHeader: true, allowLocalhost: true, allowedDomains: true, blockedDomains: true, maxResponseChars: true }
  }
  if (normalized === 'search') {
    return { ...base, apiEndpoint: true, apiKey: true }
  }
  if (normalized === 'file_io') {
    return { ...base, rootPath: true, maxReadBytes: true }
  }
  if (normalized === 'code_executor') {
    return { ...base }
  }
  if (normalized === 'text_processing') {
    return { ...base, maxTextLength: true }
  }
  if (normalized === 'json_transform') {
    return { ...base, maxRows: true }
  }
  return base
}

interface McpServerItem {
  id: string
  name: string
  description?: string
  endpoint?: string
  transport?: string
  status?: string
  isActive?: boolean
  isSystem?: boolean
  lastConnectedAt?: string | null
  tools?: unknown[]
  resources?: unknown[]
}

interface CliImportRequestItem {
  id: string
  source: 'cli' | 'web' | 'channel_auto'
  shape: 'direct' | 'group'
  command: string[]
  tool_name: string
  display_name?: string | null
  description?: string | null
  status: string
  reason?: string | null
  error?: string | null
  created_at?: string
}

function normalizeToolDescription(description: string): string {
  return String(description || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,.:;])\s*/g, '$1 ')
    .trim()
}

function extractFirstSentence(text: string): string {
  const match = text.match(/^(.+?[。.!?])(?:\s|$)/)
  return match?.[1]?.trim() || text
}

function buildToolCardCopy(item: ToolCatalogItem): { summary: string; highlights: string[] } {
  const normalized = normalizeToolDescription(item.description)
  if (!normalized) {
    return { summary: '--', highlights: [] }
  }

  const withoutExamples = normalized.replace(/\s*Minimal examples:.*/i, '').trim()
  const summary = extractFirstSentence(withoutExamples)
  const highlights: string[] = []

  const operationsMatch = withoutExamples.match(/operations:\s*([^.]+)/i)
  if (operationsMatch?.[1]) {
    const count = operationsMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean).length
    if (count > 0) highlights.push(`${count} actions`)
  }

  const useMatch = withoutExamples.match(/\bUse\s+([^.]+)/i)
  if (useMatch?.[1]) {
    highlights.push(useMatch[1].trim())
  }

  const supportsMatch = withoutExamples.match(/\bSupports?\s+([^.]+)/i)
  if (supportsMatch?.[1]) {
    highlights.push(supportsMatch[1].trim())
  }

  return {
    summary,
    highlights: Array.from(new Set(highlights)).slice(0, 3),
  }
}

export default function ToolsPage() {
  const { t } = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab] = useState<ToolTab>('builtin')
  const [catalogItems, setCatalogItems] = useState<ToolCatalogItem[]>([])
  const [builtinToolRecords, setBuiltinToolRecords] = useState<ToolRecord[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerItem[]>([])
  const [cliImports, setCliImports] = useState<CliImportRequestItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isImportingCli, setIsImportingCli] = useState(false)
  const [cliImportError, setCliImportError] = useState<string | null>(null)
  const [cliCommand, setCliCommand] = useState('')
  const [cliShape, setCliShape] = useState<'direct' | 'group'>('direct')
  const [editingBuiltin, setEditingBuiltin] = useState<ToolCatalogItem | null>(null)
  const [builtinForm, setBuiltinForm] = useState<BuiltinToolFormState | null>(null)
  const [builtinConfigError, setBuiltinConfigError] = useState<string | null>(null)
  const [savingBuiltinName, setSavingBuiltinName] = useState<string | null>(null)

  const tSafe = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const value = t(key, params)
      return value === key ? fallback : value
    },
    [t]
  )

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [catalogRes, builtinRes, mcpRes, cliImportsRes] = await Promise.allSettled([
        apiClient.get<ApiResponse<ToolCatalogResponse>>('/tools/catalog'),
        apiClient.get<{ success: boolean; data: ToolRecord[]; meta?: unknown }>('/tools', {
          params: { includeBuiltin: true, limit: 100 },
        }),
        apiClient.get<ApiResponse<McpServerItem[]>>('/mcp', { params: { page: 1, limit: 100 } }),
        apiClient.get<ApiResponse<CliImportRequestItem[]>>('/tools/import-cli'),
      ])

      const nextCatalog =
        catalogRes.status === 'fulfilled' && catalogRes.value.success
          ? catalogRes.value.data?.items || []
          : []
      const nextMcpServers =
        mcpRes.status === 'fulfilled' && mcpRes.value.success
          ? mcpRes.value.data || []
          : []
      const nextBuiltinRecords =
        builtinRes.status === 'fulfilled' && builtinRes.value.success
          ? builtinRes.value.data || []
          : []
      const nextCliImports =
        cliImportsRes.status === 'fulfilled' && cliImportsRes.value.success
          ? cliImportsRes.value.data || []
          : []

      setCatalogItems(nextCatalog)
      setBuiltinToolRecords(nextBuiltinRecords)
      setMcpServers(nextMcpServers)
      setCliImports(nextCliImports)

      if (
        (catalogRes.status === 'rejected' || !catalogRes.value.success) &&
        (builtinRes.status === 'rejected' || !builtinRes.value.success) &&
        (mcpRes.status === 'rejected' || !mcpRes.value.success) &&
        (cliImportsRes.status === 'rejected' || !cliImportsRes.value.success)
      ) {
        setError(tSafe('toolsCenter.errors.load', 'Failed to load tools center'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tSafe('toolsCenter.errors.load', 'Failed to load tools center'))
    } finally {
      setIsLoading(false)
    }
  }, [tSafe])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    const requestedTab = String(searchParams.get('tab') || '').trim().toLowerCase()
    if (requestedTab === 'builtin' || requestedTab === 'mcp' || requestedTab === 'cli') {
      setActiveTab(requestedTab)
      return
    }
    setActiveTab('builtin')
  }, [searchParams])

  const updateActiveTab = useCallback(
    (nextTab: ToolTab) => {
      setActiveTab(nextTab)
      const params = new URLSearchParams(searchParams.toString())
      if (nextTab === 'builtin') {
        params.delete('tab')
      } else {
        params.set('tab', nextTab)
      }
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const builtinToolMap = useMemo(() => {
    const entries = builtinToolRecords.map((item) => [item.name.toLowerCase(), item] as const)
    return new Map(entries)
  }, [builtinToolRecords])
  const builtinTools = useMemo(() => {
    const catalogMap = new Map(
      catalogItems
        .filter((item) => item.sourceType === 'builtin')
        .map((item) => [item.toolName.toLowerCase(), item] as const)
    )
    const merged = new Map<string, ToolCatalogItem>(catalogMap)
    for (const record of builtinToolRecords) {
      if (record.isBuiltin === false) continue
      if (!merged.has(record.name.toLowerCase())) {
        merged.set(record.name.toLowerCase(), {
          toolId: record.id,
          toolName: record.name,
          displayName: record.name,
          description: record.description || '',
          sourceType: 'builtin',
          providerId: null,
        })
      }
    }
    return Array.from(merged.values()).sort((a, b) => a.toolName.localeCompare(b.toolName))
  }, [builtinToolRecords, catalogItems])
  const cliTools = useMemo(
    () => catalogItems.filter((item) => item.sourceType === 'cli'),
    [catalogItems]
  )
  const mcpBackedTools = useMemo(
    () => catalogItems.filter((item) => item.sourceType === 'mcp'),
    [catalogItems]
  )

  const tabs = useMemo(
    () => [
      {
        id: 'builtin' as const,
        label: tSafe('toolsCenter.tabs.builtin', '内建工具'),
        count: builtinTools.length,
        icon: Wrench,
      },
      {
        id: 'mcp' as const,
        label: tSafe('toolsCenter.tabs.mcp', 'MCP 服务器'),
        count: mcpServers.length,
        icon: Server,
      },
      {
        id: 'cli' as const,
        label: tSafe('toolsCenter.tabs.cli', 'CLI 工具'),
        count: cliTools.length,
        icon: TerminalSquare,
      },
    ],
    [builtinTools.length, cliTools.length, mcpServers.length, tSafe]
  )

  const summaryCards = useMemo(
    () => [
      {
        label: tSafe('toolsCenter.summary.builtin', '内建工具'),
        value: builtinTools.length,
        helper: tSafe('toolsCenter.summary.builtinHelper', 'Runtime 自带能力'),
      },
      {
        label: tSafe('toolsCenter.summary.mcpServers', 'MCP 服务器'),
        value: mcpServers.length,
        helper: tSafe('toolsCenter.summary.mcpHelper', '外部连接与同步源'),
      },
      {
        label: tSafe('toolsCenter.summary.cliTools', 'CLI 工具'),
        value: cliTools.length,
        helper: tSafe('toolsCenter.summary.cliHelper', '本地 harness 与命令能力'),
      },
      {
        label: tSafe('toolsCenter.summary.mcpTools', 'MCP 工具'),
        value: mcpBackedTools.length,
        helper: tSafe('toolsCenter.summary.mcpToolsHelper', '由 MCP server 暴露'),
      },
    ],
    [builtinTools.length, cliTools.length, mcpBackedTools.length, mcpServers.length, tSafe]
  )

  const buildBuiltinFormState = useCallback((record?: ToolRecord): BuiltinToolFormState => {
    const config = record?.config || {}
    const toListText = (value: unknown) => (Array.isArray(value) ? value.join('\n') : '')
    return {
      isActive: record?.isActive !== false,
      timeout: config.timeout != null ? String(config.timeout) : '',
      retryAttempts: config.retryAttempts != null ? String(config.retryAttempts) : '',
      rateLimit: config.rateLimit != null ? String(config.rateLimit) : '',
      requiresApproval: Boolean(config.requiresApproval),
      apiEndpoint: typeof config.apiEndpoint === 'string' ? config.apiEndpoint : '',
      apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
      authType:
        config.authType === 'bearer' || config.authType === 'basic' || config.authType === 'api_key'
          ? config.authType
          : 'none',
      authHeader: typeof config.authHeader === 'string' ? config.authHeader : '',
      riskLevel:
        config.riskLevel === 'medium' || config.riskLevel === 'high' || config.riskLevel === 'critical'
          ? config.riskLevel
          : 'low',
      approvalScope: typeof config.approvalScope === 'string' ? config.approvalScope : 'session',
      allowLocalhost: Boolean(config.allowLocalhost),
      allowedDomains: toListText(config.allowedDomains),
      blockedDomains: toListText(config.blockedDomains),
      headless: config.headless !== false,
      browserType:
        config.browserType === 'firefox' || config.browserType === 'webkit' ? config.browserType : 'chromium',
      rootPath: typeof config.rootPath === 'string' ? config.rootPath : '',
      maxReadBytes: config.maxReadBytes != null ? String(config.maxReadBytes) : '',
      maxTextLength: config.maxTextLength != null ? String(config.maxTextLength) : '',
      maxResponseChars: config.maxResponseChars != null ? String(config.maxResponseChars) : '',
      maxRows: config.maxRows != null ? String(config.maxRows) : '',
      defaultDatabase: typeof config.defaultDatabase === 'string' ? config.defaultDatabase : '',
    }
  }, [])

  const openBuiltinEditor = useCallback(
    (item: ToolCatalogItem) => {
      const existing = builtinToolMap.get(item.toolName.toLowerCase())
      setEditingBuiltin(item)
      setBuiltinForm(buildBuiltinFormState(existing))
      setBuiltinConfigError(null)
    },
    [buildBuiltinFormState, builtinToolMap]
  )

  const closeBuiltinEditor = useCallback(() => {
    setEditingBuiltin(null)
    setBuiltinForm(null)
    setBuiltinConfigError(null)
  }, [])

  const updateBuiltinTool = useCallback(
    async (toolName: string, payload: { isActive?: boolean; config?: Record<string, unknown> }) => {
      setSavingBuiltinName(toolName)
      try {
        await apiClient.put<ApiResponse<ToolRecord>>(`/tools/by-name/${encodeURIComponent(toolName)}`, payload)
        await loadData()
      } finally {
        setSavingBuiltinName(null)
      }
    },
    [loadData]
  )

  const toggleBuiltinTool = useCallback(
    async (item: ToolCatalogItem) => {
      const existing = builtinToolMap.get(item.toolName.toLowerCase())
      const nextActive = existing?.isActive === false
      try {
        setBuiltinConfigError(null)
        setBuiltinToolRecords((prev) =>
          prev.some((record) => record.name.toLowerCase() === item.toolName.toLowerCase())
            ? prev.map((record) =>
                record.name.toLowerCase() === item.toolName.toLowerCase()
                  ? { ...record, isActive: nextActive }
                  : record
              )
            : [
                ...prev,
                {
                  id: item.toolId,
                  name: item.toolName,
                  description: item.description,
                  type: 'builtin',
                  schema: {},
                  config: {},
                  isBuiltin: true,
                  isActive: nextActive,
                  createdAt: '',
                  updatedAt: '',
                },
              ]
        )
        await updateBuiltinTool(item.toolName, { isActive: nextActive })
        toast.success(
          nextActive ? tSafe('toolsCenter.toast.enabled', '工具已启用') : tSafe('toolsCenter.toast.disabled', '工具已禁用'),
          item.toolName
        )
      } catch (err) {
        setBuiltinConfigError(
          err instanceof Error ? err.message : tSafe('toolsCenter.errors.save', '保存工具配置失败')
        )
        await loadData()
        toast.error(tSafe('toolsCenter.toast.saveFailed', '工具配置保存失败'))
      }
    },
    [builtinToolMap, loadData, tSafe, updateBuiltinTool]
  )

  const saveBuiltinEditor = useCallback(async () => {
    if (!editingBuiltin || !builtinForm) return
    const parseOptionalNumber = (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return undefined
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : null
    }
    const parseList = (value: string) =>
      value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean)

    const timeout = parseOptionalNumber(builtinForm.timeout)
    const retryAttempts = parseOptionalNumber(builtinForm.retryAttempts)
    const rateLimit = parseOptionalNumber(builtinForm.rateLimit)
    const maxReadBytes = parseOptionalNumber(builtinForm.maxReadBytes)
    const maxTextLength = parseOptionalNumber(builtinForm.maxTextLength)
    const maxResponseChars = parseOptionalNumber(builtinForm.maxResponseChars)
    const maxRows = parseOptionalNumber(builtinForm.maxRows)
    if ([timeout, retryAttempts, rateLimit, maxReadBytes, maxTextLength, maxResponseChars, maxRows].some((value) => value === null)) {
      setBuiltinConfigError(tSafe('toolsCenter.errors.invalidNumber', '数值字段格式无效'))
      return
    }

    const config: Record<string, unknown> = {
      requiresApproval: builtinForm.requiresApproval,
      riskLevel: builtinForm.riskLevel,
      approvalScope: builtinForm.approvalScope || 'session',
    }
    const visible = getBuiltinFieldVisibility(editingBuiltin.toolName)
    if (timeout !== undefined) config.timeout = timeout
    if (visible.retryAttempts && retryAttempts !== undefined) config.retryAttempts = retryAttempts
    if (rateLimit !== undefined) config.rateLimit = rateLimit
    if (visible.apiEndpoint && builtinForm.apiEndpoint.trim()) config.apiEndpoint = builtinForm.apiEndpoint.trim()
    if (visible.apiKey && builtinForm.apiKey.trim()) config.apiKey = builtinForm.apiKey.trim()
    if (visible.authType) config.authType = builtinForm.authType
    if (visible.authHeader && builtinForm.authHeader.trim()) config.authHeader = builtinForm.authHeader.trim()
    if (visible.allowLocalhost) config.allowLocalhost = builtinForm.allowLocalhost
    if (visible.allowedDomains) config.allowedDomains = parseList(builtinForm.allowedDomains)
    if (visible.blockedDomains) config.blockedDomains = parseList(builtinForm.blockedDomains)
    if (visible.headless) config.headless = builtinForm.headless
    if (visible.browserType) config.browserType = builtinForm.browserType
    if (visible.rootPath && builtinForm.rootPath.trim()) config.rootPath = builtinForm.rootPath.trim()
    if (visible.maxReadBytes && maxReadBytes !== undefined) config.maxReadBytes = maxReadBytes
    if (visible.maxTextLength && maxTextLength !== undefined) config.maxTextLength = maxTextLength
    if (visible.maxResponseChars && maxResponseChars !== undefined) config.maxResponseChars = maxResponseChars
    if (visible.maxRows && maxRows !== undefined) config.maxRows = maxRows
    if (visible.defaultDatabase && builtinForm.defaultDatabase.trim()) config.defaultDatabase = builtinForm.defaultDatabase.trim()

    try {
      setBuiltinConfigError(null)
      await updateBuiltinTool(editingBuiltin.toolName, {
        isActive: builtinForm.isActive,
        config,
      })
      toast.success(tSafe('toolsCenter.toast.saved', '工具配置已保存'), editingBuiltin.toolName)
      closeBuiltinEditor()
    } catch (err) {
      setBuiltinConfigError(
        err instanceof Error ? err.message : tSafe('toolsCenter.errors.save', '保存工具配置失败')
      )
      toast.error(tSafe('toolsCenter.toast.saveFailed', '工具配置保存失败'))
    }
  }, [
    builtinForm,
    closeBuiltinEditor,
    editingBuiltin,
    tSafe,
    updateBuiltinTool,
  ])

  const renderToolList = (items: ToolCatalogItem[], emptyTitle: string, emptyDescription: string, editable = false) => {
    if (items.length === 0) {
      return (
        <Card className="border-border-default">
          <CardContent className="p-6">
            <p className="text-sm font-medium text-text-primary">{emptyTitle}</p>
            <p className="mt-1 text-sm text-text-secondary">{emptyDescription}</p>
          </CardContent>
        </Card>
      )
    }
    return (
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {items.map((item) => (
          <Card key={item.toolId} className="border-border-default">
            <CardContent className="p-5 space-y-3">
              {(() => {
                const builtinRecord = builtinToolMap.get(item.toolName.toLowerCase())
                const isBuiltinEditable = editable && item.sourceType === 'builtin'
                const isActive = builtinRecord?.isActive !== false
                const isSaving = savingBuiltinName === item.toolName
                const cardCopy = buildToolCardCopy(item)
                return (
                  <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{item.displayName || item.toolName}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{cardCopy.summary}</p>
                </div>
                <div className="flex items-center gap-2">
                  {isBuiltinEditable ? (
                    <Badge variant="outline">{isActive ? tSafe('common.enabled', '启用') : tSafe('common.disabled', '禁用')}</Badge>
                  ) : null}
                  <Badge variant="outline">{item.sourceType}</Badge>
                </div>
              </div>
              {cardCopy.highlights.length > 0 ? (
                <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
                  {cardCopy.highlights.map((highlight) => (
                    <span key={highlight} className="rounded-full bg-bg-surface px-2.5 py-1">
                      {highlight}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 text-xs text-text-tertiary">
                <span className="rounded border border-border-subtle bg-bg-surface px-2 py-1 font-mono">
                  {item.toolName}
                </span>
                <span className="rounded border border-border-subtle bg-bg-surface px-2 py-1 font-mono">
                  {item.toolId}
                </span>
                {item.providerId ? (
                  <span className="rounded border border-border-subtle bg-bg-surface px-2 py-1">
                    provider: {item.providerId}
                  </span>
                ) : null}
              </div>
              {isBuiltinEditable ? (
                <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Power size={14} />}
                    loading={isSaving}
                    onClick={() => void toggleBuiltinTool(item)}
                  >
                    {isActive ? tSafe('toolsCenter.actions.disable', '禁用') : tSafe('toolsCenter.actions.enable', '启用')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Settings2 size={14} />}
                    onClick={() => openBuiltinEditor(item)}
                    disabled={isSaving}
                  >
                    {tSafe('toolsCenter.actions.editConfig', '编辑配置')}
                  </Button>
                </div>
              ) : null}
                  </>
                )
              })()}
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  const submitCliImport = useCallback(async () => {
    const command = cliCommand
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (command.length === 0) {
      setCliImportError(tSafe('toolsCenter.cli.import.empty', '请输入要导入的 CLI 命令前缀'))
      return
    }
    setIsImportingCli(true)
    setCliImportError(null)
    try {
      await apiClient.post<ApiResponse<CliImportRequestItem>>('/tools/import-cli', {
        command,
        shape: cliShape,
        source: 'web',
      })
      setCliCommand('')
      await loadData()
    } catch (err) {
      setCliImportError(err instanceof Error ? err.message : tSafe('toolsCenter.cli.import.failed', 'CLI 导入失败'))
    } finally {
      setIsImportingCli(false)
    }
  }, [cliCommand, cliShape, loadData, tSafe])

  const resolveCliImport = useCallback(
    async (requestId: string, approved: boolean) => {
      try {
        setCliImportError(null)
        await apiClient.post<ApiResponse<CliImportRequestItem>>(`/tools/import-cli/${requestId}/decision`, {
          approved,
        })
        await loadData()
      } catch (err) {
        setCliImportError(err instanceof Error ? err.message : tSafe('toolsCenter.cli.import.failed', 'CLI 导入失败'))
      }
    },
    [loadData, tSafe]
  )

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold text-text-primary">
                  {tSafe('toolsCenter.title', '工具中心')}
                </h1>
                <p className="text-sm text-text-secondary">
                  {tSafe(
                    'toolsCenter.subtitle',
                    '统一查看内建工具、MCP 服务器和 CLI 工具。高级编辑仍保留在原有配置页面。'
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={() => void loadData()} disabled={isLoading}>
                  {tSafe('common.refresh', '刷新')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {error ? <InlineErrorAlert message={error} onClose={() => setError(null)} /> : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map((card) => (
            <Card key={card.label} className="border-border-default">
              <CardContent className="p-5">
                <p className="text-sm text-text-secondary">{card.label}</p>
                <p className="mt-2 text-3xl font-semibold text-text-primary">{card.value}</p>
                <p className="mt-2 text-xs text-text-tertiary">{card.helper}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => updateActiveTab(tab.id)}
                className={[
                  'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors',
                  active
                    ? 'border-primary-500 bg-primary-500/10 text-primary-500'
                    : 'border-border-subtle bg-bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary',
                ].join(' ')}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
                <Badge variant="outline">{tab.count}</Badge>
              </button>
            )
          })}
        </div>

        {activeTab === 'builtin' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {tSafe('toolsCenter.sections.builtinTitle', '内建工具')}
                </h2>
                <p className="text-sm text-text-secondary">
                  {tSafe('toolsCenter.sections.builtinDescription', '这些能力随 runtime 提供，可直接进入 catalog。')}
                </p>
              </div>
            </div>
            {renderToolList(
              builtinTools,
              tSafe('toolsCenter.empty.builtinTitle', '暂无内建工具'),
              tSafe('toolsCenter.empty.builtinDescription', '当前 runtime 没有返回任何内建工具。'),
              true
            )}
          </div>
        ) : null}

        {activeTab === 'mcp' ? (
          <McpServersManager embedded />
        ) : null}

        {activeTab === 'cli' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-text-primary">
                  {tSafe('toolsCenter.sections.cliTitle', 'CLI 工具')}
                </h2>
                <p className="text-sm text-text-secondary">
                  {tSafe('toolsCenter.sections.cliDescription', '本地 harness、命令包装器和通过 package 带入的工具。')}
                </p>
              </div>
              <Link href="/skills" className="inline-flex">
                <Button variant="tertiary" rightIcon={<ExternalLink size={14} />}>
                  {tSafe('toolsCenter.actions.openSkills', '查看技能包')}
                </Button>
              </Link>
            </div>
            <Card className="border-border-default">
              <CardContent className="p-5 space-y-4">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    {tSafe('toolsCenter.cli.import.title', '导入 CLI 工具')}
                  </p>
                  <p className="mt-1 text-sm text-text-secondary">
                    {tSafe('toolsCenter.cli.import.description', '输入一个终端可用的命令前缀，按 direct 或 group 导入。')}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-[1fr_160px_auto]">
                  <input
                    value={cliCommand}
                    onChange={(event) => setCliCommand(event.target.value)}
                    placeholder="opencli xiaohongshu"
                    className="h-10 rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none"
                  />
                  <select
                    value={cliShape}
                    onChange={(event) => setCliShape(event.target.value === 'group' ? 'group' : 'direct')}
                    className="h-10 rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none"
                  >
                    <option value="direct">direct</option>
                    <option value="group">group</option>
                  </select>
                  <Button onClick={() => void submitCliImport()} disabled={isImportingCli}>
                    {isImportingCli
                      ? tSafe('toolsCenter.cli.import.importing', '导入中...')
                      : tSafe('toolsCenter.cli.import.submit', '导入')}
                  </Button>
                </div>
                {cliImportError ? <InlineErrorAlert message={cliImportError} onClose={() => setCliImportError(null)} /> : null}
              </CardContent>
            </Card>
            {renderToolList(
              cliTools,
              tSafe('toolsCenter.empty.cliTitle', '暂无 CLI 工具'),
              tSafe('toolsCenter.empty.cliDescription', '当前没有检测到来自本地 harness 或 package 的 CLI 工具。')
            )}
            <Card className="border-border-default">
              <CardContent className="p-5 space-y-4">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    {tSafe('toolsCenter.cli.requests.title', 'CLI 导入请求')}
                  </p>
                  <p className="mt-1 text-sm text-text-secondary">
                    {tSafe('toolsCenter.cli.requests.description', '展示最近的 CLI 导入与审批状态。')}
                  </p>
                </div>
                {cliImports.length === 0 ? (
                  <p className="text-sm text-text-secondary">
                    {tSafe('toolsCenter.cli.requests.empty', '还没有 CLI 导入请求。')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {cliImports.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border-default p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <p className="text-sm font-semibold text-text-primary">
                              {item.display_name || item.tool_name}
                            </p>
                            <p className="text-sm text-text-secondary">{(item.command || []).join(' ')}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{item.shape}</Badge>
                            <Badge variant="outline">{item.status}</Badge>
                          </div>
                        </div>
                        {item.description ? <p className="mt-2 text-sm text-text-secondary">{item.description}</p> : null}
                        {item.error ? <p className="mt-2 text-sm text-red-500">{item.error}</p> : null}
                        {item.status === 'awaiting_approval' ? (
                          <div className="mt-3 flex items-center gap-2">
                            <Button size="sm" onClick={() => void resolveCliImport(item.id, true)}>
                              {tSafe('toolsCenter.cli.requests.approve', '批准')}
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => void resolveCliImport(item.id, false)}>
                              {tSafe('toolsCenter.cli.requests.reject', '拒绝')}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}

        <Modal
          open={!!editingBuiltin}
          onClose={closeBuiltinEditor}
          title={tSafe('toolsCenter.builtinEditor.title', '编辑内建工具配置')}
          description={
            editingBuiltin
              ? `${editingBuiltin.displayName || editingBuiltin.toolName} · ${editingBuiltin.toolName}`
              : undefined
          }
          maxWidth="lg"
          footer={
            <>
              <Button variant="secondary" onClick={closeBuiltinEditor} disabled={!!savingBuiltinName}>
                {tSafe('common.cancel', '取消')}
              </Button>
              <Button onClick={() => void saveBuiltinEditor()} loading={!!savingBuiltinName}>
                {tSafe('common.save', '保存')}
              </Button>
            </>
          }
        >
          <div className="space-y-5">
            {builtinConfigError ? (
              <InlineErrorAlert message={builtinConfigError} onClose={() => setBuiltinConfigError(null)} />
            ) : null}
            {(() => {
              const visible = editingBuiltin ? getBuiltinFieldVisibility(editingBuiltin.toolName) : null
              return (
                <>
            <label className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
              <input
                type="checkbox"
                checked={builtinForm?.isActive ?? true}
                onChange={(event) =>
                  setBuiltinForm((prev) => (prev ? { ...prev, isActive: event.target.checked } : prev))
                }
                className="h-4 w-4 accent-current"
              />
              <div>
                <div className="text-sm font-medium text-text-primary">
                  {tSafe('toolsCenter.builtinEditor.activeLabel', '启用该内建工具')}
                </div>
                <div className="mt-1 text-xs text-text-secondary">
                  {tSafe('toolsCenter.builtinEditor.activeHint', '关闭后 runtime 将不再把该工具暴露给 agent。')}
                </div>
              </div>
            </label>

            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">timeout</div>
                  <input value={builtinForm?.timeout ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, timeout: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                {visible?.retryAttempts ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">retryAttempts</div>
                  <input value={builtinForm?.retryAttempts ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, retryAttempts: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">rateLimit</div>
                  <input value={builtinForm?.rateLimit ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, rateLimit: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                {visible?.apiEndpoint ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">apiEndpoint</div>
                  <input value={builtinForm?.apiEndpoint ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, apiEndpoint: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.apiKey ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">apiKey</div>
                  <input value={builtinForm?.apiKey ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, apiKey: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.authType ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">authType</div>
                  <select value={builtinForm?.authType ?? 'none'} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, authType: e.target.value as BuiltinToolFormState['authType'] } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500">
                    <option value="none">none</option>
                    <option value="bearer">bearer</option>
                    <option value="basic">basic</option>
                    <option value="api_key">api_key</option>
                  </select>
                </label>
                ) : null}
                {visible?.authHeader ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">authHeader</div>
                  <input value={builtinForm?.authHeader ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, authHeader: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">riskLevel</div>
                  <select value={builtinForm?.riskLevel ?? 'low'} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, riskLevel: e.target.value as BuiltinToolFormState['riskLevel'] } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500">
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">approvalScope</div>
                  <select value={builtinForm?.approvalScope ?? 'session'} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, approvalScope: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500">
                    <option value="call">call</option>
                    <option value="action">action</option>
                    <option value="target">target</option>
                    <option value="session">session</option>
                    <option value="session_action">session_action</option>
                    <option value="tool">tool</option>
                  </select>
                </label>
                <label className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
                  <input type="checkbox" checked={builtinForm?.requiresApproval ?? false} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, requiresApproval: e.target.checked } : prev))} className="h-4 w-4 accent-current" />
                  <span className="text-sm text-text-primary">requiresApproval</span>
                </label>
                {visible?.allowLocalhost ? (
                <label className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
                  <input type="checkbox" checked={builtinForm?.allowLocalhost ?? false} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, allowLocalhost: e.target.checked } : prev))} className="h-4 w-4 accent-current" />
                  <span className="text-sm text-text-primary">allowLocalhost</span>
                </label>
                ) : null}
                {visible?.headless ? (
                <label className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface px-4 py-3">
                  <input type="checkbox" checked={builtinForm?.headless ?? true} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, headless: e.target.checked } : prev))} className="h-4 w-4 accent-current" />
                  <span className="text-sm text-text-primary">headless</span>
                </label>
                ) : null}
                {visible?.browserType ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">browserType</div>
                  <select value={builtinForm?.browserType ?? 'chromium'} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, browserType: e.target.value as BuiltinToolFormState['browserType'] } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500">
                    <option value="chromium">chromium</option>
                    <option value="firefox">firefox</option>
                    <option value="webkit">webkit</option>
                  </select>
                </label>
                ) : null}
                {visible?.rootPath ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">rootPath</div>
                  <input value={builtinForm?.rootPath ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, rootPath: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.maxReadBytes ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">maxReadBytes</div>
                  <input value={builtinForm?.maxReadBytes ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, maxReadBytes: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.maxTextLength ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">maxTextLength</div>
                  <input value={builtinForm?.maxTextLength ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, maxTextLength: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.maxResponseChars ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">maxResponseChars</div>
                  <input value={builtinForm?.maxResponseChars ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, maxResponseChars: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.maxRows ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">maxRows</div>
                  <input value={builtinForm?.maxRows ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, maxRows: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.defaultDatabase ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">defaultDatabase</div>
                  <input value={builtinForm?.defaultDatabase ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, defaultDatabase: e.target.value } : prev))} className="h-10 w-full rounded-md border border-border-default bg-bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
              </div>
              {visible?.allowedDomains || visible?.blockedDomains ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {visible?.allowedDomains ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">allowedDomains</div>
                  <textarea value={builtinForm?.allowedDomains ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, allowedDomains: e.target.value } : prev))} className="min-h-[120px] w-full rounded-md border border-border-default bg-bg-surface px-3 py-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
                {visible?.blockedDomains ? (
                <label className="space-y-1">
                  <div className="text-xs text-text-secondary">blockedDomains</div>
                  <textarea value={builtinForm?.blockedDomains ?? ''} onChange={(e) => setBuiltinForm((prev) => (prev ? { ...prev, blockedDomains: e.target.value } : prev))} className="min-h-[120px] w-full rounded-md border border-border-default bg-bg-surface px-3 py-3 text-sm text-text-primary outline-none focus:border-primary-500" />
                </label>
                ) : null}
              </div>
              ) : null}
            </div>
                </>
              )
            })()}
          </div>
        </Modal>
      </div>
    </div>
  )
}
