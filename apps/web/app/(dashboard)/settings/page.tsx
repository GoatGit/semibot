'use client'

import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { User, Key, Palette, ChevronRight, Plus, Trash2, Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'

type SettingsSection = 'profile' | 'api-keys' | 'preferences'
type Theme = 'dark' | 'light' | 'system'
type Language = 'zh-CN' | 'en-US'

interface ApiResponse<T> {
  success: boolean
  data: T
}

interface UserProfile {
  id: string
  email: string
  name: string
  avatarUrl?: string
}

interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  createdAt?: string
}

interface CreatedApiKey {
  id: string
  name: string
  key: string
  keyPrefix: string
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile')

  const sections = [
    { id: 'profile' as const, label: '个人资料', icon: <User size={18} /> },
    { id: 'api-keys' as const, label: 'API 密钥', icon: <Key size={18} /> },
    { id: 'preferences' as const, label: '偏好设置', icon: <Palette size={18} /> },
  ]

  return (
    <div className="flex flex-1 min-h-0">
      <nav className="w-56 flex-shrink-0 border-r border-border-subtle p-4">
        <h1 className="text-lg font-semibold text-text-primary mb-6">设置</h1>
        <div className="space-y-1">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={clsx(
                'flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm',
                activeSection === section.id
                  ? 'bg-interactive-active text-text-primary'
                  : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
              )}
            >
              {section.icon}
              {section.label}
              {activeSection === section.id && <ChevronRight size={16} className="ml-auto" />}
            </button>
          ))}
        </div>
      </nav>

      <div className="flex-1 overflow-y-auto p-6">
        {activeSection === 'profile' && <ProfileSection />}
        {activeSection === 'api-keys' && <ApiKeysSection />}
        {activeSection === 'preferences' && <PreferencesSection />}
      </div>
    </div>
  )
}

