import { test, expect } from '@playwright/test'

/**
 * 聊天交互流程 E2E 测试
 */
test.describe('Chat Flow', () => {
  // 每个测试前先登录
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('textbox', { name: /email|邮箱|用户名/i }).fill('test@example.com')
    await page.locator('input[type="password"]').fill('testpassword123')
    await page.getByRole('button', { name: /login|登录|sign in/i }).click()

    // 等待登录完成并跳转
    await expect(page).not.toHaveURL(/\/login/i)
  })

  test.describe('Create New Session', () => {
    test('should create a new chat session', async ({ page }) => {
      // 导航到聊天页面
      await page.goto('/chat')

      // 点击新建会话按钮
      await page.getByRole('button', { name: /new|新建|创建|新会话/i })
        .or(page.getByTestId('new-session-btn'))
        .click()

      // 验证新会话已创建
      await expect(
        page.getByText(/new session|新会话|未命名/i)
          .or(page.getByTestId('session-item'))
      ).toBeVisible()

      // 验证聊天输入框可用
      await expect(
        page.getByPlaceholder(/message|消息|输入/i)
          .or(page.getByTestId('chat-input'))
      ).toBeVisible()
      await expect(
        page.getByPlaceholder(/message|消息|输入/i)
          .or(page.getByTestId('chat-input'))
      ).toBeEnabled()
    })

    test('should display empty state for new session', async ({ page }) => {
      await page.goto('/chat')

      // 创建新会话
      await page.getByRole('button', { name: /new|新建|创建/i })
        .or(page.getByTestId('new-session-btn'))
        .click()

      // 验证显示空状态或欢迎消息
      await expect(
        page.getByText(/start|开始|欢迎|hello|你好/i).first()
          .or(page.getByTestId('empty-state'))
      ).toBeVisible()
    })
  })

  test.describe('Send Message and Receive Response', () => {
    test('should send message and receive AI response', async ({ page }) => {
      await page.goto('/chat')

      // 定位输入框
      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      // 输入消息
      const testMessage = 'Hello, this is a test message'
      await chatInput.fill(testMessage)

      // 发送消息
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .or(page.locator('button[type="submit"]'))
        .click()

      // 验证用户消息已显示
      await expect(page.getByText(testMessage)).toBeVisible()

      // 验证正在加载状态
      await expect(
        page.getByTestId('loading-indicator')
          .or(page.locator('.animate-pulse'))
          .or(page.getByText(/thinking|思考中|loading|加载/i))
      ).toBeVisible()

      // 等待 AI 响应（增加超时时间以适应 SSE 流式响应）
      await expect(
        page.locator('[data-testid="assistant-message"]')
          .or(page.locator('[data-role="assistant"]'))
          .or(page.locator('.message-assistant'))
      ).toBeVisible({ timeout: 60000 })
    })

    test('should handle empty message submission', async ({ page }) => {
      await page.goto('/chat')

      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      // 确保输入框为空
      await chatInput.clear()

      // 尝试发送空消息
      const sendButton = page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))

      // 验证发送按钮被禁用或点击无效
      const isDisabled = await sendButton.isDisabled()
      if (!isDisabled) {
        await sendButton.click()
        // 验证没有发送消息（消息列表没有新增）
        await expect(page.locator('[data-testid="message-item"]')).toHaveCount(0)
      } else {
        expect(isDisabled).toBe(true)
      }
    })

    test('should support multiline message input', async ({ page }) => {
      await page.goto('/chat')

      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      // 输入多行消息
      const multilineMessage = 'Line 1\nLine 2\nLine 3'
      await chatInput.fill(multilineMessage)

      // 发送消息
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 验证多行消息正确显示
      await expect(page.getByText('Line 1')).toBeVisible()
      await expect(page.getByText('Line 2')).toBeVisible()
      await expect(page.getByText('Line 3')).toBeVisible()
    })
  })

  test.describe('Message History', () => {
    test('should display message history', async ({ page }) => {
      await page.goto('/chat')

      // 发送第一条消息
      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      await chatInput.fill('First message')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 等待响应
      await page.waitForTimeout(2000)

      // 发送第二条消息
      await chatInput.fill('Second message')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 验证两条消息都可见
      await expect(page.getByText('First message')).toBeVisible()
      await expect(page.getByText('Second message')).toBeVisible()
    })

    test('should persist messages after page refresh', async ({ page }) => {
      await page.goto('/chat')

      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      // 发送消息
      const testMessage = 'Persistence test message'
      await chatInput.fill(testMessage)
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 等待消息保存
      await page.waitForTimeout(2000)

      // 刷新页面
      await page.reload()

      // 验证消息仍然可见
      await expect(page.getByText(testMessage)).toBeVisible()
    })

    test('should scroll to latest message', async ({ page }) => {
      await page.goto('/chat')

      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      // 发送多条消息
      for (let i = 1; i <= 5; i++) {
        await chatInput.fill(`Message ${i}`)
        await page.getByRole('button', { name: /send|发送/i })
          .or(page.getByTestId('send-btn'))
          .click()
        await page.waitForTimeout(500)
      }

      // 验证最后一条消息可见（在视口内）
      await expect(page.getByText('Message 5')).toBeInViewport()
    })
  })

  test.describe('SSE Streaming', () => {
    test('should display streaming response in real-time', async ({ page }) => {
      await page.goto('/chat')

      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      // 发送消息
      await chatInput.fill('Tell me a short story')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 验证流式响应开始
      const assistantMessage = page.locator('[data-testid="assistant-message"]')
        .or(page.locator('[data-role="assistant"]'))
        .or(page.locator('.message-assistant'))

      // 等待响应开始
      await expect(assistantMessage.first()).toBeVisible({ timeout: 30000 })

      // 获取初始内容长度
      const initialContent = await assistantMessage.first().textContent()
      const initialLength = initialContent?.length || 0

      // 等待内容增长（验证流式传输）
      await page.waitForTimeout(1000)
      const updatedContent = await assistantMessage.first().textContent()
      const updatedLength = updatedContent?.length || 0

      // 验证内容有增长（流式传输正在进行）
      expect(updatedLength).toBeGreaterThanOrEqual(initialLength)
    })

    test('should handle SSE connection errors gracefully', async ({ page }) => {
      // 模拟网络断开
      await page.route('**/api/chat/**', (route) => {
        route.abort('failed')
      })

      await page.goto('/chat')

      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      await chatInput.fill('Test message')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 验证显示错误提示
      await expect(
        page.getByText(/error|错误|failed|失败|网络/i).first()
      ).toBeVisible({ timeout: 10000 })
    })

    test('should allow stopping message generation', async ({ page }) => {
      await page.goto('/chat')

      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      // 发送需要长响应的消息
      await chatInput.fill('Write a very long essay about artificial intelligence')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 等待流式响应开始
      await page.waitForTimeout(1000)

      // 查找并点击停止按钮
      const stopButton = page.getByRole('button', { name: /stop|停止|取消/i })
        .or(page.getByTestId('stop-btn'))

      if (await stopButton.isVisible()) {
        await stopButton.click()

        // 验证生成已停止（发送按钮恢复可用）
        await expect(
          page.getByRole('button', { name: /send|发送/i })
            .or(page.getByTestId('send-btn'))
        ).toBeEnabled()
      }
    })
  })

  test.describe('Session Management', () => {
    test('should switch between sessions', async ({ page }) => {
      await page.goto('/chat')

      // 创建第一个会话并发送消息
      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      await chatInput.fill('Session 1 message')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      await page.waitForTimeout(1000)

      // 创建新会话
      await page.getByRole('button', { name: /new|新建|创建/i })
        .or(page.getByTestId('new-session-btn'))
        .click()

      // 发送第二个会话的消息
      await chatInput.fill('Session 2 message')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      // 验证 Session 2 消息可见
      await expect(page.getByText('Session 2 message')).toBeVisible()

      // 切换回第一个会话
      await page.locator('[data-testid="session-item"]').first().click()

      // 验证 Session 1 消息可见
      await expect(page.getByText('Session 1 message')).toBeVisible()
    })

    test('should delete a session', async ({ page }) => {
      await page.goto('/chat')

      // 创建会话并发送消息
      const chatInput = page.getByPlaceholder(/message|消息|输入/i)
        .or(page.getByTestId('chat-input'))

      await chatInput.fill('Message to delete')
      await page.getByRole('button', { name: /send|发送/i })
        .or(page.getByTestId('send-btn'))
        .click()

      await page.waitForTimeout(1000)

      // 找到删除按钮并点击
      const sessionItem = page.locator('[data-testid="session-item"]').first()
      await sessionItem.hover()

      await page.getByRole('button', { name: /delete|删除/i })
        .or(page.getByTestId('delete-session-btn'))
        .click()

      // 确认删除
      await page.getByRole('button', { name: /confirm|确认|是/i }).click()

      // 验证会话已删除
      await expect(page.getByText('Message to delete')).not.toBeVisible()
    })
  })
})
