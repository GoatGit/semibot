import { expect, test } from '@playwright/test'
import { loginByApi } from './helpers/auth'

test.skip(!process.env.RUN_LIVE_E2E, 'Set RUN_LIVE_E2E=1 after API/Runtime are up to run live scenario.')

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

async function fetchSessionEventsSafe(page: import('@playwright/test').Page, apiBase: string, sessionId: string) {
  try {
    const res = await page.request.get(`${apiBase}/events?page=1&limit=200&sessionId=${sessionId}`, {
      timeout: 30_000,
    })
    if (!res.ok()) return []
    const body = await res.json()
    return Array.isArray(body?.items) ? body.items : []
  } catch {
    return []
  }
}

test('live: 系统默认agent使用 deep-research 研究腾讯股票', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'live scenario only runs on chromium')

  page.on('pageerror', (error) => {
    console.log('[pageerror]', error.message)
  })
  page.on('requestfailed', (request) => {
    console.log('[requestfailed]', request.method(), request.url(), request.failure()?.errorText || 'unknown')
  })
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.log(`[console:${message.type()}]`, message.text())
    }
  })

  await loginByApi(page)
  const apiBase = resolveApiBase()

  const agentsRes = await page.request.get(`${apiBase}/agents`)
  expect(agentsRes.ok(), `agents list failed: ${agentsRes.status()}`).toBeTruthy()
  const agentsBody = await agentsRes.json()
  const agents = Array.isArray(agentsBody?.data) ? agentsBody.data : []
  const systemAgent = agents.find((a: Record<string, unknown>) => a.isSystem === true)
  expect(systemAgent, 'System default agent not found').toBeTruthy()

  await page.goto('/chat/new')

  const systemAgentButton = page.getByRole('button', { name: /系统助手/i })
  await expect(systemAgentButton, 'System default agent button not found').toBeVisible({ timeout: 30_000 })
  await systemAgentButton.click()

  const prompt = '使用deep-research技能研究腾讯股票'
  await page.getByPlaceholder('输入您的问题或任务描述...').fill(prompt)
  await page.getByRole('button', { name: /(开始对话|开始)/i }).click()

  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}(?:\?|$)/i, { timeout: 20_000 })

  const sessionId = extractSessionId(page.url())
  expect(sessionId).toBeTruthy()

  const deadline = Date.now() + 480_000
  let observedToolExecution = false
  let deepResearchStarted = false
  let deepResearchFailed = false
  let planCount = 0
  let toolExecCompleted = false
  const failureSubjects = new Set<string>()

  while (Date.now() < deadline) {
    const items = await fetchSessionEventsSafe(page, apiBase, sessionId)
    for (const evt of items) {
      const eventType = String(evt?.event_type ?? '')
      const subject = String(evt?.subject ?? '')
      if (eventType === 'tool.exec.started') {
        observedToolExecution = true
        if (subject === 'deep-research') deepResearchStarted = true
      }
      if (eventType === 'tool.exec.completed') {
        toolExecCompleted = true
      }
      if (eventType === 'tool.exec.failed') {
        failureSubjects.add(subject)
        if (subject === 'deep-research') deepResearchFailed = true
      }
      if (eventType === 'skill_orchestration') {
        planCount += 1
      }
    }
    if (observedToolExecution && toolExecCompleted && !deepResearchFailed) break
    await page.waitForTimeout(3000)
  }

  expect(observedToolExecution, 'Expected at least one executable tool invocation').toBeTruthy()
  expect(deepResearchStarted, 'deep-research should not be directly executed as a tool').toBeFalsy()
  expect(deepResearchFailed, 'deep-research direct execution failure should not happen').toBeFalsy()
  expect(planCount, 'Should not replan').toBeLessThanOrEqual(1)
  expect(failureSubjects.has('file_io')).toBeFalsy()
  expect(failureSubjects.has('skill_script_runner')).toBeFalsy()
})