function ProfileSection() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [name, setName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const loadProfile = useCallback(async () => {
    try {
      setLoading(true)
      const response = await apiClient.get<ApiResponse<UserProfile>>('/users/me')
      if (response.success && response.data) {
        setProfile(response.data)
        setName(response.data.name || '')
        setAvatarUrl(response.data.avatarUrl || '')
      }
    } catch (error) {
      console.error('[Settings] 获取用户资料失败:', error)
      setMessage('加载用户资料失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  const handleSave = async () => {
    try {
      setSaving(true)
      setMessage(null)
      const response = await apiClient.patch<ApiResponse<UserProfile>>('/users/me', {
        name: name.trim(),
        avatarUrl: avatarUrl.trim() || undefined,
      })
      if (response.success && response.data) {
        setProfile(response.data)
        setMessage('保存成功')
      }
    } catch (error) {
      console.error('[Settings] 保存用户资料失败:', error)
      setMessage('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">个人资料</h2>
        <p className="text-sm text-text-secondary mt-1">来自真实 `/users/me` 接口</p>
      </div>
      <Card>
        <CardContent>
          {loading ? (
            <div className="h-32 flex items-center justify-center text-text-secondary">
              <Loader2 size={18} className="animate-spin mr-2" />
              加载中...
            </div>
          ) : (
            <div className="space-y-4">
              {message && <div className="text-sm text-text-secondary">{message}</div>}
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">邮箱</label>
                <Input value={profile?.email || ''} disabled />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">用户名</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">头像 URL</label>
                <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} disabled={saving} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={handleSave} loading={saving} disabled={loading}>
          保存更改
        </Button>
      </div>
    </div>
  )
}

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<CreatedApiKey | null>(null)
  const [showRawKey, setShowRawKey] = useState(false)

  const loadKeys = useCallback(async () => {
    try {
      setLoading(true)
      const response = await apiClient.get<ApiResponse<ApiKey[]>>('/api-keys')
      if (response.success) {
        setKeys(response.data || [])
      }
    } catch (error) {
      console.error('[Settings] 获取 API Keys 失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadKeys()
  }, [loadKeys])

  const createKey = async () => {
    if (!newKeyName.trim()) return
    try {
      setSaving(true)
      const response = await apiClient.post<ApiResponse<CreatedApiKey>>('/api-keys', {
        name: newKeyName.trim(),
      })
      if (response.success && response.data) {
        setNewlyCreatedKey(response.data)
        setShowRawKey(true)
        setNewKeyName('')
        await loadKeys()
      }
    } catch (error) {
      console.error('[Settings] 创建 API Key 失败:', error)
    } finally {
      setSaving(false)
    }
  }

  const deleteKey = async (keyId: string) => {
    try {
      setSaving(true)
      await apiClient.delete(`/api-keys/${keyId}`)
      await loadKeys()
    } catch (error) {
      console.error('[Settings] 删除 API Key 失败:', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">API 密钥</h2>
          <p className="text-sm text-text-secondary mt-1">来自真实 `/api-keys` 接口</p>
        </div>
      </div>

      <Card>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="输入新密钥名称"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              disabled={saving}
            />
            <Button leftIcon={<Plus size={16} />} onClick={createKey} loading={saving}>
              创建
            </Button>
          </div>
        </CardContent>
      </Card>

      {newlyCreatedKey && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">新密钥（仅展示一次）</CardTitle>
            <CardDescription>请立即复制保存</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono text-text-secondary bg-bg-elevated px-2 py-1 rounded flex-1 break-all">
                {showRawKey ? newlyCreatedKey.key : newlyCreatedKey.keyPrefix}
              </code>
              <button
                onClick={() => setShowRawKey((prev) => !prev)}
                className="p-1 text-text-tertiary hover:text-text-primary"
              >
                {showRawKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {loading ? (
          <div className="h-24 flex items-center justify-center text-text-secondary">
            <Loader2 size={18} className="animate-spin mr-2" />
            加载中...
          </div>
        ) : keys.length === 0 ? (
          <div className="text-sm text-text-secondary">暂无 API 密钥</div>
        ) : (
          keys.map((key) => (
            <Card key={key.id}>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-text-primary">{key.name}</div>
                    <div className="text-xs text-text-tertiary mt-1">
                      前缀: {key.keyPrefix} · 最后使用: {key.lastUsedAt || '从未使用'}
                    </div>
                  </div>
                  <Button
                    variant="tertiary"
                    size="sm"
                    leftIcon={<Trash2 size={14} />}
                    onClick={() => deleteKey(key.id)}
                    disabled={saving}
                  >
                    删除
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}

function PreferencesSection() {
  const [theme, setTheme] = useState<Theme>('dark')
  const [language, setLanguage] = useState<Language>('zh-CN')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const loadPreferences = useCallback(async () => {
    try {
      setLoading(true)
      setMessage(null)
      const response = await apiClient.get<ApiResponse<{ theme: Theme; language: Language }>>(
        '/users/preferences'
      )
      if (response.success && response.data) {
        setTheme(response.data.theme)
        setLanguage(response.data.language)
      }
    } catch (error) {
      console.error('[Settings] 获取偏好设置失败:', error)
      setMessage('加载偏好设置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPreferences()
  }, [loadPreferences])

  const savePreferences = async () => {
    try {
      setSaving(true)
      setMessage(null)
      const response = await apiClient.patch<ApiResponse<{ theme: Theme; language: Language }>>(
        '/users/preferences',
        { theme, language }
      )
      if (response.success && response.data) {
        setTheme(response.data.theme)
        setLanguage(response.data.language)
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 1200)
    } catch (error) {
      console.error('[Settings] 保存偏好设置失败:', error)
      setMessage('保存偏好设置失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">偏好设置</h2>
        <p className="text-sm text-text-secondary mt-1">来自真实 `/users/preferences` 接口</p>
      </div>

      {message && <div className="text-sm text-text-secondary">{message}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">主题</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            {(['dark', 'light', 'system'] as const).map((item) => (
              <button
                key={item}
                onClick={() => setTheme(item)}
                disabled={loading || saving}
                className={clsx(
                  'px-3 py-2 rounded-md text-sm border',
                  theme === item
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-border-default text-text-secondary'
                )}
              >
                {item}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">语言</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            {(['zh-CN', 'en-US'] as const).map((item) => (
              <button
                key={item}
                onClick={() => setLanguage(item)}
                disabled={loading || saving}
                className={clsx(
                  'px-3 py-2 rounded-md text-sm border',
                  language === item
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-border-default text-text-secondary'
                )}
              >
                {item}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-success-500">已保存</span>}
        <Button onClick={savePreferences} loading={saving} disabled={loading}>
          保存偏好
        </Button>
      </div>
    </div>
  )
}
