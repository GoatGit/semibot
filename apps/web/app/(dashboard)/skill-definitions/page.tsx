'use client'

import { useCallback, useEffect, useState } from 'react'
import { Search, Plus, RefreshCw, AlertCircle, Package, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { apiClient } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import type { SkillDefinition } from '@semibot/shared-types'

interface ApiError extends Error {
  response?: { status: number; data?: { error?: { message?: string } } }
}

interface InstallPayload {
  sourceType: 'anthropic' | 'git' | 'url'
  enableRetry: boolean
  sourceUrl?: string
}

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
  const [definitions, setDefinitions] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedDefinition, setSelectedDefinition] = useState<SkillDefinition | null>(null)
  const [showInstallDialog, setShowInstallDialog] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)

  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'

  // 安装表单状态
  const [installSourceType, setInstallSourceType] = useState<'anthropic' | 'git' | 'url'>('anthropic')
  const [installSourceUrl, setInstallSourceUrl] = useState('')

  // 编辑 Modal 状态
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editingDefinition, setEditingDefinition] = useState<SkillDefinition | null>(null)
  const [editForm, setEditForm] = useState({ name: '', description: '', isPublic: false })

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

  const handleInstall = async () => {
    if (!selectedDefinition) return

    try {
      setActionLoading(true)
      setError(null)

      const payload: InstallPayload = {
        sourceType: installSourceType,
        enableRetry: true,
      }

      if (installSourceType === 'git' || installSourceType === 'url') {
        payload.sourceUrl = installSourceUrl
      }

      await apiClient.post(`/skill-definitions/${selectedDefinition.id}/install`, payload)

      setShowInstallDialog(false)
      setInstallSourceUrl('')
      await loadDefinitions()
    } catch (err) {
      const apiErr = err as ApiError
      console.error('[SkillDefinitions] 安装失败:', err)
      setError(apiErr.response?.data?.error?.message || '安装失败')
    } finally {
      setActionLoading(false)
    }
  }

  const filteredDefinitions = definitions
    .filter(
      (def) =>
        def.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        def.skillId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        def.description?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      if (a.isPublic && !b.isPublic) return -1
      if (!a.isPublic && b.isPublic) return 1
      return 0
    })

  const handleDeleteDefinition = async (id: string) => {
    try {
      setActionLoading(true)
      setError(null)
      await apiClient.delete(`/skill-definitions/${id}`)
      await loadDefinitions()
    } catch (err) {
      const apiErr = err as ApiError
      console.error('[SkillDefinitions] 删除失败:', err)
      setError(apiErr.response?.data?.error?.message || '删除失败')
    } finally {
      setActionLoading(false)
    }
  }

  const openEditDialog = (definition: SkillDefinition) => {
    setEditingDefinition(definition)
    setEditForm({
      name: definition.name,
      description: definition.description || '',
      isPublic: definition.isPublic || false,
    })
    setShowEditDialog(true)
  }

  const handleUpdateDefinition = async () => {
    if (!editingDefinition) return
    try {
      setActionLoading(true)
      setError(null)
      await apiClient.put(`/skill-definitions/${editingDefinition.id}`, {
        name: editForm.name.trim(),
        description: editForm.description.trim() || undefined,
        isPublic: editForm.isPublic,
      })
      setShowEditDialog(false)
      setEditingDefinition(null)
      await loadDefinitions()
    } catch (err) {
      const apiErr = err as ApiError
      console.error('[SkillDefinitions] 更新失败:', err)
      setError(apiErr.response?.data?.error?.message || '更新失败')
    } finally {
      setActionLoading(false)
    }
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
          <p className="text-gray-600 mt-1">管理平台技能定义</p>
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
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{definition.name}</CardTitle>
                    {definition.isPublic && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-500">
                        内置
                      </span>
                    )}
                  </div>
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

              {/* 分类和标签 */}
              {definition.category && (
                <div className="flex items-center text-sm">
                  <span className="text-gray-500 mr-2">分类:</span>
                  <Badge variant="default">{definition.category}</Badge>
                </div>
              )}

              {definition.tags && definition.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {definition.tags.map((tag: string, idx: number) => (
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
                  onClick={() => {
                    setSelectedDefinition(definition)
                    setShowInstallDialog(true)
                  }}
                  className="flex-1"
                >
                  <Package className="w-4 h-4 mr-1" />
                  安装
                </Button>
                {isAdmin && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openEditDialog(definition)}
                      disabled={actionLoading}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleDeleteDefinition(definition.id)}
                      disabled={actionLoading}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </>
                )}
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

      {/* 安装对话框 */}
      {showInstallDialog && selectedDefinition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-lg w-full">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold">安装技能</h2>
              <p className="text-sm text-gray-600 mt-1">{selectedDefinition.name}</p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">来源类型 *</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  value={installSourceType}
                  onChange={(e) => setInstallSourceType(e.target.value as typeof installSourceType)}
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
            </div>

            <div className="p-6 border-t flex justify-end space-x-3">
              <Button variant="secondary" onClick={() => setShowInstallDialog(false)} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleInstall} disabled={actionLoading}>
                {actionLoading ? '安装中...' : '安装'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑对话框 */}
      {showEditDialog && editingDefinition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-lg w-full">
            <div className="p-6 border-b">
              <h2 className="text-xl font-bold">编辑技能定义</h2>
              <p className="text-sm text-gray-600 mt-1">{editingDefinition.skillId}</p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">名称 *</label>
                <Input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm((s) => ({ ...s, name: e.target.value }))}
                  disabled={actionLoading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">描述</label>
                <Input
                  type="text"
                  value={editForm.description}
                  onChange={(e) => setEditForm((s) => ({ ...s, description: e.target.value }))}
                  disabled={actionLoading}
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editForm.isPublic}
                  onChange={(e) => setEditForm((s) => ({ ...s, isPublic: e.target.checked }))}
                  disabled={actionLoading}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">设为内置技能（所有组织可见）</span>
              </label>
            </div>

            <div className="p-6 border-t flex justify-end space-x-3">
              <Button variant="secondary" onClick={() => { setShowEditDialog(false); setEditingDefinition(null) }} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleUpdateDefinition} disabled={actionLoading || !editForm.name.trim()}>
                {actionLoading ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
