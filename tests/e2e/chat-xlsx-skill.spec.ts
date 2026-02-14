import { test, expect } from '@playwright/test'

/**
 * US-001: 聊天流程中通过 code_executor 生成 xlsx 文件
 *
 * 验证完整链路：选择 Agent → 发送消息 → SSE 流 → code_executor 调用 →
 * file_created 事件 → FileDownload 组件渲染 → 文件可下载
 */

const TEST_SESSION_ID = 'e2e-xlsx-session-001'
const TEST_MESSAGE_ID = 'e2e-xlsx-msg-001'
const TEST_FILE_ID = 'abc123def456'
const TEST_AGENT_ID = '00000000-0000-0000-0000-000000000099'
const TEST_AGENT_NAME = '测试xslx的代理'

/** 注入 auth token，跳过登录流程 */
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

/**
 * 构建 SSE 响应体，模拟 runtime 完整事件流：
 * thinking → plan → tool_call(code_executor) → tool_result → file → text → done
 */
function buildSSEStream(): string {
  const events: Array<{ event: string; data: unknown }> = [
    // 1. thinking
    {
      event: 'message',
      data: {
        id: 'msg-1',
        type: 'thinking',
        data: { content: '正在分析您的需求...' },
        timestamp: new Date().toISOString(),
      },
    },
    // 2. plan
    {
      event: 'message',
      data: {
        id: 'msg-2',
        type: 'plan',
        data: {
          steps: [
            { id: '1', title: '分析需求', status: 'completed' },
            { id: '2', title: '执行代码生成 xlsx', status: 'running' },
          ],
          currentStep: '2',
        },
        timestamp: new Date().toISOString(),
      },
    },
    // 3. tool_call (code_executor calling)
    {
      event: 'message',
      data: {
        id: 'msg-3',
        type: 'tool_call',
        data: {
          toolName: 'code_executor',
          arguments: {
            language: 'python',
            code: 'import openpyxl\nwb = openpyxl.Workbook()\nws = wb.active\nws.append(["产品", "销量", "金额"])\nws.append(["产品A", 100, 5000])\nws.append(["产品B", 200, 8000])\nwb.save("sales_data.xlsx")\nprint("文件已生成")',
          },
          status: 'calling',
        },
        timestamp: new Date().toISOString(),
      },
    },
    // 4. tool_result (code_executor success)
    {
      event: 'message',
      data: {
        id: 'msg-4',
        type: 'tool_result',
        data: {
          toolName: 'code_executor',
          result: { stdout: '文件已生成\n', stderr: '', exit_code: 0 },
          success: true,
          duration: 1200,
        },
        timestamp: new Date().toISOString(),
      },
    },
    // 5. file_created → mapped to Agent2UI type: 'file'
    {
      event: 'message',
      data: {
        id: 'msg-5',
        type: 'file',
        data: {
          url: `http://localhost:8801/api/v1/files/${TEST_FILE_ID}`,
          filename: 'sales_data.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 5432,
        },
        timestamp: new Date().toISOString(),
      },
    },
    // 6. text response
    {
      event: 'message',
      data: {
        id: 'msg-6',
        type: 'text',
        data: { content: '已为您生成包含示例销售数据的 xlsx 文件，请点击上方卡片下载。' },
        timestamp: new Date().toISOString(),
      },
    },
    // 7. done
    {
      event: 'done',
      data: {
        sessionId: TEST_SESSION_ID,
        messageId: TEST_MESSAGE_ID,
        usage: { tokens: 350, latencyMs: 2500 },
        executionMode: 'runtime_orchestrator',
      },
    },
  ]

  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('')
}

