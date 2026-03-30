import { describe, expect, it } from 'vitest'

import {
  buildDisplayMessagesFromSessionView,
  mergeDisplayMessagesFromSessionView,
} from '@/lib/chat-session-view'
import type { SessionView } from '@/types'

describe('chat session view projection', () => {
  it('does not synthesize awaiting approval assistant messages from runState/notices', () => {
    const view: SessionView = {
      session: {
        id: 'sess-1',
        agentId: 'agent-1',
        userId: 'user-1',
        status: 'active',
        title: 'Awaiting approval',
        metadata: {},
        createdAt: '2026-03-29T12:00:00.000Z',
        startedAt: '2026-03-29T12:00:00.000Z',
      },
      messages: [
        {
          id: 'msg-user-1',
          sessionId: 'sess-1',
          role: 'user',
          content: '请执行高风险操作',
          metadata: {},
          createdAt: '2026-03-29T12:00:00.000Z',
        },
      ],
      runState: {
        sessionId: 'sess-1',
        status: 'awaiting_approval',
        pendingApprovalIds: ['appr_1'],
        updatedAt: '2026-03-29T12:01:00.000Z',
      },
      notices: [
        {
          kind: 'awaiting_approval',
          code: 'AWAITING_APPROVAL',
          message: '操作需要人工审批后继续。',
          approvalIds: ['appr_1'],
        },
      ],
      processTrace: {
        version: 1,
        messages: [{ id: 'proc-1', type: 'thinking', data: { content: '分析中' }, timestamp: '2026-03-29T12:00:30.000Z' }],
      },
    }

    const messages = buildDisplayMessagesFromSessionView(view)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'msg-user-1',
      role: 'user',
      content: '请执行高风险操作',
    })
  })

  it('preserves completed assistant artifact messages from SessionView', () => {
    const view: SessionView = {
      session: {
        id: 'sess-2',
        agentId: 'agent-1',
        userId: 'user-1',
        status: 'completed',
        title: 'Completed',
        metadata: {},
        createdAt: '2026-03-29T12:00:00.000Z',
        startedAt: '2026-03-29T12:00:00.000Z',
        endedAt: '2026-03-29T12:02:00.000Z',
      },
      messages: [
        {
          id: 'msg-user-1',
          sessionId: 'sess-2',
          role: 'user',
          content: '总结这个任务',
          metadata: {},
          createdAt: '2026-03-29T12:00:00.000Z',
        },
        {
          id: 'msg-assistant-1',
          sessionId: 'sess-2',
          role: 'assistant',
          content: '这是最终总结。',
          metadata: {},
          createdAt: '2026-03-29T12:02:00.000Z',
        },
      ],
      runState: {
        sessionId: 'sess-2',
        status: 'completed',
        pendingApprovalIds: [],
        updatedAt: '2026-03-29T12:02:00.000Z',
      },
      notices: [],
      processTrace: null,
    }

    const messages = buildDisplayMessagesFromSessionView(view)

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      id: 'msg-assistant-1',
      role: 'assistant',
      content: '这是最终总结。',
      isStreaming: false,
    })
  })

  it('drops stale local assistant placeholders when server view already contains the final artifact', () => {
    const serverMessages = buildDisplayMessagesFromSessionView({
      session: {
        id: 'sess-3',
        agentId: 'agent-1',
        userId: 'user-1',
        status: 'completed',
        title: 'Completed',
        metadata: {},
        createdAt: '2026-03-29T12:00:00.000Z',
        startedAt: '2026-03-29T12:00:00.000Z',
        endedAt: '2026-03-29T12:02:00.000Z',
      },
      messages: [
        {
          id: 'msg-assistant-db',
          sessionId: 'sess-3',
          role: 'assistant',
          content: '真实最终结果',
          metadata: {},
          createdAt: '2026-03-29T12:02:00.000Z',
        },
      ],
      runState: {
        sessionId: 'sess-3',
        status: 'completed',
        pendingApprovalIds: [],
        updatedAt: '2026-03-29T12:02:00.000Z',
      },
      notices: [],
      processTrace: null,
    } satisfies SessionView)

    const merged = mergeDisplayMessagesFromSessionView(serverMessages, [
      {
        id: 'assistant-123',
        role: 'assistant',
        content: '',
        timestamp: new Date('2026-03-29T12:01:00.000Z'),
        isStreaming: true,
        status: 'sent',
      },
      {
        id: 'error-124',
        role: 'assistant',
        content: '抱歉，发生了错误: Load failed',
        timestamp: new Date('2026-03-29T12:01:30.000Z'),
        status: 'error',
      },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'msg-assistant-db',
      role: 'assistant',
      content: '真实最终结果',
    })
  })

  it('drops stale local raw-json assistant bubble when attempt is terminal and server has no assistant artifact', () => {
    const serverMessages = buildDisplayMessagesFromSessionView({
      session: {
        id: 'sess-4',
        agentId: 'agent-1',
        userId: 'user-1',
        status: 'failed',
        title: 'Failed',
        metadata: {},
        createdAt: '2026-03-29T12:00:00.000Z',
        startedAt: '2026-03-29T12:00:00.000Z',
        endedAt: '2026-03-29T12:02:00.000Z',
      },
      messages: [
        {
          id: 'msg-user-1',
          sessionId: 'sess-4',
          role: 'user',
          content: '搜索最新 AI 行业动态并总结',
          metadata: {},
          createdAt: '2026-03-29T12:00:00.000Z',
        },
      ],
      runState: {
        sessionId: 'sess-4',
        status: 'failed',
        pendingApprovalIds: [],
        updatedAt: '2026-03-29T12:02:00.000Z',
      },
      notices: [],
      processTrace: null,
    } satisfies SessionView)

    const merged = mergeDisplayMessagesFromSessionView(
      serverMessages,
      [
        {
          id: 'assistant-123',
          role: 'assistant',
          content:
            '{"url":"https://techcrunch.com/category/artificial-intelligence/","status_code":200,"content_type":"text/html","title":"","text":"AI news body"}',
          timestamp: new Date('2026-03-29T12:01:30.000Z'),
          isStreaming: false,
          status: 'sent',
        },
      ],
      { currentAttemptStatus: 'failed' }
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'msg-user-1',
      role: 'user',
    })
  })
})
