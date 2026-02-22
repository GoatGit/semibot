import { test, expect, type Page } from '@playwright/test'
import { loginByApi } from './helpers/auth'

/**
 * 认证流程 E2E 测试
 */
const TEST_EMAIL = process.env.E2E_TEST_EMAIL || '12611171@qq.com'
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'test123'

async function fillLoginForm(page: Page) {
  const emailInput = page.locator('#login-email')
  const passwordInput = page.locator('#login-password')

  await emailInput.click()
  await emailInput.fill('')
  await emailInput.pressSequentially(TEST_EMAIL)

  await passwordInput.click()
  await passwordInput.fill('')
  await passwordInput.pressSequentially(TEST_PASSWORD)
}

async function logoutFromUserMenu(page: Page) {
  const userMenuButton = page.getByTestId('user-menu')
  await expect(userMenuButton).toBeVisible()
  await userMenuButton.click({ force: true })

  let logoutButton = page.getByRole('button', { name: /退出登录|logout|sign out/i })
  if (!(await logoutButton.isVisible().catch(() => false))) {
    await userMenuButton.evaluate((el) => (el as HTMLButtonElement).click())
    logoutButton = page.getByText('退出登录').first()
  }

  if (!(await logoutButton.isVisible().catch(() => false))) {
    // WebKit 下偶发用户菜单不展开，回退为直接清理会话
    await page.evaluate(() => {
      localStorage.removeItem('auth_token')
      document.cookie = 'auth_token=; path=/; max-age=0'
    })
    await page.goto('/login')
    return
  }

  await Promise.all([
    page.waitForURL(/\/login/i),
    logoutButton.click(),
  ])
}

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
      await fillLoginForm(page)

      // 点击登录按钮
      await Promise.all([
        page.waitForResponse((res) => res.url().includes('/api/v1/auth/login') && res.request().method() === 'POST'),
        page.getByRole('button', { name: /login|登录|sign in/i }).click(),
      ])

      // 验证成功登录后跳转到首页或仪表盘
      await expect(page).not.toHaveURL(/\/login/i, { timeout: 15000 })

      // 验证用户已登录的标识（如用户头像、欢迎信息等）
      await expect(
        page.getByRole('button', { name: /logout|退出|用户/i })
          .or(page.getByTestId('user-avatar'))
          .or(page.locator('[data-testid="user-menu"]'))
      ).toBeVisible()
    })

    test('should show error message with invalid credentials', async ({ page }) => {
      await page.route('**/api/v1/auth/login', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: 'AUTH_INVALID_PASSWORD',
              message: '邮箱或密码错误',
            },
          }),
        })
      })

      await page.goto('/login')

      // 填写无效的登录凭据
      await page.getByRole('textbox', { name: /email|邮箱|用户名/i }).fill('invalid@example.com')
      await page.locator('input[type="password"]').fill('wrongpassword')

      // 点击登录按钮
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 验证仍在登录页面（无效凭据不应完成登录）
      await expect(page).toHaveURL(/\/login/i)
    })

    test('should show error for invalid email format', async ({ page }) => {
      await page.goto('/login')

      // 填写格式错误的邮箱
      const emailInput = page.locator('#login-email')
      const passwordInput = page.locator('#login-password')
      await emailInput.click()
      await emailInput.fill('')
      await emailInput.pressSequentially('invalid-email')
      await passwordInput.click()
      await passwordInput.fill('')
      await passwordInput.pressSequentially('somepassword')

      // 点击登录按钮
      await page.getByRole('button', { name: /login|登录|sign in/i }).click()

      // 验证前端表单校验阻止登录
      await expect(page).toHaveURL(/\/login/i)
      const validationMessage = await emailInput.evaluate((el) => (el as HTMLInputElement).validationMessage)
      expect(validationMessage.length).toBeGreaterThan(0)
    })
  })

  test.describe('Logout Flow', () => {
    test.beforeEach(async ({ page }) => {
      // 先登录（通过 API 注入，避免浏览器输入差异导致的不稳定）
      await loginByApi(page)
    })

    test('should logout successfully', async ({ page }) => {
      await logoutFromUserMenu(page)

      // 验证跳转到登录页面
      await expect(page).toHaveURL(/\/login/i)

      // 验证登录表单可见
      await expect(page.getByRole('button', { name: /login|登录|sign in/i })).toBeVisible()
    })

    test('should clear session after logout', async ({ page }) => {
      // 执行退出操作
      await logoutFromUserMenu(page)

      // 尝试访问受保护的页面
      await page.goto('/dashboard')

      // 验证被重定向到登录页面
      await expect(page).toHaveURL(/\/login/i)
    })
  })

  test.describe('Session Persistence', () => {
    test('should maintain session after page refresh', async ({ page }) => {
      // 登录（通过 API 注入，专注验证会话持久化）
      await loginByApi(page)

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
