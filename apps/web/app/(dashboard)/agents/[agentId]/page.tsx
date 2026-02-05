'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import clsx from 'clsx'
import {
  ArrowLeft,
  Bot,
  Save,
  Play,
  Pause,
  Settings,
  Code,
  Wrench,
  MessageSquare,
  BarChart3,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card'

type TabId = 'config' | 'tools' | 'prompts' | 'testing' | 'analytics'

interface Tool {
  id: string
  name: string
  description: string
  enabled: boolean
}

const availableTools: Tool[] = [
  { id: 'web_search', name: 'Web Search', description: '搜索互联网获取信息', enabled: true },
  { id: 'code_executor', name: 'Code Executor', description: '执行代码并返回结果', enabled: true },
  { id: 'file_manager', name: 'File Manager', description: '读取和管理文件', enabled: false },
  { id: 'data_analyzer', name: 'Data Analyzer', description: '分析和可视化数据', enabled: false },
  { id: 'git_integration', name: 'Git Integration', description: 'Git 仓库操作', enabled: true },
]

/**
 * Agent Detail Page - Agent 详情/编辑页面
 *
 * 功能:
 * - 基本配置
 * - 工具配置
 * - Prompt 模板
 * - 测试运行
 * - 使用分析
 */
export default function AgentDetailPage() {
  const params = useParams()
  const router = useRouter()
  const agentId = params.agentId as string
  const isNew = agentId === 'new'

  const [activeTab, setActiveTab] = useState<TabId>('config')
  const [isSaving, setIsSaving] = useState(false)
  const [agentData, setAgentData] = useState({
    name: isNew ? '' : '通用助手',
    description: isNew ? '' : '多功能 AI 助手，可以帮助您完成各种任务',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 4096,
    status: isNew ? 'draft' : 'active',
  })

  const tabs = [
    { id: 'config' as const, label: '基本配置', icon: <Settings size={16} /> },
    { id: 'tools' as const, label: '工具配置', icon: <Wrench size={16} /> },
    { id: 'prompts' as const, label: 'Prompt 模板', icon: <Code size={16} /> },
    { id: 'testing' as const, label: '测试运行', icon: <MessageSquare size={16} /> },
    { id: 'analytics' as const, label: '使用分析', icon: <BarChart3 size={16} />, disabled: isNew },
  ]

  const handleSave = async () => {
    setIsSaving(true)
    // TODO: 实际保存逻辑
    await new Promise((resolve) => setTimeout(resolve, 1000))
    setIsSaving(false)

    if (isNew) {
      router.push('/agents')
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg-base">
      {/* 头部 */}
      <header className="flex-shrink-0 border-b border-border-subtle px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/agents"
              className={clsx(
                'p-2 rounded-md',
                'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
                'transition-colors duration-fast'
              )}
            >
              <ArrowLeft size={20} />
            </Link>

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary-500/20 flex items-center justify-center">
                <Bot size={20} className="text-primary-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-text-primary">
                  {isNew ? '创建新 Agent' : agentData.name}
                </h1>
                {!isNew && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full',
                        agentData.status === 'active' ? 'bg-success-500' : 'bg-neutral-500'
                      )}
                    />
                    <span className="text-xs text-text-secondary">
                      {agentData.status === 'active' ? '运行中' : '已停用'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {!isNew && (
              <Button
                variant="secondary"
                leftIcon={agentData.status === 'active' ? <Pause size={16} /> : <Play size={16} />}
              >
                {agentData.status === 'active' ? '停用' : '启用'}
              </Button>
            )}
            <Button onClick={handleSave} loading={isSaving} leftIcon={<Save size={16} />}>
              {isNew ? '创建' : '保存'}
            </Button>
          </div>
        </div>

        {/* Tab 导航 */}
        <div className="flex items-center gap-1 mt-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => !tab.disabled && setActiveTab(tab.id)}
              disabled={tab.disabled}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium',
                'transition-colors duration-fast',
                activeTab === tab.id
                  ? 'bg-primary-500/20 text-primary-400'
                  : tab.disabled
                    ? 'text-text-disabled cursor-not-allowed'
                    : 'text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl">
          {activeTab === 'config' && (
            <ConfigTab agentData={agentData} setAgentData={setAgentData} />
          )}
          {activeTab === 'tools' && <ToolsTab />}
          {activeTab === 'prompts' && <PromptsTab />}
          {activeTab === 'testing' && <TestingTab />}
          {activeTab === 'analytics' && <AnalyticsTab />}
        </div>
      </div>
    </div>
  )
}

interface AgentData {
  name: string
  description: string
  model: string
  temperature: number
  maxTokens: number
  status: string
}

interface ConfigTabProps {
  agentData: AgentData
  setAgentData: React.Dispatch<React.SetStateAction<AgentData>>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ConfigTab({ agentData, setAgentData }: ConfigTabProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
          <CardDescription>设置 Agent 的名称和描述</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                名称 <span className="text-error-500">*</span>
              </label>
              <Input
                placeholder="例如：通用助手"
                value={agentData.name}
                onChange={(e) => setAgentData((prev: ConfigTabProps['agentData']) => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">描述</label>
              <textarea
                value={agentData.description}
                onChange={(e) => setAgentData((prev: ConfigTabProps['agentData']) => ({ ...prev, description: e.target.value }))}
                placeholder="描述这个 Agent 的功能和用途..."
                className={clsx(
                  'w-full h-24 px-3 py-2 rounded-md resize-none',
                  'bg-bg-surface border border-border-default',
                  'text-text-primary placeholder:text-text-tertiary',
                  'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
                  'transition-all duration-fast'
                )}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型配置</CardTitle>
          <CardDescription>选择和配置 AI 模型参数</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">模型</label>
              <select
                value={agentData.model}
                onChange={(e) => setAgentData((prev: ConfigTabProps['agentData']) => ({ ...prev, model: e.target.value }))}
                className={clsx(
                  'w-full h-10 px-3 rounded-md',
                  'bg-bg-surface border border-border-default',
                  'text-text-primary',
                  'focus:outline-none focus:border-primary-500',
                  'transition-all duration-fast'
                )}
              >
                <option value="gpt-4">GPT-4</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                <option value="claude-3-opus">Claude 3 Opus</option>
                <option value="claude-3-sonnet">Claude 3 Sonnet</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Temperature: {agentData.temperature}
              </label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={agentData.temperature}
                onChange={(e) =>
                  setAgentData((prev: ConfigTabProps['agentData']) => ({ ...prev, temperature: parseFloat(e.target.value) }))
                }
                className="w-full"
              />
              <div className="flex justify-between text-xs text-text-tertiary mt-1">
                <span>精确 (0)</span>
                <span>平衡 (1)</span>
                <span>创意 (2)</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                最大 Token 数
              </label>
              <Input
                type="number"
                value={agentData.maxTokens}
                onChange={(e) =>
                  setAgentData((prev: ConfigTabProps['agentData']) => ({ ...prev, maxTokens: parseInt(e.target.value) }))
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ToolsTab() {
  const [tools, setTools] = useState(availableTools)

  const toggleTool = (toolId: string) => {
    setTools((prev) =>
      prev.map((tool) => (tool.id === toolId ? { ...tool, enabled: !tool.enabled } : tool))
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>可用工具</CardTitle>
          <CardDescription>选择 Agent 可以使用的工具</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {tools.map((tool) => (
              <div
                key={tool.id}
                className={clsx(
                  'flex items-center justify-between p-4 rounded-lg border',
                  'transition-colors duration-fast',
                  tool.enabled ? 'border-primary-500/50 bg-primary-500/5' : 'border-border-default'
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={clsx(
                      'w-10 h-10 rounded-lg flex items-center justify-center',
                      tool.enabled ? 'bg-primary-500/20' : 'bg-neutral-700'
                    )}
                  >
                    <Wrench
                      size={18}
                      className={tool.enabled ? 'text-primary-400' : 'text-text-tertiary'}
                    />
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-text-primary">{tool.name}</h3>
                    <p className="text-xs text-text-secondary">{tool.description}</p>
                  </div>
                </div>

                <button
                  onClick={() => toggleTool(tool.id)}
                  className={clsx(
                    'relative w-11 h-6 rounded-full transition-colors duration-fast',
                    tool.enabled ? 'bg-primary-500' : 'bg-neutral-600'
                  )}
                  role="switch"
                  aria-checked={tool.enabled}
                >
                  <span
                    className={clsx(
                      'absolute top-1 left-1 w-4 h-4 rounded-full bg-white',
                      'transition-transform duration-fast',
                      tool.enabled && 'translate-x-5'
                    )}
                  />
                </button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function PromptsTab() {
  const [systemPrompt, setSystemPrompt] = useState(
    '你是一个专业的 AI 助手。请根据用户的需求提供准确、有帮助的回答。'
  )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>System Prompt</CardTitle>
          <CardDescription>定义 Agent 的角色和行为</CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="输入 System Prompt..."
            className={clsx(
              'w-full h-48 px-3 py-2 rounded-md resize-none font-mono text-sm',
              'bg-bg-surface border border-border-default',
              'text-text-primary placeholder:text-text-tertiary',
              'focus:outline-none focus:border-primary-500 focus:shadow-glow-primary',
              'transition-all duration-fast'
            )}
          />
          <p className="text-xs text-text-tertiary mt-2">
            支持变量：{'{{user_name}}'}, {'{{date}}'}, {'{{context}}'}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Prompt 模板</CardTitle>
          <CardDescription>预设的 Prompt 模板</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {['分析任务', '代码审查', '文档生成'].map((template) => (
              <button
                key={template}
                className={clsx(
                  'flex items-center justify-between w-full p-3 rounded-lg',
                  'border border-border-default',
                  'text-left text-sm',
                  'hover:bg-interactive-hover hover:border-border-strong',
                  'transition-colors duration-fast'
                )}
              >
                <span className="text-text-primary">{template}</span>
                <ChevronRight size={16} className="text-text-tertiary" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function TestingTab() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>测试对话</CardTitle>
          <CardDescription>在发布前测试 Agent 的表现</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-64 flex items-center justify-center bg-bg-elevated rounded-lg border border-border-subtle">
            <div className="text-center">
              <MessageSquare size={32} className="text-text-tertiary mx-auto mb-2" />
              <p className="text-sm text-text-secondary">点击下方按钮开始测试对话</p>
            </div>
          </div>
          <div className="mt-4">
            <Button leftIcon={<Play size={16} />}>开始测试</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function AnalyticsTab() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>使用统计</CardTitle>
          <CardDescription>过去 30 天的使用数据</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 bg-bg-elevated rounded-lg">
              <p className="text-2xl font-semibold text-text-primary">1,234</p>
              <p className="text-xs text-text-secondary mt-1">总会话数</p>
            </div>
            <div className="p-4 bg-bg-elevated rounded-lg">
              <p className="text-2xl font-semibold text-text-primary">8.5k</p>
              <p className="text-xs text-text-secondary mt-1">总消息数</p>
            </div>
            <div className="p-4 bg-bg-elevated rounded-lg">
              <p className="text-2xl font-semibold text-text-primary">95%</p>
              <p className="text-xs text-text-secondary mt-1">成功率</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
