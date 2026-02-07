'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { Bot, Sparkles, Code, FileSearch, BarChart3, PenTool, ArrowRight, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { apiClient } from '@/lib/api'
import type { ApiResponse, Agent } from '@/types'

interface AgentOption {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  color: string
  isFallback?: boolean
}

// 默认 Agent 模板（当无法加载真实 Agent 列表时使用）
const defaultTemplates: AgentOption[] = [
  {
    id: 'general',
    name: '通用助手',
    description: '多功能 AI 助手，可以帮助您完成各种任务',
    icon: <Bot size={24} />,
    color: 'primary',
    isFallback: true,
  },
  {
    id: 'code',
    name: '代码助手',
    description: '专注于编程和代码审查的 AI 助手',
    icon: <Code size={24} />,
    color: 'info',
    isFallback: true,
  },
  {
    id: 'research',
    name: '研究助手',
    description: '帮助您搜索、整理和分析信息',
    icon: <FileSearch size={24} />,
    color: 'success',
    isFallback: true,
  },
  {
    id: 'data',
    name: '数据分析',
    description: '数据处理、可视化和洞察分析',
    icon: <BarChart3 size={24} />,
    color: 'warning',
    isFallback: true,
  },
  {
    id: 'creative',
    name: '创意写作',
    description: '文案创作、内容生成和编辑',
    icon: <PenTool size={24} />,
    color: 'error',
    isFallback: true,
  },
]

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
          .filter((a) => a.isActive)
          .map((agent, index) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description ?? '智能 AI 助手',
            icon: getAgentIcon(agent.name),
            color: getAgentColor(index),
            isFallback: false,
          }))
        if (agentOptions.length > 0) {
          setAgents(agentOptions)
          setUsingFallbackAgents(false)
          return
        }
      }

      setAgents(defaultTemplates)
      setUsingFallbackAgents(true)
    } catch (err) {
      console.error('[NewChat] 加载 Agent 列表失败:', err)
      setAgents(defaultTemplates)
      setUsingFallbackAgents(true)
    } finally {
      setIsLoadingAgents(false)
    }
  }, [])

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
        throw new Error('未加载到可用 Agent，请先创建或启用 Agent')
      }

      const agentId = selectedAgent.id

      if (!agentId) {
        throw new Error('请先选择一个 Agent')
      }

      // 调用 API 创建会话并发送第一条消息
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api/v1'}/chat/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${localStorage.getItem('auth_token') ?? ''}`,
        },
        body: JSON.stringify({
          agentId,
          message: message.trim() || '你好，请介绍一下你自己',
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error?.message ?? `创建会话失败: ${response.status}`)
      }

      // 从响应中解析 sessionId
      // SSE 流的第一个 done 事件会包含 sessionId
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let sessionId: string | null = null

      if (reader) {
        let buffer = ''
        while (!sessionId) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const data = JSON.parse(line.slice(5).trim())
                if (data.sessionId) {
                  sessionId = data.sessionId
                  break
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
        reader.cancel()
      }

      if (sessionId) {
        router.push(`/chat/${sessionId}`)
      } else {
        throw new Error('无法获取会话 ID')
      }
    } catch (err) {
      console.error('[NewChat] 创建会话失败:', err)
      setError(err instanceof Error ? err.message : '创建会话失败')
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
            <h1 className="text-2xl font-semibold text-text-primary">开始新会话</h1>
            <p className="text-text-secondary mt-2">
              选择一个 Agent，或直接输入您的问题开始对话
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
            <h2 className="text-sm font-medium text-text-secondary mb-4">选择 Agent</h2>
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
                      <h3 className="text-sm font-medium text-text-primary">{agent.name}</h3>
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
                  <p>未加载到可用 Agent，无法开始对话。</p>
                  <a href="/agents" className="underline underline-offset-4">
                    去创建或启用 Agent
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* 快速开始 */}
          <Card variant="outlined" padding="lg">
            <CardContent>
              <h2 className="text-sm font-medium text-text-secondary mb-3">快速开始</h2>
              <div className="space-y-4">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="输入您的问题或任务描述..."
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
                        已选择: {agents.find((a) => a.id === selectedAgentId)?.name}
                      </span>
                    )}
                  </div>
                  <Button
                    onClick={handleStartChat}
                    loading={isCreating}
                    disabled={(!message.trim() && !selectedAgentId) || usingFallbackAgents}
                    rightIcon={<ArrowRight size={16} />}
                  >
                    开始对话
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 示例提示 */}
          <div className="mt-8">
            <h2 className="text-sm font-medium text-text-secondary mb-3">试试这些问题</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {[
                '帮我分析这份销售数据并生成报告',
                '写一个 React 组件实现文件上传功能',
                '搜索最新的 AI 行业动态并总结',
                '帮我优化这段 Python 代码的性能',
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
