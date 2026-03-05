'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useMemo, useState } from 'react'
import { BookOpen, ExternalLink, MessageSquare, ShieldCheck, Send, Wrench } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useLocale } from '@/components/providers/LocaleProvider'
import clsx from 'clsx'

interface HelpNavItem {
  key: string
  href: string
}

const HELP_NAV_ITEMS: HelpNavItem[] = [
  { key: 'dashboard', href: '/dashboard' },
  { key: 'chat', href: '/chat' },
  { key: 'events', href: '/events' },
  { key: 'rules', href: '/rules' },
  { key: 'approvals', href: '/approvals' },
  { key: 'agents', href: '/agents' },
  { key: 'skills', href: '/skills' },
  { key: 'mcp', href: '/mcp' },
  { key: 'tools', href: '/tools' },
  { key: 'config', href: '/config' },
]

const GATEWAY_STEPS = [
  'prepare',
  'create',
  'policy',
  'test',
  'platformWebhook',
  'observe',
] as const

const GATEWAY_FAQ = ['noResponse', 'notInAllowedChatIds', 'tokenInvalid', 'approvalStuck'] as const
const FEISHU_GUIDE_KEYS = ['credentials', 'events', 'cardActions', 'testAndObserve'] as const
const TELEGRAM_GUIDE_KEYS = ['credentials', 'setWebhook', 'privacyAndChatId', 'testAndObserve'] as const
const HELP_SECTION_ANCHORS = [
  { id: 'feature-guide', icon: BookOpen, fallback: 'Feature Guide' },
  { id: 'hover-tips', icon: MessageSquare, fallback: 'Hover Tips' },
  { id: 'channel-tutorial', icon: Wrench, fallback: 'Gateway Tutorial' },
  { id: 'provider-guides', icon: Send, fallback: 'Provider Guides' },
] as const

