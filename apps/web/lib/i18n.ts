/**
 * 国际化配置
 *
 * 支持 zh-CN 和 en-US，基于浏览器语言偏好自动选择
 */

import zhCN from '@/messages/zh-CN.json'
import enUS from '@/messages/en-US.json'

export const defaultLocale = 'zh-CN'
export const locales = ['zh-CN', 'en-US'] as const
export type Locale = (typeof locales)[number]

const messages: Record<Locale, typeof zhCN> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

/**
 * 检测用户语言偏好
 */
export function detectLocale(): Locale {
  if (typeof window === 'undefined') return defaultLocale

  const stored = localStorage.getItem('locale') as Locale | null
  if (stored && locales.includes(stored)) return stored

  const browserLang = navigator.language
  if (browserLang.startsWith('en')) return 'en-US'
  return 'zh-CN'
}

/**
 * 设置语言偏好
 */
export function setLocale(locale: Locale): void {
  localStorage.setItem('locale', locale)
  document.documentElement.lang = locale
}

/**
 * 获取翻译消息
 */
export function getMessages(locale: Locale = defaultLocale) {
  return messages[locale] ?? messages[defaultLocale]
}

/**
 * 翻译函数：根据 key path 获取翻译文本
 * 支持 t('error.notFound') 格式
 */
export function createTranslator(locale: Locale) {
  const msgs = getMessages(locale)

  return function t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.')
    let value: unknown = msgs
    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = (value as Record<string, unknown>)[k]
      } else {
        return key
      }
    }

    if (typeof value !== 'string') return key

    // 替换参数 {param}
    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, name) =>
        params[name] !== undefined ? String(params[name]) : `{${name}}`
      )
    }

    return value
  }
}

export default { detectLocale, setLocale, getMessages, createTranslator, defaultLocale, locales }
