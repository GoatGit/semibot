'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { Bot, Sparkles, Code, FileSearch, BarChart3, PenTool, ArrowRight, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'
import type { ApiResponse, Agent } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

interface AgentOption {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  color: string
  isFallback?: boolean
  isSystem?: boolean
}

function getDefaultTemplates(t: (key: string) => string): AgentOption[] {
  return [
    {
      id: 'general',
      name: t('chatNew.templates.general.name'),
      description: t('chatNew.templates.general.description'),
      icon: <Bot size={24} />,
      color: 'primary',
      isFallback: true,
    },
    {
      id: 'code',
      name: t('chatNew.templates.code.name'),
      description: t('chatNew.templates.code.description'),
      icon: <Code size={24} />,
      color: 'info',
      isFallback: true,
    },
    {
      id: 'research',
      name: t('chatNew.templates.research.name'),
      description: t('chatNew.templates.research.description'),
      icon: <FileSearch size={24} />,
      color: 'success',
      isFallback: true,
    },
    {
      id: 'data',
      name: t('chatNew.templates.data.name'),
      description: t('chatNew.templates.data.description'),
      icon: <BarChart3 size={24} />,
      color: 'warning',
      isFallback: true,
    },
    {
      id: 'creative',
      name: t('chatNew.templates.creative.name'),
      description: t('chatNew.templates.creative.description'),
      icon: <PenTool size={24} />,
      color: 'error',
      isFallback: true,
    },
  ]
}

// 根据 Agent 名称选择图标
function getAgentIcon(name: string): React.ReactNode {
  const lowerName = name.toLowerCase()
  if (lowerName.includes('代码') || lowerName.includes('code')) {
    return <Code size={24} />
  }
  if (lowerName.includes('研究') || lowerName.includes('research')) {
    return <FileSearch size={24} />
  }
  if (lowerName.includes('数据') || lowerName.includes('data')) {
    return <BarChart3 size={24} />
  }
  if (lowerName.includes('创意') || lowerName.includes('写作') || lowerName.includes('creative')) {
    return <PenTool size={24} />
  }
  return <Bot size={24} />
}

// 根据索引分配颜色
function getAgentColor(index: number): string {
  const colors = ['primary', 'info', 'success', 'warning', 'error']
  return colors[index % colors.length]
}

/**
 * New Chat Page - 新建会话页面
 *
 * 提供快速开始选项:
 * - 选择 Agent
 * - 直接输入开始对话
 */
