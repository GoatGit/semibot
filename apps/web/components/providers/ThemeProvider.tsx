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

import { createContext, useContext, useCallback, useMemo } from 'react'

interface ThemeContextType {
  theme: Theme | null
  setTheme: (newTheme: Theme) => void
}

const ThemeContext = createContext<ThemeContextType>({
  theme: null,
  setTheme: () => { },
})

export function useTheme() {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme | null>(null)

  // 初始化：从 localStorage 读取缓存主题（避免闪烁）
  useEffect(() => {
    const cached = localStorage.getItem(STORAGE_KEYS.THEME) as Theme | null
    const initial = cached ?? DEFAULT_THEME
    setThemeState(initial)
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
          setThemeState(serverTheme)
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

  const handleSetTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme)
    applyTheme(newTheme)
    localStorage.setItem(STORAGE_KEYS.THEME, newTheme)
    // 异步同步到后端，不阻塞 UI
    apiClient.patch('/users/preferences', { theme: newTheme }).catch(() => { })
  }, [])

  const contextValue = useMemo(() => ({ theme, setTheme: handleSetTheme }), [theme, handleSetTheme])

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>
}
