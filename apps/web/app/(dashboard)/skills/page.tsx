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

interface Skill {
  id: string
  name: string
  description?: string
  triggerKeywords: string[]
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
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')

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
    try {
      setSaving(true)
      await apiClient.post<ApiResponse<Skill>>('/skills', {
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      })
      setNewName('')
      setNewDescription('')
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

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">Skills</h1>
            <p className="text-sm text-text-secondary mt-1">共 {skills.length} 个技能</p>
          </div>
          <Button leftIcon={<Plus size={16} />} onClick={() => setShowCreate(true)}>
            添加技能
          </Button>
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
                          {skill.isBuiltin ? '内置技能' : '自定义技能'}
                        </div>
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
                        'relative w-10 h-5 rounded-full transition-colors',
                        skill.isActive ? 'bg-primary-500' : 'bg-neutral-600',
                        (saving || skill.isBuiltin) && 'opacity-60 cursor-not-allowed'
                      )}
                    >
                      <span
                        className={clsx(
                          'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                          skill.isActive && 'translate-x-5'
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
    </div>
  )
}
