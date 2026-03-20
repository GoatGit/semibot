import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProcessCard } from '@/components/agent2ui/process/ProcessCard'
import type { Agent2UIMessage } from '@/types'

vi.mock('@/components/providers/LocaleProvider', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    setLocale: vi.fn(),
    t: (key: string, params?: Record<string, string | number>) => {
      switch (key) {
        case 'agent2ui.process.status.completed':
          return '已完成思考'
        case 'agent2ui.process.skillOrchestration.title':
          return '技能编排'
        case 'agent2ui.process.skillOrchestration.skill':
          return '技能'
        case 'agent2ui.process.skillOrchestration.skillKind':
          return '技能类型'
        case 'agent2ui.process.skillOrchestration.stepCount':
          return '步骤数'
        case 'agent2ui.process.skillOrchestration.roundGoal':
          return '本轮目标'
        case 'agent2ui.process.skillOrchestration.observeOutcome':
          return '观察结果'
        case 'agent2ui.process.skillOrchestration.observeReason':
          return '继续原因'
        case 'agent2ui.process.skillOrchestration.lastRejection':
          return '上次拒绝原因'
        case 'agent2ui.process.skillOrchestration.replan':
          return '重规划'
        case 'agent2ui.process.skillOrchestration.noSkill':
          return '未显式选择'
        case 'agent2ui.process.skillOrchestration.moreSteps':
          return `还有 ${params?.count} 步`
        case 'agent2ui.process.skillOrchestration.planMode.label':
          return '计划模式'
        case 'agent2ui.process.skillOrchestration.planMode.initial':
          return '初始规划'
        case 'agent2ui.process.skillOrchestration.planMode.incrementalReplan':
          return '增量重规划'
        case 'agent2ui.process.skillOrchestration.planMode.fullReplan':
          return '完整重规划'
        case 'agent2ui.process.skillOrchestration.planMode.unknown':
          return '未标记'
        case 'agent2ui.process.collapse':
          return '收起'
        case 'agent2ui.process.details':
          return '详情'
        case 'agent2ui.process.planSummary':
          return `执行计划：${params?.count} 个步骤`
        case 'agent2ui.process.stepSummary':
          return `推进 ${params?.count} 个步骤`
        case 'agent2ui.process.toolCallSummary':
          return `执行 ${params?.count} 次动作`
        case 'agent2ui.process.failedSummary':
          return `${params?.count} 个失败`
        case 'agent2ui.process.summarySeparator':
          return '，'
        case 'approvals.pending':
          return '待审批'
        default:
          return key
      }
    },
  }),
}))

describe('ProcessCard', () => {
  it('renders skill orchestration as readable summary instead of raw json', () => {
    const messages: Agent2UIMessage[] = [
      {
        id: 'msg-skill',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:00.000Z').toISOString(),
        data: {
          toolName: 'skill_orchestration',
          success: true,
          result: {
            loaded_skill_id: 'deep-research',
            planner_loaded_skill_id: 'deep-research',
            selected_skill_kind: 'research',
            plan_mode: 'initial',
            step_count: 3,
            step_titles: ['界定研究范围', '收集多源证据', '生成研究报告'],
            round_goal: '完成深度研究',
            observe_outcome: 'continue_execution',
          },
        },
      },
    ]

    render(
      <ProcessCard
        isActive={false}
        thinking={null}
        isThinking={false}
        plan={null}
        toolCalls={[]}
        messages={messages}
      />
    )

    expect(screen.getByText('技能编排')).toBeInTheDocument()
    expect(screen.getByText(/技能: deep-research/)).toBeInTheDocument()
    expect(screen.getByText(/计划模式: 初始规划/)).toBeInTheDocument()
    expect(screen.getByText(/步骤数: 3/)).toBeInTheDocument()
    expect(screen.getByText('1. 界定研究范围')).toBeInTheDocument()
    expect(screen.queryByText('{}')).not.toBeInTheDocument()
  })
})