export default function NewChatPage() {
  const router = useRouter()
  const { t } = useLocale()
  const fallbackTemplates = useMemo(() => getDefaultTemplates(t), [t])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [isLoadingAgents, setIsLoadingAgents] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [usingFallbackAgents, setUsingFallbackAgents] = useState(false)

  // 加载 Agent 列表
  const loadAgents = useCallback(async () => {
    try {
      setIsLoadingAgents(true)
      const response = await apiClient.get<ApiResponse<Agent[]>>('/agents')

      if (response.success && response.data && response.data.length > 0) {
        const agentOptions: AgentOption[] = response.data
          .filter((a: Agent) => a.isActive)
          .map((agent: Agent, index: number) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description ?? t('chatNew.smartAssistant'),
            icon: getAgentIcon(agent.name),
            color: getAgentColor(index),
            isFallback: false,
            isSystem: agent.isSystem === true,
          }))
        if (agentOptions.length > 0) {
          setAgents(agentOptions)
          setUsingFallbackAgents(false)
          return
        }
      }

      setAgents(fallbackTemplates)
      setUsingFallbackAgents(true)
    } catch (err) {
      console.error('[NewChat] 加载 Agent 列表失败:', err)
      setAgents(fallbackTemplates)
      setUsingFallbackAgents(true)
    } finally {
      setIsLoadingAgents(false)
    }
  }, [fallbackTemplates, t])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  const handleStartChat = async () => {
    if (!message.trim() && !selectedAgentId) return

    setIsCreating(true)
    setError(null)

    try {
      // 确定使用的 Agent
      const selectedAgent = selectedAgentId
        ? agents.find((a) => a.id === selectedAgentId)
        : agents[0]

      if (!selectedAgent || selectedAgent.isFallback || usingFallbackAgents) {
        throw new Error(t('chatNew.error.noAvailableAgent'))
      }

      const agentId = selectedAgent.id

      if (!agentId) {
        throw new Error(t('chatNew.error.selectAgent'))
      }

      const initialMessage = message.trim() || t('chatNew.defaultMessage')

      // 创建会话（普通 REST 请求，立即返回 sessionId）
      const response = await apiClient.post<ApiResponse<{ id: string }>>('/sessions', {
        agentId,
        title: initialMessage.slice(0, 100),
      })

      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? t('chatNew.error.createSession'))
      }

      const sessionId = response.data.id
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(`semibot:initialMessage:${sessionId}`, initialMessage)
      }

      // 立即跳转到会话页面，通过 query 参数传递初始消息
      router.push(`/chat/${sessionId}?initialMessage=${encodeURIComponent(initialMessage)}`)
    } catch (err) {
      console.error('[NewChat] 创建会话失败:', err)
      setError(err instanceof Error ? err.message : t('chatNew.error.createSession'))
      setIsCreating(false)
    }
  }

  const getColorClasses = (color: string, isSelected: boolean) => {
    const colors: Record<string, { bg: string; border: string; text: string }> = {
      primary: {
        bg: isSelected ? 'bg-primary-500/20' : 'hover:bg-primary-500/10',
        border: isSelected ? 'border-primary-500' : 'border-border-default hover:border-primary-500/50',
        text: 'text-primary-400',
      },
      info: {
        bg: isSelected ? 'bg-info-500/20' : 'hover:bg-info-500/10',
        border: isSelected ? 'border-info-500' : 'border-border-default hover:border-info-500/50',
        text: 'text-info-500',
      },
      success: {
        bg: isSelected ? 'bg-success-500/20' : 'hover:bg-success-500/10',
        border: isSelected ? 'border-success-500' : 'border-border-default hover:border-success-500/50',
        text: 'text-success-500',
      },
      warning: {
        bg: isSelected ? 'bg-warning-500/20' : 'hover:bg-warning-500/10',
        border: isSelected ? 'border-warning-500' : 'border-border-default hover:border-warning-500/50',
        text: 'text-warning-500',
      },
      error: {
        bg: isSelected ? 'bg-error-500/20' : 'hover:bg-error-500/10',
        border: isSelected ? 'border-error-500' : 'border-border-default hover:border-error-500/50',
        text: 'text-error-500',
      },
    }
    return colors[color] || colors.primary
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 主内容区 */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-12">
          {/* 标题区 */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary-500/20 mb-4">
              <Sparkles size={32} className="text-primary-400" />
            </div>
            <h1 className="text-2xl font-semibold text-text-primary">{t('chatNew.title')}</h1>
            <p className="text-text-secondary mt-2">
              {t('chatNew.subtitle')}
            </p>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 p-4 mb-6 rounded-lg bg-error-500/10 border border-error-500/20">
              <AlertCircle size={20} className="text-error-500 flex-shrink-0" />
              <p className="text-sm text-error-500">{error}</p>
            </div>
          )}

          {/* Agent 选择 */}
          <div className="mb-8">
            <h2 className="text-sm font-medium text-text-secondary mb-4">{t('chatNew.chooseAgent')}</h2>
            {isLoadingAgents ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500" />
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {agents.map((agent) => {
                  const isSelected = selectedAgentId === agent.id
                  const colors = getColorClasses(agent.color, isSelected)

                  return (
                    <button
                      key={agent.id}
                      onClick={() => setSelectedAgentId(isSelected ? null : agent.id)}
                      className={clsx(
                        'flex flex-col items-start p-4 rounded-lg border',
                        'transition-all duration-fast text-left',
                        colors.bg,
                        colors.border
                      )}
                    >
                      <div className={clsx('mb-3', colors.text)}>{agent.icon}</div>
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-sm font-medium text-text-primary">{agent.name}</h3>
                        {agent.isSystem && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-primary-500/20 text-primary-400 rounded">
                            {t('chatNew.system')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-secondary mt-1 line-clamp-2">
                        {agent.description}
                      </p>
                    </button>
                  )
                })}
              </div>
            )}
            {usingFallbackAgents && !isLoadingAgents && (
              <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-warning-500/10 border border-warning-500/20">
                <AlertCircle size={18} className="text-warning-500 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-warning-500">
                  <p>{t('chatNew.warning.noAvailableAgent')}</p>
                  <a href="/agents" className="underline underline-offset-4">
                    {t('chatNew.warning.goCreateAgent')}
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* 快速开始 */}
          <Card variant="outlined" padding="lg">
            <CardContent>
              <h2 className="text-sm font-medium text-text-secondary mb-3">{t('chatNew.quickStart')}</h2>
              <div className="space-y-4">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t('chatNew.inputPlaceholder')}
                  className={clsx(
                    'w-full h-32 px-4 py-3 rounded-lg resize-none',
                    'bg-bg-surface border border-border-default',
                    'text-text-primary placeholder:text-text-tertiary',
                    'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
                    'transition-all duration-fast'
                  )}
                />
                <div className="flex items-center justify-between">
                  <div className="text-xs text-text-tertiary">
                    {selectedAgentId && (
                      <span>
                        {t('chatNew.selectedPrefix')} {agents.find((a) => a.id === selectedAgentId)?.name}
                      </span>
                    )}
                  </div>
                  <Button
                    onClick={handleStartChat}
                    loading={isCreating}
                    disabled={(!message.trim() && !selectedAgentId) || usingFallbackAgents}
                    rightIcon={<ArrowRight size={16} />}
                  >
                    {t('chatNew.startChat')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 示例提示 */}
          <div className="mt-8">
            <h2 className="text-sm font-medium text-text-secondary mb-3">{t('chatNew.suggestionsTitle')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {[
                t('chatNew.suggestions.item1'),
                t('chatNew.suggestions.item2'),
                t('chatNew.suggestions.item3'),
                t('chatNew.suggestions.item4'),
              ].map((suggestion, index) => (
                <button
                  key={index}
                  onClick={() => setMessage(suggestion)}
                  className={clsx(
                    'text-left px-4 py-3 rounded-lg',
                    'bg-bg-surface border border-border-subtle',
                    'text-sm text-text-secondary',
                    'hover:bg-interactive-hover hover:text-text-primary hover:border-border-default',
                    'transition-all duration-fast'
                  )}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
