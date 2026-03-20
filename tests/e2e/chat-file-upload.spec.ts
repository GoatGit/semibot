import { test, expect, type Page } from '@playwright/test'

// ═══════════════════════════════════════════════════════════════
// 测试辅助
// ═══════════════════════════════════════════════════════════════

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

async function mockSessionList(page: Page, sessions: Array<{ id: string; title: string; createdAt: string }>) {
  await page.route('**/api/v1/sessions', async (route, request) => {
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: sessions }),
      })
      return
    }
    await route.continue()
  })
}

async function mockSessionDetail(
  page: Page,
  sessionId: string,
  history: Array<{ id: string; role: string; content: string; metadata?: Record<string, unknown> }>
) {
  await page.route(`**/api/v1/sessions/${sessionId}`, async (route, request) => {
    if (request.method() !== 'GET') { await route.continue(); return }
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
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: buildTextSSE(sessionId, chunks),
    })
  })
}

async function setupSession(page: Page, sessionId: string, history: Array<{ id: string; role: string; content: string; metadata?: Record<string, unknown> }> = []) {
  await mockSessionList(page, [{ id: sessionId, title: 'Upload Test', createdAt: new Date().toISOString() }])
  await mockSessionDetail(page, sessionId, history)
  await mockChatSSE(page, sessionId, ['收到文件，已处理。'])
}

/**
 * 通过 Playwright 的 setInputFiles 模拟文件选择
 */
async function selectFiles(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles(files)
}

function createTextFileBuffer(content: string): Buffer {
  return Buffer.from(content, 'utf-8')
}