export default function HelpCenterPage() {
  const { t } = useLocale()
  const [query, setQuery] = useState('')
  const tSafe = (key: string, fallback: string) => {
    const value = t(key)
    return value === key ? fallback : value
  }

  const filteredNavItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return HELP_NAV_ITEMS
    return HELP_NAV_ITEMS.filter((item) => {
      const navKey = item.key === 'chat' ? 'sessions' : item.key === 'mcp' ? 'mcpServers' : item.key
      const title = t(`nav.${navKey}`).toLowerCase()
      const desc = t(`help.nav.${navKey}`).toLowerCase()
      return title.includes(normalized) || desc.includes(normalized)
    })
  }, [query, t])

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-subtle bg-bg-surface/70 overflow-hidden shadow-xs">
          <CardContent className="p-6 md:p-7">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-3">
                <h1 className="text-2xl md:text-3xl font-semibold text-text-primary flex items-center gap-2">
                  <Image src="/semibot-logo.png" alt="Semibot logo" width={30} height={30} className="rounded" />
                  {t('helpCenter.title')}
                </h1>
                <p className="text-sm md:text-base text-text-secondary/90 max-w-3xl">
                  {t('helpCenter.subtitle')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{t('helpCenter.badges.hover')}</Badge>
                  <Badge variant="outline">{t('helpCenter.badges.gateway')}</Badge>
                  <Badge variant="outline">{t('helpCenter.badges.quickStart')}</Badge>
                </div>
                <div className="grid grid-cols-1 gap-3 pt-1 md:grid-cols-[1fr_auto]">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={tSafe('helpCenter.searchPlaceholder', 'Search guides, modules, and troubleshooting...')}
                    className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500/60 focus:outline-none"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {HELP_SECTION_ANCHORS.map((section) => {
                      const Icon = section.icon
                      return (
                        <a
                          key={section.id}
                          href={`#${section.id}`}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-surface/70 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
                        >
                          <Icon size={12} />
                          {tSafe(`helpCenter.sections.${section.id}`, section.fallback)}
                        </a>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card id="feature-guide" className="lg:col-span-2 border-border-subtle bg-bg-surface/60 shadow-xs">
            <CardContent className="p-5 space-y-3.5">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <BookOpen size={18} className="text-primary-400" />
                {t('helpCenter.featureGuide.title')}
              </h2>
              <p className="text-sm text-text-secondary/90">{t('helpCenter.featureGuide.subtitle')}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {filteredNavItems.map((item) => {
                  const title = t(`nav.${item.key === 'chat' ? 'sessions' : item.key === 'mcp' ? 'mcpServers' : item.key}`)
                  const description = t(`help.nav.${item.key === 'chat' ? 'sessions' : item.key === 'mcp' ? 'mcpServers' : item.key}`)
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      title={description}
                      className={clsx(
                        'rounded-lg border border-border-subtle/80 bg-bg-surface/70 px-3 py-3',
                        'hover:border-border-default hover:bg-bg-surface transition-colors'
                      )}
                    >
                      <p className="text-sm font-medium text-text-primary">{title}</p>
                      <p className="text-xs text-text-secondary/90 mt-1 leading-relaxed">{description}</p>
                    </Link>
                  )
                })}
              </div>
              {filteredNavItems.length === 0 ? (
                <p className="rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-secondary">
                  {tSafe('helpCenter.searchNoResults', 'No matching guides found. Try broader keywords.')}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card id="hover-tips" className="border-border-subtle bg-bg-surface/60 shadow-xs">
            <CardContent className="p-5 space-y-3">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <MessageSquare size={18} className="text-primary-400" />
                {t('helpCenter.hoverTips.title')}
              </h2>
              <p className="text-sm text-text-secondary/90">{t('helpCenter.hoverTips.subtitle')}</p>
              <ul className="space-y-2 text-sm text-text-secondary">
                {[1, 2, 3].map((idx) => (
                  <li key={idx} className="rounded-md border border-border-subtle/80 bg-bg-surface/70 px-3 py-2 leading-relaxed">
                    {t(`helpCenter.hoverTips.items.${idx}`)}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <Card id="gateway-tutorial" className="border-border-subtle bg-bg-surface/60 shadow-xs">
          <CardContent className="p-5 space-y-4.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <Wrench size={18} className="text-primary-400" />
                {t('helpCenter.channelTutorial.title')}
              </h2>
              <Link
                href="/config"
                className="inline-flex items-center gap-1 text-sm text-primary-400 hover:text-primary-300"
                title={t('helpCenter.channelTutorial.openConfigTip')}
              >
                {t('helpCenter.channelTutorial.openConfig')}
                <ExternalLink size={14} />
              </Link>
            </div>
            <p className="text-sm text-text-secondary/90">{t('helpCenter.channelTutorial.subtitle')}</p>

            <div className="space-y-3">
              {GATEWAY_STEPS.map((stepKey, index) => (
                <div key={stepKey} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 p-4">
                  <p className="text-sm font-medium text-text-primary">
                    {index + 1}. {t(`helpCenter.channelTutorial.steps.${stepKey}.title`)}
                  </p>
                  <p className="text-sm text-text-secondary/90 mt-1 leading-relaxed">
                    {t(`helpCenter.channelTutorial.steps.${stepKey}.description`)}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border-subtle/80 bg-bg-elevated/45 p-4">
              <p className="text-sm font-medium text-text-primary flex items-center gap-2">
                <ShieldCheck size={16} className="text-success-500" />
                {t('helpCenter.channelTutorial.securityTitle')}
              </p>
              <p className="text-sm text-text-secondary/90 mt-1 leading-relaxed">{t('helpCenter.channelTutorial.securityBody')}</p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-text-primary">{t('helpCenter.channelFaq.title')}</p>
              <div className="space-y-2">
                {GATEWAY_FAQ.map((faqKey, idx) => (
                  <details key={faqKey} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 px-4 py-3" open={idx === 0}>
                    <summary className="cursor-pointer text-sm font-medium text-text-primary">
                      {t(`helpCenter.channelFaq.items.${faqKey}.q`)}
                    </summary>
                    <p className="text-sm text-text-secondary/90 mt-2 leading-relaxed">{t(`helpCenter.channelFaq.items.${faqKey}.a`)}</p>
                  </details>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <div id="provider-guides" className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card className="border-border-subtle bg-bg-surface/60 shadow-xs">
            <CardContent className="p-5 space-y-3.5">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <Send size={18} className="text-primary-400" />
                {t('helpCenter.channelProviders.feishu.title')}
              </h2>
              <p className="text-sm text-text-secondary/90">{t('helpCenter.channelProviders.feishu.subtitle')}</p>
              <div className="space-y-2.5">
                {FEISHU_GUIDE_KEYS.map((key, index) => (
                  <div key={key} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 px-4 py-3">
                    <p className="text-sm font-medium text-text-primary">
                      {index + 1}. {t(`helpCenter.channelProviders.feishu.items.${key}.title`)}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary/90 leading-relaxed">
                      {t(`helpCenter.channelProviders.feishu.items.${key}.description`)}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border-subtle bg-bg-surface/60 shadow-xs">
            <CardContent className="p-5 space-y-3.5">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <Send size={18} className="text-primary-400" />
                {t('helpCenter.channelProviders.telegram.title')}
              </h2>
              <p className="text-sm text-text-secondary/90">{t('helpCenter.channelProviders.telegram.subtitle')}</p>
              <div className="space-y-2.5">
                {TELEGRAM_GUIDE_KEYS.map((key, index) => (
                  <div key={key} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 px-4 py-3">
                    <p className="text-sm font-medium text-text-primary">
                      {index + 1}. {t(`helpCenter.channelProviders.telegram.items.${key}.title`)}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary/90 leading-relaxed">
                      {t(`helpCenter.channelProviders.telegram.items.${key}.description`)}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
