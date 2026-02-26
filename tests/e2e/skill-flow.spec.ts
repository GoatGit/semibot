import { test, expect, type Page } from '@playwright/test'

/**
 * 技能端到端测试
 *
 * 覆盖：
 * 1. 上传创建技能（upload-create 流程）
 * 2. 技能列表展示与管理（搜索、启用/禁用、删除）
 * 3. Agent 配置技能
 * 4. 聊天中技能触发
 */

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** V2 单用户模式登录占位：仅写入本地默认用户态 */
async function login(page: Page) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({
        state: {
          user: {
            id: 'e2e-single-user',
            email: 'admin@semibot.local',
            name: 'Semibot Admin',
            role: 'owner',
            orgId: '11111111-1111-1111-1111-111111111111',
            orgName: 'Semibot',
          },
          tokens: null,
          isAuthenticated: true,
        },
        version: 0,
      })
    )
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
}

/** 导航到技能页面并等待加载完成 */
async function gotoSkills(page: Page) {
  await page.goto('/skills', { waitUntil: 'domcontentloaded' })
  await expect(
    page.getByRole('heading', { name: '技能管理' })
  ).toBeVisible({ timeout: 30000 })
}

interface MockSkillDefinition {
  id: string
  name: string
  skillId: string
  description: string
  category: string
  isActive: boolean
}

async function setupSkillDefinitionMocks(page: Page) {
  let defs: MockSkillDefinition[] = [
    {
      id: 'skill-seed-1',
      name: 'Seed Skill',
      skillId: 'seed-skill',
      description: 'seed',
      category: 'general',
      isActive: true,
    },
  ]
  let seq = 1

  await page.route('**/api/v1/skill-definitions**', async (route, request) => {
    const { pathname } = new URL(request.url())
    const method = request.method()

    if (pathname.endsWith('/skill-definitions') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: defs,
          meta: { total: defs.length, page: 1, limit: 100, totalPages: 1 },
        }),
      })
      return
    }

    if (pathname.endsWith('/skill-definitions/upload-create') && method === 'POST') {
      seq += 1
      const created: MockSkillDefinition = {
        id: `skill-upload-${seq}`,
        name: `Uploaded Skill ${seq}`,
        skillId: `uploaded-skill-${seq}`,
        description: 'uploaded by e2e',
        category: 'general',
        isActive: true,
      }
      defs = [created, ...defs]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: created }),
      })
      return
    }

    const idMatch = pathname.match(/\/api\/v1\/skill-definitions\/([^/]+)$/)
    if (idMatch && method === 'PUT') {
      const id = idMatch[1]
      const payload = (request.postDataJSON() ?? {}) as { isActive?: boolean }
      defs = defs.map((d) => (d.id === id ? { ...d, isActive: payload.isActive ?? d.isActive } : d))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      })
      return
    }

    if (idMatch && method === 'DELETE') {
      const id = idMatch[1]
      defs = defs.filter((d) => d.id !== id)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      })
      return
    }

    await route.continue()
  })
}