function createFakeImageBuffer(): Buffer {
  // 1x1 transparent PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  )
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

test.describe('Chat File Upload', () => {
  test.beforeEach(async ({ page, context }) => {
    // 注入 auth cookie 绕过登录（无需真实后端）
    const baseURL = (test.info().project.use as { baseURL?: string }).baseURL || 'http://localhost:3000'
    const url = new URL(baseURL)
    await context.addCookies([{
      name: 'auth_token',
      value: 'mock-e2e-token',
      domain: url.hostname,
      path: '/',
    }])
  })

  // ─── UPLOAD-001: 文件上传按钮和 input ───
  test.describe('UPLOAD-001: 文件上传按钮', () => {
    test('AC1: 输入区域包含添加附件按钮', async ({ page }) => {
      await setupSession(page, 'sess-upload-btn')
      await page.goto('/chat/sess-upload-btn')

      const attachBtn = page.getByLabel('添加附件')
      await expect(attachBtn).toBeVisible()
    })

    test('AC2: 页面包含隐藏的 file input 且 accept 包含允许的扩展名', async ({ page }) => {
      await setupSession(page, 'sess-upload-input')
      await page.goto('/chat/sess-upload-input')

      const fileInput = page.locator('input[type="file"]')
      await expect(fileInput).toBeAttached()

      const accept = await fileInput.getAttribute('accept')
      expect(accept).toContain('.pdf')
      expect(accept).toContain('.txt')
      expect(accept).toContain('.png')
    })
  })

  // ─── UPLOAD-002: 文件预览条 ───
  test.describe('UPLOAD-002: 文件预览条', () => {
    test('AC1: 选择 txt 文件后显示文件名预览', async ({ page }) => {
      await setupSession(page, 'sess-preview-txt')
      await page.goto('/chat/sess-preview-txt')

      await selectFiles(page, [{
        name: 'test-doc.txt',
        mimeType: 'text/plain',
        buffer: createTextFileBuffer('hello world'),
      }])

      await expect(page.getByText('test-doc.txt')).toBeVisible()
    })

    test('AC2: 点击 X 按钮移除文件', async ({ page }) => {
      await setupSession(page, 'sess-preview-remove')
      await page.goto('/chat/sess-preview-remove')

      await selectFiles(page, [{
        name: 'remove-me.txt',
        mimeType: 'text/plain',
        buffer: createTextFileBuffer('to be removed'),
      }])

      await expect(page.getByText('remove-me.txt')).toBeVisible()

      // 点击预览标签中的 X 按钮（预览条在输入框上方的 flex-wrap 容器中）
      const removeBtn = page.locator('.flex.flex-wrap button').first()
      await removeBtn.click()

      await expect(page.getByText('remove-me.txt')).not.toBeVisible()
    })

    test('AC3: 选择图片文件后显示缩略图', async ({ page }) => {
      await setupSession(page, 'sess-preview-img')
      await page.goto('/chat/sess-preview-img')

      await selectFiles(page, [{
        name: 'photo.png',
        mimeType: 'image/png',
        buffer: createFakeImageBuffer(),
      }])

      await expect(page.getByText('photo.png')).toBeVisible()
      // 图片预览应包含 img 元素
      const previewChip = page.locator('div').filter({ hasText: 'photo.png' }).first()
      await expect(previewChip.locator('img')).toBeVisible()
    })
  })

  // ─── UPLOAD-003: 文件校验 ───
  test.describe('UPLOAD-003: 文件校验', () => {
    test('AC1: 超过 5 个文件时显示错误提示', async ({ page }) => {
      await setupSession(page, 'sess-validate-count')
      await page.goto('/chat/sess-validate-count')

      const files = Array.from({ length: 6 }, (_, i) => ({
        name: `file-${i + 1}.txt`,
        mimeType: 'text/plain',
        buffer: createTextFileBuffer(`content ${i}`),
      }))

      await selectFiles(page, files)

      await expect(page.getByText(/最多上传 5 个文件/)).toBeVisible()
    })

    test('AC2: 不支持的文件类型显示错误提示', async ({ page }) => {
      await setupSession(page, 'sess-validate-type')
      await page.goto('/chat/sess-validate-type')

      // 需要先移除 accept 限制，因为浏览器会过滤
      await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]') as HTMLInputElement
        if (input) input.removeAttribute('accept')
      })

      await selectFiles(page, [{
        name: 'malware.exe',
        mimeType: 'application/x-msdownload',
        buffer: Buffer.from('fake'),
      }])

      await expect(page.getByText(/不支持的文件类型/)).toBeVisible()
    })
  })

  // ─── UPLOAD-004: multipart 请求 ───
  test.describe('UPLOAD-004: multipart 请求', () => {
    test('AC1: 带文件发送时使用 multipart/form-data', async ({ page }) => {
      await setupSession(page, 'sess-multipart')
      await page.goto('/chat/sess-multipart')

      let capturedContentType = ''
      await page.route('**/api/v1/chat/sessions/sess-multipart', async (route, request) => {
        capturedContentType = request.headers()['content-type'] || ''
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: buildTextSSE('sess-multipart', ['OK']),
        })
      })

      await selectFiles(page, [{
        name: 'upload.txt',
        mimeType: 'text/plain',
        buffer: createTextFileBuffer('file content'),
      }])

      await page.getByPlaceholder('输入您的问题...').fill('请分析这个文件')
      await page.getByRole('button', { name: '发送' }).click()

      // 等待请求完成
      await expect(page.getByText('OK')).toBeVisible({ timeout: 10000 })
      expect(capturedContentType).toContain('multipart/form-data')
    })

    test('AC2: 无文件发送时使用 application/json', async ({ page }) => {
      await setupSession(page, 'sess-json')
      await page.goto('/chat/sess-json')

      let capturedContentType = ''
      await page.route('**/api/v1/chat/sessions/sess-json', async (route, request) => {
        capturedContentType = request.headers()['content-type'] || ''
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: buildTextSSE('sess-json', ['OK']),
        })
      })

      await page.getByPlaceholder('输入您的问题...').fill('普通消息')
      await page.getByRole('button', { name: '发送' }).click()

      await expect(page.getByText('OK')).toBeVisible({ timeout: 10000 })
      expect(capturedContentType).toContain('application/json')
    })

    test('AC3: 发送后文件预览条和输入框被清空', async ({ page }) => {
      await setupSession(page, 'sess-clear')
      await page.goto('/chat/sess-clear')

      await selectFiles(page, [{
        name: 'clearme.txt',
        mimeType: 'text/plain',
        buffer: createTextFileBuffer('will be cleared'),
      }])

      await expect(page.getByText('clearme.txt')).toBeVisible()

      await page.getByPlaceholder('输入您的问题...').fill('发送并清空')
      await page.getByRole('button', { name: '发送' }).click()

      // 预览条（输入框上方的 flex-wrap 容器）应消失
      // 注意：clearme.txt 仍会出现在消息气泡的附件标签中，所以检查预览条容器
      const previewBar = page.locator('.flex.flex-wrap.gap-2.px-3.pt-3')
      await expect(previewBar).not.toBeVisible({ timeout: 5000 })
      // 输入框应清空
      await expect(page.getByPlaceholder('输入您的问题...')).toHaveValue('')
    })
  })

  // ─── UPLOAD-005: 消息气泡附件标签 ───
  test.describe('UPLOAD-005: 消息气泡附件标签', () => {
    test('AC1+AC2: 发送带文件消息后气泡中显示附件标签（文件名+大小）', async ({ page }) => {
      await setupSession(page, 'sess-attach-tag')
      await page.goto('/chat/sess-attach-tag')

      await selectFiles(page, [{
        name: 'report.txt',
        mimeType: 'text/plain',
        buffer: createTextFileBuffer('a'.repeat(1500)),
      }])

      await page.getByPlaceholder('输入您的问题...').fill('请看附件')
      await page.getByRole('button', { name: '发送' }).click()

      // 用户消息气泡中应显示附件标签
      await expect(page.getByText('report.txt')).toBeVisible({ timeout: 5000 })
      // 应显示文件大小
      await expect(page.getByText(/\d+(\.\d+)?(B|KB|MB)/)).toBeVisible()
    })
  })

  // ─── UPLOAD-006: 历史消息附件恢复 ───
  test.describe('UPLOAD-006: 历史消息附件恢复', () => {
    test('AC1: 历史消息中 metadata.attachments 正确渲染附件标签', async ({ page }) => {
      await mockSessionList(page, [{ id: 'sess-history-att', title: 'History Attach', createdAt: new Date().toISOString() }])
      await mockSessionDetail(page, 'sess-history-att', [
        {
          id: 'u1',
          role: 'user',
          content: '请分析这个文件',
          metadata: {
            attachments: [
              { filename: 'history-doc.pdf', size: 204800, mimeType: 'application/pdf', isImage: false },
            ],
          },
        },
        {
          id: 'a1',
          role: 'assistant',
          content: '已分析完毕。',
        },
      ])
      await mockChatSSE(page, 'sess-history-att', ['OK'])

      await page.goto('/chat/sess-history-att')

      // 历史用户消息应显示附件标签
      await expect(page.getByText('history-doc.pdf')).toBeVisible()
      await expect(page.getByText('200KB')).toBeVisible()
    })
  })
})
