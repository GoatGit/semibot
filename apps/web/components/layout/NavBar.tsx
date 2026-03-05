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
  Puzzle,
  Wrench,
  Activity,
  Workflow,
  ShieldCheck,
  Languages,
  CircleHelp,
} from 'lucide-react'
import { LANGUAGES } from '@/constants/config'
import { useLocale } from '@/components/providers/LocaleProvider'

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
  { icon: <Bot size={20} />, labelKey: 'nav.agents', helpKey: 'help.nav.agents', href: '/agents' },
  { icon: <Sparkles size={20} />, labelKey: 'nav.skills', helpKey: 'help.nav.skills', href: '/skills' },
  { icon: <Puzzle size={20} />, labelKey: 'nav.mcpServers', helpKey: 'help.nav.mcpServers', href: '/mcp' },
  { icon: <Wrench size={20} />, labelKey: 'nav.tools', helpKey: 'help.nav.tools', href: '/tools' },
  { icon: <SlidersHorizontal size={20} />, labelKey: 'nav.config', helpKey: 'help.nav.config', href: '/config' },
]

export function NavBar() {
  const { navBarExpanded } = useLayoutStore()
  const pathname = usePathname()
  const { locale, setLocale, t } = useLocale()
  const [isHovered, setIsHovered] = useState(false)
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
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

  const currentLanguageLabel = t(`nav.languageOptions.${locale}`) ?? locale
  const handleLocaleChange = useCallback(
    (nextLocale: typeof LANGUAGES[number]) => {
      setLocale(nextLocale, { refresh: false })
      setLanguageMenuOpen(false)
    },
    [setLocale]
  )

  return (
    <nav
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={clsx(
        'flex flex-col h-full',
        'bg-bg-surface border-r border-border-subtle',
        'transition-all duration-normal ease-out',
        isExpanded ? 'w-60' : 'w-[60px]'
      )}
    >
      <div className={clsx('px-3 py-3', 'border-b border-border-subtle')}>
        <div className={clsx('flex items-center', isExpanded ? 'gap-2 px-1' : 'justify-center')}>
          <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
            <Image src="/semibot-logo.png" alt="Semibot logo" width={32} height={32} priority />
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
              'text-xs border border-border-subtle',
              'hover:bg-interactive-hover hover:text-text-primary',
              'text-text-secondary',
              isExpanded ? 'justify-start w-full' : 'px-2'
            )}
            aria-haspopup="menu"
            aria-expanded={languageMenuOpen}
          >
            <Languages size={13} />
            {isExpanded && <span>{currentLanguageLabel}</span>}
          </button>
          {languageMenuOpen && isExpanded && (
            <div
              className="absolute left-0 mt-1 w-40 rounded-md border border-border-subtle bg-bg-surface shadow-lg z-10"
              role="menu"
            >
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
            active={pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))}
            expanded={isExpanded}
          />
        ))}
      </div>
      <div className="px-2 py-3 border-t border-border-subtle">
        <NavButton
          icon={<CircleHelp size={20} />}
          label={t('nav.helpCenter')}
          description={t('help.nav.helpCenter')}
          href="/help"
          active={pathname === '/help' || pathname.startsWith('/help/')}
          expanded={isExpanded}
          variant="primary"
        />
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
