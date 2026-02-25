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
