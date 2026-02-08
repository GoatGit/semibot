'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Search, Plus, Sparkles, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface AnthropicSkillCatalogItem {
  skillId: string
  name: string
  description?: string
  version?: string
  manifestUrl?: string
}

interface Skill {
  id: string
  name: string
  description?: string
  triggerKeywords: string[]
  config?: {
    maxExecutionTime?: number
    retryAttempts?: number
    requiresApproval?: boolean
    source?: 'local' | 'anthropic' | 'custom'
    anthropicSkill?: {
      skillId: string
      version?: string
    }
  }
  isBuiltin: boolean
  isActive: boolean
  createdAt: string
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showInstallAnthropic, setShowInstallAnthropic] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newKeywords, setNewKeywords] = useState('')
  const [newMaxExecutionTime, setNewMaxExecutionTime] = useState(30000)
  const [newRetryAttempts, setNewRetryAttempts] = useState(1)
  const [newRequiresApproval, setNewRequiresApproval] = useState(false)
  const [anthropicSkillId, setAnthropicSkillId] = useState('')
  const [anthropicVersion, setAnthropicVersion] = useState('latest')
  const [anthropicName, setAnthropicName] = useState('')
  const [anthropicDescription, setAnthropicDescription] = useState('')
  const [anthropicManifestUrl, setAnthropicManifestUrl] = useState('')
  const [catalogItems, setCatalogItems] = useState<AnthropicSkillCatalogItem[]>([])
  const [selectedCatalogSkillId, setSelectedCatalogSkillId] = useState('')

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await apiClient.get<ApiResponse<Skill[]>>('/skills', {
        params: { page: 1, limit: 100, includeBuiltin: true },
      })
      if (response.success) {
        setSkills(response.data || [])
      }
    } catch (err) {
      console.error('[Skills] 加载失败:', err)
      setError('加载技能失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  useEffect(() => {
    const loadCatalog = async () => {
      try {
        const response = await apiClient.get<ApiResponse<AnthropicSkillCatalogItem[]>>(
          '/skills/catalog/anthropic'
        )
        if (response.success && Array.isArray(response.data)) {
          setCatalogItems(response.data)
        }
      } catch (err) {
        console.warn('[Skills] 加载 Anthropic 目录失败:', err)
      }
    }

    loadCatalog()
  }, [])

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return skills
    return skills.filter((skill) => {
      return (
        skill.name.toLowerCase().includes(query) ||
        (skill.description || '').toLowerCase().includes(query)
      )
    })
  }, [skills, searchQuery])

  const handleToggle = async (skill: Skill) => {
    if (skill.isBuiltin) return
    try {
      setSaving(true)
      await apiClient.put<ApiResponse<Skill>>(`/skills/${skill.id}`, {
        isActive: !skill.isActive,
      })
      await loadSkills()
    } catch (err) {
      console.error('[Skills] 更新状态失败:', err)
      setError('更新技能状态失败')
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = async () => {
    if (!newName.trim()) return
    const triggerKeywords = newKeywords
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

    try {
      setSaving(true)
      await apiClient.post<ApiResponse<Skill>>('/skills', {
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        triggerKeywords: triggerKeywords.length > 0 ? triggerKeywords : undefined,
        config: {
          maxExecutionTime: newMaxExecutionTime,
          retryAttempts: newRetryAttempts,
          requiresApproval: newRequiresApproval,
        },
      })
      setNewName('')
      setNewDescription('')
      setNewKeywords('')
      setNewMaxExecutionTime(30000)
      setNewRetryAttempts(1)
      setNewRequiresApproval(false)
      setShowCreate(false)
      await loadSkills()
    } catch (err) {
      console.error('[Skills] 创建失败:', err)
      setError('创建技能失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (skill: Skill) => {
    if (skill.isBuiltin) return
    try {
      setSaving(true)
      await apiClient.delete(`/skills/${skill.id}`)
      await loadSkills()
    } catch (err) {
      console.error('[Skills] 删除失败:', err)
      setError('删除技能失败')
    } finally {
      setSaving(false)
    }
  }

  const handleInstallAnthropicSkill = async () => {
    if (!anthropicSkillId.trim() && !anthropicManifestUrl.trim()) return

    try {
      setSaving(true)
      setError(null)
      const payload = {
        skillId: anthropicSkillId.trim() || undefined,
        version: anthropicVersion.trim() || 'latest',
        name: anthropicName.trim() || undefined,
        description: anthropicDescription.trim() || undefined,
      }

      if (anthropicManifestUrl.trim()) {
        await apiClient.post<ApiResponse<Skill>>('/skills/install/anthropic/manifest', {
          manifestUrl: anthropicManifestUrl.trim(),
          ...payload,
        })
      } else if (payload.skillId) {
        await apiClient.post<ApiResponse<Skill>>('/skills/install/anthropic', payload)
      }

      setAnthropicSkillId('')
      setAnthropicVersion('latest')
      setAnthropicName('')
      setAnthropicDescription('')
      setAnthropicManifestUrl('')
      setSelectedCatalogSkillId('')
      setShowInstallAnthropic(false)
      await loadSkills()
    } catch (err) {
      console.error('[Skills] 安装 Anthropic Skill 失败:', err)
      setError('安装 Anthropic Skill 失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSelectCatalogSkill = (skillId: string) => {
    setSelectedCatalogSkillId(skillId)
    const selected = catalogItems.find((item) => item.skillId === skillId)
    if (!selected) return

    setAnthropicSkillId(selected.skillId)
    setAnthropicVersion(selected.version || 'latest')
    setAnthropicName(selected.name)
    setAnthropicDescription(selected.description || '')
    setAnthropicManifestUrl(selected.manifestUrl || '')
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Skills</h1>
            <p className="text-sm text-text-secondary mt-1">共 {skills.length} 个技能</p>
          </div>
          <div className="flex items-center gap-2">
            <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreate(true)}>
              添加技能
            </Button>
            <Button variant="secondary" onClick={() => setShowInstallAnthropic(true)}>
              安装 Anthropic Skill
            </Button>
          </div>
        </div>
        <div className="mt-4 max-w-md">
          <Input
            placeholder="搜索技能..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search size={16} />}
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 p-3 rounded-md bg-error-500/10 border border-error-500/30 text-sm text-error-500">
            {error}
          </div>
        )}

        {loading ? (
          <div className="h-40 flex items-center justify-center text-text-secondary">
            <Loader2 size={18} className="animate-spin mr-2" />
            加载中...
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-text-secondary">
            暂无技能
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredSkills.map((skill) => (
              <Card key={skill.id}>
                <CardContent>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-md bg-primary-500/20 flex items-center justify-center">
                        <Sparkles size={16} className="text-primary-400" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-text-primary">{skill.name}</div>
                        <div className="text-xs text-text-secondary mt-1">
                          {skill.description || '无描述'}
                        </div>
                        <div className="text-[11px] text-text-tertiary mt-2">
                          {skill.isBuiltin
                            ? '内置技能'
                            : skill.config?.source === 'anthropic'
                              ? 'Anthropic Skill'
                              : '自定义技能'}
                        </div>
                        {skill.config?.source === 'anthropic' && skill.config?.anthropicSkill?.skillId && (
                          <div className="mt-1 text-[11px] text-text-tertiary">
                            ID: {skill.config.anthropicSkill.skillId}
                            {skill.config.anthropicSkill.version
                              ? `@${skill.config.anthropicSkill.version}`
                              : ''}
                          </div>
                        )}
                        {skill.triggerKeywords.length > 0 && (
                          <div className="mt-2 text-[11px] text-text-tertiary">
                            触发词：{skill.triggerKeywords.join(' / ')}
                          </div>
                        )}
                        {!skill.isBuiltin && (
                          <div className="mt-1 text-[11px] text-text-tertiary">
                            超时 {skill.config?.maxExecutionTime ?? 30000}ms · 重试 {skill.config?.retryAttempts ?? 0} 次 ·
                            {skill.config?.requiresApproval ? ' 需审批' : ' 免审批'}
                          </div>
                        )}
                      </div>
                    </div>
                    {!skill.isBuiltin && (
                      <button
                        onClick={() => handleDelete(skill)}
                        disabled={saving}
                        className="p-1.5 text-text-tertiary hover:text-error-500"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  <div className="mt-4 flex items-center justify-between">
                    <span className={clsx('text-xs', skill.isActive ? 'text-success-500' : 'text-text-tertiary')}>
                      {skill.isActive ? '已启用' : '已禁用'}
                    </span>
                    <button
                      onClick={() => handleToggle(skill)}
                      disabled={saving || skill.isBuiltin}
                      className={clsx(
                        'relative inline-flex w-10 h-5 items-center rounded-full p-0.5 transition-colors',
                        skill.isActive ? 'bg-primary-500' : 'bg-neutral-600',
                        (saving || skill.isBuiltin) && 'opacity-60 cursor-not-allowed'
                      )}
                    >
                      <span
                        className={clsx(
                          'block h-4 w-4 rounded-full bg-white transition-transform',
                          skill.isActive ? 'translate-x-5' : 'translate-x-0'
                        )}
                      />
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">添加技能</h3>
            <Input
              placeholder="技能名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={saving}
            />
            <textarea
              placeholder="技能描述"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              disabled={saving}
              className={clsx(
                'w-full h-24 px-3 py-2 rounded-md resize-none',
                'bg-bg-surface border border-border-default',
                'text-text-primary placeholder:text-text-tertiary',
                'focus:outline-none focus:border-primary-500'
              )}
            />
            <Input
              placeholder="触发词（逗号分隔，例如：报表,统计,分析）"
              value={newKeywords}
              onChange={(e) => setNewKeywords(e.target.value)}
              disabled={saving}
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-tertiary mb-1">最大执行时长(ms)</label>
                <Input
                  type="number"
                  min={1000}
                  max={300000}
                  value={newMaxExecutionTime}
                  onChange={(e) => setNewMaxExecutionTime(Number(e.target.value) || 30000)}
                  disabled={saving}
                />
              </div>
              <div>
                <label className="block text-xs text-text-tertiary mb-1">重试次数</label>
                <Input
                  type="number"
                  min={0}
                  max={5}
                  value={newRetryAttempts}
                  onChange={(e) => setNewRetryAttempts(Number(e.target.value) || 0)}
                  disabled={saving}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={newRequiresApproval}
                onChange={(e) => setNewRequiresApproval(e.target.checked)}
                disabled={saving}
              />
              执行前需要审批
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowCreate(false)} disabled={saving}>
                取消
              </Button>
              <Button onClick={handleCreate} loading={saving}>
                创建
              </Button>
            </div>
          </div>
        </div>
      )}

      {showInstallAnthropic && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-bg-surface border border-border-default p-6 space-y-4">
            <h3 className="text-lg font-semibold text-text-primary">安装 Anthropic Skill</h3>
            <Input
              placeholder="Skill ID（例如：text-editor）"
              value={anthropicSkillId}
              onChange={(e) => setAnthropicSkillId(e.target.value)}
              disabled={saving}
            />
            <div>
              <label className="block text-xs text-text-tertiary mb-1">从 Anthropic 目录选择（可选）</label>
              <select
                value={selectedCatalogSkillId}
                onChange={(e) => handleSelectCatalogSkill(e.target.value)}
                disabled={saving}
                className={clsx(
                  'w-full h-10 px-3 rounded-md',
                  'bg-bg-surface border border-border-default',
                  'text-text-primary',
                  'focus:outline-none focus:border-primary-500'
                )}
              >
                <option value="">手动输入 / 选择目录项</option>
                {catalogItems.map((item) => (
                  <option key={item.skillId} value={item.skillId}>
                    {item.name} ({item.skillId})
                  </option>
                ))}
              </select>
            </div>
            <Input
              placeholder="Manifest URL（可选，优先）"
              value={anthropicManifestUrl}
              onChange={(e) => setAnthropicManifestUrl(e.target.value)}
              disabled={saving}
            />
            <Input
              placeholder="版本（默认 latest）"
              value={anthropicVersion}
              onChange={(e) => setAnthropicVersion(e.target.value)}
              disabled={saving}
            />
            <Input
              placeholder="本地显示名称（可选）"
              value={anthropicName}
              onChange={(e) => setAnthropicName(e.target.value)}
              disabled={saving}
            />
            <textarea
              placeholder="描述（可选）"
              value={anthropicDescription}
              onChange={(e) => setAnthropicDescription(e.target.value)}
              disabled={saving}
              className={clsx(
                'w-full h-20 px-3 py-2 rounded-md resize-none',
                'bg-bg-surface border border-border-default',
                'text-text-primary placeholder:text-text-tertiary',
                'focus:outline-none focus:border-primary-500'
              )}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setShowInstallAnthropic(false)}
                disabled={saving}
              >
                取消
              </Button>
              <Button onClick={handleInstallAnthropicSkill} loading={saving}>
                安装
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
