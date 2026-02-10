'use client'

import { useEffect, useState } from 'react'
import { STORAGE_KEYS, DEFAULT_THEME } from '@/constants/config'
import { apiClient } from '@/lib/api'

type Theme = 'dark' | 'light' | 'system'

interface PreferencesResponse {
  success: boolean
  data: { theme: Theme; language: string }
}

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? getSystemTheme() : theme
  document.documentElement.dataset.theme = resolved
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme | null>(null)

  // 初始化：从 localStorage 读取缓存主题（避免闪烁）
  useEffect(() => {
    const cached = localStorage.getItem(STORAGE_KEYS.THEME) as Theme | null
    const initial = cached ?? DEFAULT_THEME
    setTheme(initial)
    applyTheme(initial)
  }, [])

  // 从后端加载偏好并同步
  useEffect(() => {
    let cancelled = false
    const loadPreferences = async () => {
      try {
        const response = await apiClient.get<PreferencesResponse>('/users/preferences')
        if (!cancelled && response.success && response.data) {
          const serverTheme = response.data.theme
          setTheme(serverTheme)
          applyTheme(serverTheme)
          localStorage.setItem(STORAGE_KEYS.THEME, serverTheme)
        }
      } catch {
        // 静默处理，使用缓存主题
      }
    }
    loadPreferences()
    return () => { cancelled = true }
  }, [])

  // 监听 system 主题变化
  useEffect(() => {
    if (theme !== 'system') return
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [theme])

  return <>{children}</>
}
