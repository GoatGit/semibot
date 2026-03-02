'use client'

import Link from 'next/link'
import { BookOpen, CircleHelp, ExternalLink, MessageSquare, ShieldCheck, Send, Wrench } from 'lucide-react'
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

export default function HelpCenterPage() {
  const { t } = useLocale()

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-subtle bg-bg-surface/70 overflow-hidden shadow-xs">
          <CardContent className="p-6 md:p-7">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-3">
                <h1 className="text-2xl md:text-3xl font-semibold text-text-primary flex items-center gap-2">
                  <CircleHelp size={24} className="text-primary-400" />
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
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2 border-border-subtle bg-bg-surface/60 shadow-xs">
            <CardContent className="p-5 space-y-3.5">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <BookOpen size={18} className="text-primary-400" />
                {t('helpCenter.featureGuide.title')}
              </h2>
              <p className="text-sm text-text-secondary/90">{t('helpCenter.featureGuide.subtitle')}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {HELP_NAV_ITEMS.map((item) => {
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
            </CardContent>
          </Card>

          <Card className="border-border-subtle bg-bg-surface/60 shadow-xs">
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

        <Card className="border-border-subtle bg-bg-surface/60 shadow-xs">
          <CardContent className="p-5 space-y-4.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <Wrench size={18} className="text-primary-400" />
                {t('helpCenter.gatewayTutorial.title')}
              </h2>
              <Link
                href="/config"
                className="inline-flex items-center gap-1 text-sm text-primary-400 hover:text-primary-300"
                title={t('helpCenter.gatewayTutorial.openConfigTip')}
              >
                {t('helpCenter.gatewayTutorial.openConfig')}
                <ExternalLink size={14} />
              </Link>
            </div>
            <p className="text-sm text-text-secondary/90">{t('helpCenter.gatewayTutorial.subtitle')}</p>

            <div className="space-y-3">
              {GATEWAY_STEPS.map((stepKey, index) => (
                <div key={stepKey} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 p-4">
                  <p className="text-sm font-medium text-text-primary">
                    {index + 1}. {t(`helpCenter.gatewayTutorial.steps.${stepKey}.title`)}
                  </p>
                  <p className="text-sm text-text-secondary/90 mt-1 leading-relaxed">
                    {t(`helpCenter.gatewayTutorial.steps.${stepKey}.description`)}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border-subtle/80 bg-bg-elevated/45 p-4">
              <p className="text-sm font-medium text-text-primary flex items-center gap-2">
                <ShieldCheck size={16} className="text-success-500" />
                {t('helpCenter.gatewayTutorial.securityTitle')}
              </p>
              <p className="text-sm text-text-secondary/90 mt-1 leading-relaxed">{t('helpCenter.gatewayTutorial.securityBody')}</p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-text-primary">{t('helpCenter.gatewayFaq.title')}</p>
              <div className="space-y-2">
                {GATEWAY_FAQ.map((faqKey) => (
                  <div key={faqKey} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 px-4 py-3">
                    <p className="text-sm font-medium text-text-primary">{t(`helpCenter.gatewayFaq.items.${faqKey}.q`)}</p>
                    <p className="text-sm text-text-secondary/90 mt-1 leading-relaxed">{t(`helpCenter.gatewayFaq.items.${faqKey}.a`)}</p>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card className="border-border-subtle bg-bg-surface/60 shadow-xs">
            <CardContent className="p-5 space-y-3.5">
              <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <Send size={18} className="text-primary-400" />
                {t('helpCenter.gatewayProviders.feishu.title')}
              </h2>
              <p className="text-sm text-text-secondary/90">{t('helpCenter.gatewayProviders.feishu.subtitle')}</p>
              <div className="space-y-2.5">
                {FEISHU_GUIDE_KEYS.map((key, index) => (
                  <div key={key} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 px-4 py-3">
                    <p className="text-sm font-medium text-text-primary">
                      {index + 1}. {t(`helpCenter.gatewayProviders.feishu.items.${key}.title`)}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary/90 leading-relaxed">
                      {t(`helpCenter.gatewayProviders.feishu.items.${key}.description`)}
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
                {t('helpCenter.gatewayProviders.telegram.title')}
              </h2>
              <p className="text-sm text-text-secondary/90">{t('helpCenter.gatewayProviders.telegram.subtitle')}</p>
              <div className="space-y-2.5">
                {TELEGRAM_GUIDE_KEYS.map((key, index) => (
                  <div key={key} className="rounded-lg border border-border-subtle/80 bg-bg-surface/70 px-4 py-3">
                    <p className="text-sm font-medium text-text-primary">
                      {index + 1}. {t(`helpCenter.gatewayProviders.telegram.items.${key}.title`)}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary/90 leading-relaxed">
                      {t(`helpCenter.gatewayProviders.telegram.items.${key}.description`)}
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
