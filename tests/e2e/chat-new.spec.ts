import { test, expect } from '@playwright/test'
import { loginByApi } from './helpers/auth'

const agentsResponse = {
  success: true,
  data: [
    {
      id: '00000000-0000-0000-0000-000000000001',
      name: '通用助手',
      description: '通用任务处理',
      isActive: true,
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      name: '代码助手',
      description: '代码与审查',
      isActive: true,
    },
    {
      id: '00000000-0000-0000-0000-000000000003',
      name: '停用助手',
      description: '不应显示',
      isActive: false,
    },
  ],
}

async function mockAgents(page: import('@playwright/test').Page, responseBody = agentsResponse) {
  await page.route('**/api/v1/agents**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseBody),
    })
  })
}

test.describe('/chat/new', () => {
  test.beforeEach(async ({ page }) => {
    await loginByApi(page)
  })

  test('renders agents from API and allows selection', async ({ page }) => {
    await mockAgents(page)

    await page.goto('/chat/new')

    await expect(page.getByRole('heading', { name: /开始新会话/i })).toBeVisible()
    await expect(page.getByText('通用助手')).toBeVisible()
    await expect(page.getByText('代码助手')).toBeVisible()
    await expect(page.getByText('停用助手')).toHaveCount(0)

    const agentButton = page.getByRole('button', { name: /代码助手/i })
    await agentButton.click()
    await expect(page.getByText(/已选择:.*代码助手/i)).toBeVisible()

    await agentButton.click()
    await expect(page.getByText(/已选择:/i)).toHaveCount(0)
  })

  test('falls back to default templates when API returns empty list', async ({ page }) => {
    await mockAgents(page, { success: true, data: [] })

    await page.goto('/chat/new')

    await expect(page.getByText('通用助手')).toBeVisible()
    await expect(page.getByText('代码助手')).toBeVisible()
    await expect(page.getByText('研究助手')).toBeVisible()

    const startButton = page.getByRole('button', { name: /开始对话/i })
    await expect(startButton).toBeDisabled()
  })

  test('suggestion buttons populate the message input', async ({ page }) => {
    await mockAgents(page)

    await page.goto('/chat/new')

    const suggestion = '帮我分析这份销售数据并生成报告'
    await page.getByRole('button', { name: suggestion }).click()

    await expect(page.getByPlaceholder('输入您的问题或任务描述...')).toHaveValue(suggestion)
  })

  test('start button enables when agent selected and uses default message', async ({ page }) => {
    await mockAgents(page)

    let createPayload: { agentId?: string; title?: string } = {}

    await page.route('**/api/v1/sessions', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.continue()
        return
      }

      createPayload = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { id: 'sess-123' },
        }),
      })
    })

    await page.route('**/api/v1/sessions/sess-123', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: 'sess-123',
            agentId: '00000000-0000-0000-0000-000000000001',
            title: '你好，请介绍一下你自己',
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        }),
      })
    })

    await page.route('**/api/v1/sessions/sess-123/messages', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    })

    await page.route('**/api/v1/chat/sessions/sess-123', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: [
          'event: message',
          'data: {"id":"m1","type":"text","data":{"content":"你好"}}',
          '',
          'event: done',
          'data: {"sessionId":"sess-123","messageId":"m2","usage":{"tokens":1,"latencyMs":1}}',
          '',
        ].join('\n'),
      })
    })

    await page.goto('/chat/new')

    const startButton = page.getByRole('button', { name: /开始对话/i })
    await expect(startButton).toBeDisabled()

    await page.getByRole('button', { name: /通用助手/i }).click()
    await expect(startButton).toBeEnabled()

    await Promise.all([
      page.waitForURL(/\/chat\/sess-123/),
      startButton.click(),
    ])

    expect(createPayload.agentId).toBe('00000000-0000-0000-0000-000000000001')
    expect(createPayload.title).toBe('你好，请介绍一下你自己')
  })

  test('shows error when session id is missing', async ({ page }) => {
    await mockAgents(page)

    await page.route('**/api/v1/sessions', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.continue()
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      })
    })

    await page.goto('/chat/new')

    await page.getByRole('button', { name: /通用助手/i }).click()
    await page.getByRole('button', { name: /开始对话/i }).click()

    await expect(page.getByText(/创建会话失败/i)).toBeVisible()
  })
})
