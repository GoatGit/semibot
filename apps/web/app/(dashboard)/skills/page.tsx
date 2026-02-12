'use client'

import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Search, Plus, RefreshCw, AlertCircle, Package, Loader2, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
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

export default function SkillDefinitionsPage() {
  const [definitions, setDefinitions] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

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
      setError('加载技能定义失败')
    } finally {
      setLoading(false)
    }
  }, [])

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
      setError(error.response?.data?.error?.message || error.message || '创建技能失败')
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
              管理平台技能定义，共 {definitions.length} 个
            </p>
          </div>
          <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreateDialog(true)}>
            创建技能
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
        {filteredDefinitions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 rounded-2xl bg-bg-elevated flex items-center justify-center mb-4">
              <Package size={32} className="text-text-tertiary" />
            </div>
            <h3 className="text-lg font-medium text-text-primary">没有找到技能定义</h3>
            <p className="text-sm text-text-secondary mt-1">尝试调整搜索条件</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredDefinitions.map((definition) => (
              <Card key={definition.id}>
                <CardContent>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-md bg-primary-500/20 flex items-center justify-center flex-shrink-0">
                        <Zap size={16} className="text-primary-400" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text-primary">{definition.name}</div>
                        <div className="text-xs text-text-secondary mt-0.5">
                          {definition.description || '暂无描述'}
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
                              {definition.isActive ? '已启用' : '已禁用'}
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
                      {definition.isActive ? '禁用' : '启用'}
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
              <h2 className="text-lg font-semibold text-text-primary">创建技能</h2>
              <p className="text-sm text-text-secondary mt-1">上传包含 SKILL.md 的安装包，自动创建技能定义并安装</p>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">安装包文件 *</label>
                <FileUpload
                  accept=".zip,.tar.gz,.tgz"
                  allowedExtensions={['.zip', '.tar.gz', '.tgz']}
                  maxSize={100 * 1024 * 1024}
                  value={createFile}
                  onFileSelect={setCreateFile}
                  error={createUploadError}
                  onError={setCreateUploadError}
                  hint="支持 .zip、.tar.gz、.tgz 格式，最大 100MB。包内需包含 SKILL.md 文件"
                  disabled={actionLoading}
                />
              </div>
            </div>

            <div className="p-6 border-t border-border-subtle flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setShowCreateDialog(false); setCreateFile(null); setCreateUploadError('') }} disabled={actionLoading}>
                取消
              </Button>
              <Button onClick={handleCreate} loading={actionLoading} disabled={!createFile}>
                上传并创建
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