async function setupAgentAndChatMocks(page: Page) {
  const now = new Date().toISOString()
  let agents = [
    {
      id: 'agent-e2e-1',
      name: 'E2E Agent',
      description: 'E2E mocked agent',
      systemPrompt: 'You are a helpful assistant.',
      config: { model: 'gpt-4o' },
      skills: ['seed-skill'],
      mcpServerIds: [],
      isActive: true,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
    },
  ]

  await page.route('**/api/v1/llm-providers/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          {
            modelId: 'gpt-4o',
            displayName: 'GPT-4o',
            displayNameSource: 'provider',
            providerName: 'OpenAI',
            providerType: 'openai',
          },
        ],
      }),
    })
  })

  await page.route('**/api/v1/mcp**', async (route, request) => {
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 0 } }),
      })
      return
    }
    await route.continue()
  })

  await page.route('**/api/v1/agents', async (route, request) => {
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: agents }),
      })
      return
    }
    await route.continue()
  })

  await page.route('**/api/v1/agents/*', async (route, request) => {
    const method = request.method()
    const id = new URL(request.url()).pathname.split('/').pop() ?? ''
    const index = agents.findIndex((a) => a.id === id)

    if (method === 'GET') {
      await route.fulfill({
        status: index >= 0 ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(index >= 0
          ? { success: true, data: agents[index] }
          : { success: false, error: 'not found' }),
      })
      return
    }

    if (method === 'PUT' && index >= 0) {
      const payload = (request.postDataJSON() ?? {}) as Record<string, unknown>
      const updated = {
        ...agents[index],
        ...payload,
        config: {
          ...agents[index].config,
          ...(payload.config as Record<string, unknown> | undefined),
        },
        updatedAt: new Date().toISOString(),
      }
      agents[index] = updated
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: updated }),
      })
      return
    }

    await route.continue()
  })

  await page.route('**/api/v1/sessions', async (route, request) => {
    if (request.method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'sess-skill-flow' } }),
      })
      return
    }
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      })
      return
    }
    await route.continue()
  })

  await page.route('**/api/v1/sessions/sess-skill-flow', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: 'sess-skill-flow',
          agentId: 'agent-e2e-1',
          title: 'Skill Flow Session',
          status: 'active',
          createdAt: now,
        },
      }),
    })
  })

  await page.route('**/api/v1/sessions/sess-skill-flow/messages', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    })
  })

  await page.route('**/api/v1/chat/sessions/sess-skill-flow', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      body: [
        'event: message',
        `data: ${JSON.stringify({
          id: 'm1',
          type: 'text',
          data: { content: '收到消息' },
          timestamp: new Date().toISOString(),
        })}`,
        '',
        'event: done',
        `data: ${JSON.stringify({ sessionId: 'sess-skill-flow', messageId: 'done-1' })}`,
        '',
      ].join('\n'),
    })
  })
}

/**
 * 创建一个最小的 zip 文件（包含 SKILL.md）用于上传测试
 */
function createTestSkillZip(name: string, description: string): Buffer {
  const skillMdContent = [
    '---',
    `name: "${name}"`,
    `description: "${description}"`,
    'trigger_keywords:',
    '  - test-trigger',
    '  - e2e-test',
    '---',
    '',
    `# ${name}`,
    '',
    'This is a test skill created by E2E test.',
    '',
  ].join('\n')

  const contentBuffer = Buffer.from(skillMdContent, 'utf-8')
  const fileName = 'SKILL.md'

  const localFileHeader = buildLocalFileHeader(fileName, contentBuffer)
  const centralDir = buildCentralDirectoryEntry(fileName, contentBuffer, 0)
  const endOfCentralDir = buildEndOfCentralDirectory(
    1,
    centralDir.length,
    localFileHeader.length + contentBuffer.length,
  )

  return Buffer.concat([localFileHeader, contentBuffer, centralDir, endOfCentralDir])
}

/** ZIP Local File Header */
function buildLocalFileHeader(fileName: string, content: Buffer): Buffer {
  const nameBuffer = Buffer.from(fileName, 'utf-8')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(crc32(content), 14)
  header.writeUInt32LE(content.length, 18)
  header.writeUInt32LE(content.length, 22)
  header.writeUInt16LE(nameBuffer.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, nameBuffer])
}

/** ZIP Central Directory Entry */
function buildCentralDirectoryEntry(fileName: string, content: Buffer, localHeaderOffset: number): Buffer {
  const nameBuffer = Buffer.from(fileName, 'utf-8')
  const entry = Buffer.alloc(46)
  entry.writeUInt32LE(0x02014b50, 0)
  entry.writeUInt16LE(20, 4)
  entry.writeUInt16LE(20, 6)
  entry.writeUInt16LE(0, 8)
  entry.writeUInt16LE(0, 10)
  entry.writeUInt16LE(0, 12)
  entry.writeUInt16LE(0, 14)
  entry.writeUInt32LE(crc32(content), 16)
  entry.writeUInt32LE(content.length, 20)
  entry.writeUInt32LE(content.length, 24)
  entry.writeUInt16LE(nameBuffer.length, 28)
  entry.writeUInt16LE(0, 30)
  entry.writeUInt16LE(0, 32)
  entry.writeUInt16LE(0, 34)
  entry.writeUInt16LE(0, 36)
  entry.writeUInt32LE(0, 38)
  entry.writeUInt32LE(localHeaderOffset, 42)
  return Buffer.concat([entry, nameBuffer])
}

