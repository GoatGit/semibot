import { expect, test } from '@playwright/test'
import { loginByApi } from './helpers/auth'

test.skip(!process.env.RUN_LIVE_E2E, 'Set RUN_LIVE_E2E=1 after API/Runtime are up to run live deep-research scenario.')

test.setTimeout(600_000)

function resolveApiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL
  if (fromEnv && fromEnv.trim()) {
    const normalized = fromEnv.replace(/\/$/, '')
    return normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`
  }
  return 'http://localhost:3001/api/v1'
}

function extractSessionId(url: string): string {
  const match = url.match(/\/chat\/([^/?#]+)/)
  const candidate = match?.[1] ?? ''
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : ''
}

test('live: 新建会话并使用 deep-research 研究阿里巴巴股票', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'live scenario only runs on chromium')

  await loginByApi(page)
  const apiBase = resolveApiBase()

  const agentsRes = await page.request.get(`${apiBase}/agents`)
  expect(agentsRes.ok(), `agents list failed: ${agentsRes.status()}`).toBeTruthy()
  const agentsBody = await agentsRes.json()
  const agents = Array.isArray(agentsBody?.data) ? agentsBody.data : []
  const deepResearchAgent = agents.find((a: Record<string, unknown>) => a.name === '深度股票研究专家')
  expect(deepResearchAgent, 'Agent "深度股票研究专家" not found').toBeTruthy()
  const skills = Array.isArray(deepResearchAgent?.skills) ? deepResearchAgent.skills.map((s) => String(s)) : []
  const hasDeepResearch = skills.some((s) => s === 'deep-research' || s.endsWith(':deep-research'))
  expect(hasDeepResearch, 'Agent does not include deep-research skill').toBeTruthy()

  await page.goto('/chat/new')

  const agentButton = page.getByRole('button', { name: /深度股票研究专家/i })
  await expect(agentButton, 'Agent "深度股票研究专家" not found').toBeVisible({ timeout: 30_000 })
  await agentButton.click()

  const prompt = '研究阿里巴巴股票'
  await page.getByPlaceholder('输入您的问题或任务描述...').fill(prompt)
  await page.getByRole('button', { name: /(开始对话|开始)/i }).click()

  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}(?:\?|$)/i, { timeout: 20_000 })

  const sessionId = extractSessionId(page.url())
  expect(sessionId).toBeTruthy()

  const deadline = Date.now() + 480_000
  let promptReceivedEvent = false
  let hasToolExecution = false

  while (Date.now() < deadline) {
    const eventsRes = await page.request.get(`${apiBase}/events?page=1&limit=30&sessionId=${sessionId}`)
    if (eventsRes.ok()) {
      const eventsBody = await eventsRes.json()
      const items = Array.isArray(eventsBody?.items) ? eventsBody.items : []
      promptReceivedEvent = items.some((evt: Record<string, unknown>) => {
        const eventType = String(evt.event_type ?? '')
        const payload =
          typeof evt.payload === 'object' && evt.payload !== null ? (evt.payload as Record<string, unknown>) : {}
        const message = String(payload.message ?? '')
        return eventType === 'chat.message.received' && message.includes(prompt)
      })
      hasToolExecution = items.some((evt: Record<string, unknown>) => {
        const eventType = String(evt.event_type ?? '')
        return eventType === 'tool.exec.started' || eventType === 'tool.exec.completed'
      })
    }

    if (promptReceivedEvent && hasToolExecution) {
      break
    }
    await page.waitForTimeout(3000)
  }

  expect(promptReceivedEvent, 'Expected chat.message.received event with the prompt').toBeTruthy()
  expect(hasToolExecution, 'Expected tool execution events in this session').toBeTruthy()
})
