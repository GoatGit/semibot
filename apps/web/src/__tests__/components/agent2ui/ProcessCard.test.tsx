import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
        case 'agent2ui.process.route.title':
          return '路由'
        case 'agent2ui.process.route.reason':
          return '原因'
        case 'agent2ui.process.route.goal':
          return '目标'
        case 'agent2ui.process.route.mode.directAnswer':
          return '直接回答'
        case 'agent2ui.process.route.mode.directReasoning':
          return '直接推理'
        case 'agent2ui.process.route.mode.planAct':
          return 'Plan-Act'
        case 'agent2ui.process.route.mode.delegate':
          return '委托'
        case 'agent2ui.process.route.mode.unknown':
          return '未知'
        case 'agent2ui.process.directReasoning.title':
          return '直接推理'
        case 'agent2ui.process.directReasoning.status.completed':
          return '已完成'
        case 'agent2ui.process.directReasoning.status.partial':
          return '部分完成'
        case 'agent2ui.process.directReasoning.status.upgradeRequired':
          return '待升级'
        case 'agent2ui.process.directReasoning.status.failed':
          return '失败'
        case 'agent2ui.process.directReasoning.toolCalls':
          return '工具调用'
        case 'agent2ui.process.directReasoning.upgradeReason':
          return '升级原因'
        case 'agent2ui.process.observeDr.title':
          return 'DR 观察'
        case 'agent2ui.process.observeDr.reason':
          return '原因'
        case 'agent2ui.process.observeDr.upgradeReason':
          return '升级原因'
        case 'agent2ui.process.observeDr.outcome.respondSuccess':
          return '直接回复'
        case 'agent2ui.process.observeDr.outcome.respondPartial':
          return '部分回复'
        case 'agent2ui.process.observeDr.outcome.upgradeToPlanAct':
          return '升级到 Plan-Act'
        case 'agent2ui.process.observeDr.outcome.unknown':
          return '未知'
        case 'agent2ui.process.delegate.title':
          return '委托'
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
        isActive={true}
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

  it('does not render empty skill orchestration placeholder summary', () => {
    const messages: Agent2UIMessage[] = [
      {
        id: 'msg-skill-empty',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:00.000Z').toISOString(),
        data: {
          toolName: 'skill_orchestration',
          success: true,
          result: {
            plan_mode: 'unknown',
            step_count: 0,
          },
        },
      },
    ]

    render(
      <ProcessCard
        isActive={true}
        thinking={null}
        isThinking={false}
        plan={null}
        toolCalls={[]}
        messages={messages}
      />
    )

    expect(screen.queryByText('技能编排')).not.toBeInTheDocument()
  })

  it('renders route, direct reasoning and observe dr entries in process timeline', () => {
    const messages: Agent2UIMessage[] = [
      {
        id: 'msg-route',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:00.000Z').toISOString(),
        data: {
          toolName: 'route',
          success: true,
          result: {
            mode: 'direct_reasoning',
            reason: '当前上下文已经足够，先走轻量执行。',
            goal: '解读上传文档并总结核心观点',
          },
        },
      },
      {
        id: 'msg-dr',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:01.000Z').toISOString(),
        data: {
          toolName: 'direct_reasoning',
          success: true,
          result: {
            status: 'completed',
            answer: '已基于文档摘要生成总结。',
            toolUsage: {
              tool_calls: 1,
            },
          },
        },
      },
      {
        id: 'msg-observe',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:02.000Z').toISOString(),
        data: {
          toolName: 'observe_dr',
          success: true,
          result: {
            outcome: 'respond_success',
            reason: '结果已经足以直接回复用户。',
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

    expect(screen.getByText('路由')).toBeInTheDocument()
    expect(screen.getAllByText('直接推理').length).toBeGreaterThan(0)
    expect(screen.queryByText(/目标: 解读上传文档并总结核心观点/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('已完成思考'))
    expect(screen.getByRole('button', { name: '详情' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    expect(screen.getByText(/目标: 解读上传文档并总结核心观点/)).toBeInTheDocument()
    expect(screen.getByText(/工具调用: 1/)).toBeInTheDocument()
    expect(screen.getByText('DR 观察')).toBeInTheDocument()
    expect(screen.getByText('直接回复')).toBeInTheDocument()
  })

  it('renders awaiting approval as pending instead of completed', () => {
    const messages: Agent2UIMessage[] = [
      {
        id: 'msg-pending-approval',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:00.000Z').toISOString(),
        data: {
          toolName: 'web_fetch',
          success: false,
          error: 'approval_pending',
          result: {
            status: 'pending',
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

    expect(screen.getAllByText('待审批').length).toBeGreaterThan(0)
    expect(screen.queryByText('已完成思考')).not.toBeInTheDocument()
  })

  it('renders awaiting approval as pending when only checkpoint status marks it pending', () => {
    const messages: Agent2UIMessage[] = [
      {
        id: 'msg-route',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:00.000Z').toISOString(),
        data: {
          toolName: 'route',
          success: true,
          result: {
            mode: 'direct_reasoning',
            reason: '需要联网获取最新信息并总结。',
          },
        },
      },
      {
        id: 'msg-dr',
        type: 'tool_result',
        timestamp: new Date('2026-03-10T10:00:01.000Z').toISOString(),
        data: {
          toolName: 'direct_reasoning',
          success: true,
          result: {
            status: 'partial',
            resourceUsage: {
              tool_calls: 2,
            },
          },
        },
      },
    ]

    render(
      <ProcessCard
        isActive={false}
        awaitingApproval
        thinking={null}
        isThinking={false}
        plan={null}
        toolCalls={[]}
        messages={messages}
      />
    )

    expect(screen.getAllByText('待审批').length).toBeGreaterThan(0)
    expect(screen.queryByText('已完成思考')).not.toBeInTheDocument()
  })

  it('renders delegate skill call and result entries in process timeline', () => {
    const messages: Agent2UIMessage[] = [
      {
        id: 'msg-delegate-call',
        type: 'skill_call',
        timestamp: new Date('2026-03-10T10:00:03.000Z').toISOString(),
        data: {
          skillId: 'researcher',
          skillName: 'subagent:researcher',
          arguments: { task: '研究阿里巴巴' },
          status: 'calling',
        },
      },
      {
        id: 'msg-delegate-result',
        type: 'skill_result',
        timestamp: new Date('2026-03-10T10:00:05.000Z').toISOString(),
        data: {
          skillId: 'researcher',
          skillName: 'subagent:researcher',
          result: 'delegated answer',
          success: true,
          duration: 2000,
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

    expect(screen.getAllByText(/委托: subagent:researcher/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('详情'))
    expect(screen.getByText('delegated answer')).toBeInTheDocument()
  })
})
