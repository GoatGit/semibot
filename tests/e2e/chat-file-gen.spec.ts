import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

/**
 * US-003 / US-004: 真实环境 E2E 测试
 * 聊天流程中通过 code_executor 生成 PDF / XLSX 文件
 *
 * 前置条件：
 * - 三层服务已启动：Frontend (3100), API (3101), Runtime (8901)
 * - 测试账号已存在：12611171@qq.com / test123
 * - Runtime 已安装 openpyxl + reportlab
 * - 至少有一个 isActive=true 的 Agent
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3101/api/v1'
const APP_BASE = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3100'
const TEST_EMAIL = '12611171@qq.com'
const TEST_PASSWORD = 'test123'

// 增加超时 — LLM 调用 + code_executor 执行需要时间
test.setTimeout(180_000)

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** 通过 API 登录，返回 JWT token */
async function apiLogin(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  })
  expect(res.ok(), `Login failed: ${res.status()}`).toBeTruthy()
  const body = await res.json()
  expect(body.success).toBe(true)
  return body.data.token as string
}

/** 将 token 注入浏览器（localStorage + cookie），跳过 UI 登录 */
async function injectAuth(page: Page, token: string) {
  // 先访问一次以设置 origin
  await page.goto(APP_BASE, { waitUntil: 'domcontentloaded' })

  await page.evaluate((t) => {
    localStorage.setItem('auth_token', t)
  }, token)

  await page.context().addCookies([
    { name: 'auth_token', value: token, domain: 'localhost', path: '/' },
  ])
}

