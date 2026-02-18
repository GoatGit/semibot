'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { STORAGE_KEYS, DEFAULT_LANGUAGE, LANGUAGES } from '@/constants/config'

type Locale = typeof LANGUAGES[number]

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string) => string
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LANGUAGE,
  setLocale: () => {},
  t: (key: string) => key,
})

export function useLocale() {
  return useContext(LocaleContext)
}

// 内联翻译表，避免异步加载复杂度
const messages: Record<Locale, Record<string, Record<string, string>>> = {
  'zh-CN': {
    common: {
      loading: '加载中...',
      error: '错误',
      success: '成功',
      confirm: '确认',
      cancel: '取消',
      save: '保存',
      delete: '删除',
      edit: '编辑',
      create: '创建',
      search: '搜索',
      noData: '暂无数据',
      retry: '重试',
    },
    errors: {
      AUTH_INVALID_TOKEN: '无效的认证令牌',
      AUTH_TOKEN_EXPIRED: '认证令牌已过期',
      AUTH_UNAUTHORIZED: '未授权访问',
      AGENT_NOT_FOUND: 'Agent 不存在',
      SESSION_NOT_FOUND: '会话不存在',
      SKILL_NOT_FOUND: '技能不存在',
      WEBHOOK_NOT_FOUND: 'Webhook 不存在',
      WEBHOOK_LIMIT_EXCEEDED: 'Webhook 数量已达上限',
      WEBHOOK_DELIVERY_FAILED: 'Webhook 推送失败',
      RATE_LIMIT_EXCEEDED: '请求频率超限，请稍后重试',
      INTERNAL_ERROR: '服务器内部错误',
      NETWORK_ERROR: '网络连接失败',
    },
  },
  'en-US': {
    common: {
      loading: 'Loading...',
      error: 'Error',
      success: 'Success',
      confirm: 'Confirm',
      cancel: 'Cancel',
      save: 'Save',
      delete: 'Delete',
      edit: 'Edit',
      create: 'Create',
      search: 'Search',
      noData: 'No data',
      retry: 'Retry',
    },
    errors: {
      AUTH_INVALID_TOKEN: 'Invalid authentication token',
      AUTH_TOKEN_EXPIRED: 'Authentication token expired',
      AUTH_UNAUTHORIZED: 'Unauthorized access',
      AGENT_NOT_FOUND: 'Agent not found',
      SESSION_NOT_FOUND: 'Session not found',
      SKILL_NOT_FOUND: 'Skill not found',
      WEBHOOK_NOT_FOUND: 'Webhook not found',
      WEBHOOK_LIMIT_EXCEEDED: 'Webhook limit exceeded',
      WEBHOOK_DELIVERY_FAILED: 'Webhook delivery failed',
      RATE_LIMIT_EXCEEDED: 'Rate limit exceeded, please try again later',
      INTERNAL_ERROR: 'Internal server error',
      NETWORK_ERROR: 'Network connection failed',
    },
  },
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LANGUAGE)

  useEffect(() => {
    const cached = localStorage.getItem(STORAGE_KEYS.LANGUAGE) as Locale | null
    if (cached && LANGUAGES.includes(cached)) {
      setLocaleState(cached)
      document.documentElement.lang = cached
    }
  }, [])

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale)
    localStorage.setItem(STORAGE_KEYS.LANGUAGE, newLocale)
    document.documentElement.lang = newLocale
  }

  const t = (key: string): string => {
    // key 格式: "common.loading" 或 "errors.AUTH_INVALID_TOKEN"
    const parts = key.split('.')
    if (parts.length !== 2) return key

    const [namespace, messageKey] = parts
    return messages[locale]?.[namespace]?.[messageKey] ?? key
  }

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  )
}
