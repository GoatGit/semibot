'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useLayoutStore } from '@/stores/layoutStore'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import clsx from 'clsx'
import {
  LayoutDashboard,
  Bot,
  SlidersHorizontal,
  MessageSquare,
  Sparkles,
  Wrench,
  Activity,
  Workflow,
  ShieldCheck,
  Languages,
  CircleHelp,
  Moon,
  Sun,
  Monitor,
  RefreshCw,
  BarChart2,
  Clapperboard,
} from 'lucide-react'
import { LANGUAGES } from '@/constants/config'
import { useLocale } from '@/components/providers/LocaleProvider'
import { useTheme } from '@/components/providers/ThemeProvider'
import { apiClient } from '@/lib/api'

interface NavItem {
  icon: React.ReactNode
  labelKey: string
  helpKey: string
  href: string
}

const navItems: NavItem[] = [
  { icon: <LayoutDashboard size={20} />, labelKey: 'nav.dashboard', helpKey: 'help.nav.dashboard', href: '/dashboard' },
  { icon: <MessageSquare size={20} />, labelKey: 'nav.sessions', helpKey: 'help.nav.sessions', href: '/chat' },
  { icon: <Activity size={20} />, labelKey: 'nav.events', helpKey: 'help.nav.events', href: '/events' },
  { icon: <Workflow size={20} />, labelKey: 'nav.rules', helpKey: 'help.nav.rules', href: '/rules' },
  { icon: <ShieldCheck size={20} />, labelKey: 'nav.approvals', helpKey: 'help.nav.approvals', href: '/approvals' },
  { icon: <BarChart2 size={20} />, labelKey: 'nav.usage', helpKey: 'help.nav.usage', href: '/usage' },
  { icon: <Bot size={20} />, labelKey: 'nav.agents', helpKey: 'help.nav.agents', href: '/agents' },
  { icon: <Clapperboard size={20} />, labelKey: 'nav.studio', helpKey: 'help.nav.studio', href: '/studio' },
  { icon: <Sparkles size={20} />, labelKey: 'nav.skills', helpKey: 'help.nav.skills', href: '/skills' },
  { icon: <Wrench size={20} />, labelKey: 'nav.tools', helpKey: 'help.nav.tools', href: '/tools' },
  { icon: <SlidersHorizontal size={20} />, labelKey: 'nav.config', helpKey: 'help.nav.config', href: '/config' },
]

