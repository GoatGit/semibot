import { test, expect } from '@playwright/test'
import { loginByApi } from './helpers/auth'

test('debug login with role selectors', async ({ page }) => {
  await loginByApi(page)
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 })
})
