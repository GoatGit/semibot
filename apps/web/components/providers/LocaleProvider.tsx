'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { STORAGE_KEYS, DEFAULT_LANGUAGE, LANGUAGES } from '@/constants/config'
import { createTranslator } from '@/lib/i18n'

type Locale = typeof LANGUAGES[number]
type TranslateParams = Record<string, string | number>
interface SetLocaleOptions {
  refresh?: boolean
}

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale, options?: SetLocaleOptions) => void
  t: (key: string, params?: TranslateParams) => string
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LANGUAGE,
  setLocale: () => {},
  t: (key: string) => key,
})

export function useLocale() {
  return useContext(LocaleContext)
}

function isLocale(value: string | null | undefined): value is Locale {
  return !!value && LANGUAGES.includes(value as Locale)
}

function resolveStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE
  const fromLanguage = localStorage.getItem(STORAGE_KEYS.LANGUAGE)
  const fromLegacyLocale = localStorage.getItem('locale')
  if (isLocale(fromLanguage)) return fromLanguage
  if (isLocale(fromLegacyLocale)) return fromLegacyLocale
  return DEFAULT_LANGUAGE
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => resolveStoredLocale())

  useEffect(() => {
    const nextLocale = resolveStoredLocale()
    setLocaleState(nextLocale)
    document.documentElement.lang = nextLocale
  }, [])

  const setLocale = useCallback((newLocale: Locale, options?: SetLocaleOptions) => {
    if (!isLocale(newLocale)) return

    const shouldRefresh = options?.refresh ?? true
    const localeChanged = newLocale !== locale

    setLocaleState(newLocale)
    localStorage.setItem(STORAGE_KEYS.LANGUAGE, newLocale)
    // 兼容旧逻辑：仍写入 legacy key。
    localStorage.setItem('locale', newLocale)
    document.documentElement.lang = newLocale
    if (shouldRefresh && localeChanged && typeof window !== 'undefined') {
      window.location.reload()
    }
  }, [locale])

  const translator = useMemo(() => createTranslator(locale), [locale])
  const t = useCallback((key: string, params?: TranslateParams) => translator(key, params), [translator])

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  )
}
