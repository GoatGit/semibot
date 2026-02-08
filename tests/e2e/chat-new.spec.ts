import { test, expect } from '@playwright/test'

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

async function seedAuth(page: import('@playwright/test').Page) {
  await page.context().addCookies([
    {
      name: 'auth_token',
      value: 'test-token',
      domain: 'localhost',
      path: '/',
    },
  ])

  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'test-token')
  })
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
    await seedAuth(page)
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

    let startPayload: { agentId?: string; message?: string } = {}

    await page.route('**/api/v1/chat/start**', async (route, request) => {
      startPayload = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
        body: 'data: {"sessionId":"sess-123"}\n\n',
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

    expect(startPayload.agentId).toBe('00000000-0000-0000-0000-000000000001')
    expect(startPayload.message).toBe('你好，请介绍一下你自己')
  })

  test('shows error when session id is missing', async ({ page }) => {
    await mockAgents(page)

    await page.route('**/api/v1/chat/start**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
        body: 'data: {"foo":"bar"}\n\n',
      })
    })

    await page.goto('/chat/new')

    await page.getByRole('button', { name: /通用助手/i }).click()
    await page.getByRole('button', { name: /开始对话/i }).click()

    await expect(page.getByText(/无法获取会话 ID/i)).toBeVisible()
  })
})
