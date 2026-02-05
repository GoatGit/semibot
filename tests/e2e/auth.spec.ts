import { test, expect } from '@playwright/test'

/**
 * 认证流程 E2E 测试
 */
test.describe('Authentication Flow', () => {
  test.describe('Login Page', () => {
    test('should render login page correctly', async ({ page }) => {
      await page.goto('/login')

      // 验证页面标题
      await expect(page).toHaveTitle(/Semibot|登录|Login/i)

      // 验证登录表单元素存在
      await expect(page.getByRole('textbox', { name: /email|邮箱|用户名/i })).toBeVisible()
      await expect(page.getByRole('textbox', { name: /password|密码/i }).or(page.locator('input[type="password"]'))).toBeVisible()
      await expect(page.getByRole('button', { name: /login|登录|sign in/i })).toBeVisible()
    })

    test('should show validation errors for empty fields', async ({ page }) => {
      await page.goto('/login')

      // 直接点击登录按钮
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 验证显示错误提示
      await expect(page.getByText(/required|必填|不能为空/i).first()).toBeVisible()
    })
  })

  test.describe('Login with Credentials', () => {
    test('should login successfully with valid credentials', async ({ page }) => {
      await page.goto('/login')

      // 填写有效的登录凭据
      await page.getByRole('textbox', { name: /email|邮箱|用户名/i }).fill('test@example.com')
      await page.locator('input[type="password"]').fill('testpassword123')

      // 点击登录按钮
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 验证成功登录后跳转到首页或仪表盘
      await expect(page).toHaveURL(/\/(dashboard|home|chat)?$/i)

      // 验证用户已登录的标识（如用户头像、欢迎信息等）
      await expect(
        page.getByRole('button', { name: /logout|退出|用户/i })
          .or(page.getByTestId('user-avatar'))
          .or(page.locator('[data-testid="user-menu"]'))
      ).toBeVisible()
    })

    test('should show error message with invalid credentials', async ({ page }) => {
      await page.goto('/login')

      // 填写无效的登录凭据
      await page.getByRole('textbox', { name: /email|邮箱|用户名/i }).fill('invalid@example.com')
      await page.locator('input[type="password"]').fill('wrongpassword')

      // 点击登录按钮
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 验证显示错误消息
      await expect(
        page.getByText(/invalid|错误|失败|incorrect|unauthorized/i).first()
      ).toBeVisible()

      // 验证仍在登录页面
      await expect(page).toHaveURL(/\/login/i)
    })

    test('should show error for invalid email format', async ({ page }) => {
      await page.goto('/login')

      // 填写格式错误的邮箱
      await page.getByRole('textbox', { name: /email|邮箱|用户名/i }).fill('invalid-email')
      await page.locator('input[type="password"]').fill('somepassword')

      // 点击登录按钮
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 验证显示邮箱格式错误
      await expect(
        page.getByText(/invalid email|邮箱格式|valid email/i).first()
      ).toBeVisible()
    })
  })

  test.describe('Logout Flow', () => {
    test.beforeEach(async ({ page }) => {
      // 先登录
      await page.goto('/login')
      await page.getByRole('textbox', { name: /email|邮箱|用户名/i }).fill('test@example.com')
      await page.locator('input[type="password"]').fill('testpassword123')
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 等待登录完成
      await expect(page).not.toHaveURL(/\/login/i)
    })

    test('should logout successfully', async ({ page }) => {
      // 点击用户菜单或退出按钮
      const userMenu = page.getByRole('button', { name: /用户|user|profile/i })
        .or(page.getByTestId('user-menu'))
        .or(page.locator('[data-testid="user-avatar"]'))

      if (await userMenu.isVisible()) {
        await userMenu.click()
      }

      // 点击退出按钮
      await page.getByRole('button', { name: /logout|退出|sign out/i })
        .or(page.getByRole('menuitem', { name: /logout|退出|sign out/i }))
        .click()

      // 验证跳转到登录页面
      await expect(page).toHaveURL(/\/(login)?$/i)

      // 验证登录表单可见
      await expect(page.getByRole('button', { name: /login|登录|sign in/i })).toBeVisible()
    })

    test('should clear session after logout', async ({ page }) => {
      // 执行退出操作
      const userMenu = page.getByRole('button', { name: /用户|user|profile/i })
        .or(page.getByTestId('user-menu'))

      if (await userMenu.isVisible()) {
        await userMenu.click()
      }

      await page.getByRole('button', { name: /logout|退出|sign out/i })
        .or(page.getByRole('menuitem', { name: /logout|退出|sign out/i }))
        .click()

      // 尝试访问受保护的页面
      await page.goto('/dashboard')

      // 验证被重定向到登录页面
      await expect(page).toHaveURL(/\/login/i)
    })
  })

  test.describe('Session Persistence', () => {
    test('should maintain session after page refresh', async ({ page }) => {
      // 登录
      await page.goto('/login')
      await page.getByRole('textbox', { name: /email|邮箱|用户名/i }).fill('test@example.com')
      await page.locator('input[type="password"]').fill('testpassword123')
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 等待登录完成
      await expect(page).not.toHaveURL(/\/login/i)

      // 刷新页面
      await page.reload()

      // 验证仍然处于登录状态
      await expect(page).not.toHaveURL(/\/login/i)
    })

    test('should redirect to login when accessing protected route without auth', async ({ page }) => {
      // 直接访问受保护的路由
      await page.goto('/dashboard')

      // 验证被重定向到登录页面
      await expect(page).toHaveURL(/\/login/i)
    })
  })
})