/** 获取第一个 isActive 的 agent ID */
async function getActiveAgentId(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get(`${API_BASE}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const active = body.data.find((a: { isActive: boolean }) => a.isActive)
  expect(active, 'No active agent found').toBeTruthy()
  return active.id as string
}

interface SSEResult {
  files: Array<{ filename: string; url: string; mimeType: string }>
  hasError: boolean
  hasDone: boolean
  rawEvents: string[]
}

/**
 * 通过 Node fetch 发送消息并流式解析 SSE，返回所有 file 事件
 * 使用 native fetch 以支持 streaming（Playwright APIRequestContext 不支持 SSE 长连接）
 */
async function sendMessageAndParseSSE(
  token: string,
  sessionId: string,
  message: string,
  timeoutMs = 150_000,
): Promise<SSEResult> {
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

  const result: SSEResult = { files: [], hasError: false, hasDone: false, rawEvents: [] }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // 按 \n\n 分割完整的 SSE 事件块
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop()! // 最后一个可能不完整，保留

      for (const block of blocks) {
        if (!block.trim()) continue
        result.rawEvents.push(block)

        const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue

        // 优先使用标准 SSE event: 行，否则从 data JSON 中读取 event 字段
        let eventType = eventLine?.slice(7).trim()

        try {
          const parsed = JSON.parse(dataLine.slice(6))
          if (!eventType) {
            eventType = parsed.event
          }

          if (eventType === 'done') {
            result.hasDone = true
            break
          }
          if (eventType === 'error') {
            result.hasError = true
          }

          // file_created 事件 — runtime 生成文件后推送
          if (eventType === 'file_created' && parsed.data) {
            result.files.push({
              filename: parsed.data.filename,
              url: parsed.data.url,
              mimeType: parsed.data.mime_type || parsed.data.mimeType,
            })
          }
          // 兼容 type=file 格式
          if (parsed.type === 'file' && parsed.data) {
            result.files.push({
              filename: parsed.data.filename,
              url: parsed.data.url,
              mimeType: parsed.data.mime_type || parsed.data.mimeType,
            })
          }
        } catch {
          // 非 JSON（如 ping 注释行），跳过
        }
      }

      if (result.hasDone) break
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      // timeout — 仍然返回已收集的结果
    } else {
      throw err
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }

  return result
}

/** 创建会话 */
async function createSession(
  request: APIRequestContext,
  token: string,
  agentId: string,
  title: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { agentId, title },
  })
  expect(res.ok(), `Create session failed: ${res.status()}`).toBeTruthy()
  const body = await res.json()
  expect(body.success).toBe(true)
  return body.data.id as string
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

test.describe('Real E2E: Chat File Generation (PDF & XLSX)', () => {
  let token: string
  let agentId: string

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request)
    agentId = await getActiveAgentId(request, token)
  })

  /* ============================================================== */
  /*  XLSX 测试                                                      */
  /* ============================================================== */

  test('XLSX: API 链路 — code_executor 生成 xlsx 并返回 file 事件', async ({ request }) => {
    const sessionId = await createSession(request, token, agentId, 'E2E: XLSX 生成测试')

    const result = await sendMessageAndParseSSE(
      token,
      sessionId,
      '请使用 code_executor 工具执行以下 Python 代码来生成 xlsx 文件：\n\nimport openpyxl\nwb = openpyxl.Workbook()\nws = wb.active\nws.append(["产品名", "数量", "金额"])\nws.append(["产品A", 100, 5000])\nws.append(["产品B", 200, 8000])\nws.append(["产品C", 150, 6500])\nwb.save("sales_report.xlsx")\nprint("文件已生成")',
    )

    // Debug: 打印收到的事件摘要
    console.log('[XLSX] hasDone:', result.hasDone, 'hasError:', result.hasError, 'files:', result.files.length, 'rawEvents:', result.rawEvents.length)
    // Debug: 打印前 10 个和最后 5 个原始事件
    console.log('[XLSX] First 10 raw events:')
    result.rawEvents.slice(0, 10).forEach((e, i) => console.log(`  [${i}]`, e.substring(0, 200)))
    console.log('[XLSX] Last 5 raw events:')
    result.rawEvents.slice(-5).forEach((e, i) => console.log(`  [${result.rawEvents.length - 5 + i}]`, e.substring(0, 200)))
    // Debug: 打印所有包含 file 的事件
    console.log('[XLSX] Events containing "file":')
    result.rawEvents.filter(e => e.includes('file')).forEach((e, i) => console.log(`  [file-${i}]`, e.substring(0, 300)))

    // 验证 SSE 流正常完成
    expect(result.hasDone, 'SSE stream should have a done event').toBe(true)
    expect(result.hasError, 'SSE stream should not have errors').toBe(false)

    // 验证至少收到一个 file 事件
    expect(result.files.length, 'Expected at least one file event in SSE stream').toBeGreaterThanOrEqual(1)

    // Debug: 打印文件信息
    console.log('[XLSX] files:', JSON.stringify(result.files, null, 2))

    // 验证文件名包含 xlsx
    const xlsxFile = result.files.find((f) => f.filename?.endsWith('.xlsx'))
    expect(xlsxFile, 'Expected an .xlsx file in the response').toBeTruthy()

    // 验证 mimeType
    expect(xlsxFile!.mimeType).toContain('spreadsheet')

    // 验证文件可下载
    if (xlsxFile!.url) {
      const downloadRes = await request.get(xlsxFile!.url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (downloadRes.ok()) {
        const body = await downloadRes.body()
        expect(body.length).toBeGreaterThan(0)
      }
    }
  })

  test('XLSX: UI 链路 — 聊天页面显示文件下载卡片', async ({ page, request }) => {
    await injectAuth(page, token)

    const sessionId = await createSession(request, token, agentId, 'E2E: XLSX UI 测试')

    // 导航到会话页面，通过 initialMessage 触发消息发送
    const msg = '请使用 code_executor 工具执行 Python 代码生成一个 xlsx 文件：import openpyxl; wb = openpyxl.Workbook(); ws = wb.active; ws.append(["姓名","部门","工资"]); ws.append(["张三","技术部",15000]); ws.append(["李四","市场部",12000]); wb.save("employees.xlsx"); print("done")'
    await page.goto(`${APP_BASE}/chat/${sessionId}?initialMessage=${encodeURIComponent(msg)}`)

    // 等待下载按钮出现（FileDownload 组件渲染完成的标志）
    // LLM 响应需要 1-2 分钟，所以给足够的超时
    const downloadBtn = page.locator('[aria-label="下载文件"]').first()
    await expect(downloadBtn).toBeVisible({ timeout: 180_000 })

    // 验证文件名包含 .xlsx
    const fileCard = page.locator('text=/.+\\.xlsx/i').first()
    await expect(fileCard).toBeVisible({ timeout: 10_000 })
  })

  /* ============================================================== */
  /*  PDF 测试                                                       */
  /* ============================================================== */

  test('PDF: API 链路 — code_executor 生成 pdf 并返回 file 事件', async ({ request }) => {
    const sessionId = await createSession(request, token, agentId, 'E2E: PDF 生成测试')

    const result = await sendMessageAndParseSSE(
      token,
      sessionId,
      '请使用 code_executor 工具执行以下 Python 代码来生成 PDF 文件：\n\nfrom reportlab.lib.pagesizes import A4\nfrom reportlab.pdfgen import canvas\nc = canvas.Canvas("test_report.pdf", pagesize=A4)\nc.setFont("Helvetica", 24)\nc.drawString(100, 750, "Test Report")\nc.setFont("Helvetica", 12)\nc.drawString(100, 700, "This is a test PDF generated by code_executor.")\nc.drawString(100, 680, "It contains sample content for E2E testing.")\nc.save()\nprint("PDF generated")',
    )

    // 验证 SSE 流正常完成
    expect(result.hasDone, 'SSE stream should have a done event').toBe(true)
    expect(result.hasError, 'SSE stream should not have errors').toBe(false)

    // 验证至少收到一个 file 事件
    expect(result.files.length, 'Expected at least one file event in SSE stream').toBeGreaterThanOrEqual(1)

    // 验证文件名包含 pdf
    const pdfFile = result.files.find((f) => f.filename.endsWith('.pdf'))
    expect(pdfFile, 'Expected a .pdf file in the response').toBeTruthy()

    // 验证 mimeType
    expect(pdfFile!.mimeType).toContain('pdf')

    // 验证文件可下载
    if (pdfFile!.url) {
      const downloadRes = await request.get(pdfFile!.url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (downloadRes.ok()) {
        const body = await downloadRes.body()
        expect(body.length).toBeGreaterThan(0)
      }
    }
  })

  test('PDF: UI 链路 — 聊天页面显示文件下载卡片', async ({ page, request }) => {
    await injectAuth(page, token)

    const sessionId = await createSession(request, token, agentId, 'E2E: PDF UI 测试')

    const msg = '请使用 code_executor 工具执行 Python 代码生成一个 PDF 文件：from reportlab.lib.pagesizes import A4; from reportlab.pdfgen import canvas; c = canvas.Canvas("report.pdf", pagesize=A4); c.setFont("Helvetica", 24); c.drawString(100, 750, "Report"); c.save(); print("done")'
    await page.goto(`${APP_BASE}/chat/${sessionId}?initialMessage=${encodeURIComponent(msg)}`)

    // 等待下载按钮出现（FileDownload 组件渲染完成的标志）
    const downloadBtn = page.locator('[aria-label="下载文件"]').first()
    await expect(downloadBtn).toBeVisible({ timeout: 180_000 })

    // 验证文件名包含 .pdf
    const fileCard = page.locator('text=/.+\\.pdf/i').first()
    await expect(fileCard).toBeVisible({ timeout: 10_000 })
  })

  /* ============================================================== */
  /*  错误处理测试                                                    */
  /* ============================================================== */

  test('Error: 缺少 Python 包时 code_executor 应返回错误信息而非崩溃', async ({ request }) => {
    const sessionId = await createSession(request, token, agentId, 'E2E: 错误处理测试')

    const result = await sendMessageAndParseSSE(
      token,
      sessionId,
      '请用 Python 的 nonexistent_package_xyz 库生成一个文件',
    )

    // 验证 SSE 流正常完成（有 done 事件），没有连接中断
    expect(result.hasDone, 'SSE stream should complete with done event').toBe(true)

    // 不应该有 file 事件（因为代码执行会失败）
    // 但 agent 可能会重试或给出文字说明，这都是可接受的
  })
})
