import type { Page } from '@playwright/test'

let cachedToken: string | null = null

const TEST_EMAIL = process.env.E2E_TEST_EMAIL || '12611171@qq.com'
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'test123'

/**
 * Login via API and inject token into browser storage.
 * Caches token to reduce repeated login requests in one run.
 */
export async function loginByApi(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })

  if (!cachedToken) {
    const loginResult = await page.evaluate(async ({ email, password }) => {
      const maxRetries = 5
      for (let i = 0; i < maxRetries; i++) {
        const res = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })

        const data = await res.json()
        if (data.success && data.data?.token) {
          return { success: true, token: data.data.token as string }
        }

        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 3000 * (i + 1)))
          continue
        }

        return { success: false, error: data.error?.message || 'Login failed' }
      }

      return { success: false, error: 'Login retries exhausted' }
    }, { email: TEST_EMAIL, password: TEST_PASSWORD })

    if (!loginResult.success || !loginResult.token) {
      throw new Error(`Login failed: ${loginResult.error || 'Unknown error'}`)
    }

    cachedToken = loginResult.token
  }

  await page.evaluate((token) => {
    document.cookie = `auth_token=${token}; path=/; max-age=86400; samesite=strict`
    localStorage.setItem('auth_token', token)
  }, cachedToken)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 10000 })
}
