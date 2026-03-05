'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Search, Plus, RefreshCw, AlertCircle, Package, Loader2, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { FileUpload } from '@/components/ui/FileUpload'
import { Modal } from '@/components/ui/Modal'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { SkillDefinition } from '@semibot/shared-types'
import { useLocale } from '@/components/providers/LocaleProvider'

interface RuntimeSkillsResponse {
  success: boolean
  data?: {
    available?: boolean
    tools?: string[]
    skills?: string[]
    metadata?: Array<Record<string, unknown>>
    source?: string
    error?: string
  }
}

interface SkillsCliResponse {
  success?: boolean
  data?: {
    stdout?: string
    stderr?: string
    syncedSkills?: string[]
    candidates?: string[]
  }
}

export default function SkillDefinitionsPage() {
  const { t } = useLocale()
  const [definitions, setDefinitions] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [skillsCliLoading, setSkillsCliLoading] = useState(false)
  const [skillsCliActionLoading, setSkillsCliActionLoading] = useState<'init' | 'update' | 'find' | 'add' | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // 创建表单状态
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createFile, setCreateFile] = useState<File | null>(null)
  const [createUploadError, setCreateUploadError] = useState('')
  const [directoryFiles, setDirectoryFiles] = useState<File[]>([])
  const [directoryName, setDirectoryName] = useState<string>('')
  const [skillsCliQuery, setSkillsCliQuery] = useState('')
  const [skillsCliSkill, setSkillsCliSkill] = useState('')
  const [skillsCliOutput, setSkillsCliOutput] = useState('')
  const [skillsCliCandidates, setSkillsCliCandidates] = useState<string[]>([])
  const directoryInputRef = useRef<HTMLInputElement | null>(null)

  const buildDefinitionsFromRuntime = useCallback((runtimeData?: RuntimeSkillsResponse['data']): SkillDefinition[] => {
    const metadataRows = Array.isArray(runtimeData?.metadata) ? runtimeData?.metadata : []
    const nowIso = new Date().toISOString()
    const fromMetadata: SkillDefinition[] = metadataRows
      .map((row, idx) => {
        const skillId = String(row.skill_id || row.name || `skill_${idx}`)
        const name = String(row.name || skillId)
        const description = String(row.description || '')
        const tags = Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)) : []
        const status = String(row.status || 'active')
        const createdAt = String(row.installed_at || nowIso)
        const updatedAt = String(row.indexed_at || nowIso)
        return {
          id: `runtime:${skillId}`,
          skillId,
          name,
          description,
          triggerKeywords: [],
          category: String(row.source || 'package'),
          tags,
          isActive: status === 'active',
          isPublic: false,
          createdAt,
          updatedAt,
        }
      })

    const builtinSkillNames = Array.isArray(runtimeData?.skills) ? runtimeData.skills : []
    const builtinSkillLike = builtinSkillNames
      .filter((name) => name === 'pdf' || name === 'xlsx')
      .map<SkillDefinition>((name) => ({
        id: `builtin:${name}`,
        skillId: name,
        name,
        description: '',
        triggerKeywords: [],
        category: 'builtin',
        tags: ['builtin'],
        isActive: true,
        isPublic: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      }))

    const merged = [...fromMetadata, ...builtinSkillLike]
    const dedup = new Map<string, SkillDefinition>()
    for (const item of merged) {
      if (!dedup.has(item.skillId)) dedup.set(item.skillId, item)
    }
    return Array.from(dedup.values())
  }, [])

  const applyDefinitionsSafely = useCallback((next: SkillDefinition[]) => {
    setDefinitions((prev) => {
      const prevHasCustom = prev.some((item) => item.category !== 'builtin')
      const nextHasCustom = next.some((item) => item.category !== 'builtin')
      if (prevHasCustom && !nextHasCustom) return prev
      return next
    })
  }, [])

  useEffect(() => {
    if (!directoryInputRef.current) return
    directoryInputRef.current.setAttribute('webkitdirectory', '')
    directoryInputRef.current.setAttribute('directory', '')
  }, [showCreateDialog])

  const loadDefinitions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const runtime = await apiClient.get<RuntimeSkillsResponse>('/runtime/skills')
      const runtimeData = runtime.data
      if (runtime.success && runtimeData?.available) {
        const next = buildDefinitionsFromRuntime(runtimeData)
        applyDefinitionsSafely(next)
        return
      }
      // Runtime temporarily unavailable: keep existing list to avoid UI flashing back to legacy data source.
    } catch (err) {
      console.error('[SkillDefinitions] 加载失败:', err)
      setError(t('skillsPage.error.load'))
    } finally {
      setLoading(false)
    }
  }, [applyDefinitionsSafely, buildDefinitionsFromRuntime, t])

  const waitForSyncedSkillsVisible = useCallback(
    async (expectedSkills: string[]) => {
      const targets = expectedSkills.map((item) => item.trim()).filter(Boolean)
      if (targets.length === 0) return
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const runtime = await apiClient.get<RuntimeSkillsResponse>('/runtime/skills')
        const runtimeData = runtime.data
        if (!runtime.success || !runtimeData?.available) continue
        const next = buildDefinitionsFromRuntime(runtimeData)
        const ids = new Set(next.map((item) => item.skillId))
        const ready = targets.every((name) => ids.has(name))
        if (ready) {
          applyDefinitionsSafely(next)
          return
        }
      }
    },
    [applyDefinitionsSafely, buildDefinitionsFromRuntime]
  )

  useEffect(() => {
    loadDefinitions()
  }, [loadDefinitions])

  const handleCreate = async () => {
    if (!createFile && directoryFiles.length === 0) return

    try {
      setUploadLoading(true)
      setError(null)

      let uploadFile = createFile
      if (!uploadFile && directoryFiles.length > 0) {
        const JSZip = (await import('jszip')).default
        const zip = new JSZip()
        for (const file of directoryFiles) {
          const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
          zip.file(relativePath, file)
        }
        const blob = await zip.generateAsync({ type: 'blob' })
        const name = directoryName ? `${directoryName}.zip` : 'skill-directory.zip'
        uploadFile = new File([blob], name, { type: 'application/zip' })
      }
      if (!uploadFile) {
        setCreateUploadError('请选择 zip 包或目录')
        return
      }

      const formData = new FormData()
      formData.append('file', uploadFile)
      formData.append('force', 'false')

      await apiClient.upload('/runtime/skills/install/upload', formData)
      await apiClient.post('/runtime/skills/refresh-runtime', {})

      setShowCreateDialog(false)
      setCreateFile(null)
      setCreateUploadError('')
      setDirectoryFiles([])
      setDirectoryName('')
      await loadDefinitions()
      toast.success('技能安装成功', `已安装 ${uploadFile.name}`)
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const message = error.response?.data?.error?.message || error.message || t('skillsPage.error.create')
      setError(message)
      toast.error('技能安装失败', message)
    } finally {
      setUploadLoading(false)
    }
  }

  const handleSkillsCliAction = async (action: 'init' | 'update' | 'find' | 'add') => {
    try {
      setSkillsCliLoading(true)
      setSkillsCliActionLoading(action)
      setError(null)
      setSkillsCliOutput('')
      const payload: Record<string, unknown> = { action }
      if (action === 'find') {
        payload.query = skillsCliQuery.trim()
      }
      if (action === 'add') {
        payload.skill = skillsCliSkill.trim()
      }
      const response = await apiClient.post<SkillsCliResponse>(
        '/runtime/skills/skills-cli',
        payload
      )
      const data = response?.data
      const lines = [
        data?.stdout || '',
        data?.stderr || '',
        Array.isArray(data?.syncedSkills) && data?.syncedSkills.length > 0
          ? `synced: ${data?.syncedSkills.join(', ')}`
          : '',
      ]
      const output = lines.filter(Boolean).join('\n').trim()
      setSkillsCliOutput(output)
      if (action === 'find') {
        const fromBackend = Array.isArray(data?.candidates)
          ? data.candidates
              .map((item) => String(item || '').trim())
              .filter((item) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/i.test(item))
          : []
        if (fromBackend.length > 0) {
          setSkillsCliCandidates(Array.from(new Set(fromBackend)))
        } else {
          const packagePattern = /\b([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*)\b/gi
          const matches = output.match(packagePattern) || []
          const candidates = Array.from(new Set(matches.map((item) => item.trim()).filter(Boolean)))
          setSkillsCliCandidates(candidates)
        }
      } else {
        setSkillsCliCandidates([])
      }
      if (action === 'add' || action === 'update' || action === 'init') {
        await loadDefinitions()
        const synced = Array.isArray(data?.syncedSkills) ? data.syncedSkills : []
        await waitForSyncedSkillsVisible(synced)
        if (action === 'add') {
          toast.success(
            'Skills.sh 安装完成',
            synced.length > 0 ? `已同步: ${synced.join(', ')}` : '安装完成，未发现新增技能目录'
          )
        } else {
          toast.success(
            action === 'init' ? '技能库初始化完成' : '技能库更新完成',
            synced.length > 0 ? `已同步 ${synced.length} 个技能` : '未检测到新增技能'
          )
        }
      }
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const message = error.response?.data?.error?.message || error.message || 'skills cli failed'
      setError(message)
      toast.error('Skills.sh 操作失败', message)
      setSkillsCliCandidates([])
    } finally {
      setSkillsCliLoading(false)
      setSkillsCliActionLoading(null)
    }
  }

  const handleToggleActive = async (definition: SkillDefinition) => {
    if (definition.id.startsWith('builtin:')) {
      setError('内置技能暂不支持在此页面启停。')
      return
    }
    try {
      setActionLoading(true)
      setError(null)

      if (definition.id.startsWith('runtime:')) {
        await apiClient.post(`/control/skills/${definition.isActive ? 'disable' : 'enable'}`, {
          payload: { skill_id: definition.skillId },
        })
      } else {
        await apiClient.put(`/skill-definitions/${definition.id}`, {
          isActive: !definition.isActive,
        })
      }

      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } } }
      console.error('[SkillDefinitions] 切换状态失败:', err)
      setError(error.response?.data?.error?.message || t('skillsPage.error.toggle'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async (definition: SkillDefinition) => {
    if (definition.id.startsWith('builtin:')) {
      setError('内置技能暂不支持删除。')
      return
    }
    if (!confirm(t('skillsPage.confirm.delete', { name: definition.name }))) return

    try {
      setActionLoading(true)
      setError(null)

      if (definition.id.startsWith('runtime:')) {
        await apiClient.post('/control/skills/uninstall', {
          payload: { skill_id: definition.skillId },
        })
      } else {
        await apiClient.delete(`/skill-definitions/${definition.id}`)
      }

      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } } }
      console.error('[SkillDefinitions] 删除失败:', err)
      setError(error.response?.data?.error?.message || t('skillsPage.error.delete'))
    } finally {
      setActionLoading(false)
    }
  }

  const filteredDefinitions = definitions.filter(
    (def) =>
      def.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      def.skillId.toLowerCase().includes(searchQuery.toLowerCase()) ||
      def.description?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const filteredIds = useMemo(() => filteredDefinitions.map((def) => def.id), [filteredDefinitions])
  const selectedCount = selectedIds.length
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.includes(id))
  const modalBusy = uploadLoading || skillsCliLoading
  const installLabel = (() => {
    const text = t('skillsPage.install')
    return text === 'skillsPage.install' ? '安装技能' : text
  })()

  useEffect(() => {
    const validIds = new Set(definitions.map((def) => def.id))
    setSelectedIds((prev) => prev.filter((id) => validIds.has(id)))
  }, [definitions])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      if (allFilteredSelected) {
        return prev.filter((id) => !filteredIds.includes(id))
      }
      const next = new Set(prev)
      filteredIds.forEach((id) => next.add(id))
      return Array.from(next)
    })
  }

  const handleBatchSetActive = async (isActive: boolean) => {
    if (selectedIds.length === 0) return
    try {
      setActionLoading(true)
      setError(null)
      const total = selectedIds.length
      const selectedDefs = definitions.filter((def) => selectedIds.includes(def.id))
      const results = await Promise.allSettled(
        selectedDefs.map((def) => {
          if (def.id.startsWith('builtin:')) {
            return Promise.reject(new Error('builtin skill immutable'))
          }
          if (def.id.startsWith('runtime:')) {
            return apiClient.post(`/control/skills/${isActive ? 'enable' : 'disable'}`, {
              payload: { skill_id: def.skillId },
            })
          }
          return apiClient.put(`/skill-definitions/${def.id}`, { isActive })
        })
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      setSelectedIds([])
      await loadDefinitions()
      if (failed > 0) {
        setError(t('skillsPage.error.batchToggle', { failed, total }))
      }
    } finally {
      setActionLoading(false)
    }
  }

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) return
    if (!confirm(t('skillsPage.confirm.batchDelete', { count: selectedIds.length }))) return

    try {
      setActionLoading(true)
      setError(null)
      const total = selectedIds.length
      const selectedDefs = definitions.filter((def) => selectedIds.includes(def.id))
      const results = await Promise.allSettled(
        selectedDefs.map((def) => {
          if (def.id.startsWith('builtin:')) {
            return Promise.reject(new Error('builtin skill immutable'))
          }
          if (def.id.startsWith('runtime:')) {
            return apiClient.post('/control/skills/uninstall', {
              payload: { skill_id: def.skillId },
            })
          }
          return apiClient.delete(`/skill-definitions/${def.id}`)
        })
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      setSelectedIds([])
      await loadDefinitions()
      if (failed > 0) {
        setError(t('skillsPage.error.batchDelete', { failed, total }))
      }
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-primary-500 mx-auto mb-4" />
          <p className="text-text-secondary">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        {/* 头部 */}
        <header className="border-b border-border-subtle pb-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-text-primary">{t('skillsPage.title')}</h1>
              <p className="text-sm text-text-secondary mt-1">
                {t('skillsPage.subtitlePrefix')} {definitions.length} {t('skillsPage.subtitleSuffix')}
              </p>
            </div>
            <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreateDialog(true)}>
              {installLabel}
            </Button>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="mt-3 rounded-md px-3 py-2 border bg-error-500/10 border-error-500/20">
              <div className="flex items-start">
                <AlertCircle className="w-4 h-4 text-error-500 mr-2 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-error-500">{error}</p>
              </div>
            </div>
          )}

          {/* 搜索栏 */}
          <div className="flex items-center gap-4 mt-4">
            <div className="flex-1 max-w-md">
              <Input
                placeholder={t('skillsPage.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                leftIcon={<Search size={16} />}
              />
            </div>
            <Button variant="secondary" onClick={loadDefinitions}>
              <RefreshCw className="w-4 h-4 mr-2" />
              {t('common.refresh')}
            </Button>
            {filteredDefinitions.length > 0 && (
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  data-testid="skills-select-all"
                  type="checkbox"
                  className="rounded border-border-default"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAllFiltered}
                  disabled={actionLoading}
                />
                {t('skillsPage.batch.selectAllVisible')}
              </label>
            )}
          </div>

          {selectedCount > 0 && (
            <div className="mt-3 rounded-md border border-primary-500/30 bg-primary-500/10 px-3 py-2 flex flex-wrap items-center gap-2">
              <span className="text-sm text-text-primary">
                {t('skillsPage.batch.selectedCount', { count: selectedCount })}
              </span>
              <Button
                data-testid="skills-batch-enable"
                variant="secondary"
                size="sm"
                disabled={actionLoading}
                onClick={() => handleBatchSetActive(true)}
              >
                {t('skillsPage.batch.enable')}
              </Button>
              <Button
                data-testid="skills-batch-disable"
                variant="secondary"
                size="sm"
                disabled={actionLoading}
                onClick={() => handleBatchSetActive(false)}
              >
                {t('skillsPage.batch.disable')}
              </Button>
              <Button
                data-testid="skills-batch-delete"
                variant="secondary"
                size="sm"
                disabled={actionLoading}
                onClick={handleBatchDelete}
              >
                {t('skillsPage.batch.delete')}
              </Button>
            </div>
          )}
        </header>

        {/* 技能列表 */}
        <div>
          {filteredDefinitions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="w-16 h-16 rounded-2xl bg-bg-elevated flex items-center justify-center mb-4">
                <Package size={32} className="text-text-tertiary" />
              </div>
              <h3 className="text-lg font-medium text-text-primary">{t('skillsPage.emptyTitle')}</h3>
              <p className="text-sm text-text-secondary mt-1">{t('skillsPage.emptyDescription')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredDefinitions.map((definition) => (
                <Card key={definition.id}>
                  <CardContent>
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 min-w-0">
                        <input
                          data-testid={`skill-select-${definition.id}`}
                          type="checkbox"
                          className="mt-1 rounded border-border-default"
                          checked={selectedIds.includes(definition.id)}
                          onChange={() => toggleSelect(definition.id)}
                          disabled={actionLoading}
                        />
                        <div className="w-9 h-9 rounded-md bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                          <Zap size={16} className="text-primary-400" />
                        </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text-primary">{definition.name}</div>
                        <div className="text-xs text-text-secondary mt-0.5">
                          {definition.description || t('skillsPage.noDescription')}
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-base text-text-tertiary border border-border-subtle font-mono">
                            {definition.skillId}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className={clsx(
                              'w-1.5 h-1.5 rounded-full',
                              definition.isActive ? 'bg-success-500' : 'bg-text-tertiary'
                            )} />
                            <span className={clsx(
                              'text-[11px]',
                              definition.isActive ? 'text-success-500' : 'text-text-tertiary'
                            )}>
                              {definition.isActive ? t('skillsPage.enabled') : t('skillsPage.disabled')}
                            </span>
                          </div>
                        </div>
                        {definition.category && (
                          <div className="text-[11px] text-text-tertiary mt-1.5">
                            {definition.category}
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(definition)}
                      disabled={actionLoading}
                      className="p-1.5 text-text-tertiary hover:text-error-500 flex-shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-end gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleToggleActive(definition)}
                      disabled={actionLoading}
                    >
                      {definition.isActive ? t('skillsPage.disable') : t('skillsPage.enable')}
                    </Button>
                  </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={showCreateDialog}
        onClose={() => {
          setShowCreateDialog(false)
          setCreateFile(null)
          setCreateUploadError('')
          setDirectoryFiles([])
          setDirectoryName('')
          setSkillsCliOutput('')
          setSkillsCliCandidates([])
        }}
        title={t('skillsPage.install')}
        description={t('skillsPage.createDescription')}
        maxWidth="xl"
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setShowCreateDialog(false)
              setCreateFile(null)
              setCreateUploadError('')
              setDirectoryFiles([])
              setDirectoryName('')
              setSkillsCliOutput('')
              setSkillsCliCandidates([])
            }}
            disabled={modalBusy}
          >
            {t('common.close')}
          </Button>
        }
      >
        <div className="space-y-6">
          <section className="rounded-lg border border-border-subtle p-4 space-y-3">
            <h3 className="text-sm font-semibold text-text-primary">安装包安装</h3>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">{t('skillsPage.packageLabel')}</label>
              <FileUpload
                accept=".zip,.tar.gz,.tgz"
                allowedExtensions={['.zip', '.tar.gz', '.tgz']}
                maxSize={100 * 1024 * 1024}
                value={createFile}
                onFileSelect={setCreateFile}
                error={createUploadError}
                onError={setCreateUploadError}
                hint={t('skillsPage.packageHint')}
                disabled={modalBusy}
              />
            </div>
            <div className="rounded-lg border border-border-subtle p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-text-secondary">或上传技能目录</div>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => directoryInputRef.current?.click()}
                  disabled={uploadLoading}
                >
                  选择目录
                </Button>
              </div>
              <input
                ref={directoryInputRef}
                type="file"
                className="hidden"
                multiple
                onChange={(event) => {
                  const files = event.target.files ? Array.from(event.target.files) : []
                  setDirectoryFiles(files)
                  const first = files[0] as (File & { webkitRelativePath?: string }) | undefined
                  const root = first?.webkitRelativePath?.split('/')[0] || ''
                  setDirectoryName(root)
                  if (files.length > 0) {
                    setCreateFile(null)
                    setCreateUploadError('')
                  }
                  event.currentTarget.value = ''
                }}
              />
              {directoryFiles.length > 0 && (
                <div className="mt-2 text-xs text-text-tertiary">
                  已选择目录 {directoryName || '(未命名)'}，共 {directoryFiles.length} 个文件（提交时自动打包为 zip）
                </div>
              )}
            </div>
            <div className="pt-1">
              <Button onClick={handleCreate} loading={uploadLoading} disabled={uploadLoading || (!createFile && directoryFiles.length === 0)}>
                {t('skillsPage.uploadAndInstall')}
              </Button>
            </div>
          </section>

          <section className="rounded-lg border border-border-subtle p-4 space-y-3">
            <h3 className="text-sm font-semibold text-text-primary">Skills.sh 安装</h3>
            <p className="text-xs text-text-tertiary">
              使用 npx skills 管理并同步 ~/.agents/skills 到 ~/.semibot/skills
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={skillsCliLoading || uploadLoading}
                loading={skillsCliActionLoading === 'init'}
                onClick={() => handleSkillsCliAction('init')}
              >
                初始化技能库
              </Button>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={skillsCliLoading || uploadLoading}
                loading={skillsCliActionLoading === 'update'}
                onClick={() => handleSkillsCliAction('update')}
              >
                更新技能库
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
              <Input placeholder="输入关键词搜索（例如 deep research）" value={skillsCliQuery} onChange={(e) => setSkillsCliQuery(e.target.value)} disabled={skillsCliLoading || uploadLoading} />
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={skillsCliLoading || uploadLoading || !skillsCliQuery.trim()}
                loading={skillsCliActionLoading === 'find'}
                onClick={() => handleSkillsCliAction('find')}
              >
                搜索技能
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
              <Input placeholder="输入技能包名（例如 owner/repo@skill-id）" value={skillsCliSkill} onChange={(e) => setSkillsCliSkill(e.target.value)} disabled={skillsCliLoading || uploadLoading} />
              <Button
                size="sm"
                type="button"
                disabled={skillsCliLoading || uploadLoading || !skillsCliSkill.trim()}
                loading={skillsCliActionLoading === 'add'}
                onClick={() => handleSkillsCliAction('add')}
              >
                安装该技能
              </Button>
            </div>
            {skillsCliOutput && (
              <div className="space-y-2">
                {skillsCliCandidates.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {skillsCliCandidates.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="rounded border border-border-default px-2 py-1 text-xs text-text-primary hover:border-primary-500 hover:text-primary-500"
                        onClick={() => setSkillsCliSkill(name)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
                <pre className="max-h-64 overflow-auto rounded bg-bg-muted p-2 text-xs text-text-secondary whitespace-pre-wrap">
                  {skillsCliOutput}
                </pre>
              </div>
            )}
          </section>
        </div>
      </Modal>
    </div>
  )
}
