import { v4 as uuidv4 } from 'uuid'
import type { Agent2UIMessage, Agent2UIType, Agent2UIData } from '@semibot/shared-types'

function mkMessage(type: Agent2UIType, data: Agent2UIData): Agent2UIMessage {
  return {
    id: uuidv4(),
    type,
    data,
    timestamp: new Date().toISOString(),
  }
}

function summarizeProcessText(value: unknown, maxChars = 280): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
}

export function parseJSONData(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export function isExecutionComplete(event: Record<string, unknown>): boolean {
  return event.type === 'execution_complete'
}

export function isExecutionError(event: Record<string, unknown>): boolean {
  return event.type === 'execution_error'
}

export function mapRuntimeEventToAgent2UI(event: Record<string, unknown>): Agent2UIMessage | null {
  const type = event.type as string | undefined
  if (!type) return null

  switch (type) {
    case 'thinking':
      return mkMessage('thinking', {
        content: (event.content as string) ?? '',
        stage: event.stage as 'analyzing' | 'planning' | 'reasoning' | 'concluding' | undefined,
      })

    case 'plan_created': {
      const steps = (event.steps as Array<{ id: string; title: string }> | undefined) ?? []
      return mkMessage('plan', {
        steps: steps.map((s) => ({ id: s.id, title: s.title, status: 'pending' })),
        currentStep: '',
      })
    }

    case 'plan_version': {
      const steps = (event.steps as Array<{ id: string; title: string }> | undefined) ?? []
      return mkMessage('plan', {
        steps: steps.map((s) => ({ id: s.id, title: s.title, status: 'pending' })),
        currentStep: '',
      })
    }

    case 'plan_step_start':
      return mkMessage('plan_step', {
        stepId: (event.step_id as string) ?? '',
        title: (event.title as string) ?? '',
        status: 'running',
        tool: event.tool as string | undefined,
        params: event.params as Record<string, unknown> | undefined,
      })

    case 'plan_step_complete':
      return mkMessage('plan_step', {
        stepId: (event.step_id as string) ?? '',
        title: (event.title as string) ?? '',
        status: 'completed',
        result: event.result,
        durationMs: event.duration_ms as number | undefined,
      })

    case 'plan_step_failed':
      return mkMessage('plan_step', {
        stepId: (event.step_id as string) ?? '',
        title: (event.title as string) ?? '',
        status: 'failed',
        error: (event.error as string) ?? 'Unknown error',
      })

    case 'tool_call_start':
      return mkMessage('tool_call', {
        toolName: (event.tool_name as string) ?? '',
        arguments: (event.arguments as Record<string, unknown>) ?? {},
        status: 'calling',
      })

    case 'tool_call_complete':
      return mkMessage('tool_result', {
        toolName: (event.tool_name as string) ?? '',
        result: event.result,
        success: (event.success as boolean) ?? true,
        error: event.error as string | undefined,
        duration: event.duration as number | undefined,
      })

    case 'skill_orchestration_trace':
      return mkMessage('tool_result', {
        toolName: 'skill_orchestration',
        result: {
          skill_context_skill_id: event.skill_context_skill_id,
          selected_skill: event.selected_skill,
          loaded_skill_id: event.loaded_skill_id,
          planner_loaded_skill_id: event.planner_loaded_skill_id,
          selected_skill_kind: event.selected_skill_kind,
          has_skill_md: event.has_skill_md,
          plan_mode: event.plan_mode,
          round_goal: event.round_goal,
          step_count: event.step_count,
          step_titles: event.step_titles,
          is_replan: event.is_replan,
          observe_outcome: event.observe_outcome,
          observe_reason: event.observe_reason,
          replan_reason: event.replan_reason,
          replan_failure_reflection: event.replan_failure_reflection,
          planner_last_rejection_reason: event.planner_last_rejection_reason,
        },
        success: true,
      })

    case 'act_decision':
      return mkMessage('tool_result', {
        toolName: 'act_decision',
        result: {
          stepId: event.step_id,
          title: event.title,
          plannerPhase: event.planner_phase,
          plannerIntent: event.planner_intent,
          plannerRequiredResources: event.planner_required_resources,
          plannerExpectedOutputs: event.planner_expected_outputs,
          plannerCompletionCriteria: event.planner_completion_criteria,
          decision: event.decision,
          selectedTool: event.tool_name,
          arguments: event.arguments,
          artifactResultText: summarizeProcessText(event.artifact_result_text),
          artifactType: event.artifact_type,
          artifactMedium: event.artifact_medium,
          artifactFormat: event.artifact_format,
          artifactName: event.artifact_name,
          artifactPurpose: event.artifact_purpose,
          selectedSkill: event.selected_skill,
        },
        success: true,
      })

    case 'planner_llm_call':
      return mkMessage('tool_result', {
        toolName: 'planner_llm',
        result: {
          event: event.event,
          turnIndex: event.turn_index,
          model: event.model,
          toolsEnabled: event.tools_enabled,
          compactMode: event.compact_mode,
          durationMs: event.duration_ms,
          finishReason: event.finish_reason,
          usage: event.usage,
          toolCallCount: event.tool_call_count,
          contentLen: event.content_len,
          error: event.error,
          responseExcerpt: summarizeProcessText(event.response_excerpt),
        },
        success: event.event !== 'planner.llm_call_failed',
        error: event.event === 'planner.llm_call_failed'
          ? ((event.error as string | undefined) ?? 'planner_llm_call_failed')
          : undefined,
      })

    case 'route.mode_selected':
      return mkMessage('tool_result', {
        toolName: 'route',
        result: {
          mode: event.mode,
          reason: summarizeProcessText(event.reason, 240),
          goal: summarizeProcessText(event.goal, 240),
        },
        success: true,
      })

    case 'dr.completed':
    case 'dr.failed':
      return mkMessage('tool_result', {
        toolName: 'direct_reasoning',
        result: {
          status: event.status ?? (type === 'dr.failed' ? 'failed' : 'completed'),
          answer: summarizeProcessText(event.answer, 240),
          upgradeReason: summarizeProcessText(event.upgrade_reason, 240),
          toolUsage: event.tool_usage,
          resourceUsage: event.resource_usage,
          diagnostics: event.diagnostics,
          failure: event.failure,
        },
        success: type !== 'dr.failed',
        error: type === 'dr.failed'
          ? ((event.error as string | undefined) ?? 'direct_reasoning_failed')
          : undefined,
      })

    case 'observe_dr.respond_success':
    case 'observe_dr.respond_partial':
    case 'observe_dr.upgrade_to_plan_act':
      return mkMessage('tool_result', {
        toolName: 'observe_dr',
        result: {
          outcome: type.replace('observe_dr.', ''),
          reason: summarizeProcessText(event.reason, 240),
          status: event.status,
          intermediateContext: event.intermediate_context,
          resourceUsage: event.resource_usage,
          upgradeReason: summarizeProcessText(event.upgrade_reason, 240),
        },
        success: true,
      })

    case 'failure_reflection':
      return mkMessage('tool_result', {
        toolName: 'failure_reflection',
        result: {
          content: (event.content as string) ?? '',
        },
        success: true,
      })

    // OpenClaw bridge compatibility
    case 'tool_call':
      return mkMessage('tool_call', {
        toolName: (event.tool_name as string) ?? '',
        arguments: (event.input as Record<string, unknown>) ?? {},
        status: 'calling',
      })

    case 'tool_result':
      return mkMessage('tool_result', {
        toolName: (event.tool_name as string) ?? '',
        result: event.output ?? event.result,
        success: (event.success as boolean) ?? true,
        error: event.error as string | undefined,
      })

    case 'skill_call_start':
      return mkMessage('skill_call', {
        skillId: (event.skill_id as string) ?? '',
        skillName: (event.skill_name as string) ?? '',
        arguments: (event.arguments as Record<string, unknown>) ?? {},
        status: 'calling',
      })

    case 'skill_call_complete':
      return mkMessage('skill_result', {
        skillId: (event.skill_id as string) ?? '',
        skillName: (event.skill_name as string) ?? '',
        result: event.result,
        success: (event.success as boolean) ?? true,
        error: event.error as string | undefined,
        duration: event.duration as number | undefined,
      })

    case 'mcp_call_start':
      return mkMessage('mcp_call', {
        serverId: (event.server_id as string) ?? '',
        toolName: (event.tool_name as string) ?? '',
        arguments: (event.arguments as Record<string, unknown>) ?? {},
        status: 'calling',
      })

    case 'mcp_call_complete':
      return mkMessage('mcp_result', {
        serverId: (event.server_id as string) ?? '',
        toolName: (event.tool_name as string) ?? '',
        result: event.result,
        success: (event.success as boolean) ?? true,
        error: event.error as string | undefined,
        duration: event.duration as number | undefined,
      })

    case 'text_chunk':
      return mkMessage('text', { content: (event.content as string) ?? '' })

    case 'text':
      return mkMessage('text', { content: (event.content as string) ?? '' })

    case 'file_created':
      return mkMessage('file', {
        url: (event.url as string) ?? '',
        filename: (event.filename as string) ?? 'file',
        mimeType: (event.mime_type as string) ?? 'application/octet-stream',
        size: event.size as number | undefined,
      })

    default:
      return null
  }
}
