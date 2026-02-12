import { test, expect } from '@playwright/test'

test('debug: check login page and API', async ({ page }) => {
  // 1. 检查前端是否可达
  const response = await page.goto('/login')
  console.log(`[DEBUG] Page status: ${response?.status()}`)
  console.log(`[DEBUG] Page URL: ${page.url()}`)

  // 2. 截图看看页面状态
  await page.waitForLoadState('networkidle')
  console.log(`[DEBUG] Page title: ${await page.title()}`)

  // 3. 直接在浏览器里测试 API 连通性
  const apiResult = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/v1/health')
      const text = await res.text()
      return { status: res.status, body: text, ok: res.ok }
    } catch (e) {
      return { error: String(e) }
    }
  })
  console.log(`[DEBUG] API /health result:`, JSON.stringify(apiResult))

  // 4. 测试登录 API
  const loginResult = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: '12611171@qq.com', password: 'test123' }),
      })
      const text = await res.text()
      return { status: res.status, body: text, ok: res.ok }
    } catch (e) {
      return { error: String(e) }
    }
  })
  console.log(`[DEBUG] API /auth/login result:`, JSON.stringify(loginResult))

  // 5. 检查输入框是否存在
  const emailInput = page.locator('#login-email')
  const passwordInput = page.locator('#login-password')
  const loginBtn = page.getByRole('button', { name: '登录' })

  console.log(`[DEBUG] Email input visible: ${await emailInput.isVisible()}`)
  console.log(`[DEBUG] Password input visible: ${await passwordInput.isVisible()}`)
  console.log(`[DEBUG] Login button visible: ${await loginBtn.isVisible()}`)
})
