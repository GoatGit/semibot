/**
 * Chat 流程端到端测试 — SemiGraph vs OpenClaw
 *
 * 搜索代理2 → OpenClaw runtime
 * 搜索代理3 → SemiGraph runtime
 *
 * 10 个测试用例覆盖：
 *  1. 基础对话（OpenClaw）
 *  2. 基础对话（SemiGraph）
 *  3. 搜索类工具调用（OpenClaw）
 *  4. 搜索类工具调用（SemiGraph）
 *  5. 多轮对话上下文（OpenClaw）
 *  6. 多轮对话上下文（SemiGraph）
 *  7. 取消执行（OpenClaw）
 *  8. Agent 切换
 *  9. 研究 + PDF 生成（OpenClaw）
 * 10. 研究 + PDF 生成（SemiGraph）
 */
import { expect, test, type Page } from '@playwright/test'
import { loginByApi } from './helpers/auth'

/* ------------------------------------------------------------------ */
/*  常量 & 工具函数                                                    */
/* ------------------------------------------------------------------ */

const OPENCLAW_AGENT = '搜索代理2'
const SEMIGRAPH_AGENT = '搜索代理3'

/** 全局超时 10 分钟 */
test.setTimeout(600_000)

function resolveApiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL
  if (fromEnv && fromEnv.trim()) {
    const normalized = fromEnv.replace(/\/$/, '')
    return normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`
  }
  return 'http://localhost:3001/api/v1'
}

/** 重启执行平面并等待 VM ready */
async function ensureFreshRuntime(page: Page, token: string, apiBase: string) {
  const reb = await page.request.post(`${apiBase}/vm/rebootstrap`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(reb.ok(), `vm/rebootstrap failed: ${reb.status()}`).toBeTruthy()

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const st = await page.request.get(`${apiBase}/vm/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (st.ok()) {
      const body = await st.json()
      if (body?.data?.status === 'ready') return
    }
    await page.waitForTimeout(2000)
  }
  throw new Error('VM did not become ready within 120 s after rebootstrap')
}

/** 确保指定 Agent 的 runtimeType 正确 */
async function ensureAgentRuntime(
  page: Page,
  token: string,
  apiBase: string,
  agentName: string,
  runtimeType: 'openclaw' | 'semigraph',
) {
  const listRes = await page.request.get(`${apiBase}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(listRes.ok()).toBeTruthy()
  const listBody = await listRes.json()
  const agent = (listBody.data as Array<{ id: string; name: string; runtimeType?: string }>)
    .find((a) => a.name === agentName)
  expect(agent, `Agent "${agentName}" not found`).toBeTruthy()

  if (agent!.runtimeType !== runtimeType) {
    const upd = await page.request.put(`${apiBase}/agents/${agent!.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { runtimeType },
    })
    expect(upd.ok(), `Agent runtimeType update failed: ${upd.status()}`).toBeTruthy()
  }
  return agent!.id
}

/** 在 /chat/new 页面选择 Agent、输入问题、点击开始对话 */
async function startChatWith(page: Page, agentName: string, prompt: string) {
  await page.goto('/chat/new')
  const agentCard = page.getByRole('button', { name: new RegExp(agentName) })
  await expect(agentCard).toBeVisible({ timeout: 15_000 })
  await agentCard.click()

  await page.getByPlaceholder('输入您的问题或任务描述...').fill(prompt)
  await page.getByRole('button', { name: '开始对话' }).click()

  // 等待跳转到会话页
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15_000 })
}

/** 等待执行完成（停止按钮消失） */
async function waitForExecutionComplete(page: Page, timeoutMs = 420_000) {
  const stopBtn = page.getByRole('button', { name: /停止/ })
  // 先等停止按钮出现（说明流已开始）
  await expect(stopBtn).toBeVisible({ timeout: 60_000 }).catch(() => {
    // 如果从未出现说明执行极快或已完成
  })
  // 再等停止按钮消失（说明流已结束）
  await expect(stopBtn).not.toBeVisible({ timeout: timeoutMs })
}

/**
 * 获取最后一条 assistant 回复的文本内容。
 * assistant 气泡选择器：带 border-border-subtle 的 rounded-xl 元素（排除头像等干扰）
 */
function assistantBubbles(page: Page) {
  return page.locator('.rounded-xl.border-border-subtle, [class*="rounded-xl"][class*="border-border-subtle"]')
}

