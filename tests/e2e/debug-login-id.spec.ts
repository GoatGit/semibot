import { test, expect } from '@playwright/test'

test('debug: verify login with type instead of fill', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '登录' }).waitFor({ timeout: 15000 })

  // Try approach 1: click then type
  const emailInput = page.locator('#login-email')
  const passwordInput = page.locator('#login-password')

  await emailInput.click()
  await emailInput.pressSequentially('12611171@qq.com')

  await passwordInput.click()
  await passwordInput.pressSequentially('test123')

  const emailValue = await emailInput.inputValue()
  const passwordValue = await passwordInput.inputValue()
  console.log(`[DEBUG] Email value: "${emailValue}"`)
  console.log(`[DEBUG] Password value: "${passwordValue}"`)

  await page.getByRole('button', { name: '登录' }).click()

  await page.waitForTimeout(3000)
  console.log(`[DEBUG] URL after login: ${page.url()}`)

  const errorEl = page.locator('.text-error-500')
  if (await errorEl.isVisible().catch(() => false)) {
    const errorText = await errorEl.textContent()
    console.log(`[DEBUG] Error: "${errorText}"`)
  } else {
    console.log('[DEBUG] No error visible - login may have succeeded')
  }
})
