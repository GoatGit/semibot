import { test, expect, type Page } from '@playwright/test'
import { loginByApi } from './helpers/auth'

interface TestSession {
  id: string
  title: string
  createdAt: string
}

function buildTextSSE(sessionId: string, chunks: string[]): string {
  const events: string[] = []

  chunks.forEach((chunk, i) => {
    events.push('event: message')
    events.push(`data: ${JSON.stringify({
      id: `msg-${i + 1}`,
      type: 'text',
      data: { content: chunk },
      timestamp: new Date().toISOString(),
    })}`)
    events.push('')
  })

  events.push('event: done')
  events.push(`data: ${JSON.stringify({
    sessionId,
    messageId: `done-${Date.now()}`,
    usage: { tokens: 1, latencyMs: 1 },
  })}`)
  events.push('')

  return events.join('\n')
}

async function mockSessionList(page: Page, sessions: TestSession[]) {
  await page.route('**/api/v1/sessions', async (route, request) => {
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: sessions }),
      })
      return
    }

    if (request.method() === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      })
      return
    }

    await route.continue()
  })
}

async function mockSessionDetail(page: Page, sessionId: string, history: Array<{ id: string; role: 'user' | 'assistant'; content: string }>) {
  await page.route(`**/api/v1/sessions/${sessionId}`, async (route, request) => {
    if (request.method() !== 'GET') {
      await route.continue()
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: sessionId,
          agentId: '00000000-0000-0000-0000-000000000001',
          title: `Session ${sessionId}`,
          status: 'active',
          createdAt: new Date().toISOString(),
        },
      }),
    })
  })

  await page.route(`**/api/v1/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: history.map((m) => ({
          ...m,
          createdAt: new Date().toISOString(),
        })),
      }),
    })
  })
}

async function mockChatSSE(page: Page, sessionId: string, chunks: string[]) {
  await page.route(`**/api/v1/chat/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      body: buildTextSSE(sessionId, chunks),
    })
  })
}

