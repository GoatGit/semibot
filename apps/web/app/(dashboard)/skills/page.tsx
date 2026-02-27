'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Search, Plus, RefreshCw, AlertCircle, Package, Loader2, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { FileUpload } from '@/components/ui/FileUpload'
import { apiClient } from '@/lib/api'
import type { SkillDefinition } from '@semibot/shared-types'
import { useLocale } from '@/components/providers/LocaleProvider'

interface ApiResponse<T> {
  success: boolean
  data: T
  meta?: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

export default function SkillDefinitionsPage() {
  const { t } = useLocale()
  const [definitions, setDefinitions] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // 创建表单状态
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createFile, setCreateFile] = useState<File | null>(null)
  const [createUploadError, setCreateUploadError] = useState('')

  const loadDefinitions = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await apiClient.get<ApiResponse<SkillDefinition[]>>('/skill-definitions', {
        params: { page: 1, limit: 100 },
      })
      if (response.success) {
        setDefinitions(response.data || [])
      }
    } catch (err) {
      console.error('[SkillDefinitions] 加载失败:', err)
      setError(t('skillsPage.error.load'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadDefinitions()
  }, [loadDefinitions])

  const handleCreate = async () => {
    if (!createFile) return

    try {
      setActionLoading(true)
      setError(null)

      const formData = new FormData()
      formData.append('file', createFile)
      formData.append('enableRetry', 'true')

      await apiClient.upload('/skill-definitions/upload-create', formData)

      setShowCreateDialog(false)
      setCreateFile(null)
      setCreateUploadError('')
      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } }; message?: string }
      setError(error.response?.data?.error?.message || error.message || t('skillsPage.error.create'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleToggleActive = async (definition: SkillDefinition) => {
    try {
      setActionLoading(true)
      setError(null)

      await apiClient.put(`/skill-definitions/${definition.id}`, {
        isActive: !definition.isActive,
      })

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
    if (!confirm(t('skillsPage.confirm.delete', { name: definition.name }))) return

    try {
      setActionLoading(true)
      setError(null)

      await apiClient.delete(`/skill-definitions/${definition.id}`)

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
      const results = await Promise.allSettled(
        selectedIds.map((id) =>
          apiClient.put(`/skill-definitions/${id}`, { isActive })
        )
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
      const results = await Promise.allSettled(
        selectedIds.map((id) => apiClient.delete(`/skill-definitions/${id}`))
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
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 头部 */}
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">{t('skillsPage.title')}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {t('skillsPage.subtitlePrefix')} {definitions.length} {t('skillsPage.subtitleSuffix')}
            </p>
          </div>
          <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreateDialog(true)}>
            {t('skillsPage.create')}
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
      <div className="flex-1 overflow-y-auto p-6">
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

      {/* 创建技能对话框 */}
      {showCreateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-bg-surface border border-border-default rounded-lg max-w-lg w-full">
            <div className="p-6 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-primary">{t('skillsPage.create')}</h2>
              <p className="text-sm text-text-secondary mt-1">
                {t('skillsPage.createDescription')}
              </p>
            </div>

            <div className="p-6 space-y-4">
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
                  disabled={actionLoading}
                />
              </div>
            </div>

            <div className="p-6 border-t border-border-subtle flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setShowCreateDialog(false); setCreateFile(null); setCreateUploadError('') }} disabled={actionLoading}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleCreate} loading={actionLoading} disabled={!createFile}>
                {t('skillsPage.uploadAndCreate')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
