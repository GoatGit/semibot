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

  it('returns null for unknown event', () => {
    expect(mapRuntimeEventToAgent2UI({ type: 'unknown' })).toBeNull()
  })
})
