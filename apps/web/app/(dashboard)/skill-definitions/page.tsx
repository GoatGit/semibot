'use client'

import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Search, Plus, RefreshCw, Package, Pencil, Trash2, Loader2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Tooltip } from '@/components/ui/Tooltip'
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

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 头部 */}
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">技能管理</h1>
            <p className="text-sm text-text-secondary mt-1">
              管理平台技能定义，共 {definitions.length} 个
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" leftIcon={<RefreshCw size={16} />} onClick={loadDefinitions}>
              刷新
            </Button>
            <Button leftIcon={<Plus size={16} />} onClick={() => window.location.href = '/skill-definitions/new'}>
              创建技能
            </Button>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mt-3 p-3 rounded-md bg-error-500/10 border border-error-500/30 text-sm text-error-500 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-error-500/60 hover:text-error-500 text-xs">
              关闭
            </button>
          </div>
        )}

        {/* 搜索栏 */}
        <div className="mt-4 max-w-md">
          <Input
            placeholder="搜索技能名称、ID 或描述..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search size={16} />}
          />
        </div>
      </header>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
          </div>
        ) : filteredDefinitions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-12">
            <div className="w-16 h-16 rounded-2xl bg-neutral-800 flex items-center justify-center mb-4">
              <Zap size={32} className="text-text-tertiary" />
            </div>
            {searchQuery ? (
              <>
                <h3 className="text-lg font-medium text-text-primary">未找到匹配的技能</h3>
                <p className="text-sm text-text-secondary mt-1 mb-4">尝试调整搜索条件</p>
                <Button variant="secondary" onClick={() => setSearchQuery('')}>清除搜索</Button>
              </>
            ) : (
              <>
                <h3 className="text-lg font-medium text-text-primary">暂无技能定义</h3>
                <p className="text-sm text-text-secondary mt-1 mb-4">创建您的第一个技能定义开始使用</p>
                <Button leftIcon={<Plus size={16} />} onClick={() => window.location.href = '/skill-definitions/new'}>创建技能</Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                      <p className="text-sm text-text-tertiary mt-1">{definition.skillId}</p>
                    </div>
                    {definition.isActive ? (
                      <Badge variant="success">已启用</Badge>
                    ) : (
                      <Badge variant="default">已禁用</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-text-secondary line-clamp-2">
                    {definition.description || '暂无描述'}
                  </p>

                  {/* 分类和标签 */}
                  {definition.category && (
                    <div className="flex items-center text-sm">
                      <span className="text-text-tertiary mr-2">分类:</span>
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
                      leftIcon={<Package size={14} />}
                    >
                      安装
                    </Button>
                    {isAdmin && (
                      <>
                        <Tooltip content="编辑">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openEditDialog(definition)}
                            disabled={actionLoading}
                          >
                            <Pencil size={14} />
                          </Button>
                        </Tooltip>
                        <Tooltip content="删除">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleDeleteDefinition(definition.id)}
                            disabled={actionLoading}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </Tooltip>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* 安装对话框 */}
      <Modal
        open={showInstallDialog && !!selectedDefinition}
        onClose={() => setShowInstallDialog(false)}
        title="安装技能"
        description={selectedDefinition?.name}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowInstallDialog(false)} disabled={actionLoading}>
              取消
            </Button>
            <Button onClick={handleInstall} loading={actionLoading}>
              安装
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">来源类型 *</label>
            <Select
              value={installSourceType}
              onChange={(val) => setInstallSourceType(val as typeof installSourceType)}
              options={[
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'git', label: 'Git' },
                { value: 'url', label: 'URL' },
              ]}
            />
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
        </div>
      </Modal>

      {/* 编辑对话框 */}
      <Modal
        open={showEditDialog && !!editingDefinition}
        onClose={() => { setShowEditDialog(false); setEditingDefinition(null) }}
        title="编辑技能定义"
        description={editingDefinition?.skillId}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setShowEditDialog(false); setEditingDefinition(null) }} disabled={actionLoading}>
              取消
            </Button>
            <Button onClick={handleUpdateDefinition} loading={actionLoading} disabled={!editForm.name.trim()}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">名称 *</label>
            <Input
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm((s) => ({ ...s, name: e.target.value }))}
              disabled={actionLoading}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">描述</label>
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
              className="rounded border-border-default"
            />
            <span className="text-sm text-text-secondary">设为内置技能（所有组织可见）</span>
          </label>
        </div>
      </Modal>
    </div>
  )
}