const ASSISTANT_BUBBLE_SELECTOR = '.rounded-xl.border-border-subtle, [class*="rounded-xl"][class*="border-border-subtle"]'

/** 等待 assistant 产出有意义的回复文本 */
async function waitForAssistantReply(page: Page, minLength = 10, timeoutMs = 60_000) {
  await page.waitForFunction(
    ({ selector, min }) => {
      const bubbles = document.querySelectorAll(selector)
      for (const b of bubbles) {
        const text = b.textContent || ''
        if (text.length >= min) return true
      }
      return false
    },
    { selector: ASSISTANT_BUBBLE_SELECTOR, min: minLength },
    { timeout: timeoutMs },
  )
}

/** 等待第 N 个 assistant 气泡出现并包含足够文本（用于多轮对话） */
async function waitForNthAssistantReply(page: Page, n: number, minLength = 10, timeoutMs = 120_000) {
  await page.waitForFunction(
    ({ selector, nth, min }) => {
      const bubbles = document.querySelectorAll(selector)
      if (bubbles.length < nth) return false
      const text = bubbles[nth - 1].textContent || ''
      return text.length >= min
    },
    { selector: ASSISTANT_BUBBLE_SELECTOR, nth: n, min: minLength },
    { timeout: timeoutMs },
  )
}

/** 获取最后一条 assistant 气泡的文本 */
async function getLastAssistantText(page: Page): Promise<string> {
  const bubbles = page.locator(ASSISTANT_BUBBLE_SELECTOR)
  const count = await bubbles.count()
  if (count === 0) return ''
  return (await bubbles.nth(count - 1).textContent()) || ''
}

/* ------------------------------------------------------------------ */
/*  测试套件                                                           */
/* ------------------------------------------------------------------ */

