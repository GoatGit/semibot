import { test, expect } from '@playwright/test'

test('debug login with role selectors', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '登录' }).waitFor({ timeout: 15000 })
  console.log('Login form loaded')

  await page.getByRole('textbox', { name: '邮箱' }).fill('12611171@qq.com')
  await page.getByRole('textbox', { name: '密码' }).fill('test123')
  console.log('Filled credentials')

  await page.getByRole('button', { name: '登录' }).click()
  console.log('Clicked login')

  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 })
  console.log('Login success, URL:', page.url())
})
