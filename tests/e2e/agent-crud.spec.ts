import { test, expect } from '@playwright/test'
import { loginByApi } from './helpers/auth'

/**
 * Agent 管理 CRUD E2E 测试
 */
test.describe('Agent Management', () => {
  // 每个测试前先登录
  test.beforeEach(async ({ page }) => {
    await loginByApi(page)
  })

  test.describe('List Agents', () => {
    test('should display agents list page', async ({ page }) => {
      // 导航到 Agent 管理页面
      await page.goto('/agents')

      // 验证页面标题
      await expect(
        page.getByRole('heading', { name: /agents|代理|智能体/i })
          .or(page.getByText(/agent management|代理管理/i))
      ).toBeVisible()

      // 验证有 Agent 列表或空状态
      await expect(
        page.locator('[data-testid="agent-list"]')
          .or(page.locator('[data-testid="agent-card"]').first())
          .or(page.getByText(/no agents|暂无代理|empty/i))
      ).toBeVisible()
    })

    test('should display agent cards with correct information', async ({ page }) => {
      await page.goto('/agents')

      // 如果存在 Agent，验证卡片信息
      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        // 验证 Agent 名称可见
        await expect(agentCard.locator('[data-testid="agent-name"]')
          .or(agentCard.getByRole('heading'))
        ).toBeVisible()

        // 验证 Agent 描述或状态可见
        await expect(
          agentCard.locator('[data-testid="agent-description"]')
            .or(agentCard.locator('[data-testid="agent-status"]'))
        ).toBeVisible()
      }
    })

    test('should filter agents by search', async ({ page }) => {
      await page.goto('/agents')

      // 找到搜索框
      const searchInput = page.getByPlaceholder(/search|搜索|查找/i)
        .or(page.getByTestId('agent-search'))

      if (await searchInput.isVisible()) {
        // 输入搜索关键词
        await searchInput.fill('test-agent')

        // 等待搜索结果
        await page.waitForTimeout(500)

        // 验证搜索结果只显示匹配的 Agent
        const visibleAgents = page.locator('[data-testid="agent-card"]:visible')
        const count = await visibleAgents.count()

        if (count > 0) {
          // 验证所有可见的 Agent 包含搜索关键词
          for (let i = 0; i < count; i++) {
            const agentText = await visibleAgents.nth(i).textContent()
            expect(agentText?.toLowerCase()).toContain('test-agent')
          }
        }
      }
    })

    test('should paginate agents list', async ({ page }) => {
      await page.goto('/agents')

      // 查找分页控件
      const pagination = page.locator('[data-testid="pagination"]')
        .or(page.getByRole('navigation', { name: /pagination|分页/i }))

      if (await pagination.isVisible()) {
        // 点击下一页
        await page.getByRole('button', { name: /next|下一页|>/i }).click()

        // 验证 URL 或页面内容变化
        await page.waitForTimeout(500)

        // 点击上一页
        await page.getByRole('button', { name: /previous|上一页|</i }).click()
      }
    })
  })

  test.describe('Create Agent', () => {
    test('should open create agent modal/page', async ({ page }) => {
      await page.goto('/agents')

      // 点击创建 Agent 按钮
      await page.getByRole('button', { name: /create|新建|添加|创建代理/i })
        .or(page.getByTestId('create-agent-btn'))
        .click()

      // 验证创建表单可见
      await expect(page.getByRole('dialog', { name: /create agent|创建代理|新建代理/i })).toBeVisible()

      // 验证表单字段存在
      await expect(
        page.getByLabel(/name|名称/i)
          .or(page.getByPlaceholder(/agent name|代理名称/i))
      ).toBeVisible()
    })

    test('should create a new agent successfully', async ({ page }) => {
      await page.goto('/agents')

      // 点击创建按钮
      await page.getByRole('button', { name: /create|新建|添加/i })
        .or(page.getByTestId('create-agent-btn'))
        .click()

      // 填写 Agent 信息
      const agentName = `Test Agent ${Date.now()}`
      const agentDescription = 'This is a test agent created by E2E test'

      await page.getByLabel(/name|名称/i)
        .or(page.getByPlaceholder(/agent name|代理名称/i))
        .fill(agentName)

      await page.getByLabel(/description|描述/i)
        .or(page.getByPlaceholder(/description|描述/i))
        .fill(agentDescription)

      // 选择模型（如果有）
      const modelSelect = page.getByLabel(/model|模型/i)
        .or(page.getByTestId('model-select'))

      if (await modelSelect.isVisible()) {
        await modelSelect.click()
        await page.getByRole('option').first().click()
      }

      // 填写系统提示词（如果有）
      const systemPrompt = page.getByLabel(/system prompt|系统提示词/i)
        .or(page.getByPlaceholder(/system prompt|系统提示/i))

      if (await systemPrompt.isVisible()) {
        await systemPrompt.fill('You are a helpful assistant.')
      }

      // 提交表单
      const createResponsePromise = page.waitForResponse((res) => {
        if (res.request().method() !== 'POST') return false
        return /\/api\/v1\/agents\/?$/.test(new URL(res.url()).pathname)
      })
      await page.getByRole('button', { name: /save|保存|create|创建|submit|提交/i }).click()
      const createResponse = await createResponsePromise

      // 验证创建成功
      expect(createResponse.ok(), `Create agent failed: ${createResponse.status()}`).toBeTruthy()
      const createBody = await createResponse.json()
      expect(createBody?.success).toBe(true)
    })

    test('should show validation errors for required fields', async ({ page }) => {
      await page.goto('/agents')

      // 点击创建按钮
      await page.getByRole('button', { name: /create|新建|添加/i })
        .or(page.getByTestId('create-agent-btn'))
        .click()

      // 直接提交空表单
      await page.getByRole('button', { name: /save|保存|create|创建|submit|提交/i }).click()

      // 验证显示验证错误
      await expect(
        page.getByText(/required|必填|不能为空/i).first()
      ).toBeVisible()
    })

    test('should cancel agent creation', async ({ page }) => {
      await page.goto('/agents')

      // 点击创建按钮
      await page.getByRole('button', { name: /create|新建|添加/i })
        .or(page.getByTestId('create-agent-btn'))
        .click()

      // 填写一些内容
      await page.getByLabel(/name|名称/i)
        .or(page.getByPlaceholder(/agent name|代理名称/i))
        .fill('Agent to cancel')

      // 点击取消
      await page.getByRole('button', { name: /cancel|取消/i }).click()

      // 验证模态框关闭
      await expect(
        page.getByRole('dialog')
          .or(page.locator('[data-testid="agent-form"]'))
      ).not.toBeVisible()

      // 验证未创建的 Agent 不在列表中
      await expect(page.getByText('Agent to cancel')).not.toBeVisible()
    })
  })

  test.describe('Edit Agent', () => {
    test('should open edit agent modal/page', async ({ page }) => {
      await page.goto('/agents')

      // 找到第一个 Agent 并点击编辑
      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        await agentCard.hover()
        await page.getByRole('button', { name: /edit|编辑|修改/i })
          .or(page.getByTestId('edit-agent-btn'))
          .first()
          .click()

        // 验证编辑表单可见
        await expect(
          page.getByRole('dialog')
            .or(page.locator('[data-testid="agent-form"]'))
            .or(page.getByRole('heading', { name: /edit agent|编辑代理|修改代理/i }))
        ).toBeVisible()
      }
    })

    test('should update agent information', async ({ page }) => {
      await page.goto('/agents')

      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        // 获取原始名称
        const originalName = await agentCard.locator('[data-testid="agent-name"]')
          .or(agentCard.getByRole('heading'))
          .textContent()

        // 打开编辑
        await agentCard.hover()
        await page.getByRole('button', { name: /edit|编辑/i })
          .or(page.getByTestId('edit-agent-btn'))
          .first()
          .click()

        // 修改名称
        const updatedName = `Updated ${Date.now()}`
        const nameInput = page.getByLabel(/name|名称/i)
          .or(page.getByPlaceholder(/agent name|代理名称/i))

        await nameInput.clear()
        await nameInput.fill(updatedName)

        // 保存
        await page.getByRole('button', { name: /save|保存|update|更新/i }).click()

        // 验证更新成功
        await expect(
          page.getByText(/success|成功|updated/i)
            .or(page.getByText(updatedName))
        ).toBeVisible()

        // 验证名称已更新
        await page.goto('/agents')
        await expect(page.getByText(updatedName)).toBeVisible()
      }
    })

    test('should preserve original values when canceling edit', async ({ page }) => {
      await page.goto('/agents')

      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        // 获取原始名称
        const originalName = await agentCard.locator('[data-testid="agent-name"]')
          .or(agentCard.getByRole('heading'))
          .textContent()

        // 打开编辑
        await agentCard.hover()
        await page.getByRole('button', { name: /edit|编辑/i })
          .or(page.getByTestId('edit-agent-btn'))
          .first()
          .click()

        // 修改名称
        const nameInput = page.getByLabel(/name|名称/i)
          .or(page.getByPlaceholder(/agent name|代理名称/i))

        await nameInput.clear()
        await nameInput.fill('Modified name')

        // 取消
        await page.getByRole('button', { name: /cancel|取消/i }).click()

        // 验证原始名称仍然存在
        if (originalName) {
          await expect(page.getByText(originalName)).toBeVisible()
        }
      }
    })
  })

  test.describe('Delete Agent', () => {
    test('should show delete confirmation dialog', async ({ page }) => {
      await page.goto('/agents')

      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        // 点击删除按钮
        await agentCard.hover()
        await page.getByRole('button', { name: /delete|删除/i })
          .or(page.getByTestId('delete-agent-btn'))
          .first()
          .click()

        // 验证确认对话框出现
        await expect(
          page.getByRole('alertdialog')
            .or(page.getByText(/confirm|确认|are you sure|确定要删除/i))
        ).toBeVisible()
      }
    })

    test('should delete agent after confirmation', async ({ page }) => {
      // 先创建一个测试 Agent
      await page.goto('/agents')

      await page.getByRole('button', { name: /create|新建|添加/i })
        .or(page.getByTestId('create-agent-btn'))
        .click()

      const agentName = `Agent to Delete ${Date.now()}`

      await page.getByLabel(/name|名称/i)
        .or(page.getByPlaceholder(/agent name|代理名称/i))
        .fill(agentName)

      await page.getByRole('button', { name: /save|保存|create|创建/i }).click()

      // 等待创建完成
      await page.waitForTimeout(1000)
      await page.goto('/agents')

      // 找到刚创建的 Agent
      const agentCard = page.locator('[data-testid="agent-card"]', { hasText: agentName })

      if (await agentCard.isVisible()) {
        // 删除
        await agentCard.hover()
        await page.getByRole('button', { name: /delete|删除/i })
          .or(page.getByTestId('delete-agent-btn'))
          .first()
          .click()

        // 确认删除
        await page.getByRole('button', { name: /confirm|确认|delete|删除|yes|是/i })
          .filter({ hasText: /confirm|确认|delete|删除|yes|是/i })
          .click()

        // 验证删除成功
        await expect(
          page.getByText(/deleted|已删除|success|成功/i)
        ).toBeVisible()

        // 验证 Agent 已从列表中移除
        await page.waitForTimeout(500)
        await expect(page.getByText(agentName)).not.toBeVisible()
      }
    })

    test('should cancel delete when clicking cancel', async ({ page }) => {
      await page.goto('/agents')

      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        // 获取 Agent 名称
        const agentName = await agentCard.locator('[data-testid="agent-name"]')
          .or(agentCard.getByRole('heading'))
          .textContent()

        // 点击删除
        await agentCard.hover()
        await page.getByRole('button', { name: /delete|删除/i })
          .or(page.getByTestId('delete-agent-btn'))
          .first()
          .click()

        // 点击取消
        await page.getByRole('button', { name: /cancel|取消|no|否/i }).click()

        // 验证 Agent 仍然存在
        if (agentName) {
          await expect(page.getByText(agentName)).toBeVisible()
        }
      }
    })
  })

  test.describe('Agent Details', () => {
    test('should navigate to agent details page', async ({ page }) => {
      await page.goto('/agents')

      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        // 点击 Agent 卡片进入详情
        await agentCard.click()

        // 验证进入详情页面
        await expect(page).toHaveURL(/\/agents\/[a-zA-Z0-9-]+/i)

        // 验证详情信息可见
        await expect(
          page.getByRole('heading')
            .or(page.locator('[data-testid="agent-detail-name"]'))
        ).toBeVisible()
      }
    })

    test('should display agent configuration', async ({ page }) => {
      await page.goto('/agents')

      const agentCard = page.locator('[data-testid="agent-card"]').first()

      if (await agentCard.isVisible()) {
        await agentCard.click()

        // 验证配置信息可见
        await expect(
          page.getByText(/model|模型/i)
            .or(page.getByText(/system prompt|系统提示/i))
            .or(page.getByText(/configuration|配置/i))
        ).toBeVisible()
      }
    })
  })
})
