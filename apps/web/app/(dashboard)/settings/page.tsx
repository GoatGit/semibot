'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'
import { User, Palette, Loader2, Lock, SlidersHorizontal, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'
import { STORAGE_KEYS } from '@/constants/config'

type SettingsSection = 'profile' | 'password' | 'preferences'
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

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile')

  const sections = [
    { id: 'profile' as const, label: '个人资料', icon: <User size={18} /> },
    { id: 'password' as const, label: '修改密码', icon: <Lock size={18} /> },
    { id: 'preferences' as const, label: '偏好设置', icon: <Palette size={18} /> },
  ]

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary">个人设置</h1>
                <p className="mt-1 text-sm text-text-secondary">
                  管理个人资料、登录安全和界面偏好。
                </p>
              </div>
              <Link
                href="/config"
                className={clsx(
                  'inline-flex items-center gap-2 rounded-md border border-border-default px-3 py-2 text-sm',
                  'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                )}
              >
                <SlidersHorizontal size={14} />
                平台配置
                <ArrowRight size={14} />
              </Link>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={clsx(
                'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm',
                'border transition-colors duration-fast',
                activeSection === section.id
                  ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                  : 'border-border-default text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
              )}
            >
              {section.icon}
              {section.label}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-border-default bg-bg-surface p-6">
        {activeSection === 'profile' && <ProfileSection />}
        {activeSection === 'password' && <PasswordSection />}
        {activeSection === 'preferences' && <PreferencesSection />}
        </div>
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

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleChangePassword = async () => {
    setMessage(null)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage({ type: 'error', text: '请填写所有字段' })
      return
    }

    if (newPassword.length < 8) {
      setMessage({ type: 'error', text: '新密码至少 8 个字符' })
      return
    }

    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: '两次输入的新密码不一致' })
      return
    }

    try {
      setSaving(true)
      await apiClient.put('/users/me/password', {
        currentPassword,
        newPassword,
      })
      setMessage({ type: 'success', text: '密码修改成功' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '密码修改失败'
      setMessage({ type: 'error', text: errMsg })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">修改密码</h2>
        <p className="text-sm text-text-secondary mt-1">更新您的登录密码</p>
      </div>
      <Card>
        <CardContent>
          <div className="space-y-4">
            {message && (
              <div
                className={clsx(
                  'text-sm',
                  message.type === 'success' ? 'text-success-500' : 'text-error-500'
                )}
              >
                {message.text}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">当前密码</label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={saving}
                placeholder="请输入当前密码"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">新密码</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={saving}
                placeholder="至少 8 个字符"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">确认新密码</label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={saving}
                placeholder="再次输入新密码"
              />
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={handleChangePassword} loading={saving}>
          修改密码
        </Button>
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
        // 同步主题到 DOM 和 localStorage
        const savedTheme = response.data.theme
        const resolved = savedTheme === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : savedTheme
        document.documentElement.dataset.theme = resolved
        localStorage.setItem(STORAGE_KEYS.THEME, savedTheme)
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
          <p className="text-xs text-text-tertiary mt-3">语言切换功能开发中，当前仅支持中文界面</p>
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
