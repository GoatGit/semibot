'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { Bot, Sparkles, Code, FileSearch, BarChart3, PenTool, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'

interface AgentTemplate {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  color: string
}

const agentTemplates: AgentTemplate[] = [
  {
    id: 'general',
    name: '通用助手',
    description: '多功能 AI 助手，可以帮助您完成各种任务',
    icon: <Bot size={24} />,
    color: 'primary',
  },
  {
    id: 'code',
    name: '代码助手',
    description: '专注于编程和代码审查的 AI 助手',
    icon: <Code size={24} />,
    color: 'info',
  },
  {
    id: 'research',
    name: '研究助手',
    description: '帮助您搜索、整理和分析信息',
    icon: <FileSearch size={24} />,
    color: 'success',
  },
  {
    id: 'data',
    name: '数据分析',
    description: '数据处理、可视化和洞察分析',
    icon: <BarChart3 size={24} />,
    color: 'warning',
  },
  {
    id: 'creative',
    name: '创意写作',
    description: '文案创作、内容生成和编辑',
    icon: <PenTool size={24} />,
    color: 'error',
  },
]

/**
 * New Chat Page - 新建会话页面
 *
 * 提供快速开始选项:
 * - 选择 Agent 模板
 * - 直接输入开始对话
 */
export default function NewChatPage() {
  const router = useRouter()
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleStartChat = async () => {
    if (!message.trim() && !selectedTemplate) return

    setIsCreating(true)

    // 模拟创建会话
    // TODO: 实际实现时调用 API 创建会话
    await new Promise((resolve) => setTimeout(resolve, 500))

    // 生成临时会话 ID 并跳转
    const sessionId = `session-${Date.now()}`
    router.push(`/chat/${sessionId}`)
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
              选择一个 Agent 模板，或直接输入您的问题开始对话
            </p>
          </div>

          {/* Agent 模板选择 */}
          <div className="mb-8">
            <h2 className="text-sm font-medium text-text-secondary mb-4">选择 Agent 模板</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {agentTemplates.map((template) => {
                const isSelected = selectedTemplate === template.id
                const colors = getColorClasses(template.color, isSelected)

                return (
                  <button
                    key={template.id}
                    onClick={() => setSelectedTemplate(isSelected ? null : template.id)}
                    className={clsx(
                      'flex flex-col items-start p-4 rounded-lg border',
                      'transition-all duration-fast text-left',
                      colors.bg,
                      colors.border
                    )}
                  >
                    <div className={clsx('mb-3', colors.text)}>{template.icon}</div>
                    <h3 className="text-sm font-medium text-text-primary">{template.name}</h3>
                    <p className="text-xs text-text-secondary mt-1 line-clamp-2">
                      {template.description}
                    </p>
                  </button>
                )
              })}
            </div>
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
                    {selectedTemplate && (
                      <span>
                        已选择: {agentTemplates.find((t) => t.id === selectedTemplate)?.name}
                      </span>
                    )}
                  </div>
                  <Button
                    onClick={handleStartChat}
                    loading={isCreating}
                    disabled={!message.trim() && !selectedTemplate}
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
