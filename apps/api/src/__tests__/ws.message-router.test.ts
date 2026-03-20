import { describe, expect, it } from 'vitest'
import {
  mapRuntimeEventToAgent2UI,
  isExecutionComplete,
  isExecutionError,
  parseJSONData,
} from '../ws/message-router'

describe('ws/message-router', () => {
  it('parses valid JSON and rejects invalid JSON', () => {
    expect(parseJSONData('{"type":"thinking"}')).toEqual({ type: 'thinking' })
    expect(parseJSONData('{bad json')).toBeNull()
  })

  it('detects execution terminal events', () => {
    expect(isExecutionComplete({ type: 'execution_complete' })).toBe(true)
    expect(isExecutionComplete({ type: 'thinking' })).toBe(false)

    expect(isExecutionError({ type: 'execution_error' })).toBe(true)
    expect(isExecutionError({ type: 'text_chunk' })).toBe(false)
  })

  it('maps thinking event', () => {
    const msg = mapRuntimeEventToAgent2UI({
      type: 'thinking',
      content: 'Analyzing',
      stage: 'planning',
    })

    expect(msg?.type).toBe('thinking')
    expect((msg?.data as { content: string }).content).toBe('Analyzing')
  })

  it('maps plan lifecycle events', () => {
    const created = mapRuntimeEventToAgent2UI({
      type: 'plan_created',
      steps: [{ id: 's1', title: 'step 1' }],
    })
    expect(created?.type).toBe('plan')

    const start = mapRuntimeEventToAgent2UI({
      type: 'plan_step_start',
      step_id: 's1',
      title: 'step 1',
      tool: 'search',
      params: { q: 'abc' },
    })
    expect(start?.type).toBe('plan_step')
    expect((start?.data as { status: string }).status).toBe('running')

    const done = mapRuntimeEventToAgent2UI({
      type: 'plan_step_complete',
      step_id: 's1',
      title: 'step 1',
      result: { ok: true },
      duration_ms: 12,
    })
    expect(done?.type).toBe('plan_step')
    expect((done?.data as { status: string }).status).toBe('completed')
  })

  it('maps tool/skill/mcp and text/file events', () => {
    expect(mapRuntimeEventToAgent2UI({ type: 'tool_call_start', tool_name: 'x', arguments: {} })?.type).toBe('tool_call')
    expect(mapRuntimeEventToAgent2UI({ type: 'tool_call_complete', tool_name: 'x', success: true })?.type).toBe('tool_result')

    expect(mapRuntimeEventToAgent2UI({ type: 'skill_call_start', skill_id: 'id', skill_name: 'n' })?.type).toBe('skill_call')
    expect(mapRuntimeEventToAgent2UI({ type: 'skill_call_complete', skill_id: 'id', skill_name: 'n', success: true })?.type).toBe('skill_result')

    expect(mapRuntimeEventToAgent2UI({ type: 'mcp_call_start', server_id: 'sid', tool_name: 't' })?.type).toBe('mcp_call')
    expect(mapRuntimeEventToAgent2UI({ type: 'mcp_call_complete', server_id: 'sid', tool_name: 't', success: true })?.type).toBe('mcp_result')

    expect(mapRuntimeEventToAgent2UI({ type: 'text_chunk', content: 'hello' })?.type).toBe('text')
    expect(mapRuntimeEventToAgent2UI({ type: 'file_created', filename: 'a.txt', url: '/x' })?.type).toBe('file')
  })

  it('maps skill_orchestration_trace event', () => {
    const msg = mapRuntimeEventToAgent2UI({
      type: 'skill_orchestration_trace',
      selected_skill: 'deep-research',
      loaded_skill_id: 'deep-research',
      planner_loaded_skill_id: 'deep-research',
      selected_skill_kind: 'hybrid',
      has_skill_md: true,
      plan_mode: 'initial',
      round_goal: '完成深度研究',
      step_count: 3,
      step_titles: ['界定研究范围与方法', '收集并交叉验证多源证据', '生成最终研究报告'],
      observe_outcome: 'continue_execution',
      observe_reason: 'current step produced intermediate artifacts but more work remains',
      skill_md_gate_injected: true,
      installer_gate: { dropped: 1, reports: [] },
    })
    expect(msg?.type).toBe('tool_result')
    expect((msg?.data as { toolName: string }).toolName).toBe('skill_orchestration')
    expect((msg?.data as { result: { observe_reason: string } }).result.observe_reason).toContain('more work remains')
    expect((msg?.data as { result: { step_count: number } }).result.step_count).toBe(3)
    expect((msg?.data as { result: { plan_mode: string } }).result.plan_mode).toBe('initial')
    expect((msg?.data as { result: { round_goal: string } }).result.round_goal).toBe('完成深度研究')
    expect((msg?.data as { result: { step_titles: string[] } }).result.step_titles).toHaveLength(3)
    expect((msg?.data as { result: { loaded_skill_id: string } }).result.loaded_skill_id).toBe('deep-research')
    expect((msg?.data as { result: { planner_loaded_skill_id: string } }).result.planner_loaded_skill_id).toBe('deep-research')
  })

  it('maps act_decision event', () => {
    const msg = mapRuntimeEventToAgent2UI({
      type: 'act_decision',
      step_id: 's1',
      title: 'Phase 1: SCOPE',
      planner_tool: 'search',
      decision: 'tool_call',
      tool_name: 'code_executor',
      arguments: { language: 'python' },
      artifact_result_text: '# 标题\n\n' + 'A'.repeat(400),
      completion_text: '{"decision":"complete_task","artifact_result_text":"' + 'B'.repeat(400) + '"}',
      selected_skill: 'deep-research',
    })
    expect(msg?.type).toBe('tool_result')
    expect((msg?.data as { toolName: string }).toolName).toBe('act_decision')
    expect((msg?.data as { result: { selectedTool: string } }).result.selectedTool).toBe('code_executor')
    expect(((msg?.data as { result: { artifactResultText?: string } }).result.artifactResultText?.length ?? 0)).toBeLessThanOrEqual(283)
    expect((msg?.data as { result: { completionText?: string } }).result.completionText).toBeUndefined()
  })

  it('maps failure_reflection event', () => {
    const msg = mapRuntimeEventToAgent2UI({
      type: 'failure_reflection',
      content: '[SYSTEM] FAILURE REFLECTION\n\nObserved Failures\n- file_io: File not found',
    })
    expect(msg?.type).toBe('tool_result')
    expect((msg?.data as { toolName: string }).toolName).toBe('failure_reflection')
    expect((msg?.data as { result: { content: string } }).result.content).toContain('FAILURE REFLECTION')
  })

  it('returns null for unknown event', () => {
    expect(mapRuntimeEventToAgent2UI({ type: 'unknown' })).toBeNull()
  })
})