export function NavBar() {
  const { navBarExpanded } = useLayoutStore()
  const pathname = usePathname()
  const { locale, setLocale, t } = useLocale()
  const { theme, setTheme } = useTheme()
  const [isHovered, setIsHovered] = useState(false)
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null)
  const [runtimeHealthy, setRuntimeHealthy] = useState<boolean | null>(null)
  const [appVersion, setAppVersion] = useState('dev')
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [releaseNotesUrl, setReleaseNotesUrl] = useState<string | null>(null)
  const [upgradeStatus, setUpgradeStatus] = useState<string>('idle')
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const isExpanded = navBarExpanded || isHovered

  const handleMouseEnter = useCallback(() => {
    if (!navBarExpanded) {
      setIsHovered(true)
    }
  }, [navBarExpanded])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
  }, [])

  useEffect(() => {
    if (!languageMenuOpen) return undefined
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setLanguageMenuOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLanguageMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [languageMenuOpen])

  useEffect(() => {
    let cancelled = false

    const checkHealth = async () => {
      try {
        await apiClient.get('/health')
        if (!cancelled) setApiHealthy(true)
      } catch {
        if (!cancelled) setApiHealthy(false)
      }

      try {
        const response = await apiClient.get<{ data?: { available?: boolean } }>('/runtime/health')
        if (!cancelled) setRuntimeHealthy(response?.data?.available === true)
      } catch {
        if (!cancelled) setRuntimeHealthy(false)
      }
    }

    void checkHealth()
    const timer = window.setInterval(() => {
      void checkHealth()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const shouldPollUpgradeStatus = ['queued', 'stopping', 'upgrading', 'restarting'].includes(upgradeStatus)

    const loadUpgradeStatus = async () => {
      try {
        const response = await apiClient.get<{
          data?: {
            status?: string
            message?: string | null
            error?: string | null
          }
        }>('/version/upgrade')
        const data = response?.data
        if (cancelled || !data) return
        setUpgradeStatus(String(data.status || 'idle'))
        setUpgradeMessage(data.message || null)
        setUpgradeError(data.error || null)
      } catch {
        if (!cancelled) {
          setUpgradeStatus('idle')
          setUpgradeMessage(null)
          setUpgradeError(null)
        }
      }
    }

    void loadUpgradeStatus()
    if (!shouldPollUpgradeStatus) {
      return () => {
        cancelled = true
      }
    }

    const timer = window.setInterval(() => {
      void loadUpgradeStatus()
    }, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [upgradeStatus])

  useEffect(() => {
    let cancelled = false

    const loadVersion = async () => {
      try {
        const response = await apiClient.get<{
          data?: {
            currentVersion?: string
            latestVersion?: string | null
            updateAvailable?: boolean
            releaseNotesUrl?: string | null
          }
        }>('/version')
        const data = response?.data
        if (cancelled || !data) return
        setAppVersion(data.currentVersion || 'dev')
        setLatestVersion(data.latestVersion || null)
        setUpdateAvailable(data.updateAvailable === true)
        setReleaseNotesUrl(data.releaseNotesUrl || null)
      } catch {
        if (!cancelled) {
          setAppVersion('dev')
          setLatestVersion(null)
          setUpdateAvailable(false)
          setReleaseNotesUrl(null)
        }
      }
    }

    void loadVersion()
    const timer = window.setInterval(() => {
      void loadVersion()
    }, 5 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const currentLanguageLabel = t(`nav.languageOptions.${locale}`) ?? locale
  const handleLocaleChange = useCallback(
    (nextLocale: typeof LANGUAGES[number]) => {
      setLocale(nextLocale, { refresh: false })
      setLanguageMenuOpen(false)
    },
    [setLocale]
  )

  const toggleTheme = useCallback(() => {
    if (theme === 'dark') setTheme('light')
    else if (theme === 'light') setTheme('system')
    else setTheme('dark')
  }, [theme, setTheme])

  const upgradeInFlight = ['queued', 'stopping', 'upgrading', 'restarting'].includes(upgradeStatus)

  const isNavItemActive = useCallback(
    (href: string) => {
      if (href === '/tools') {
        return pathname === '/tools'
      }
      return pathname === href || (href !== '/' && pathname.startsWith(href))
    },
    [pathname]
  )

  const handleVersionClick = useCallback(() => {}, [])

  const handleOpenReleaseNotes = useCallback(() => {
    if (!releaseNotesUrl) return
    window.open(releaseNotesUrl, '_blank', 'noopener,noreferrer')
  }, [releaseNotesUrl])

  const handleTriggerUpgrade = useCallback(async () => {
    if (!updateAvailable || upgradeInFlight) return
    try {
      const response = await apiClient.post<{
        data?: {
          status?: string
          message?: string | null
          error?: string | null
        }
      }>('/version/upgrade', {})
      const data = response?.data
      setUpgradeStatus(String(data?.status || 'queued'))
      setUpgradeMessage(data?.message || '升级任务已提交')
      setUpgradeError(data?.error || null)
    } catch (error) {
      setUpgradeStatus('failed')
      setUpgradeMessage('启动升级失败')
      setUpgradeError(error instanceof Error ? error.message : '启动升级失败')
    }
  }, [updateAvailable, upgradeInFlight])

  return (
    <nav
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={clsx(
        'flex flex-col h-full bg-bg-surface border-r border-border-subtle transition-all duration-normal ease-out',
        isExpanded ? 'w-60' : 'w-[60px]'
      )}
    >
      <div className={clsx('px-3 py-3 border-b border-border-subtle')}>
        <div className={clsx('flex items-center', isExpanded ? 'gap-2 px-1' : 'justify-center')}>
          <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
            <Image src="/semibot-logo.png" alt="Semibot logo" width={32} height={32} priority unoptimized />
          </div>
          {isExpanded && (
            <span className="font-display font-semibold text-lg text-text-primary whitespace-nowrap">
              Semibot
            </span>
          )}
        </div>
        <div ref={menuRef} className={clsx('relative mt-2', isExpanded ? 'inline-flex' : 'flex justify-center')}>
          <button
            type="button"
            onClick={() => setLanguageMenuOpen((prev) => !prev)}
            className={clsx(
              'h-7 px-2 rounded-md flex items-center gap-1.5 transition-colors',
              'text-xs border border-border-subtle hover:bg-interactive-hover hover:text-text-primary text-text-secondary',
              isExpanded ? 'justify-start w-full' : 'px-2'
            )}
            aria-haspopup="menu"
            aria-expanded={languageMenuOpen}
          >
            <Languages size={13} />
            {isExpanded && <span>{currentLanguageLabel}</span>}
          </button>
          {languageMenuOpen && isExpanded && (
            <div className="absolute left-0 mt-1 w-40 rounded-md border border-border-subtle bg-bg-surface shadow-lg z-10" role="menu">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => handleLocaleChange(lang)}
                  className={clsx(
                    'w-full text-left px-3 py-2 text-sm transition-colors',
                    lang === locale ? 'bg-primary-500/10 text-primary-500' : 'text-text-secondary hover:bg-bg-elevated'
                  )}
                  role="menuitem"
                >
                  {t(`nav.languageOptions.${lang}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 py-4 space-y-1 px-2 overflow-y-auto">
        {navItems.map((item) => (
          <NavButton
            key={item.href}
            icon={item.icon}
            label={t(item.labelKey)}
            description={t(item.helpKey)}
            href={item.href}
            active={isNavItemActive(item.href)}
            expanded={isExpanded}
          />
        ))}
      </div>

      <div className="border-t border-border-subtle p-2 space-y-2">
        {/* Health Indicators Row */}
        <div className={clsx('flex items-center gap-2', !isExpanded && 'flex-col')}>
          <HealthIndicator expanded={isExpanded} label="API" healthy={apiHealthy} />
          <HealthIndicator expanded={isExpanded} label="Runtime" healthy={runtimeHealthy} />
        </div>

        {/* Action Buttons Row */}
        <div className={clsx('flex items-center gap-1', !isExpanded && 'flex-col')}>
          {/* Help Center */}
          <Link
            href="/help"
            className={clsx(
              'flex items-center justify-center p-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-interactive-hover transition-colors',
              isExpanded ? 'flex-1' : 'w-10 h-10',
              pathname === '/help' && 'bg-interactive-active text-text-primary'
            )}
            title={t('nav.helpCenter')}
          >
            <CircleHelp size={16} />
            {isExpanded && <span className="ml-2 text-xs font-medium">{t('nav.helpCenter')}</span>}
          </Link>

          {/* Theme Toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className={clsx(
              'flex items-center justify-center p-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-interactive-hover transition-colors',
              isExpanded ? 'flex-1' : 'w-10 h-10'
            )}
            title="切换主题"
          >
            {theme === 'dark' ? <Moon size={16} /> : theme === 'light' ? <Sun size={16} /> : <Monitor size={16} />}
            {isExpanded && (
              <span className="ml-2 text-xs font-medium">
                {theme === 'dark' ? '夜间' : theme === 'light' ? '日间' : '跟随系统'}
              </span>
            )}
          </button>
        </div>

        {/* Version Row */}
        <div className={clsx('space-y-1', !isExpanded && 'flex flex-col items-center gap-1 space-y-0')}>
          <button
            type="button"
            onClick={handleVersionClick}
            className={clsx(
              'relative flex items-center justify-center p-2 rounded-md transition-colors hover:bg-interactive-hover',
              updateAvailable ? 'text-amber-500 hover:text-amber-400' : 'text-text-tertiary hover:text-text-secondary',
              isExpanded ? 'flex-1' : 'w-10 h-10 flex-col'
            )}
            title={updateAvailable && latestVersion ? `发现新版本 ${latestVersion}，当前 ${appVersion}` : `当前版本 ${appVersion}`}
          >
            {isExpanded ? (
              <>
                <RefreshCw size={14} className={clsx('opacity-60', updateAvailable && 'text-amber-500')} />
                <span className="ml-2 text-xs font-mono font-medium">{appVersion}</span>
                {updateAvailable && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-red-500" />}
              </>
            ) : (
              <>
                <span className="text-[10px] font-mono font-medium tracking-tighter shrink-0 pt-0.5" style={{ transform: 'scale(0.8)' }}>
                  {appVersion}
                </span>
                {updateAvailable && <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500" />}
              </>
            )}
          </button>
          {isExpanded && updateAvailable && latestVersion && (
            <div className="px-2 text-[10px] text-amber-500">
              发现新版本 {latestVersion}
            </div>
          )}
          {isExpanded && updateAvailable && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleTriggerUpgrade}
                disabled={upgradeInFlight}
                className={clsx(
                  'px-2 py-2 rounded-md text-[10px] font-medium transition-colors',
                  upgradeInFlight
                    ? 'bg-amber-500/10 text-amber-400 cursor-not-allowed'
                    : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/20'
                )}
                title="后台安装并重启到最新版本"
              >
                {upgradeInFlight ? '更新中' : '立即更新'}
              </button>
              {releaseNotesUrl && (
                <button
                  type="button"
                  onClick={handleOpenReleaseNotes}
                  className="px-2 py-2 rounded-md text-[10px] font-medium text-text-secondary hover:bg-interactive-hover hover:text-text-primary transition-colors"
                  title="查看发布说明"
                >
                  发布说明
                </button>
              )}
            </div>
          )}
          {isExpanded && upgradeMessage && (
            <div className={clsx('px-2 text-[10px]', upgradeStatus === 'failed' ? 'text-red-400' : 'text-text-secondary')}>
              {upgradeMessage}
            </div>
          )}
          {isExpanded && upgradeError && upgradeStatus === 'failed' && (
            <div
              className="mx-2 max-h-32 overflow-y-auto rounded-md border border-red-500/20 bg-red-500/5 px-2 py-1 text-[10px] text-red-400 break-all"
              title="升级错误详情"
            >
              {upgradeError}
            </div>
          )}
          {isExpanded && !updateAvailable && <div className="flex-1" />}
        </div>
      </div>
    </nav>
  )
}

interface NavButtonProps {
  icon: React.ReactNode
  label: string
  description: string
  href: string
  active?: boolean
  expanded: boolean
  variant?: 'default' | 'primary'
}

function NavButton({ icon, label, description, href, active, expanded, variant = 'default' }: NavButtonProps) {
  void description
  return (
    <Link
      href={href}
      className={clsx(
        'flex items-center gap-3 h-10 px-3 rounded-md w-full',
        'transition-colors duration-fast',
        expanded ? 'justify-start' : 'justify-center',
        active
          ? 'bg-interactive-active text-text-primary'
          : variant === 'primary'
            ? 'bg-primary-500/10 text-primary-400 hover:bg-primary-500/20'
            : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
      )}
      title={!expanded ? label : undefined}
    >
      {icon}
      {expanded && <span className="text-sm font-medium">{label}</span>}
    </Link>
  )
}

interface HealthIndicatorProps {
  expanded: boolean
  label: string
  healthy: boolean | null
}

function HealthIndicator({ expanded, label, healthy }: HealthIndicatorProps) {
  const dotColor =
    healthy === null
      ? 'bg-amber-400'
      : healthy
        ? 'bg-emerald-400'
        : 'bg-red-400'

  const glowColor =
    healthy === null
      ? 'shadow-[0_0_6px_rgba(251,191,36,0.6)]'
      : healthy
        ? 'shadow-[0_0_6px_rgba(52,211,153,0.6)]'
        : 'shadow-[0_0_6px_rgba(248,113,113,0.6)]'

  return (
    <div
      className={clsx(
        'flex flex-1 items-center gap-2 rounded-md transition-colors cursor-default',
        expanded
          ? 'px-2 py-1.5 justify-center bg-white/[0.04] hover:bg-white/[0.08] min-h-[36px]'
          : 'w-10 h-10 justify-center bg-transparent hover:bg-white/[0.05]',
        'text-xs'
      )}
      title={`${label}: ${healthy === null ? 'checking' : healthy ? 'healthy' : 'down'}`}
    >
      <span className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', dotColor, glowColor)} />
      {expanded && <span className="font-medium text-text-secondary">{label}</span>}
    </div>
  )
}
