'use client'

import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Search, Plus, History, RefreshCw, AlertCircle, Package, Loader2, Power, Trash2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { FileUpload } from '@/components/ui/FileUpload'
import { apiClient } from '@/lib/api'
import type { SkillDefinition } from '@semibot/shared-types'

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

interface VersionHistoryItem {
  version: string
  status: string
  isCurrent: boolean
  installedAt?: string
  installedBy?: string
  sourceType: string
  sourceUrl?: string
  checksumSha256: string
  fileSizeBytes?: number
  deprecatedAt?: string
  deprecatedReason?: string
}

export default function SkillDefinitionsPage() {
  const [definitions, setDefinitions] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedDefinition, setSelectedDefinition] = useState<SkillDefinition | null>(null)
  const [versions, setVersions] = useState<VersionHistoryItem[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const [showInstallDialog, setShowInstallDialog] = useState(false)
  const [showRollbackDialog, setShowRollbackDialog] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<string>('')
  const [rollbackReason, setRollbackReason] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  // 安装表单状态
  const [installVersion, setInstallVersion] = useState('')
  const [installSourceType, setInstallSourceType] = useState<'anthropic' | 'git' | 'url' | 'upload'>('anthropic')
  const [installSourceUrl, setInstallSourceUrl] = useState('')
  const [installManifestUrl, setInstallManifestUrl] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadError, setUploadError] = useState('')

  // 创建表单状态
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createSkillId, setCreateSkillId] = useState('')
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createTriggerKeywords, setCreateTriggerKeywords] = useState('')

  // 编辑表单状态
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editingDefinition, setEditingDefinition] = useState<SkillDefinition | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editTriggerKeywords, setEditTriggerKeywords] = useState('')

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
      setError('加载技能定义失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDefinitions()
  }, [loadDefinitions])

  const loadVersions = async (definitionId: string) => {
    try {
      const response = await apiClient.get<ApiResponse<VersionHistoryItem[]>>(
        `/skill-definitions/${definitionId}/versions`
      )
      if (response.success) {
        setVersions(response.data || [])
      }
    } catch (err) {
      console.error('[SkillDefinitions] 加载版本失败:', err)
      setError('加载版本历史失败')
    }
  }

  const handleShowVersions = async (definition: SkillDefinition) => {
    setSelectedDefinition(definition)
    setShowVersions(true)
    await loadVersions(definition.id)
  }

  const handleInstall = async () => {
    if (!selectedDefinition || !installVersion) return

    try {
      setActionLoading(true)
      setError(null)

      if (installSourceType === 'upload') {
        if (!uploadFile) {
          setError('请选择要上传的安装包文件')
          return
        }

        const formData = new FormData()
        formData.append('file', uploadFile)
        formData.append('version', installVersion)
        formData.append('enableRetry', 'true')

        await apiClient.upload(`/skill-definitions/${selectedDefinition.id}/upload-install`, formData)
      } else {
        const payload: Record<string, string | boolean> = {
          version: installVersion,
          sourceType: installSourceType,
          enableRetry: true,
        }

        if (installSourceType === 'git' || installSourceType === 'url') {
          payload.sourceUrl = installSourceUrl
        }

        if (installManifestUrl) {
          payload.manifestUrl = installManifestUrl
        }

        await apiClient.post(`/skill-definitions/${selectedDefinition.id}/install`, payload)
      }

      setShowInstallDialog(false)
      setInstallVersion('')
      setInstallSourceUrl('')
      setInstallManifestUrl('')
      setUploadFile(null)
      setUploadError('')
      await loadVersions(selectedDefinition.id)
      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } } }
      console.error('[SkillDefinitions] 安装��败:', err)
      setError(error.response?.data?.error?.message || '安装失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleRollback = async () => {
    if (!selectedDefinition || !rollbackTarget) return

    try {
      setActionLoading(true)
      setError(null)

      await apiClient.post(`/skill-definitions/${selectedDefinition.id}/rollback`, {
        targetVersion: rollbackTarget,
        reason: rollbackReason,
      })

      setShowRollbackDialog(false)
      setRollbackTarget('')
      setRollbackReason('')
      await loadVersions(selectedDefinition.id)
      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } } }
      console.error('[SkillDefinitions] 回滚失败:', err)
      setError(error.response?.data?.error?.message || '回滚失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!createSkillId || !createName) return

    try {
      setActionLoading(true)
      setError(null)

      await apiClient.post('/skill-definitions', {
        skillId: createSkillId,
        name: createName,
        ...(createDescription && { description: createDescription }),
        ...(createTriggerKeywords.trim() && {
          triggerKeywords: createTriggerKeywords.split(',').map(k => k.trim()).filter(Boolean),
        }),
      })

      setShowCreateDialog(false)
      setCreateSkillId('')
      setCreateName('')
      setCreateDescription('')
      setCreateTriggerKeywords('')
      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } } }
      console.error('[SkillDefinitions] 创建失败:', err)
      setError(error.response?.data?.error?.message || '创建技能失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleEdit = (definition: SkillDefinition) => {
    setEditingDefinition(definition)
    setEditName(definition.name)
    setEditDescription(definition.description || '')
    setEditTriggerKeywords(definition.triggerKeywords?.join(', ') || '')
    setShowEditDialog(true)
  }

  const handleSaveEdit = async () => {
    if (!editingDefinition || !editName) return

    try {
      setActionLoading(true)
      setError(null)

      await apiClient.put(`/skill-definitions/${editingDefinition.id}`, {
        name: editName,
        description: editDescription || undefined,
        triggerKeywords: editTriggerKeywords
          .split(',')
          .map(k => k.trim())
          .filter(Boolean),
      })

      setShowEditDialog(false)
      setEditingDefinition(null)
      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } } }
      console.error('[SkillDefinitions] 编辑失败:', err)
      setError(error.response?.data?.error?.message || '编辑失败')
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
      setError(error.response?.data?.error?.message || '切换状态失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async (definition: SkillDefinition) => {
    if (!confirm(`确定要删除技能「${definition.name}」吗？此操作不可撤销。`)) return

    try {
      setActionLoading(true)
      setError(null)

      await apiClient.delete(`/skill-definitions/${definition.id}`)

      await loadDefinitions()
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: { message?: string } } } }
      console.error('[SkillDefinitions] 删除失败:', err)
      setError(error.response?.data?.error?.message || '删除失败')
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

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { label: string; variant: 'success' | 'warning' | 'error' | 'default' }> = {
      active: { label: '已激活', variant: 'success' },
      pending: { label: '等待中', variant: 'warning' },
      downloading: { label: '下载中', variant: 'warning' },
      validating: { label: '校验中', variant: 'warning' },
      installing: { label: '安装中', variant: 'warning' },
      failed: { label: '失败', variant: 'error' },
      deprecated: { label: '已废弃', variant: 'default' },
    }

    const config = statusConfig[status] || { label: status, variant: 'default' }
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const formatBytes = (bytes?: number) => {
    if (!bytes) return 'N/A'
    const mb = bytes / 1024 / 1024
    return `${mb.toFixed(2)} MB`
  }

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A'
    return new Date(dateStr).toLocaleString('zh-CN')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-primary-500 mx-auto mb-4" />
          <p className="text-text-secondary">加载中...</p>
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
            <h1 className="text-xl font-semibold text-text-primary">技能管理</h1>
            <p className="text-sm text-text-secondary mt-1">
              管理平台技能定义和版本，共 {definitions.length} 个
            </p>
          </div>
          <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreateDialog(true)}>
            创建技能
          </Button>
        </div>

        {/* 错��提示 */}
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
              placeholder="搜索技能名称、ID 或描述..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search size={16} />}
            />
          </div>
          <Button variant="secondary" onClick={loadDefinitions}>
            <RefreshCw className="w-4 h-4 mr-2" />
            刷新
          </Button>
        </div>
      </header>

      {/* 技能列表 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filteredDefinitions.map((definition) => (
            <Card key={definition.id} interactive padding="sm">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary truncate">{definition.name}</h3>
                  <p className="text-xs text-text-tertiary truncate">{definition.skillId}</p>
                </div>
                <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                  {definition.isActive ? (
                    <Badge variant="success">启用</Badge>
                  ) : (
                    <Badge variant="default">禁用</Badge>
                  )}
                  {definition.currentVersion && (
                    <span className="text-xs text-text-tertiary font-mono">v{definition.currentVersion}</span>
                  )}
                </div>
              </div>

              <p className="text-xs text-text-secondary line-clamp-2 mb-2">
                {definition.description || '暂无描述'}
              </p>

              {/* 触发词 + 分类 + 标签 */}
              {((definition.triggerKeywords && definition.triggerKeywords.length > 0) ||
                definition.category ||
                (definition.tags && definition.tags.length > 0)) && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {definition.category && (
                    <Badge variant="default" className="text-xs">{definition.category}</Badge>
                  )}
                  {definition.triggerKeywords?.map((keyword, idx) => (
                    <Badge key={`kw-${idx}`} variant="outline" className="text-xs">
                      {keyword}
                    </Badge>
                  ))}
                  {definition.tags?.map((tag, idx) => (
                    <Badge key={`tag-${idx}`} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex gap-1.5 pt-2 border-t border-border-subtle">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleShowVersions(definition)}
                >
                  <History className="w-3.5 h-3.5 mr-1" />
                  版本
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSelectedDefinition(definition)
                    setShowInstallDialog(true)
                  }}
                >
                  <Package className="w-3.5 h-3.5 mr-1" />
                  安装
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleEdit(definition)}
                  title="编辑"
                >
                  <Pencil className="w-3.5 h-3.5 mr-1" />
                  编辑
                </Button>
                <div className="flex-1" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleToggleActive(definition)}
                  disabled={actionLoading}
                  title={definition.isActive ? '禁用' : '启用'}
                >
                  <Power className={clsx('w-3.5 h-3.5', definition.isActive ? 'text-success-500' : 'text-text-tertiary')} />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleDelete(definition)}
                  disabled={actionLoading}
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5 text-error-500" />
                </Button>
              </div>
            </Card>
          ))}
        </div>

        {filteredDefinitions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 rounded-2xl bg-bg-elevated flex items-center justify-center mb-4">
              <Package size={32} className="text-text-tertiary" />
            </div>
            <h3 className="text-lg font-medium text-text-primary">没有找到技能定义</h3>
            <p className="text-sm text-text-secondary mt-1">尝试调整搜索条件</p>
          </div>
        )}
      </div>

      {/* 版本历史对话框 */}
      {showVersions && selectedDefinition && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-bg-surface border border-border-default rounded-lg max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-border-subtle">
              <h2 className="text-xl font-semibold text-text-primary">版本历史 - {selectedDefinition.name}</h2>
              <p className="text-sm text-text-secondary mt-1">{selectedDefinition.skillId}</p>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-4">
                {versions.map((version) => (
                  <Card key={version.version} className={version.isCurrent ? 'border-primary-500 border-2' : ''}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center space-x-3">
                          <span className="text-lg font-semibold text-text-primary">{version.version}</span>
                          {version.isCurrent && <Badge variant="success">当前版本</Badge>}
                          {getStatusBadge(version.status)}
                        </div>
                        {!version.isCurrent && version.status === 'active' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setRollbackTarget(version.version)
                              setShowRollbackDialog(true)
                            }}
                          >
                            <RefreshCw className="w-4 h-4 mr-1" />
                            回滚
                          </Button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-text-tertiary">来源类型:</span>
                          <span className="ml-2 font-medium text-text-primary">{version.sourceType}</span>
                        </div>
                        <div>
                          <span className="text-text-tertiary">包大小:</span>
                          <span className="ml-2 font-medium text-text-primary">{formatBytes(version.fileSizeBytes)}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-text-tertiary">安装时间:</span>
                          <span className="ml-2 font-medium text-text-primary">{formatDate(version.installedAt)}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-text-tertiary">校验值:</span>
                          <span className="ml-2 font-mono text-xs text-text-secondary">{version.checksumSha256?.substring(0, 16) ?? 'N/A'}...</span>
                        </div>
                        {version.sourceUrl && (
                          <div className="col-span-2">
                            <span className="text-text-tertiary">来源 URL:</span>
                            <span className="ml-2 text-xs text-text-secondary break-all">{version.sourceUrl}</span>
                          </div>
                        )}
                        {version.deprecatedAt && (
                          <div className="col-span-2 text-error-500">
                            <span className="text-text-tertiary">废弃时间:</span>
                            <span className="ml-2">{formatDate(version.deprecatedAt)}</span>
                            {version.deprecatedReason && (
                              <p className="text-sm mt-1">原因: {version.deprecatedReason}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            <div className="p-6 border-t border-border-subtle flex justify-end">
              <Button variant="secondary" onClick={() => setShowVersions(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 创建技能对话框 */}
      {showCreateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-bg-surface border border-border-default rounded-lg max-w-lg w-full">
            <div className="p-6 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-primary">创建技能</h2>
              <p className="text-sm text-text-secondary mt-1">创建一个新的技能定义</p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">技能 ID *</label>
                <Input
                  type="text"
                  placeholder="例如: my-org/my-skill"
                  value={createSkillId}
                  onChange={(e) => setCreateSkillId(e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1">支持字母、数字、点、下划线、冒号、斜杠和连字符</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">名称 *</label>
                <Input
                  type="text"
                  placeholder="技能显示名称"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">描述</label>
                <Input
                  type="text"
                  placeholder="技能功能描述（可选）"
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">触发词</label>
                <Input
                  type="text"
                  placeholder="用逗号分隔多个关键词，如: 翻译,translate"
                  value={createTriggerKeywords}
                  onChange={(e) => setCreateTriggerKeywords(e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1">用于匹配用户消息自动触发技能</p>
              </div>
            </div>

            <div className="p-6 border-t border-border-subtle flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowCreateDialog(false)} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleCreate} loading={actionLoading} disabled={!createSkillId || !createName}>
                创建
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑技能对话框 */}
      {showEditDialog && editingDefinition && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-bg-surface border border-border-default rounded-lg max-w-lg w-full">
            <div className="p-6 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-primary">编辑技能</h2>
              <p className="text-sm text-text-secondary mt-1">{editingDefinition.skillId}</p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">名称 *</label>
                <Input
                  type="text"
                  placeholder="技能显示名称"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">描述</label>
                <Input
                  type="text"
                  placeholder="技能功能描述（可选）"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">触发词</label>
                <Input
                  type="text"
                  placeholder="用逗号分隔多个关键词，如: 翻译,translate"
                  value={editTriggerKeywords}
                  onChange={(e) => setEditTriggerKeywords(e.target.value)}
                />
                <p className="text-xs text-text-tertiary mt-1">用于匹配用户消息自动触发技能</p>
              </div>
            </div>

            <div className="p-6 border-t border-border-subtle flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowEditDialog(false)} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleSaveEdit} loading={actionLoading} disabled={!editName}>
                保存
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 安装对话框 */}
      {showInstallDialog && selectedDefinition && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-bg-surface border border-border-default rounded-lg max-w-lg w-full">
            <div className="p-6 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-primary">安装新版本</h2>
              <p className="text-sm text-text-secondary mt-1">{selectedDefinition.name}</p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">版本号 *</label>
                <Input
                  type="text"
                  placeholder="1.0.0"
                  value={installVersion}
                  onChange={(e) => setInstallVersion(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">来源类型 *</label>
                <select
                  className={clsx(
                    'w-full px-3 py-2 rounded-md',
                    'bg-bg-surface border border-border-default',
                    'text-text-primary',
                    'focus:outline-none focus:border-primary-500',
                    'transition-all duration-fast'
                  )}
                  value={installSourceType}
                  onChange={(e) => setInstallSourceType(e.target.value as 'anthropic' | 'git' | 'url' | 'upload')}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="git">Git</option>
                  <option value="url">URL</option>
                  <option value="upload">上传安装包</option>
                </select>
              </div>

              {(installSourceType === 'git' || installSourceType === 'url') && (
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1.5">来源 URL *</label>
                  <Input
                    type="text"
                    placeholder="https://..."
                    value={installSourceUrl}
                    onChange={(e) => setInstallSourceUrl(e.target.value)}
                  />
                </div>
              )}

              {installSourceType === 'upload' && (
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1.5">安装包文件 *</label>
                  <FileUpload
                    accept=".zip,.tar.gz,.tgz"
                    allowedExtensions={['.zip', '.tar.gz', '.tgz']}
                    maxSize={100 * 1024 * 1024}
                    value={uploadFile}
                    onFileSelect={setUploadFile}
                    error={uploadError}
                    onError={setUploadError}
                    hint="支持 .zip、.tar.gz、.tgz 格式，最大 100MB"
                    disabled={actionLoading}
                  />
                </div>
              )}

              {installSourceType !== 'upload' && (
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1.5">Manifest URL（可选）</label>
                  <Input
                    type="text"
                    placeholder="https://..."
                    value={installManifestUrl}
                    onChange={(e) => setInstallManifestUrl(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="p-6 border-t border-border-subtle flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowInstallDialog(false)} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleInstall} loading={actionLoading} disabled={!installVersion || (installSourceType === 'upload' && !uploadFile)}>
                安装
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 回滚对话框 */}
      {showRollbackDialog && selectedDefinition && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-bg-surface border border-border-default rounded-lg max-w-lg w-full">
            <div className="p-6 border-b border-border-subtle">
              <h2 className="text-lg font-semibold text-text-primary">回滚版本</h2>
              <p className="text-sm text-text-secondary mt-1">
                将 {selectedDefinition.name} 回滚到版本 {rollbackTarget}
              </p>
            </div>

            <div className="p-6 space-y-4">
              <div className="rounded-md px-3 py-2 border bg-warning-500/10 border-warning-500/20">
                <p className="text-sm text-warning-500">
                  <strong>警告:</strong> 回滚操作将更改当前激活版本，请确认后再继续。
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">回滚原因（可选）</label>
                <textarea
                  className={clsx(
                    'w-full px-3 py-2 rounded-md resize-none',
                    'bg-bg-surface border border-border-default',
                    'text-text-primary placeholder:text-text-tertiary',
                    'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
                    'transition-all duration-fast'
                  )}
                  rows={3}
                  placeholder="请输入回滚原因..."
                  value={rollbackReason}
                  onChange={(e) => setRollbackReason(e.target.value)}
                />
              </div>
            </div>

            <div className="p-6 border-t border-border-subtle flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowRollbackDialog(false)} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleRollback} loading={actionLoading}>
                确认回滚
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