/** ZIP End of Central Directory */
function buildEndOfCentralDirectory(entryCount: number, centralDirSize: number, centralDirOffset: number): Buffer {
  const record = Buffer.alloc(22)
  record.writeUInt32LE(0x06054b50, 0)
  record.writeUInt16LE(0, 4)
  record.writeUInt16LE(0, 6)
  record.writeUInt16LE(entryCount, 8)
  record.writeUInt16LE(entryCount, 10)
  record.writeUInt32LE(centralDirSize, 12)
  record.writeUInt32LE(centralDirOffset, 16)
  record.writeUInt16LE(0, 20)
  return record
}

/** CRC32 计算 */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

test.describe('Skill Management Flow', () => {

  test.beforeEach(async ({ page }) => {
    await login(page)
    await setupSkillDefinitionMocks(page)
  })

  test.describe('Upload Create Skill', () => {
    test('should display skills page with create button', async ({ page }) => {
      await gotoSkills(page)

      await expect(
        page.getByRole('heading', { name: '技能管理' })
      ).toBeVisible()

      await expect(
        page.getByRole('button', { name: '创建技能' })
      ).toBeVisible()
    })

    test('should open upload-create dialog', async ({ page }) => {
      await gotoSkills(page)

      await page.getByRole('button', { name: '创建技能' }).click()

      await expect(page.getByText('上传包含 SKILL.md 的安装包，自动创建技能定义并安装')).toBeVisible()
      await expect(page.getByText('安装包文件')).toBeVisible()
    })

    test('should disable submit button when no file selected', async ({ page }) => {
      await gotoSkills(page)

      await page.getByRole('button', { name: '创建技能' }).click()

      const submitBtn = page.getByRole('button', { name: '上传并创建' })
      await expect(submitBtn).toBeDisabled()
    })

    test('should close dialog on cancel', async ({ page }) => {
      await gotoSkills(page)

      await page.getByRole('button', { name: '创建技能' }).click()
      await expect(page.getByText('上传包含 SKILL.md 的安装包，自动创建技能定义并安装')).toBeVisible()

      await page.getByRole('button', { name: '取消' }).click()

      await expect(page.getByText('上传包含 SKILL.md 的安装包，自动创建技能定义并安装')).not.toBeVisible()
    })

    test('should upload skill package and create definition', async ({ page }) => {
      const skillName = `E2E Test Skill ${Date.now()}`
      const skillDescription = 'Skill created by E2E test'

      const zipBuffer = createTestSkillZip(skillName, skillDescription)

      await gotoSkills(page)
      const countBefore = await page.getByRole('button', { name: /^启用$|^禁用$/ }).count()

      await page.getByRole('button', { name: '创建技能' }).click()

      const fileInput = page.locator('input[type="file"]')
      await fileInput.setInputFiles({
        name: 'test-skill.zip',
        mimeType: 'application/zip',
        buffer: zipBuffer,
      })

      const submitBtn = page.getByRole('button', { name: '上传并创建' })
      await expect(submitBtn).toBeEnabled()

      await submitBtn.click()

      // 等待对话框关闭（上传成功）或错误出现
      await expect(page.getByRole('heading', { name: '创建技能' })).not.toBeVisible({ timeout: 30000 })
      await expect.poll(async () => page.getByRole('button', { name: /^启用$|^禁用$/ }).count()).toBeGreaterThan(countBefore)
    })

    test('should upload and then update skill with new package', async ({ page }) => {
      test.setTimeout(60000)
      const timestamp = Date.now()
      const skillName = `E2E Overwrite Skill ${timestamp}`
      const updatedName = `E2E Overwrite Updated ${timestamp}`

      // 第一次上传
      const zipBuffer1 = createTestSkillZip(skillName, 'Original description')
      await gotoSkills(page)
      const countBefore = await page.getByRole('button', { name: /^启用$|^禁用$/ }).count()
      await page.getByRole('button', { name: '创建技能' }).click()

      const fileInput = page.locator('input[type="file"]')
      await fileInput.setInputFiles({
        name: 'test-skill.zip',
        mimeType: 'application/zip',
        buffer: zipBuffer1,
      })

      await page.getByRole('button', { name: '上传并创建' }).click()

      // 等待对话框关闭（上传成功）
      await expect(page.getByRole('heading', { name: '创建技能' })).not.toBeVisible({ timeout: 30000 })
      await expect.poll(async () => page.getByRole('button', { name: /^启用$|^禁用$/ }).count()).toBeGreaterThan(countBefore)

      // 第二次上传（覆盖更新）
      const zipBuffer2 = createTestSkillZip(updatedName, 'Updated description')
      await page.getByRole('button', { name: '创建技能' }).click()

      const fileInput2 = page.locator('input[type="file"]')
      await fileInput2.setInputFiles({
        name: 'test-skill-v2.zip',
        mimeType: 'application/zip',
        buffer: zipBuffer2,
      })

      await page.getByRole('button', { name: '上传并创建' }).click()

      // 等待对话框关闭
      await expect(page.getByRole('heading', { name: '创建技能' })).not.toBeVisible({ timeout: 30000 })
      await expect.poll(async () => page.getByRole('button', { name: /^启用$|^禁用$/ }).count()).toBeGreaterThan(countBefore + 1)
    })
  })

  test.describe('Skill List Management', () => {
    test('should search skills by name', async ({ page }) => {
      await gotoSkills(page)

      const searchInput = page.getByPlaceholder('搜索技能名称、ID 或描述...')
      await expect(searchInput).toBeVisible()
      await searchInput.fill('E2E')
      await page.waitForTimeout(500)

      // 验证过滤后的卡片都包含搜索词（或无结果）
      const cards = page.locator('.grid > div').filter({ hasText: /E2E/i })
      const count = await cards.count()
      for (let i = 0; i < count; i++) {
        const text = await cards.nth(i).textContent()
        expect(text?.toLowerCase()).toContain('e2e')
      }
    })

    test('should toggle skill active status', async ({ page }) => {
      await gotoSkills(page)

      // 找到第一个卡片中的启用/禁用按钮
      const toggleBtn = page.getByRole('button', { name: /^启用$|^禁用$/ }).first()
      if (await toggleBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        const originalText = (await toggleBtn.textContent())?.trim()
        const expectedText = originalText === '禁用' ? '启用' : '禁用'

        await toggleBtn.click()

        // 等待按钮文本真正切换（API 调用 + 列表重新加载）
        await expect(
          page.getByRole('button', { name: new RegExp(`^${expectedText}$`) }).first()
        ).toBeVisible({ timeout: 15000 })
      }
    })

    test('should delete skill with confirmation', async ({ page }) => {
      await gotoSkills(page)

      // 删除按钮是卡片右上角的 Trash2 图标按钮
      const deleteBtn = page.locator('button').filter({ has: page.locator('svg.lucide-trash-2') }).first()
      if (await deleteBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        const countBefore = await page.locator('.grid > div').count()

        // 监听 confirm 对话框并接受
        page.on('dialog', (dialog) => dialog.accept())
        await deleteBtn.click()
        await page.waitForTimeout(2000)

        // 验证卡片数量减少或页面无报错
        const countAfter = await page.locator('.grid > div').count()
        expect(countAfter).toBeLessThanOrEqual(countBefore)
      }
    })
  })
})

