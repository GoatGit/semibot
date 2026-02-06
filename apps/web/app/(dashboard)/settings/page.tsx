'use client'

import { useState } from 'react'
import clsx from 'clsx'
import { User, Key, Palette, Globe, Bell, Shield, ChevronRight, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card'
import {
  API_KEY_MASK_PREFIX_LENGTH,
  API_KEY_MASK_SUFFIX_LENGTH,
  API_KEY_MASK_CHAR_COUNT,
  THEMES,
  LANGUAGES,
  DEFAULT_THEME,
  DEFAULT_LANGUAGE,
} from '@/constants/config'

type SettingsSection = 'profile' | 'api-keys' | 'preferences' | 'notifications' | 'security'

interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
  lastUsed: string | null
}

/**
 * Settings Page - 设置页面
 *
 * 包含以下部分:
 * - Profile settings (用户资料)
 * - API keys management (API 密钥管理)
 * - Preferences (偏好设置: 主题、语言)
 */
export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile')

  const sections = [
    { id: 'profile' as const, label: '个人资料', icon: <User size={18} /> },
    { id: 'api-keys' as const, label: 'API 密钥', icon: <Key size={18} /> },
    { id: 'preferences' as const, label: '偏好设置', icon: <Palette size={18} /> },
    { id: 'notifications' as const, label: '通知设置', icon: <Bell size={18} /> },
    { id: 'security' as const, label: '安全设置', icon: <Shield size={18} /> },
  ]

  return (
    <div className="flex flex-1 min-h-0">
      {/* 侧边导航 */}
      <nav className="w-56 flex-shrink-0 border-r border-border-subtle p-4">
        <h1 className="text-lg font-semibold text-text-primary mb-6">设置</h1>
        <div className="space-y-1">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={clsx(
                'flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm',
                'transition-colors duration-fast',
                activeSection === section.id
                  ? 'bg-interactive-active text-text-primary'
                  : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
              )}
            >
              {section.icon}
              {section.label}
              {activeSection === section.id && (
                <ChevronRight size={16} className="ml-auto" />
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeSection === 'profile' && <ProfileSection />}
        {activeSection === 'api-keys' && <ApiKeysSection />}
        {activeSection === 'preferences' && <PreferencesSection />}
        {activeSection === 'notifications' && <NotificationsSection />}
        {activeSection === 'security' && <SecuritySection />}
      </div>
    </div>
  )
}

function ProfileSection() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">个人资料</h2>
        <p className="text-sm text-text-secondary mt-1">管理您的账户信息</p>
      </div>

      <Card>
        <CardContent>
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-full bg-primary-500/20 flex items-center justify-center">
              <User size={32} className="text-primary-400" />
            </div>
            <div>
              <Button variant="secondary" size="sm">更换头像</Button>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                用户名
              </label>
              <Input placeholder="请输入用户名" defaultValue="developer" />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                邮箱
              </label>
              <Input type="email" placeholder="请输入邮箱" defaultValue="dev@example.com" />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                个人简介
              </label>
              <textarea
                className={clsx(
                  'w-full h-24 px-3 py-2 rounded-md resize-none',
                  'bg-bg-surface border border-border-default',
                  'text-text-primary placeholder:text-text-tertiary',
                  'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
                  'transition-all duration-fast'
                )}
                placeholder="介绍一下自己..."
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button>保存更改</Button>
      </div>
    </div>
  )
}