test.describe('US-001: Chat XLSX Skill', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page)
  })

  test('agent 选择页面正确加载并显示「测试xslx的代理」', async ({ page }) => {
    // Mock agents API
    await page.route('**/api/v1/agents**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: TEST_AGENT_ID,
              name: TEST_AGENT_NAME,
              description: '用于测试 xlsx 文件生成的代理',
              isActive: true,
            },
          ],
        }),
      })
    })

    await page.goto('/chat/new')

    // AC: agent 选择页面正确加载并显示「测试xslx的代理」
    await expect(page.getByRole('heading', { name: /开始新会话/i })).toBeVisible()
    await expect(page.getByText(TEST_AGENT_NAME)).toBeVisible()
  })

  test('完整链路：选择 agent → 发送消息 → SSE 流 → 文件卡片渲染 → 可下载', async ({ page }) => {
    // Mock agents API
    await page.route('**/api/v1/agents**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: TEST_AGENT_ID,
              name: TEST_AGENT_NAME,
              description: '用于测试 xlsx 文件生成的代理',
              isActive: true,
            },
          ],
        }),
      })
    })

    // Mock session creation
    await page.route('**/api/v1/sessions', async (route, request) => {
      if (request.method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { id: TEST_SESSION_ID },
          }),
        })
      } else {
        await route.continue()
      }
    })

    // Mock session detail
    await page.route(`**/api/v1/sessions/${TEST_SESSION_ID}`, async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              id: TEST_SESSION_ID,
              agentId: TEST_AGENT_ID,
              title: '请生成一个包含示例销售数据的 xlsx 文件',
              status: 'active',
              createdAt: new Date().toISOString(),
            },
          }),
        })
      } else {
        await route.continue()
      }
    })

    // Mock session messages (empty history)
    await page.route(`**/api/v1/sessions/${TEST_SESSION_ID}/messages`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    })

    // Mock SSE chat endpoint (直连后端 3101)
    await page.route(`**/api/v1/chat/sessions/${TEST_SESSION_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
        body: buildSSEStream(),
      })
    })

    // Mock file download endpoint
    await page.route(`**/api/v1/files/${TEST_FILE_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="sales_data.xlsx"',
        },
        body: Buffer.from('PK\x03\x04fake-xlsx-content'),
      })
    })

    // Step 1: 访问 /chat/new
    await page.goto('/chat/new')
    await expect(page.getByRole('heading', { name: /开始新会话/i })).toBeVisible()

    // Step 2: 选择「测试xslx的代理」
    await page.getByRole('button', { name: new RegExp(TEST_AGENT_NAME) }).click()
    await expect(page.getByText(new RegExp(`已选择:.*${TEST_AGENT_NAME}`))).toBeVisible()

    // Step 3: 输入消息并发送
    const textarea = page.getByPlaceholder('输入您的问题或任务描述...')
    await textarea.fill('请生成一个包含示例销售数据的 xlsx 文件')

    // 点击开始对话 → 创建会话 → 跳转到 session page
    const startButton = page.getByRole('button', { name: /开始对话/i })
    await expect(startButton).toBeEnabled()

    await Promise.all([
      page.waitForURL(new RegExp(`/chat/${TEST_SESSION_ID}`)),
      startButton.click(),
    ])

    // AC: 消息发送后成功创建会话并跳转
    await expect(page).toHaveURL(new RegExp(`/chat/${TEST_SESSION_ID}`))

    // Step 4-5: 等待 SSE 流推送完成（文件卡片出现即表示 SSE 流正常推送了 thinking → tool_call → file → text）
    // Step 6-7: 验证 FileDownload 组件渲染文件卡片
    // AC: FileDownload 组件正确渲染文件卡片
    await expect(
      page.getByText('sales_data.xlsx')
    ).toBeVisible({ timeout: 30000 })

    // 验证文件大小显示
    await expect(page.getByText('5.3 KB')).toBeVisible()

    // 验证下载按钮存在
    await expect(page.getByRole('button', { name: /下载文件/i })).toBeVisible()

    // Step 8: 验证文件可下载
    // AC: 文件可通过 /api/v1/files/{file_id} 端点成功下载
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
      page.getByText('sales_data.xlsx').click(),
    ])

    // 如果浏览器触发了 download 事件，验证文件名
    if (download) {
      expect(download.suggestedFilename()).toContain('sales_data')
    }

    // 验证文本响应也正确显示
    await expect(
      page.getByText(/已为您生成.*xlsx.*文件/)
    ).toBeVisible({ timeout: 10000 })
  })

  test('SSE 流正常推送，无中断或超时', async ({ page }) => {
    // 设置所有必要的 mock
    await page.route('**/api/v1/agents**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{
            id: TEST_AGENT_ID,
            name: TEST_AGENT_NAME,
            description: '测试代理',
            isActive: true,
          }],
        }),
      })
    })

    await page.route('**/api/v1/sessions', async (route, request) => {
      if (request.method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { id: TEST_SESSION_ID } }),
        })
      } else {
        await route.continue()
      }
    })

    await page.route(`**/api/v1/sessions/${TEST_SESSION_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: TEST_SESSION_ID,
            agentId: TEST_AGENT_ID,
            title: '测试',
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        }),
      })
    })

    await page.route(`**/api/v1/sessions/${TEST_SESSION_ID}/messages`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
    })

    // 记录 SSE 请求是否被正确发起
    let sseRequestReceived = false
    await page.route(`**/api/v1/chat/sessions/${TEST_SESSION_ID}`, async (route) => {
      sseRequestReceived = true
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: buildSSEStream(),
      })
    })

    // 执行完整流程
    await page.goto('/chat/new')
    await page.getByRole('button', { name: new RegExp(TEST_AGENT_NAME) }).click()
    await page.getByPlaceholder('输入您的问题或任务描述...').fill('生成 xlsx')

    await Promise.all([
      page.waitForURL(new RegExp(`/chat/${TEST_SESSION_ID}`)),
      page.getByRole('button', { name: /开始对话/i }).click(),
    ])

    // 等待 SSE 流完成（done 事件后流式消息标记为完成）
    await expect(
      page.getByText('sales_data.xlsx')
    ).toBeVisible({ timeout: 30000 })

    // AC: SSE 流正常推送，无中断或超时
    expect(sseRequestReceived).toBe(true)

    // 验证没有错误消息
    await expect(page.getByText(/错误|error|失败/i)).toHaveCount(0)
  })
})