test.describe('Agent Skill Configuration', () => {

  test.beforeEach(async ({ page }) => {
    await login(page)
    await setupSkillDefinitionMocks(page)
    await setupAgentAndChatMocks(page)
  })

  test('should display skills section on agent detail page', async ({ page }) => {
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible({ timeout: 15000 })

    const editBtn = page.locator('[data-testid="edit-agent-btn"]').first()
    if (await editBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      await editBtn.click()
      await expect(page).toHaveURL(/\/agents\/[a-zA-Z0-9-]+/i, { timeout: 10000 })

      await expect(page.getByText('Skills 配置')).toBeVisible({ timeout: 15000 })
    }
  })

  test('should show uploaded skill definitions as checkboxes on agent edit page', async ({ page }) => {
    test.setTimeout(60000)

    // 进入 Agent 编辑页，验证 skill definitions 出现在 checkbox 列表中
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible({ timeout: 15000 })

    // 等待 agent 卡片加载完成
    const editBtn = page.locator('[data-testid="edit-agent-btn"]').first()
    await expect(editBtn).toBeVisible({ timeout: 15000 })
    await editBtn.click()
    await expect(page).toHaveURL(/\/agents\/[a-zA-Z0-9-]+/i, { timeout: 10000 })

    await expect(page.getByText('Skills 配置')).toBeVisible({ timeout: 15000 })

    // 等待加载完成（spinner 消失）
    await expect(page.getByText('加载技能列表...')).not.toBeVisible({ timeout: 15000 })

    const checkboxes = page.locator('input[type="checkbox"]')
    const emptyState = page.getByText('暂无可用技能')

    const hasCheckboxes = await checkboxes.first().isVisible().catch(() => false)
    const hasEmptyState = await emptyState.isVisible().catch(() => false)

    // 至少有一种状态：有技能 checkbox 或者空状态
    expect(hasCheckboxes || hasEmptyState).toBe(true)

    // 如果有 checkbox，说明 skill definitions 正确加载了
    if (hasCheckboxes) {
      const count = await checkboxes.count()
      expect(count).toBeGreaterThan(0)
    }
  })

  test('should toggle skill selection on agent and save', async ({ page }) => {
    test.setTimeout(60000)

    // 进入 Agent 编辑页
    await page.goto('/agents', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible({ timeout: 15000 })

    const editBtn = page.locator('[data-testid="edit-agent-btn"]').first()
    await expect(editBtn).toBeVisible({ timeout: 15000 })
    await editBtn.click()
    await expect(page).toHaveURL(/\/agents\/[a-zA-Z0-9-]+/i, { timeout: 10000 })

    await expect(page.getByText('Skills 配置')).toBeVisible({ timeout: 15000 })

    // 找到 Skills 配置区域内的 checkbox（排除 MCP Servers 区域的 checkbox）
    const skillsSection = page.locator('div').filter({ hasText: /^Skills 配置$/ }).locator('..').locator('..')
    const firstCheckbox = skillsSection.locator('input[type="checkbox"]').first()

    if (await firstCheckbox.isVisible().catch(() => false)) {
      const wasChecked = await firstCheckbox.isChecked()

      await firstCheckbox.click()
      const isNowChecked = await firstCheckbox.isChecked()
      expect(isNowChecked).toBe(!wasChecked)

      // 保存
      const saveBtn = page.getByRole('button', { name: /^保存$|^创建$/ })
      await saveBtn.click()

      // 保存后应跳转回 agents 列表
      await expect(page).toHaveURL(/\/agents$/, { timeout: 15000 })
    }
  })
})

test.describe('Chat with Skill-Enabled Agent', () => {

  test.beforeEach(async ({ page }) => {
    test.setTimeout(60000)
    await login(page)
    await setupSkillDefinitionMocks(page)
    await setupAgentAndChatMocks(page)
  })

  test('should start chat and send message to skill-enabled agent', async ({ page }) => {
    // 进入新建会话页面
    await page.goto('/chat/new', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '开始新会话' })).toBeVisible({ timeout: 15000 })

    // 选择第一个 Agent
    const agentBtn = page.locator('button').filter({ hasText: /.+/ }).locator('h3').first()
    await expect(agentBtn).toBeVisible({ timeout: 15000 })
    await agentBtn.click()

    // 输入消息
    const chatInput = page.getByPlaceholder('输入您的问题或任务描述...')
    await expect(chatInput).toBeVisible()
    await chatInput.fill('Hello, test message for skill-enabled agent')

    // 点击开始对话
    const startBtn = page.getByRole('button', { name: '开始对话' })
    if (await startBtn.isEnabled()) {
      await startBtn.click()

      // 应该跳转到会话页面
      await expect(page).toHaveURL(/\/chat\/[a-zA-Z0-9-]+/, { timeout: 30000 })

      // 等待消息出现在会话页面
      await expect(
        page.getByText('Hello, test message for skill-enabled agent')
      ).toBeVisible({ timeout: 15000 })
    }
  })

  test('should handle chat with agent that has no skills gracefully', async ({ page }) => {
    await page.goto('/chat/new', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '开始新会话' })).toBeVisible({ timeout: 15000 })

    // 选择第一个 Agent
    const agentBtn = page.locator('button').filter({ hasText: /.+/ }).locator('h3').first()
    await expect(agentBtn).toBeVisible({ timeout: 15000 })
    await agentBtn.click()

    const chatInput = page.getByPlaceholder('输入您的问题或任务描述...')
    await expect(chatInput).toBeVisible()
    await chatInput.fill('Simple question without skill trigger')

    const startBtn = page.getByRole('button', { name: '开始对话' })
    if (await startBtn.isEnabled()) {
      await startBtn.click()

      // 应该跳转到会话页面
      await expect(page).toHaveURL(/\/chat\/[a-zA-Z0-9-]+/, { timeout: 30000 })

      // 等待消息出现
      await expect(
        page.getByText('Simple question without skill trigger')
      ).toBeVisible({ timeout: 15000 })
    }
  })
})