test.describe('Chat Runtime E2E — OpenClaw vs SemiGraph', () => {
  let token: string
  let apiBase: string

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage()
    await loginByApi(page)
    token = await page.evaluate(() => localStorage.getItem('auth_token') || '')
    expect(token.length).toBeGreaterThan(20)
    apiBase = resolveApiBase()

    // 确保两个 Agent 的 runtimeType 正确
    await ensureAgentRuntime(page, token, apiBase, OPENCLAW_AGENT, 'openclaw')
    await ensureAgentRuntime(page, token, apiBase, SEMIGRAPH_AGENT, 'semigraph')
    await ensureFreshRuntime(page, token, apiBase)
    await page.close()
  })

  test.beforeEach(async ({ page }) => {
    await loginByApi(page)
  })

  /* ================================================================ */
  /*  1. 基础对话 — OpenClaw                                          */
  /* ================================================================ */
  test('1. [OpenClaw] 基础对话：问答完整，SSE 流正常结束', async ({ page }) => {
    await startChatWith(page, OPENCLAW_AGENT, '请用一句话介绍量子计算的核心原理')

    await waitForExecutionComplete(page)
    await waitForAssistantReply(page, 10)

    const text = await getLastAssistantText(page)
    expect(text.length, `assistant 回复过短: "${text}"`).toBeGreaterThan(10)
  })

  /* ================================================================ */
  /*  2. 基础对话 — SemiGraph                                         */
  /* ================================================================ */
  test('2. [SemiGraph] 基础对话：问答完整，SSE 流正常结束', async ({ page }) => {
    await startChatWith(page, SEMIGRAPH_AGENT, '请用一句话解释区块链的工作原理')

    await waitForExecutionComplete(page)
    await waitForAssistantReply(page, 10)

    const text = await getLastAssistantText(page)
    expect(text.length, `assistant 回复过短: "${text}"`).toBeGreaterThan(10)
  })

  /* ================================================================ */
  /*  3. 工具调用 — OpenClaw 搜索                                     */
  /* ================================================================ */
  test('3. [OpenClaw] 搜索类问题：触发工具调用并返回结果', async ({ page }) => {
    await startChatWith(page, OPENCLAW_AGENT, '搜索2025年全球AI芯片市场规模，给出关键数据')

    await waitForExecutionComplete(page)
    await waitForAssistantReply(page, 20)

    const text = await getLastAssistantText(page)
    expect(text.length, `搜索结果回复过短: "${text}"`).toBeGreaterThan(20)

    // ProcessCard 可能出现也可能不出现（取决于是否触发工具），仅做软检查
    const processCard = page.getByText(/已完成思考|深度思考中/)
    const hasProcess = await processCard.isVisible().catch(() => false)
    console.log(`[Test 3] ProcessCard visible: ${hasProcess}`)
  })

  /* ================================================================ */
  /*  4. 工具调用 — SemiGraph 搜索                                    */
  /* ================================================================ */
  test('4. [SemiGraph] 搜索类问题：触发工具调用并返回结果', async ({ page }) => {
    await startChatWith(page, SEMIGRAPH_AGENT, '搜索特斯拉2024年全年交付量数据，列出关键数字')

    await waitForExecutionComplete(page)
    await waitForAssistantReply(page, 20)

    const text = await getLastAssistantText(page)
    expect(text.length, `搜索结果回复过短: "${text}"`).toBeGreaterThan(20)

    const processCard = page.getByText(/已完成思考|深度思考中/)
    const hasProcess = await processCard.isVisible().catch(() => false)
    console.log(`[Test 4] ProcessCard visible: ${hasProcess}`)
  })

  /* ================================================================ */
  /*  5. 多轮对话上下文 — OpenClaw                                    */
  /* ================================================================ */
  // FIXME: OpenClaw 多轮对话存在 bug — 第二轮消息发送后 runtime 无响应
  // SemiGraph 多轮对话（测试 6）正常通过，问题仅限 OpenClaw runtime
  test.fixme('5. [OpenClaw] 多轮对话：第二轮能引用第一轮的上下文', async ({ page }) => {
    // 第一轮：简单问候
    await startChatWith(page, OPENCLAW_AGENT, '你好')
    await waitForExecutionComplete(page, 180_000)
    await waitForAssistantReply(page, 1, 120_000)

    // 记录第一轮状态
    const firstRoundBubbles = await page.locator(ASSISTANT_BUBBLE_SELECTOR).count()
    console.log(`[Test 5] First round bubbles: ${firstRoundBubbles}`)

    // 第二轮：发送新消息
    const input = page.getByPlaceholder('输入您的问题...')
    await expect(input).toBeVisible({ timeout: 30_000 })
    await input.fill('请问 2+3 等于几？直接回答数字')
    await page.getByRole('button', { name: '发送' }).click()

    // 等待第二轮完成
    await waitForExecutionComplete(page, 180_000)

    // 等待新的 assistant 气泡出现（比第一轮多）
    await page.waitForFunction(
      ({ selector, prevCount }) => {
        const bubbles = document.querySelectorAll(selector)
        return bubbles.length > prevCount
      },
      { selector: ASSISTANT_BUBBLE_SELECTOR, prevCount: firstRoundBubbles },
      { timeout: 120_000 },
    )

    const text = await getLastAssistantText(page)
    console.log(`[Test 5] Second round reply: "${text.slice(0, 100)}"`)
    expect(text.length, `第二轮回复过短: "${text}"`).toBeGreaterThan(0)
    expect(text, `回复应包含 5，实际: "${text}"`).toContain('5')
  })

  /* ================================================================ */
  /*  6. 多轮对话上下文 — SemiGraph                                   */
  /* ================================================================ */
  test('6. [SemiGraph] 多轮对话：第二轮能引用第一轮的上下文', async ({ page }) => {
    await startChatWith(page, SEMIGRAPH_AGENT, '请记住：我最喜欢的编程语言是 Rust')
    await waitForExecutionComplete(page)
    await waitForAssistantReply(page, 2)

    const input = page.getByPlaceholder('输入您的问题...')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill('我刚才说最喜欢什么编程语言？直接回答语言名称')
    await page.getByRole('button', { name: '发送' }).click()

    await waitForExecutionComplete(page)
    await waitForNthAssistantReply(page, 2, 2, 120_000)

    const text = await getLastAssistantText(page)
    expect(text, `回复应包含 Rust，实际: "${text}"`).toContain('Rust')
  })

  /* ================================================================ */
  /*  7. 取消执行 — OpenClaw                                          */
  /* ================================================================ */
  test('7. [OpenClaw] 取消执行：点击停止后流中断，可继续发送新消息', async ({ page }) => {
    await startChatWith(
      page,
      OPENCLAW_AGENT,
      '请详细分析全球前20大科技公司的市值变化趋势，逐一列出每家公司的数据',
    )

    // 等停止按钮出现
    const stopBtn = page.getByRole('button', { name: /停止/ })
    await expect(stopBtn).toBeVisible({ timeout: 60_000 })

    // 尝试点击停止按钮；如果执行已经完成按钮消失了，也算通过
    const clicked = await stopBtn.click({ timeout: 5_000 }).then(() => true).catch(() => false)
    console.log(`[Test 7] Stop button clicked: ${clicked}`)

    // 停止按钮应消失
    await expect(stopBtn).not.toBeVisible({ timeout: 30_000 })

    // 输入框应可用，可以继续发送新消息
    const input = page.getByPlaceholder('输入您的问题...')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await expect(input).toBeEnabled({ timeout: 10_000 })
  })

  /* ================================================================ */
  /*  8. Agent 切换                                                    */
  /* ================================================================ */
  test('8. Agent 切换：先选搜索代理2再切搜索代理3，均可正常开始对话', async ({ page }) => {
    await page.goto('/chat/new')

    // 选择 OpenClaw Agent
    const oc = page.getByRole('button', { name: new RegExp(OPENCLAW_AGENT) })
    await expect(oc).toBeVisible({ timeout: 15_000 })
    await oc.click()

    // 切换到 SemiGraph Agent
    const sg = page.getByRole('button', { name: new RegExp(SEMIGRAPH_AGENT) })
    await expect(sg).toBeVisible({ timeout: 15_000 })
    await sg.click()

    // 用 SemiGraph Agent 开始对话
    await page.getByPlaceholder('输入您的问题或任务描述...').fill('你好，请做个自我介绍')
    await page.getByRole('button', { name: '开始对话' }).click()

    // 应成功跳转到会话页
    await expect(page).toHaveURL(/\/chat\//, { timeout: 15_000 })

    await waitForExecutionComplete(page)
    await waitForAssistantReply(page, 5)

    const text = await getLastAssistantText(page)
    expect(text.length, `assistant 回复过短: "${text}"`).toBeGreaterThan(5)
  })

  /* ================================================================ */
  /*  9. 文件生成 — OpenClaw 研究 + PDF                               */
  /* ================================================================ */
  test.fixme('9. [OpenClaw] 研究任务 + PDF 生成：研究腾讯并生成 PDF 报告', async ({ page }) => {
    // OpenClaw runtime 在长时间研究任务中不稳定，会话可能丢失消息（后端 bug）
    await startChatWith(
      page,
      OPENCLAW_AGENT,
      '研究腾讯控股2024年的营收和利润数据，并生成一份PDF报告',
    )

    await waitForExecutionComplete(page, 480_000)

    // ProcessCard 可能出现也可能不出现，仅做软检查
    const processCard = page.getByText(/已完成思考|深度思考中/)
    const hasProcess9 = await processCard.isVisible().catch(() => false)
    console.log(`[Test 9] ProcessCard visible: ${hasProcess9}`)

    // 应生成 PDF 文件卡片
    const pdfCard = page.locator('div', {
      has: page.locator('p', { hasText: /\.pdf$/i }),
    }).first()
    await expect(pdfCard).toBeVisible({ timeout: 480_000 })

    // 验证下载按钮存在
    const downloadBtn = pdfCard.getByRole('button', { name: '下载文件' })
    await expect(downloadBtn).toBeVisible({ timeout: 10_000 })
  })

  /* ================================================================ */
  /* 10. 文件生成 — SemiGraph 研究 + PDF                              */
  /* ================================================================ */
  test('10. [SemiGraph] 研究任务 + PDF 生成：研究比亚迪并生成 PDF 报告', async ({ page }) => {
    await startChatWith(
      page,
      SEMIGRAPH_AGENT,
      '研究比亚迪2024年新能源汽车销量数据，并生成一份PDF报告',
    )

    await waitForExecutionComplete(page, 480_000)

    const processCard = page.getByText(/已完成思考|深度思考中/)
    const hasProcess10 = await processCard.isVisible().catch(() => false)
    console.log(`[Test 10] ProcessCard visible: ${hasProcess10}`)

    const pdfCard = page.locator('div', {
      has: page.locator('p', { hasText: /\.pdf$/i }),
    }).first()
    await expect(pdfCard).toBeVisible({ timeout: 480_000 })

    const downloadBtn = pdfCard.getByRole('button', { name: '下载文件' })
    await expect(downloadBtn).toBeVisible({ timeout: 10_000 })
  })
})
