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
import { useLocale } from '@/components/providers/LocaleProvider'

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
  const { t } = useLocale()
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile')

  const sections = [
    { id: 'profile' as const, label: t('settings.sections.profile'), icon: <User size={18} /> },
    { id: 'password' as const, label: t('settings.sections.password'), icon: <Lock size={18} /> },
    { id: 'preferences' as const, label: t('settings.sections.preferences'), icon: <Palette size={18} /> },
  ]

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary">{t('settings.title')}</h1>
                <p className="mt-1 text-sm text-text-secondary">
                  {t('settings.subtitle')}
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
                {t('settings.platformConfig')}
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
  const { t } = useLocale()
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
      setMessage(t('settings.profile.error.load'))
    } finally {
      setLoading(false)
    }
  }, [t])

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
        setMessage(t('settings.profile.success.saved'))
      }
    } catch (error) {
      console.error('[Settings] 保存用户资料失败:', error)
      setMessage(t('settings.profile.error.save'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{t('settings.profile.title')}</h2>
        <p className="text-sm text-text-secondary mt-1">{t('settings.profile.subtitle')}</p>
      </div>
      <Card>
        <CardContent>
          {loading ? (
            <div className="h-32 flex items-center justify-center text-text-secondary">
              <Loader2 size={18} className="animate-spin mr-2" />
              {t('common.loading')}
            </div>
          ) : (
            <div className="space-y-4">
              {message && <div className="text-sm text-text-secondary">{message}</div>}
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">{t('auth.email')}</label>
                <Input value={profile?.email || ''} disabled />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">{t('settings.profile.username')}</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">{t('settings.profile.avatarUrl')}</label>
                <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} disabled={saving} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={handleSave} loading={saving} disabled={loading}>
          {t('settings.profile.saveChanges')}
        </Button>
      </div>
    </div>
  )
}

function PasswordSection() {
  const { t } = useLocale()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleChangePassword = async () => {
    setMessage(null)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage({ type: 'error', text: t('settings.password.error.required') })
      return
    }

    if (newPassword.length < 8) {
      setMessage({ type: 'error', text: t('settings.password.error.minLength') })
      return
    }

    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: t('settings.password.error.mismatch') })
      return
    }

    try {
      setSaving(true)
      await apiClient.put('/users/me/password', {
        currentPassword,
        newPassword,
      })
      setMessage({ type: 'success', text: t('settings.password.success.changed') })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : t('settings.password.error.changeFailed')
      setMessage({ type: 'error', text: errMsg })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{t('settings.password.title')}</h2>
        <p className="text-sm text-text-secondary mt-1">{t('settings.password.subtitle')}</p>
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
              <label className="block text-sm font-medium text-text-primary mb-1.5">{t('settings.password.currentPassword')}</label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={saving}
                placeholder={t('settings.password.currentPasswordPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">{t('settings.password.newPassword')}</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={saving}
                placeholder={t('settings.password.newPasswordPlaceholder')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">{t('settings.password.confirmPassword')}</label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={saving}
                placeholder={t('settings.password.confirmPasswordPlaceholder')}
              />
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={handleChangePassword} loading={saving}>
          {t('settings.password.changePassword')}
        </Button>
      </div>
    </div>
  )
}

function PreferencesSection() {
  const { locale, setLocale: applyLocale, t } = useLocale()
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
      setMessage(t('settings.preferences.error.load'))
    } finally {
      setLoading(false)
    }
  }, [t])

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
        if (response.data.language !== locale) {
          applyLocale(response.data.language)
        }
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 1200)
    } catch (error) {
      console.error('[Settings] 保存偏好设置失败:', error)
      setMessage(t('settings.preferences.error.save'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">{t('settings.preferences.title')}</h2>
        <p className="text-sm text-text-secondary mt-1">{t('settings.preferences.subtitle')}</p>
      </div>

      {message && <div className="text-sm text-text-secondary">{message}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.preferences.theme')}</CardTitle>
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
                {item === 'dark' && t('settings.preferences.themeOptions.dark')}
                {item === 'light' && t('settings.preferences.themeOptions.light')}
                {item === 'system' && t('settings.preferences.themeOptions.system')}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.preferences.language')}</CardTitle>
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
                {item === 'zh-CN' ? t('settings.preferences.languageOptions.zhCN') : t('settings.preferences.languageOptions.enUS')}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-tertiary mt-3">{t('settings.preferences.languageHint')}</p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-success-500">{t('settings.preferences.saved')}</span>}
        <Button onClick={savePreferences} loading={saving} disabled={loading}>
          {t('settings.preferences.save')}
        </Button>
      </div>
    </div>
  )
}