test.describe('Chat Flow', () => {
  test.beforeEach(async ({ page }) => {
    await loginByApi(page)
  })

  test.describe('Create New Session', () => {
    test('should create a new chat session', async ({ page }) => {
      test.setTimeout(90_000)
      await mockSessionList(page, [])
      await page.route('**/api/v1/agents**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: [{
              id: '00000000-0000-0000-0000-000000000001',
              name: '通用助手',
              description: '通用任务处理',
              isActive: true,
            }],
          }),
        })
      })
      await page.route('**/api/v1/sessions', async (route, request) => {
        if (request.method() !== 'POST') {
          await route.continue()
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { id: 'sess-created' } }),
        })
      })
      await mockSessionDetail(page, 'sess-created', [])
      await mockChatSSE(page, 'sess-created', ['你好，我是测试助手。'])

      await page.goto('/chat/new', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await expect(page).toHaveURL(/\/chat\/new/)

      await page.getByRole('button', { name: /通用助手/ }).click()
      await page.getByRole('button', { name: /开始对话/i }).click()
      await expect(page).toHaveURL(/\/chat\/sess-created/)
      await expect(page.getByPlaceholder('输入您的问题...')).toBeVisible()
    })

    test('should display empty state for new session', async ({ page }) => {
      await mockSessionList(page, [])
      await page.goto('/chat')

      await expect(page.getByText('暂无会话')).toBeVisible()
      await expect(page.getByRole('heading', { name: /选择一个会话开始对话/i })).toBeVisible()
    })
  })

  test.describe('Send Message and Receive Response', () => {
    test('should send message and receive AI response', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-send', title: 'Send', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-send', [])
      await mockChatSSE(page, 'sess-send', ['这是', '测试回复'])

      await page.goto('/chat/sess-send')
      const chatInput = page.getByPlaceholder('输入您的问题...')
      await chatInput.fill('Hello, this is a test message')
      await page.getByRole('button', { name: '发送' }).click()

      await expect(page.getByText('Hello, this is a test message')).toBeVisible()
      await expect(page.getByText('这是测试回复')).toBeVisible({ timeout: 10000 })
    })

    test('should handle empty message submission', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-empty', title: 'Empty', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-empty', [])

      await page.goto('/chat/sess-empty')
      await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
    })

    test('should support multiline message input', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-multi', title: 'Multi', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-multi', [])
      await mockChatSSE(page, 'sess-multi', ['收到多行消息'])

      await page.goto('/chat/sess-multi')

      const chatInput = page.getByPlaceholder('输入您的问题...')
      const multilineMessage = 'Line 1\nLine 2\nLine 3'
      await chatInput.fill(multilineMessage)
      await page.getByRole('button', { name: '发送' }).click()

      await expect(page.getByText('Line 1')).toBeVisible()
      await expect(page.getByText('Line 2')).toBeVisible()
      await expect(page.getByText('Line 3')).toBeVisible()
    })
  })

  test.describe('Message History', () => {
    test('should display message history', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-history', title: 'History', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-history', [
        { id: 'u1', role: 'user', content: 'First message' },
        { id: 'a1', role: 'assistant', content: 'Second message' },
      ])

      await page.goto('/chat/sess-history')
      await expect(page.getByText('First message')).toBeVisible()
      await expect(page.getByText('Second message')).toBeVisible()
    })

    test('should persist messages after page refresh', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-refresh', title: 'Refresh', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-refresh', [
        { id: 'u1', role: 'user', content: 'Persistence test message' },
      ])

      await page.goto('/chat/sess-refresh')
      await page.reload()

      await expect(page.getByText('Persistence test message')).toBeVisible()
    })

    test('should scroll to latest message', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-scroll', title: 'Scroll', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-scroll', [
        { id: 'm1', role: 'user', content: 'Message 1' },
        { id: 'm2', role: 'assistant', content: 'Message 2' },
        { id: 'm3', role: 'user', content: 'Message 3' },
        { id: 'm4', role: 'assistant', content: 'Message 4' },
        { id: 'm5', role: 'user', content: 'Message 5' },
      ])

      await page.goto('/chat/sess-scroll')
      await expect(page.getByText('Message 5')).toBeInViewport()
    })
  })

  test.describe('SSE Streaming', () => {
    test('should display streaming response in real-time', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-stream', title: 'Stream', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-stream', [])
      await mockChatSSE(page, 'sess-stream', ['Hello ', 'world'])

      await page.goto('/chat/sess-stream')
      await page.getByPlaceholder('输入您的问题...').fill('Tell me a short story')
      await page.getByRole('button', { name: '发送' }).click()

      await expect(page.getByText('Hello world')).toBeVisible({ timeout: 10000 })
    })

    test('should handle SSE connection errors gracefully', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-error', title: 'Error', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-error', [])
      await page.route('**/api/v1/chat/sessions/sess-error', async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { message: '模拟网络错误' } }),
        })
      })

      await page.goto('/chat/sess-error')
      await page.getByPlaceholder('输入您的问题...').fill('Test message')
      await page.getByRole('button', { name: '发送' }).click()

      await expect(page.getByText('抱歉，发生了错误: 模拟网络错误')).toBeVisible({ timeout: 10000 })
    })

    test('should allow stopping message generation', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-stop', title: 'Stop', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-stop', [])
      await page.route('**/api/v1/chat/sessions/sess-stop', async (route) => {
        await new Promise((r) => setTimeout(r, 5000))
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: buildTextSSE('sess-stop', ['这是一条较慢的回复']),
        })
      })

      await page.goto('/chat/sess-stop')
      await page.getByPlaceholder('输入您的问题...').fill('Write a very long essay about artificial intelligence')
      await page.getByRole('button', { name: '发送' }).click()

      const stopButton = page.getByRole('button', { name: '停止' })
      await expect(stopButton).toBeVisible({ timeout: 3000 })
      await stopButton.click()

      await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
    })
  })

  test.describe('Session Management', () => {
    test('should switch between sessions', async ({ page }) => {
      await mockSessionList(page, [
        { id: 's1', title: 'Session 1', createdAt: new Date().toISOString() },
        { id: 's2', title: 'Session 2', createdAt: new Date().toISOString() },
      ])
      await mockSessionDetail(page, 's1', [{ id: 'u1', role: 'user', content: 'Session 1 message' }])
      await mockSessionDetail(page, 's2', [{ id: 'u2', role: 'user', content: 'Session 2 message' }])

      await page.goto('/chat')
      await page.getByRole('button', { name: /Session 1/i }).first().click()
      await expect(page.getByText('Session 1 message')).toBeVisible()

      await page.goto('/chat')
      await page.getByRole('button', { name: /Session 2/i }).first().click()
      await expect(page.getByText('Session 2 message')).toBeVisible()
    })

    test('should delete a session', async ({ page }) => {
      await mockSessionList(page, [
        { id: 'delete-1', title: 'Message to delete', createdAt: new Date().toISOString() },
      ])

      await page.route('**/api/v1/sessions/delete-1', async (route, request) => {
        if (request.method() === 'DELETE') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: null }),
          })
          return
        }
        await route.continue()
      })

      await page.goto('/chat')
      await page.getByLabel('删除会话').first().click()
      await page.getByRole('button', { name: '确认删除' }).click()

      await expect(page.getByRole('button', { name: /Message to delete/i })).toHaveCount(0)
    })
  })
})
