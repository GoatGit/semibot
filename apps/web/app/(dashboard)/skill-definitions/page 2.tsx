'use client'

import { useCallback, useEffect, useState } from 'react'
import { Search, Plus, History, RefreshCw, AlertCircle, CheckCircle, Clock, Package } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { apiClient } from '@/lib/api'
import type { SkillDefinition, SkillPackage } from '@semibot/shared-types'

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
  const [installSourceType, setInstallSourceType] = useState<'anthropic' | 'git' | 'url'>('anthropic')
  const [installSourceUrl, setInstallSourceUrl] = useState('')
  const [installManifestUrl, setInstallManifestUrl] = useState('')

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

      const payload: any = {
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

      setShowInstallDialog(false)
      setInstallVersion('')
      setInstallSourceUrl('')
      setInstallManifestUrl('')
      await loadVersions(selectedDefinition.id)
      await loadDefinitions()
    } catch (err: any) {
      console.error('[SkillDefinitions] 安装失败:', err)
      setError(err.response?.data?.error?.message || '安装失败')
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
    } catch (err: any) {
      console.error('[SkillDefinitions] 回滚失败:', err)
      setError(err.response?.data?.error?.message || '回滚失败')
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
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">技能管理</h1>
          <p className="text-gray-600 mt-1">管理平台技能定义和版本</p>
        </div>
        <Button onClick={() => window.location.href = '/skill-definitions/new'}>
          <Plus className="w-4 h-4 mr-2" />
          创建技能
        </Button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start">
          <AlertCircle className="w-5 h-5 text-red-600 mr-3 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium text-red-800">错误</h3>
            <p className="text-sm text-red-700 mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* 搜索栏 */}
      <div className="flex items-center space-x-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
          <Input
            type="text"
            placeholder="搜索技能名称、ID 或描述..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button variant="secondary" onClick={loadDefinitions}>
          <RefreshCw className="w-4 h-4 mr-2" />
          刷新
        </Button>
      </div>

      {/* 技能列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredDefinitions.map((definition) => (
          <Card key={definition.id} className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <CardTitle className="text-lg">{definition.name}</CardTitle>
                  <p className="text-sm text-gray-500 mt-1">{definition.skillId}</p>
                </div>
                {definition.isActive ? (
                  <Badge variant="success">已启用</Badge>
                ) : (
                  <Badge variant="default">已禁用</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-600 line-clamp-2">
                {definition.description || '暂无描述'}
              </p>

              {/* 版本信息 */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">当前版本:</span>
                <span className="font-medium">{definition.currentVersion || 'N/A'}</span>
              </div>

              {/* 分类和标签 */}
              {definition.category && (
                <div className="flex items-center text-sm">
                  <span className="text-gray-500 mr-2">分类:</span>
                  <Badge variant="default">{definition.category}</Badge>
                </div>
              )}

              {definition.tags && definition.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {definition.tags.map((tag, idx) => (
                    <Badge key={idx} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex space-x-2 pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleShowVersions(definition)}
                  className="flex-1"
                >
                  <History className="w-4 h-4 mr-1" />
                  版本
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSelectedDefinition(definition)
                    setShowInstallDialog(true)
                  }}
                  className="flex-1"
                >
                  <Package className="w-4 h-4 mr-1" />
                  安装
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredDefinitions.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">没有找到技能定义</p>
        </div>
      )}

      {/* 版本历史对话框 */}
      {showVersions && selectedDefinition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold">版本历史 - {selectedDefinition.name}</h2>
              <p className="text-sm text-gray-600 mt-1">{selectedDefinition.skillId}</p>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-4">
                {versions.map((version) => (
                  <Card key={version.version} className={version.isCurrent ? 'border-blue-500 border-2' : ''}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center space-x-3">
                          <span className="text-lg font-semibold">{version.version}</span>
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
                          <span className="text-gray-500">来源��型:</span>
                          <span className="ml-2 font-medium">{version.sourceType}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">包大小:</span>
                          <span className="ml-2 font-medium">{formatBytes(version.fileSizeBytes)}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-gray-500">安装时间:</span>
                          <span className="ml-2 font-medium">{formatDate(version.installedAt)}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-gray-500">校验值:</span>
                          <span className="ml-2 font-mono text-xs">{version.checksumSha256.substring(0, 16)}...</span>
                        </div>
                        {version.sourceUrl && (
                          <div className="col-span-2">
                            <span className="text-gray-500">来源 URL:</span>
                            <span className="ml-2 text-xs break-all">{version.sourceUrl}</span>
                          </div>
                        )}
                        {version.deprecatedAt && (
                          <div className="col-span-2 text-red-600">
                            <span className="text-gray-500">废弃时间:</span>
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

            <div className="p-6 border-t flex justify-end">
              <Button variant="secondary" onClick={() => setShowVersions(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 安装对话框 */}
      {showInstallDialog && selectedDefinition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-lg w-full">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold">安装新版本</h2>
              <p className="text-sm text-gray-600 mt-1">{selectedDefinition.name}</p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">版本号 *</label>
                <Input
                  type="text"
                  placeholder="1.0.0"
                  value={installVersion}
                  onChange={(e) => setInstallVersion(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">来源类型 *</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  value={installSourceType}
                  onChange={(e) => setInstallSourceType(e.target.value as any)}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="git">Git</option>
                  <option value="url">URL</option>
                </select>
              </div>

              {(installSourceType === 'git' || installSourceType === 'url') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">来源 URL *</label>
                  <Input
                    type="text"
                    placeholder="https://..."
                    value={installSourceUrl}
                    onChange={(e) => setInstallSourceUrl(e.target.value)}
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Manifest URL（可选）</label>
                <Input
                  type="text"
                  placeholder="https://..."
                  value={installManifestUrl}
                  onChange={(e) => setInstallManifestUrl(e.target.value)}
                />
              </div>
            </div>

            <div className="p-6 border-t flex justify-end space-x-3">
              <Button variant="secondary" onClick={() => setShowInstallDialog(false)} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleInstall} disabled={actionLoading || !installVersion}>
                {actionLoading ? '安装中...' : '安装'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 回滚对话框 */}
      {showRollbackDialog && selectedDefinition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-lg w-full">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold">回滚版本</h2>
              <p className="text-sm text-gray-600 mt-1">
                将 {selectedDefinition.name} 回滚到版本 {rollbackTarget}
              </p>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800">
                  <strong>警告:</strong> 回滚操作将更改当前激活版本，请确认后再继续。
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">回滚原因（可选）</label>
                <textarea
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  rows={3}
                  placeholder="请输入回滚原因..."
                  value={rollbackReason}
                  onChange={(e) => setRollbackReason(e.target.value)}
                />
              </div>
            </div>

            <div className="p-6 border-t flex justify-end space-x-3">
              <Button variant="secondary" onClick={() => setShowRollbackDialog(false)} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleRollback} disabled={actionLoading}>
                {actionLoading ? '回滚中...' : '确认回滚'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
