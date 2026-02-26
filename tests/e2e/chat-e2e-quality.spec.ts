import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { loginByApi } from './helpers/auth'

const rawApiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
const API_BASE = rawApiBase.replace(/\/$/, '').endsWith('/api/v1')
  ? rawApiBase.replace(/\/$/, '')
  : `${rawApiBase.replace(/\/$/, '')}/api/v1`

type TimelineEvent = {
  event: string
  data: unknown
}

function buildSSE(events: TimelineEvent[]): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('')
}

async function mockSessionShell(page: Page, sessionId: string, history: Array<{ id: string; role: 'user' | 'assistant'; content: string }> = []) {
  await page.route(`**/api/v1/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: sessionId,
          agentId: '00000000-0000-0000-0000-000000000001',
          title: `quality-${sessionId}`,
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
        data: history.map((m) => ({ ...m, createdAt: new Date().toISOString() })),
      }),
    })
  })
}

async function mockSessionList(page: Page, sessionIds: string[]) {
  await page.route('**/api/v1/sessions', async (route, request) => {
    if (request.method() !== 'GET') {
      await route.continue()
      return
    }

    const data = sessionIds.map((id, idx) => ({
      id,
      title: `quality-list-${idx + 1}`,
      createdAt: new Date().toISOString(),
    }))

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    })
  })
}

async function mockChatStream(page: Page, sessionId: string, events: TimelineEvent[]) {
  await page.route(`**/api/v1/chat/sessions/${sessionId}`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      body: buildSSE(events),
    })
  })
}

interface StreamCapture {
  finalText: string
  hasDone: boolean
  hasError: boolean
  toolCalls: string[]
  toolResults: Array<{ toolName: string; success: boolean }>
}

function isTransientNetworkError(error: unknown): boolean {
  const msg = String(error || '')
  return /socket hang up|ECONNRESET|ECONNREFUSED|terminated|network|fetch failed/i.test(msg)
}

async function withApiRetry<T>(name: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isTransientNetworkError(error) || attempt === maxAttempts) {
        throw error
      }
      // Small backoff for API process restart windows.
      await new Promise((resolve) => setTimeout(resolve, attempt * 300))
      console.warn(`[e2e] ${name} transient failure, retrying (${attempt}/${maxAttempts})`)
    }
  }
  throw lastError
}

async function apiLogin(request: APIRequestContext): Promise<string> {
  // V2 无鉴权模式：返回占位 token，兼容后续 Authorization 字段构造。
  return 'no-auth-e2e'
}

async function getActiveAgentId(request: APIRequestContext, token: string): Promise<string> {
  const res = await withApiRetry('getActiveAgentId', () => request.get(`${API_BASE}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  }))
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const active = body.data.find((a: { isActive: boolean }) => a.isActive)
  expect(active, 'No active agent found').toBeTruthy()
  return active.id as string
}