function ApiKeysSection() {
  const [showKey, setShowKey] = useState<string | null>(null)
  const [apiKeys] = useState<ApiKey[]>([
    {
      id: '1',
      name: 'Production API Key',
      key: 'sk-prod-xxxxxxxxxxxxxxxxxxxx',
      createdAt: '2026-01-15',
      lastUsed: '2026-02-05',
    },
    {
      id: '2',
      name: 'Development API Key',
      key: 'sk-dev-xxxxxxxxxxxxxxxxxxxx',
      createdAt: '2026-02-01',
      lastUsed: null,
    },
  ])

  const maskKey = (key: string) => {
    return key.slice(0, API_KEY_MASK_PREFIX_LENGTH) + '•'.repeat(API_KEY_MASK_CHAR_COUNT) + key.slice(-API_KEY_MASK_SUFFIX_LENGTH)
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">API 密钥</h2>
          <p className="text-sm text-text-secondary mt-1">管理您的 API 访问密钥</p>
        </div>
        <Button leftIcon={<Plus size={16} />}>创建密钥</Button>
      </div>

      <div className="space-y-3">
        {apiKeys.map((apiKey) => (
          <Card key={apiKey.id}>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-text-primary">{apiKey.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="text-xs font-mono text-text-secondary bg-bg-elevated px-2 py-1 rounded">
                      {showKey === apiKey.id ? apiKey.key : maskKey(apiKey.key)}
                    </code>
                    <button
                      onClick={() => setShowKey(showKey === apiKey.id ? null : apiKey.id)}
                      className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                      aria-label={showKey === apiKey.id ? '隐藏密钥' : '显示密钥'}
                    >
                      {showKey === apiKey.id ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-xs text-text-tertiary">
                    <span>创建于 {apiKey.createdAt}</span>
                    <span>
                      {apiKey.lastUsed ? `最后使用 ${apiKey.lastUsed}` : '从未使用'}
                    </span>
                  </div>
                </div>
                <Button variant="tertiary" size="sm" leftIcon={<Trash2 size={14} />}>
                  删除
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

function PreferencesSection() {
  const [theme, setTheme] = useState<typeof THEMES[number]>(DEFAULT_THEME)
  const [language, setLanguage] = useState<typeof LANGUAGES[number]>(DEFAULT_LANGUAGE)

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">偏好设置</h2>
        <p className="text-sm text-text-secondary mt-1">自定义您的使用体验</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette size={18} />
            外观
          </CardTitle>
          <CardDescription>选择界面主题</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {[
              { id: 'dark', label: '深色' },
              { id: 'light', label: '浅色' },
              { id: 'system', label: '跟随系统' },
            ].map((option) => (
              <button
                key={option.id}
                onClick={() => setTheme(option.id as typeof theme)}
                className={clsx(
                  'flex-1 py-3 px-4 rounded-lg border text-sm font-medium',
                  'transition-all duration-fast',
                  theme === option.id
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-border-default text-text-secondary hover:border-border-strong'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe size={18} />
            语言
          </CardTitle>
          <CardDescription>选择界面语言</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {[
              { id: 'zh-CN', label: '简体中文' },
              { id: 'en-US', label: 'English' },
            ].map((option) => (
              <button
                key={option.id}
                onClick={() => setLanguage(option.id as typeof language)}
                className={clsx(
                  'flex-1 py-3 px-4 rounded-lg border text-sm font-medium',
                  'transition-all duration-fast',
                  language === option.id
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-border-default text-text-secondary hover:border-border-strong'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button>保存更改</Button>
      </div>
    </div>
  )
}

function NotificationsSection() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">通知设置</h2>
        <p className="text-sm text-text-secondary mt-1">管理您的通知偏好</p>
      </div>

      <Card>
        <CardContent>
          <div className="space-y-4">
            <NotificationToggle
              label="任务完成通知"
              description="当 Agent 任务完成时发送通知"
              defaultChecked
            />
            <NotificationToggle
              label="错误警报"
              description="当发生错误时立即通知"
              defaultChecked
            />
            <NotificationToggle
              label="系统更新"
              description="接收系统更新和维护通知"
            />
            <NotificationToggle
              label="营销信息"
              description="接收产品更新和促销信息"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

interface NotificationToggleProps {
  label: string
  description: string
  defaultChecked?: boolean
}

function NotificationToggle({ label, description, defaultChecked = false }: NotificationToggleProps) {
  const [checked, setChecked] = useState(defaultChecked)

  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-secondary">{description}</p>
      </div>
      <button
        onClick={() => setChecked(!checked)}
        className={clsx(
          'relative w-11 h-6 rounded-full transition-colors duration-fast',
          checked ? 'bg-primary-500' : 'bg-neutral-600'
        )}
        role="switch"
        aria-checked={checked}
      >
        <span
          className={clsx(
            'absolute top-1 left-1 w-4 h-4 rounded-full bg-white',
            'transition-transform duration-fast',
            checked && 'translate-x-5'
          )}
        />
      </button>
    </div>
  )
}

function SecuritySection() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text-primary">安全设置</h2>
        <p className="text-sm text-text-secondary mt-1">保护您的账户安全</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>修改密码</CardTitle>
          <CardDescription>定期更换密码以确保账户安全</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                当前密码
              </label>
              <Input type="password" placeholder="请输入当前密码" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                新密码
              </label>
              <Input type="password" placeholder="请输入新密码" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                确认新密码
              </label>
              <Input type="password" placeholder="请再次输入新密码" />
            </div>
            <Button>更新密码</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>两步验证</CardTitle>
          <CardDescription>为您的账户添加额外的安全保护</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-text-primary">状态：未启用</p>
              <p className="text-xs text-text-secondary mt-1">
                启用两步验证后，登录时需要额外验证
              </p>
            </div>
            <Button variant="secondary">启用</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
