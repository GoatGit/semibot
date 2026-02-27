'use client'

import { useState, useCallback } from 'react'
import { useLayoutStore } from '@/stores/layoutStore'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
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
} from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'

interface NavItem {
  icon: React.ReactNode
  labelKey: string
  href: string
}

const navItems: NavItem[] = [
  { icon: <LayoutDashboard size={20} />, labelKey: 'nav.dashboard', href: '/dashboard' },
  { icon: <MessageSquare size={20} />, labelKey: 'nav.sessions', href: '/chat' },
  { icon: <Activity size={20} />, labelKey: 'nav.events', href: '/events' },
  { icon: <Workflow size={20} />, labelKey: 'nav.rules', href: '/rules' },
  { icon: <ShieldCheck size={20} />, labelKey: 'nav.approvals', href: '/approvals' },
  { icon: <Bot size={20} />, labelKey: 'nav.agents', href: '/agents' },
  { icon: <Sparkles size={20} />, labelKey: 'nav.skills', href: '/skills' },
  { icon: <Puzzle size={20} />, labelKey: 'nav.mcpServers', href: '/mcp' },
  { icon: <Wrench size={20} />, labelKey: 'nav.tools', href: '/tools' },
  { icon: <SlidersHorizontal size={20} />, labelKey: 'nav.config', href: '/config' },
]

export function NavBar() {
  const { navBarExpanded } = useLayoutStore()
  const pathname = usePathname()
  const { locale, setLocale, t } = useLocale()
  const [isHovered, setIsHovered] = useState(false)

  const isExpanded = navBarExpanded || isHovered

  const handleMouseEnter = useCallback(() => {
    if (!navBarExpanded) {
      setIsHovered(true)
    }
  }, [navBarExpanded])

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
  }, [])

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN', { refresh: false })
  }, [locale, setLocale])

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
          <div className="w-8 h-8 rounded-lg bg-primary-500 flex items-center justify-center">
            <Bot size={18} className="text-neutral-950" />
          </div>
          {isExpanded && (
            <span className="font-display font-semibold text-lg text-text-primary whitespace-nowrap">
              Semibot
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={toggleLocale}
          className={clsx(
            'mt-2 h-7 px-2 rounded-md',
            'text-xs border border-border-subtle',
            'hover:bg-interactive-hover hover:text-text-primary',
            'text-text-secondary transition-colors',
            isExpanded ? 'inline-flex items-center gap-1.5' : 'w-full flex items-center justify-center'
          )}
          title={t('nav.switchLanguage')}
          aria-label={t('nav.switchLanguage')}
        >
          <Languages size={13} />
          {isExpanded && <span>{t('nav.language')}</span>}
        </button>
      </div>

      <div className="flex-1 py-4 space-y-1 px-2 overflow-y-auto">
        {navItems.map((item) => (
          <NavButton
            key={item.href}
            icon={item.icon}
            label={t(item.labelKey)}
            href={item.href}
            active={pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))}
            expanded={isExpanded}
          />
        ))}


      </div>
    </nav>
  )
}

interface NavButtonProps {
  icon: React.ReactNode
  label: string
  href: string
  active?: boolean
  expanded: boolean
  variant?: 'default' | 'primary'
}

function NavButton({ icon, label, href, active, expanded, variant = 'default' }: NavButtonProps) {
  return (
    <Link
      href={href}
      className={clsx(
        'flex items-center gap-3 h-10 px-3 rounded-md',
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