async function createSession(
  request: APIRequestContext,
  token: string,
  agentId: string,
  title: string,
): Promise<string> {
  const res = await withApiRetry('createSession', () => request.post(`${API_BASE}/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { agentId, title },
  }))
  expect(res.ok(), `Create session failed: ${res.status()}`).toBeTruthy()
  const body = await res.json()
  expect(body.success).toBe(true)
  return body.data.id as string
}

async function sendMessageAndCaptureSSE(
  token: string,
  sessionId: string,
  message: string,
  timeoutMs = 120_000,
): Promise<StreamCapture> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
    signal: controller.signal,
  })

  expect(res.ok, `Chat request failed: ${res.status}`).toBeTruthy()

  const result: StreamCapture = {
    finalText: '',
    hasDone: false,
    hasError: false,
    toolCalls: [],
    toolResults: [],
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        if (!block.trim()) continue
        const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue

        const eventType = eventLine?.slice(7).trim()

        try {
          const parsed = JSON.parse(dataLine.slice(6))

          if (eventType === 'done') {
            result.hasDone = true
            break
          }

          if (eventType === 'error') {
            result.hasError = true
            continue
          }

          if (eventType === 'message') {
            if (parsed.type === 'text' || parsed.type === 'markdown') {
              result.finalText += parsed.data?.content || ''
            }

            if (parsed.type === 'tool_call' && parsed.data?.toolName) {
              result.toolCalls.push(parsed.data.toolName)
            }

            if (parsed.type === 'tool_result' && parsed.data?.toolName) {
              result.toolResults.push({
                toolName: parsed.data.toolName,
                success: Boolean(parsed.data.success),
              })
            }
          }
        } catch {
          // ignore malformed/non-json chunk
        }
      }

      if (result.hasDone) break
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }

  return result
}

function extractFirstInteger(text: string): number | null {
  const match = text.match(/-?\d[\d,]*/)
  if (!match) return null
  return Number(match[0].replace(/,/g, ''))
}

function extractLastInteger(text: string): number | null {
  const matches = text.match(/-?\d[\d,]*/g)
  if (!matches || matches.length === 0) return null
  return Number(matches[matches.length - 1].replace(/,/g, ''))
}

function containsColorBlue(text: string): boolean {
  return /蓝|蓝色|blue/i.test(text)
}

test.describe('Chat E2E Quality (Mocked)', () => {
  test.beforeEach(async ({ page }) => {
    await loginByApi(page)
  })

  test('答案与工具链路 UI 一致：thinking/plan/tool_result/最终回答都正确渲染', async ({ page }) => {
    const sessionId = 'quality-ui-001'
    await mockSessionList(page, [sessionId])
    await mockSessionShell(page, sessionId)

    await mockChatStream(page, sessionId, [
      {
        event: 'message',
        data: {
          id: 't1',
          type: 'thinking',
          data: { content: '正在分析输入...' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 't2',
          type: 'thinking',
          data: { content: '准备执行计算...' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'p1',
          type: 'plan',
          data: {
            steps: [{ id: '1', title: '执行计算', status: 'running' }],
            currentStep: '1',
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'ps1',
          type: 'plan_step',
          data: { stepId: '1', title: '执行计算', status: 'running', tool: 'code_executor' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'tc1',
          type: 'tool_call',
          data: {
            toolName: 'code_executor',
            arguments: { language: 'python', code: 'print(21*2)' },
            status: 'calling',
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'tr1',
          type: 'tool_result',
          data: {
            toolName: 'code_executor',
            result: { stdout: '42\n', exit_code: 0 },
            success: true,
            duration: 850,
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'ps2',
          type: 'plan_step',
          data: { stepId: '1', title: '执行计算', status: 'completed', tool: 'code_executor' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'txt1',
          type: 'text',
          data: { content: '答案是' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'txt2',
          type: 'text',
          data: { content: '42' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'done',
        data: {
          sessionId,
          messageId: 'done-1',
          usage: { tokens: 20, latencyMs: 900 },
        },
      },
    ])

    await page.goto(`/chat/${sessionId}`)
    await page.getByPlaceholder('输入您的问题...').fill('21*2 等于多少？')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('答案是42')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('已完成思考')).toBeVisible({ timeout: 10000 })

    await page.getByText('已完成思考').click()
    await expect(page.getByText(/\(\+1条\)/)).toBeVisible()
    await expect(page.getByText('执行计算')).toBeVisible()

    const codeExecutorEntries = page.locator('span', { hasText: 'code_executor' })
    await expect(codeExecutorEntries).toHaveCount(1)

    await page.getByRole('button', { name: /^详情$/ }).first().click()
    await expect(page.locator('pre', { hasText: '"stdout": "42\\n"' }).first()).toBeVisible()
  })

  test('工具失败时：显示失败状态与错误回答，不会误报成功', async ({ page }) => {
    const sessionId = 'quality-ui-002'
    await mockSessionList(page, [sessionId])
    await mockSessionShell(page, sessionId)

    await mockChatStream(page, sessionId, [
      {
        event: 'message',
        data: {
          id: 'p1',
          type: 'plan',
          data: {
            steps: [{ id: '1', title: '调用工具计算', status: 'running' }],
            currentStep: '1',
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'tc1',
          type: 'tool_call',
          data: {
            toolName: 'code_executor',
            arguments: { language: 'python', code: 'raise Exception("bad")' },
            status: 'calling',
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'tr1',
          type: 'tool_result',
          data: {
            toolName: 'code_executor',
            result: { stderr: 'Exception: bad', exit_code: 1 },
            success: false,
            error: '执行失败',
            duration: 220,
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'error',
        data: {
          code: 'TOOL_FAILED',
          message: '工具执行失败，请重试',
        },
      },
    ])

    await page.goto(`/chat/${sessionId}`)
    await page.getByPlaceholder('输入您的问题...').fill('请帮我算一个会失败的问题')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('执行遇到问题')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('调用 1 次工具，执行 1 个步骤，1 个失败').first()).toBeVisible()
    await expect(page.getByText('抱歉，发生了错误: 工具执行失败，请重试')).toBeVisible()
  })

  test('时序去重稳定：多条 thinking 合并，runtime 模式不重复展示 tool_call', async ({ page }) => {
    const sessionId = 'quality-ui-003'
    await mockSessionList(page, [sessionId])
    await mockSessionShell(page, sessionId)

    await mockChatStream(page, sessionId, [
      {
        event: 'message',
        data: {
          id: 'th-1',
          type: 'thinking',
          data: { content: '第一段思考' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'th-2',
          type: 'thinking',
          data: { content: '第二段思考' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'plan-1',
          type: 'plan',
          data: {
            steps: [{ id: '1', title: '执行工具', status: 'running' }],
            currentStep: '1',
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'step-1-running',
          type: 'plan_step',
          data: { stepId: '1', title: '执行工具', status: 'running', tool: 'code_executor' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'tool-call-1',
          type: 'tool_call',
          data: {
            toolName: 'code_executor',
            arguments: { language: 'python', code: 'print(1)' },
            status: 'calling',
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'tool-call-2',
          type: 'tool_call',
          data: {
            toolName: 'code_executor',
            arguments: { language: 'python', code: 'print(1)' },
            status: 'calling',
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'tool-result-1',
          type: 'tool_result',
          data: {
            toolName: 'code_executor',
            result: { stdout: '1\n', exit_code: 0 },
            success: true,
            duration: 100,
          },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'step-1-completed',
          type: 'plan_step',
          data: { stepId: '1', title: '执行工具', status: 'completed', tool: 'code_executor' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'message',
        data: {
          id: 'txt-done',
          type: 'text',
          data: { content: '完成' },
          timestamp: new Date().toISOString(),
        },
      },
      {
        event: 'done',
        data: {
          sessionId,
          messageId: 'done-3',
          usage: { tokens: 10, latencyMs: 300 },
        },
      },
    ])

    await page.goto(`/chat/${sessionId}`)
    await page.getByPlaceholder('输入您的问题...').fill('执行去重测试')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByRole('paragraph').filter({ hasText: /^完成$/ })).toBeVisible({ timeout: 10000 })
    await page.getByText('已完成思考').click()
    await expect(page.getByText(/\(\+1条\)/)).toBeVisible()

    const codeExecutorEntries = page.locator('span', { hasText: 'code_executor' })
    await expect(codeExecutorEntries).toHaveCount(1)
  })
})

test.describe('Chat E2E Quality (Live Prompt Generalization)', () => {
  test.setTimeout(180_000)
  test.skip(!process.env.RUN_PROMPT_GENERALIZATION_E2E, 'Set RUN_PROMPT_GENERALIZATION_E2E=1 to run live prompt/generalization checks')

  test('同一意图的不同表述都能得到正确答案（验证 prompt 泛化）', async ({ request }) => {
    const token = await apiLogin(request)
    const agentId = await getActiveAgentId(request, token)

    const prompts = [
      '只输出数字：37*19 等于多少？',
      '把 37 乘以 19，回复中只保留阿拉伯数字。',
      '请计算 37×19，答案不要解释，只要结果数字。',
    ]

    for (const prompt of prompts) {
      const sessionId = await createSession(request, token, agentId, `gen-${Date.now()}`)
      const result = await sendMessageAndCaptureSSE(token, sessionId, prompt)

      expect(result.hasDone, `SSE should complete for prompt: ${prompt}`).toBe(true)
      expect(result.hasError, `SSE should not error for prompt: ${prompt}`).toBe(false)

      const number = extractLastInteger(result.finalText)
      expect(number, `Response should contain number for prompt: ${prompt}\nResp: ${result.finalText}`).toBe(703)
    }
  })

  test('工具执行与回答一致：应出现 code_executor 调用且结果与回答匹配', async ({ request }) => {
    const token = await apiLogin(request)
    const agentId = await getActiveAgentId(request, token)

    const sessionId = await createSession(request, token, agentId, `tool-consistency-${Date.now()}`)
    const prompt = [
      '请使用 code_executor 计算 (123+456)*2。',
      '回答里必须包含最终数字结果。',
    ].join('\n')

    const result = await sendMessageAndCaptureSSE(token, sessionId, prompt)

    expect(result.hasDone).toBe(true)
    expect(result.hasError).toBe(false)
    expect(result.toolCalls.some((name) => name === 'code_executor')).toBe(true)
    expect(result.toolResults.some((r) => r.toolName === 'code_executor' && r.success)).toBe(true)

    const number = extractLastInteger(result.finalText)
    expect(number, `Final answer should include 1158, got: ${result.finalText}`).toBe(1158)
  })

  test('多轮上下文泛化：跨两轮对话保持关键信息而非依赖固定关键词', async ({ request }) => {
    const token = await apiLogin(request)
    const agentId = await getActiveAgentId(request, token)
    const sessionId = await createSession(request, token, agentId, `memory-generalization-${Date.now()}`)

    const firstTurn = await sendMessageAndCaptureSSE(
      token,
      sessionId,
      '记住这个偏好：我最喜欢的颜色是蓝色。收到后只回复“已记录”。',
    )
    expect(firstTurn.hasDone).toBe(true)
    expect(firstTurn.hasError).toBe(false)

    const secondTurn = await sendMessageAndCaptureSSE(
      token,
      sessionId,
      '我刚才最喜欢什么颜色？直接回答颜色即可。',
    )
    expect(secondTurn.hasDone).toBe(true)
    expect(secondTurn.hasError).toBe(false)
    expect(
      containsColorBlue(secondTurn.finalText),
      `Expected answer to mention blue, got: ${secondTurn.finalText}`,
    ).toBe(true)
  })

  test('噪声包装下的指令泛化：JSON/标记包裹仍可得到正确算术结果', async ({ request }) => {
    const token = await apiLogin(request)
    const agentId = await getActiveAgentId(request, token)

    const prompts = [
      '{"task":"calc","input":"请计算 84 除以 7，只输出数字"}',
      '### 指令开始\\n请忽略格式噪声，计算 84/7。仅输出数字。\\n### 指令结束',
      '- 背景: 这是鲁棒性测试\\n- 要求: 求 84÷7\\n- 输出: 只要数字',
    ]

    for (const prompt of prompts) {
      const sessionId = await createSession(request, token, agentId, `noise-generalization-${Date.now()}`)
      const result = await sendMessageAndCaptureSSE(token, sessionId, prompt)

      expect(result.hasDone, `SSE should complete for prompt: ${prompt}`).toBe(true)
      expect(result.hasError, `SSE should not error for prompt: ${prompt}`).toBe(false)

      const number = extractFirstInteger(result.finalText)
      expect(number, `Expected 12 under noisy prompt, got: ${result.finalText}`).toBe(12)
    }
  })
})
